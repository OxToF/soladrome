// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// Phase-2 points — snapshot job. Reads on-chain LP state, computes accrual with
// the PURE logic in app/lib/points.ts, and persists it via the SECURITY DEFINER
// RPCs in supabase/points_phase2.sql. See POINTS_PHASE2_DESIGN.md §3.
//
// Trigger: a scheduled caller (Vercel Cron) hits this with the CRON_SECRET.
//   GET /api/points/snapshot?key=<CRON_SECRET>            → accrue + persist
//   GET /api/points/snapshot?key=<CRON_SECRET>&dryRun=1   → compute only, no write
// Without CRON_SECRET configured, only dryRun is allowed (local dev). This route
// never trusts anything from the client — points are a pure function of chain
// state read here with the app's own read-only provider.
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  getProgram, statePda, lpMintPda, PROGRAM_ID, toUiDecimals, WSOL_MINT_STR,
} from "@/lib/program";
import { isPoolTrusted } from "@/lib/tokens";
import {
  valuePool, computePositionAccrual, nonNeg, resolvePricesUsd, reconcilePrices,
  DEFAULT_RATE_POINTS_PER_USD_HOUR, DEFAULT_MIN_POOL_TVL_USD,
  DEFAULT_MAX_POSITION_USD, DEFAULT_MULTIPLIER_BPS,
} from "@/lib/points";
import { fetchJupiterUsdPrices, fetchPythMajorsUsd } from "@/lib/prices_external";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ── Config (env-tunable, safe defaults) ──────────────────────────────────────
const RPC = process.env.NEXT_PUBLIC_RPC_URL || process.env.RPC_URL || "https://api.devnet.solana.com";
const CRON_SECRET = process.env.CRON_SECRET || "";
const RATE          = num(process.env.POINTS_RATE,          DEFAULT_RATE_POINTS_PER_USD_HOUR);
const MIN_TVL_USD   = num(process.env.POINTS_MIN_TVL_USD,   DEFAULT_MIN_POOL_TVL_USD);
const MAX_POS_USD   = num(process.env.POINTS_MAX_POSITION_USD, DEFAULT_MAX_POSITION_USD);
// Cap on the interval a single snapshot bills, so a stalled cron cannot later
// over-credit a whole outage at the current (possibly higher) value. Default 2×
// the intended hourly cadence.
const MAX_ELAPSED_S = num(process.env.POINTS_MAX_ELAPSED_SECONDS, 7200);
const LOCK_TTL_S    = num(process.env.POINTS_LOCK_TTL_SECONDS, 300);
// Pricing: external market price (Jupiter) is primary; Soladrome's own reserves
// are NEVER used for valuation unless this fallback is explicitly enabled (it
// reintroduces the self-pricing manipulation vector — keep off in production).
const JUP_MIN_LIQ_USD = num(process.env.POINTS_MIN_TOKEN_LIQ_USD, 10_000);
const PRICE_TOL_PCT   = num(process.env.POINTS_PRICE_TOLERANCE_PCT, 3);
const ALLOW_INTERNAL_FALLBACK = (process.env.POINTS_ALLOW_INTERNAL_PRICE_FALLBACK || "") === "1";
// Mints cross-checked against Pyth majors (1:1-redeemable / native only — LSTs
// and wstETH are NOT 1:1 with SOL/ETH, so they ride Jupiter alone).
const CBBTC_MINT = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
const ETH_MINT   = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";

// LP MINIMUM_LIQUIDITY is locked to the System Program — never a real LP.
const LP_DEAD = "11111111111111111111111111111111";
const LP_DECIMALS = 6; // protocol invariant (LP mints are 6 decimals)

function num(v: string | undefined, d: number): number {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
}

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

const connection = new Connection(RPC, "confirmed");
const readonlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: async (t: any) => t,
  signAllTransactions: async (t: any) => t,
};
const program = getProgram(new AnchorProvider(connection, readonlyWallet as any, { commitment: "confirmed" }));

function lpUserInfoPda(pool: PublicKey, user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp_user"), pool.toBuffer(), user.toBuffer()], PROGRAM_ID,
  )[0];
}

/** All (owner, rawAmount) holding `mint`, via getProgramAccounts on the token
 *  program filtered to that mint. Excludes the dead-liquidity System-Program
 *  holder and zero balances — neither can ever accrue. */
async function lpHolders(mint: PublicKey): Promise<{ owner: string; amountRaw: number }[]> {
  const accs = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });
  const out: { owner: string; amountRaw: number }[] = [];
  for (const { account } of accs) {
    const data = account.data as Buffer;
    const owner = new PublicKey(data.subarray(32, 64)).toBase58();
    const amountRaw = Number(data.readBigUInt64LE(64));
    if (owner === LP_DEAD || amountRaw <= 0) continue;
    out.push({ owner, amountRaw });
  }
  return out;
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const dryRun = url.searchParams.get("dryRun") === "1";
  const key = url.searchParams.get("key")
    || (req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");

  // Auth: with a secret configured, require it. Without one, only dryRun is
  // allowed (so a misconfigured prod can never silently accrue unauthenticated).
  if (CRON_SECRET) {
    if (key !== CRON_SECRET) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  } else if (!dryRun) {
    return NextResponse.json({ error: "CRON_SECRET not configured; only dryRun allowed" }, { status: 401 });
  }

  try {
    // Single-flight lock (skip in dryRun — it writes nothing).
    if (!dryRun) {
      const { data: locked } = await supabase.rpc("acquire_snapshot_lock", { p_ttl_seconds: LOCK_TTL_S });
      if (locked !== true) return NextResponse.json({ error: "another snapshot in progress" }, { status: 409 });
    }

    try {
      const st: any = await (program.account as any).protocolState.fetch(statePda);
      const usdcMint: PublicKey = st.usdcMint;
      const usdcStr = usdcMint.toBase58();

      // Pool multipliers → map (absent = default 1.0×).
      const { data: multRows } = await supabase.from("pool_multipliers").select("pool_address, multiplier_bps");
      const multByPool = new Map<string, number>();
      (multRows ?? []).forEach((r: any) => multByPool.set(r.pool_address, r.multiplier_bps));

      // All AMM pools, trusted only.
      const allPools: any[] = await (program.account as any).ammPool.all();
      const trusted = allPools.filter((p) =>
        isPoolTrusted(p.account.tokenAMint.toString(), p.account.tokenBMint.toString(), usdcMint));

      // Mint decimals read ON-CHAIN (authoritative, not a hardcoded table). The
      // decimals byte lives at offset 44 in both the classic SPL and Token-2022
      // mint layouts, so this is program-agnostic.
      const mintSet = new Set<string>();
      trusted.forEach((p) => {
        mintSet.add(p.account.tokenAMint.toString());
        mintSet.add(p.account.tokenBMint.toString());
      });
      const mintList = [...mintSet];
      const mintInfos = await connection.getMultipleAccountsInfo(mintList.map((m) => new PublicKey(m)));
      const decimalsOf = new Map<string, number>();
      mintList.forEach((m, i) => {
        const info = mintInfos[i];
        decimalsOf.set(m, info && info.data.length > 44 ? info.data[44] : 6);
      });

      const pools = trusted.map((p) => {
        const mintA = p.account.tokenAMint.toString();
        const mintB = p.account.tokenBMint.toString();
        return {
          address:  p.publicKey.toBase58(),
          pubkey:   p.publicKey as PublicKey,
          mintA, mintB,
          reserveAUi: toUiDecimals(p.account.reserveA, decimalsOf.get(mintA) ?? 6),
          reserveBUi: toUiDecimals(p.account.reserveB, decimalsOf.get(mintB) ?? 6),
          // LP amounts (supply + per-user basis + wallet balance) all stay in RAW
          // base units: value = basis × (TVL / supply) is a ratio of LP amounts,
          // so the LP decimals cancel — only the token reserves need UI units.
          totalLpRaw: Number(p.account.totalLp.toString()),
        };
      });

      // ── Pricing: EXTERNAL market price, never Soladrome's own reserves ──────
      // Valuing LP from the same pools it sits in is circular and manipulable
      // (skew a thin reserve → inflate your own LP's USD value → farm points).
      // Primary = Jupiter aggregate (all Solana liquidity), thin tokens dropped;
      // cross-checked against Pyth majors so a poisoned feed is rejected. The
      // internal-reserve BFS remains only as an explicitly-opt-in fallback.
      const jup = await fetchJupiterUsdPrices(mintList, JUP_MIN_LIQ_USD);
      const pyth = await fetchPythMajorsUsd();
      const crossCheck: Record<string, number> = {};
      if (pyth.SOL) crossCheck[WSOL_MINT_STR] = pyth.SOL;
      if (pyth.BTC) crossCheck[CBBTC_MINT]    = pyth.BTC;
      if (pyth.ETH) crossCheck[ETH_MINT]      = pyth.ETH;
      const { prices: extPrices, disputed } = reconcilePrices(jup, crossCheck, PRICE_TOL_PCT);
      const fallback = ALLOW_INTERNAL_FALLBACK ? resolvePricesUsd(pools, usdcStr) : {};
      // External prices win over any fallback; USDC anchored at $1.
      const priceMap: Record<string, number> = { [usdcStr]: 1, ...fallback, ...extPrices };
      const priceOf = (mint: string): number | null =>
        priceMap[mint] !== undefined ? priceMap[mint] : null;

      // Value each pool; keep only eligible (priceable + above TVL floor).
      const valued = pools.map((p) => ({
        ...p,
        val: valuePool({
          reserveAUi: p.reserveAUi, reserveBUi: p.reserveBUi, totalLpUi: p.totalLpRaw,
          priceAUsd: priceOf(p.mintA), priceBUsd: priceOf(p.mintB),
          multiplierBps: multByPool.get(p.address) ?? DEFAULT_MULTIPLIER_BPS,
        }, MIN_TVL_USD),
      }));
      const eligible = valued.filter((p) => p.val.eligible);

      // Existing accrual rows → last_snapshot_at per (wallet,pool) for elapsed.
      const { data: prevRows } = await supabase
        .from("lp_points").select("wallet_address, pool_address, last_snapshot_at");
      const lastSeen = new Map<string, number>(); // "wallet|pool" → epoch ms
      (prevRows ?? []).forEach((r: any) =>
        lastSeen.set(`${r.wallet_address}|${r.pool_address}`, new Date(r.last_snapshot_at).getTime()));

      const nowMs = Date.now();
      const cfg = { ratePointsPerUsdHour: RATE, maxPositionUsd: MAX_POS_USD };

      let totalTvlUsd = 0, pointsAdded = 0;
      const walletsSeen = new Set<string>();
      const writes: PromiseLike<any>[] = [];
      const perPool: any[] = [];

      for (const p of eligible) {
        totalTvlUsd += p.val.tvlUsd;
        const holders = await lpHolders(lpMintPda(p.pubkey));
        if (holders.length === 0) { perPool.push({ pool: p.address, holders: 0, points: 0 }); continue; }

        // Batch LpUserInfo (deposited LP basis) for all holders of this pool.
        const infoPdas = holders.map((h) => lpUserInfoPda(p.pubkey, new PublicKey(h.owner)));
        const infos: (any | null)[] = await (program.account as any).lpUserInfo.fetchMultiple(infoPdas);

        let poolPoints = 0;
        holders.forEach((h, i) => {
          const info = infos[i];
          const depositedLpRaw = info ? Number(info.lpAmount.toString()) : 0;
          const kkey = `${h.owner}|${p.address}`;
          const seen = lastSeen.get(kkey);
          // First sighting: elapsed 0 (just record a baseline, credit nothing yet).
          const elapsedSeconds = seen == null ? 0 : Math.min((nowMs - seen) / 1000, MAX_ELAPSED_S);

          const acc = computePositionAccrual(p.val, {
            depositedLpUi: depositedLpRaw,
            walletLpBalanceUi: h.amountRaw,
            elapsedSeconds,
          }, cfg);

          walletsSeen.add(h.owner);
          poolPoints += acc.points;
          // Persist even a 0 (new position) so a baseline row + timestamp exists.
          if (!dryRun) {
            writes.push(supabase.rpc("accrue_lp_points", {
              p_wallet: h.owner, p_pool: p.address,
              p_add: nonNeg(acc.points), p_value_usd: nonNeg(acc.cappedUsd),
            }));
          }
        });
        pointsAdded += poolPoints;
        perPool.push({
          pool: p.address, mintA: p.mintA, mintB: p.mintB,
          tvlUsd: round(p.val.tvlUsd), lpPriceUsd: p.val.lpPriceUsd,
          multiplierBps: p.val.multiplierBps, holders: holders.length, points: round(poolPoints),
        });
      }

      if (!dryRun) {
        await Promise.allSettled(writes);
        await supabase.rpc("record_lp_snapshot", {
          p_wallets: walletsSeen.size, p_pools: eligible.length,
          p_tvl: totalTvlUsd, p_added: pointsAdded, p_ok: true, p_note: null,
        });
      }

      return NextResponse.json({
        dryRun,
        poolsTotal: pools.length,
        poolsEligible: eligible.length,
        skipped: valued.filter((p) => !p.val.eligible).map((p) => ({
          pool: p.address, reason: priceOf(p.mintA) == null || priceOf(p.mintB) == null ? "no-price" : "below-tvl-floor",
        })),
        walletsSeen: walletsSeen.size,
        totalTvlUsd: round(totalTvlUsd),
        pointsAdded: round(pointsAdded),
        rate: RATE, minTvlUsd: MIN_TVL_USD, maxPositionUsd: MAX_POS_USD, maxElapsedSeconds: MAX_ELAPSED_S,
        priceSource: "jupiter+pyth", pricedMints: Object.keys(extPrices).length,
        disputedMints: disputed, internalFallback: ALLOW_INTERNAL_FALLBACK,
        perPool,
      });
    } finally {
      if (!dryRun) await supabase.rpc("release_snapshot_lock");
    }
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

function round(x: number): number { return Math.round(x * 1e6) / 1e6; }
