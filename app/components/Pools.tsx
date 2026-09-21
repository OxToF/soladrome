// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  unpackAccount,
} from "@solana/spl-token";
import { SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  getProgram, poolPda, lpMintPda, vaultAPda, vaultBPda,
  sortMints, userAta, userAtaAuto, commonAccounts, statePda, oSolaM, solaM, PROGRAM_ID,
  getMintPrograms,
  fromUiDecimals, toUiDecimals, toUi,
  buildWrapInstructions, buildUnwrapInstruction, ensureAtaIx, sendTx,
  WSOL_MINT_STR, SOL_FEE_RESERVE, spendableSol,
} from "@/lib/program";
import { getTokenList, symbolByMint, WSOL_MINT, decimalsForMint, isPoolTrusted } from "@/lib/tokens";
import {
  EMISSIONS_OFF, continuousActive, computePendingOsola, lpUserInfoPda, rewardBasis,
  type EmissionCfg,
} from "@/lib/lprewards";
import { useSoladrome } from "@/lib/SoladromeContext";
import { trackQuest } from "@/lib/quests";
import { StatusBanner } from "./ui/StatusBanner";
import { Skeleton } from "./ui/Skeleton";
import { ButtonHint } from "./ui/ButtonHint";

const LP_DEAD = new PublicKey("11111111111111111111111111111111");
const PCT = [25, 50, 75, 100] as const;

// ☢️ The reward precision, the epoch length, the emission window and the pending-oSOLA
// calculation now live in `lib/lprewards.ts`, shared with the recipe engine. A second copy
// here would let this screen and a one-click recipe disagree about what is claimable, and the
// recipe would revert with NothingToClaim for the whole batch.
const SECS_PER_YEAR = 365 * 24 * 3600;

// APR derived from the *live* on-chain rate, so it reads 0 when emissions are off.
//
// ⚠️ `rewardsEnabled` is not decoration. The continuous stream is paid by `advance_pool_rewards`
// (amm.rs), which returns early for a pool the authority never approved, so an unapproved pool
// pays its LPs exactly nothing. This function used to read only the GLOBAL rate and the pool's
// TVL, so every pool advertised the same emission APR whether or not it earned a single oSOLA —
// the figure was most wrong precisely where it did most damage, on a pool a depositor had no
// other way of knowing was unfunded. Approval is per pool, so the APR must be too.
function poolEmissionApr(
  tvlUsdc: number | null, osolaPrice: number | null, cfg: EmissionCfg, nowSec: number,
  rewardsEnabled: boolean,
): number | null {
  if (!tvlUsdc || tvlUsdc <= 0 || !osolaPrice || osolaPrice <= 0) return null;
  if (!rewardsEnabled) return 0;
  if (cfg.ratePerSec <= 0 || !continuousActive(nowSec, cfg.endEpoch)) return 0;
  const osolaPerYear = (cfg.ratePerSec / 1e6) * SECS_PER_YEAR;
  return (osolaPerYear * osolaPrice / tvlUsdc) * 100;
}

type View = "list" | "manage" | "create";
type ManageTab = "add" | "remove" | "claim";

// Surface the *real* cause of a failed tx. Wallet adapters wrap the underlying
// SendTransactionError, so a bare e.message is often a useless "Internal error";
// dig into cause/error and append the program/preflight logs when present.
function fmtErr(e: any): string {
  const msg  = e?.message ?? e?.error?.message ?? e?.cause?.message ?? String(e);
  const logs = e?.logs ?? e?.cause?.logs ?? e?.error?.logs;
  const tail = Array.isArray(logs) && logs.length ? ` — ${logs.slice(-4).join(" | ")}` : "";
  return `${e?.name ? e.name + ": " : ""}${msg}${tail}`;
}

interface PoolInfo {
  address:  string;
  mintA:    string;
  mintB:    string;
  reserveA: number;
  reserveB: number;
  feeRate:  number;
  totalLp:  number;
  tvlUsdc:  number | null;
  // Continuous reward fields from on-chain AmmPool
  osolaRewardPerLp: bigint;
  lastRewardTs:     number;
  rewardsEnabled:   boolean;
}

// ── Token avatar helpers ───────────────────────────────────────────────────

const TOKEN_COLORS: Record<string, string> = {
  SOLA:   "#4ade80",
  hiSOLA: "#86efac",
  oSOLA:  "#bbf7d0",
  USDC:   "#2775ca",
  SOL:    "#9945ff",
  wSOL:   "#9945ff",
};

function tokenColor(sym: string): string {
  if (TOKEN_COLORS[sym]) return TOKEN_COLORS[sym];
  const h = [...sym].reduce((a, c) => a + c.charCodeAt(0) * 37, 0);
  return ["#f59e0b", "#ec4899", "#8b5cf6", "#06b6d4", "#f97316"][h % 5];
}

function PairBadge({ symA, symB }: { symA: string; symB: string }) {
  return (
    <div className="flex items-center shrink-0">
      <span
        className="w-9 h-9 rounded-full border-2 border-[#0f1117] flex items-center justify-center text-[10px] font-black text-black z-10 relative"
        style={{ background: tokenColor(symA) }}
      >
        {symA.slice(0, 2).toUpperCase()}
      </span>
      <span
        className="w-9 h-9 rounded-full border-2 border-[#0f1117] flex items-center justify-center text-[10px] font-black text-black -ml-3"
        style={{ background: tokenColor(symB) }}
      >
        {symB.slice(0, 2).toUpperCase()}
      </span>
    </div>
  );
}

function numInput(v: string, set: (s: string) => void) {
  if (v === "" || /^\d*\.?\d*$/.test(v)) set(v);
}

// ── Main component ─────────────────────────────────────────────────────────

export function Pools() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { sendTransaction } = useWallet();
  const { usdcMint } = useSoladrome();
  const tokens = getTokenList(usdcMint);

  const [view,      setView]      = useState<View>("list");
  const [manageTab, setManageTab] = useState<ManageTab>("add");
  const [pools,     setPools]     = useState<PoolInfo[]>([]);
  const [poolsLoading, setPoolsLoading] = useState(true);
  const [selected,  setSelected]  = useState<PoolInfo | null>(null);
  const [osolaPrice, setOsolaPrice] = useState<number | null>(null);
  const [emissionCfg, setEmissionCfg] = useState<EmissionCfg>(EMISSIONS_OFF);
  const [loading,       setLoading]       = useState(false);
  const [status,        setStatus]        = useState("");
  const [claimAllBusy,  setClaimAllBusy]  = useState(false);
  const [claimAllMsg,   setClaimAllMsg]   = useState("");

  const [userLpBals,    setUserLpBals]    = useState<Record<string, number>>({});
  const [userLpRaws,    setUserLpRaws]    = useState<Record<string, bigint>>({});
  const [userRewardDbt, setUserRewardDbt] = useState<Record<string, bigint>>({});
  // ☢️ `LpUserInfo.lp_amount` — what the PROGRAM recorded through add_liquidity. Rewards pay on
  // min(this, wallet balance), so a screen that projects from the wallet balance alone lies to
  // anyone holding transferred LP. See `rewardBasis`.
  const [userLpRecorded, setUserLpRecorded] = useState<Record<string, bigint>>({});
  const [pendingOsola,  setPendingOsola]  = useState<Record<string, number>>({});

  // Add liquidity
  const [addA, setAddA] = useState("");
  const [addB, setAddB] = useState("");
  const [balA, setBalA] = useState<number | null>(null);
  const [balB, setBalB] = useState<number | null>(null);
  // Bumped after every transaction, successful or not. Without it the balances below are
  // read once when the tab opens and never again, so the percentage buttons keep proposing
  // a balance the wallet no longer has — every failed attempt already burned its fee.
  const [balTick, setBalTick] = useState(0);

  // Remove liquidity
  const [lpAmt, setLpAmt] = useState("");
  const [lpBal, setLpBal] = useState<number | null>(null);
  const [retA,  setRetA]  = useState<number | null>(null);
  const [retB,  setRetB]  = useState<number | null>(null);

  // Create pool
  const [newMintA, setNewMintA] = useState(0);
  const [newMintB, setNewMintB] = useState(1);
  const [newFee,   setNewFee]   = useState("30");
  const [newProto, setNewProto] = useState("2000");

  // ── Data fetching ─────────────────────────────────────────────────────────

  const fetchPools = useCallback(async () => {
    try {
      const provider = new AnchorProvider(connection, wallet ?? ({} as any), {});
      const program  = getProgram(provider);
      const all      = await (program.account as any).ammPool.all();
      const usdcStr = usdcMint?.toString() ?? "";

      // First pass: build pool infos — filter out spam/unknown-token pools
      const trusted = all.filter((p: any) =>
        isPoolTrusted(p.account.tokenAMint.toString(), p.account.tokenBMint.toString(), usdcMint)
      );
      const infos: PoolInfo[] = trusted.map((p: any) => {
        const mA   = p.account.tokenAMint.toString();
        const mB   = p.account.tokenBMint.toString();
        const decA = decimalsForMint(mA, usdcMint);
        const decB = decimalsForMint(mB, usdcMint);
        const ra   = toUiDecimals(p.account.reserveA as BN, decA);
        const rb   = toUiDecimals(p.account.reserveB as BN, decB);
        const tvlUsdc = mA === usdcStr ? ra * 2 : mB === usdcStr ? rb * 2 : null;
        return {
          address:  p.publicKey.toString(),
          mintA: mA, mintB: mB,
          reserveA: ra, reserveB: rb,
          feeRate:  p.account.feeRate as number,
          totalLp:  toUiDecimals(p.account.totalLp as BN, 6),
          tvlUsdc,
          osolaRewardPerLp: BigInt((p.account.osolaRewardPerLp ?? new BN(0)).toString()),
          lastRewardTs:     Number((p.account.lastRewardTs ?? new BN(0)).toString()),
          rewardsEnabled:   !!p.account.rewardsEnabled,
        } as PoolInfo;
      });

      // Second pass: build price map from USDC pools, then fill tvlUsdc for non-USDC pools
      const priceMap: Record<string, number> = { [usdcStr]: 1.0 };
      for (const p of infos) {
        if (p.mintA === usdcStr && p.reserveB > 0) priceMap[p.mintB] = p.reserveA / p.reserveB;
        else if (p.mintB === usdcStr && p.reserveA > 0) priceMap[p.mintA] = p.reserveB / p.reserveA;
      }
      for (const p of infos) {
        if (p.tvlUsdc === null) {
          const pA = priceMap[p.mintA];
          const pB = priceMap[p.mintB];
          if (pA !== undefined && pB !== undefined)
            p.tvlUsdc = p.reserveA * pA + p.reserveB * pB;
        }
      }

      setPools(infos);

      // Live continuous-emission config from ProtocolState — the rate is dynamic
      // and the window auto-sunsets, so the UI must read it rather than assume a
      // constant. When off (rate 0 / window closed) no phantom rewards are shown.
      try {
        const st: any = await (program.account as any).protocolState.fetch(statePda);
        setEmissionCfg({
          ratePerSec: Number(st.continuousRatePerSec ?? 0),
          endEpoch:   Number(st.continuousEndEpoch ?? 0),
        });
        // oSOLA is valued off the bonding curve, never off an AMM pool. It is an
        // option struck at the $1 floor, so it is worth curve − 1, floored at 0.
        // No oSOLA/USDC pool exists to quote against, and quoting one would have
        // made this APR manipulable by skewing a thin reserve. Note this reads 0
        // while SOLA sits at the floor, which is correct but makes the emission
        // APR display 0% until the curve moves.
        const curvePrice = toUi(st.virtualUsdc as BN) / toUi(st.virtualSola as BN);
        setOsolaPrice(Math.max(0, curvePrice - 1));
      } catch { setEmissionCfg(EMISSIONS_OFF); setOsolaPrice(null); }
    } catch { } finally { setPoolsLoading(false); }
  }, [connection, wallet, usdcMint]);

  useEffect(() => { fetchPools(); }, [fetchPools]);

  // Keep selected pool in sync when pools refresh
  useEffect(() => {
    if (!selected) return;
    const updated = pools.find(p => p.address === selected.address);
    if (updated) setSelected(updated);
  }, [pools]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch user LP balances and reward debts
  useEffect(() => {
    if (!wallet || pools.length === 0) return;
    const bals: Record<string, number> = {};
    const raws: Record<string, bigint> = {};
    const debts: Record<string, bigint> = {};
    const recorded: Record<string, bigint> = {};

    const provider = new AnchorProvider(connection, wallet, {});
    const program  = getProgram(provider);

    // Batch all per-pool reads into two RPC calls (getMultipleAccountsInfo)
    // instead of 2 requests per pool. On rate-limited RPCs the old 2N burst
    // was a primary 429 source. LP token accounts decode via unpackAccount;
    // lpUserInfo decodes via Anchor's fetchMultiple (both single round-trips).
    const lpAtas    = pools.map((p) => userAta(lpMintPda(new PublicKey(p.address)), wallet.publicKey));
    const userInfos = pools.map((p) => lpUserInfoPda(new PublicKey(p.address), wallet.publicKey));

    Promise.allSettled([
      connection.getMultipleAccountsInfo(lpAtas),
      (program.account as any).lpUserInfo.fetchMultiple(userInfos),
    ]).then(([lpRes, infoRes]) => {
      const lpInfos: (any | null)[] = lpRes.status === "fulfilled" ? lpRes.value : [];
      const infos:   (any | null)[] = infoRes.status === "fulfilled" ? infoRes.value : [];
      pools.forEach((p, i) => {
        const lpInfo = lpInfos[i];
        if (lpInfo) {
          const acc = unpackAccount(lpAtas[i], lpInfo);
          raws[p.address] = acc.amount;
          bals[p.address] = Number(acc.amount) / 1e6; // LP mints use 6 decimals (protocol invariant)
        } else {
          raws[p.address] = 0n;
          bals[p.address] = 0;
        }
        const info = infos[i];
        debts[p.address]    = info ? BigInt(info.rewardDebt.toString()) : 0n;
        recorded[p.address] = info ? BigInt(info.lpAmount?.toString() ?? "0") : 0n;
      });
      setUserLpBals({ ...bals });
      setUserLpRaws({ ...raws });
      setUserRewardDbt({ ...debts });
      setUserLpRecorded({ ...recorded });
    });
  }, [pools, wallet, connection]);

  // Compute pending oSOLA every 5 seconds (live ticker)
  useEffect(() => {
    const compute = () => {
      if (pools.length === 0) return;
      const now = Math.floor(Date.now() / 1000);
      const pending: Record<string, number> = {};
      for (const p of pools) {
        const basis = rewardBasis(userLpRecorded[p.address] ?? 0n, userLpRaws[p.address] ?? 0n);
        const debt  = userRewardDbt[p.address] ?? 0n;
        pending[p.address] = computePendingOsola(p, debt, basis, now, emissionCfg);
      }
      setPendingOsola(pending);
    };
    compute();
    const id = setInterval(compute, 5000);
    return () => clearInterval(id);
  }, [pools, userLpRaws, userLpRecorded, userRewardDbt, emissionCfg]);

  // ── Balance fetch for manage view ─────────────────────────────────────────

  useEffect(() => {
    if (!wallet || !selected) return;
    const mintAPk = new PublicKey(selected.mintA);
    const mintBPk = new PublicKey(selected.mintB);
    const lpMint  = lpMintPda(new PublicKey(selected.address));

    const bal = async (mint: PublicKey) => {
      try {
        if (mint.toString() === WSOL_MINT)
          return (await connection.getBalance(wallet.publicKey)) / 1e9;
        // A pool side can be Token-2022 (an xStock quoted in USDC is the flagship pair), so the
        // ATA must be derived under the mint's own program or this reads 0 and the add-liquidity
        // form believes the wallet is empty.
        const ata = await userAtaAuto(connection, mint, wallet.publicKey);
        return (await connection.getTokenAccountBalance(ata)).value.uiAmount ?? 0;
      } catch { return 0; }
    };

    if (manageTab === "add") {
      bal(mintAPk).then(setBalA);
      bal(mintBPk).then(setBalB);
    }
    if (manageTab === "remove") {
      bal(lpMint).then(setLpBal);
    }
  }, [manageTab, selected, wallet, connection, balTick]);

  // ── Ratio logic ───────────────────────────────────────────────────────────

  const poolHasLiquidity = !!selected && selected.reserveA > 0 && selected.reserveB > 0;

  // `balA` for a wSOL side is the NATIVE balance, not a token account, so it is also what
  // pays the fee and the rent of every ATA this deposit opens. Spending all of it is a
  // guaranteed "insufficient lamports" on the wrap transfer.
  const isWsolA   = selected?.mintA === WSOL_MINT_STR;
  const isWsolB   = selected?.mintB === WSOL_MINT_STR;
  const spendA    = balA === null ? null : isWsolA ? spendableSol(balA) : balA;
  // Side B is the auto-computed one on a pool that already has liquidity, but it is just as
  // often the wSOL side (wSOL sorts second against a USDC-quoted pair), so it needs the same
  // reserve before the ratio is checked against it.
  const spendB    = balB === null ? null : isWsolB ? spendableSol(balB) : balB;

  function onChangeA(v: string) {
    numInput(v, setAddA);
    if (!poolHasLiquidity || !selected) return;
    const a = parseFloat(v);
    if (!isNaN(a) && a > 0)
      setAddB((a * selected.reserveB / selected.reserveA).toFixed(6).replace(/\.?0+$/, ""));
    else setAddB("");
  }

  function onChangeB(v: string) {
    if (poolHasLiquidity) return;
    numInput(v, setAddB);
  }

  function applyPctA(pct: number) {
    if (!spendA) return;
    onChangeA(((spendA * pct) / 100).toFixed(6).replace(/\.?0+$/, ""));
  }

  function onChangeLp(v: string) {
    numInput(v, setLpAmt);
    if (!selected || selected.totalLp <= 0) { setRetA(null); setRetB(null); return; }
    const lp = parseFloat(v);
    if (!isNaN(lp) && lp > 0) {
      setRetA(lp * selected.reserveA / selected.totalLp);
      setRetB(lp * selected.reserveB / selected.totalLp);
    } else { setRetA(null); setRetB(null); }
  }

  function applyPctLp(pct: number) {
    if (!lpBal) return;
    onChangeLp(((lpBal * pct) / 100).toFixed(6).replace(/\.?0+$/, ""));
  }

  function prov() { return new AnchorProvider(connection, wallet!, {}); }

  // ── Transactions ──────────────────────────────────────────────────────────

  async function createPool() {
    if (!wallet) return;
    setLoading(true); setStatus("");
    try {
      const program = getProgram(prov());
      const ma = tokens[newMintA]?.mint;
      const mb = tokens[newMintB]?.mint;
      if (!ma || !mb || ma === mb) throw new Error("Invalid token pair");
      const [mintAPk, mintBPk] = sortMints(new PublicKey(ma), new PublicKey(mb));
      const poolAddr = poolPda(mintAPk, mintBPk);
      const lpMint   = lpMintPda(poolAddr);
      // Each side is served by whichever program owns its mint — they may differ.
      const { programA, programB } = await getMintPrograms(connection, mintAPk, mintBPk);
      const ix = await program.methods
        .createPool(+newFee, +newProto)
        .accounts({
          creator:       wallet.publicKey,
          protocolState: statePda,
          tokenAMint:    mintAPk,
          tokenBMint:    mintBPk,
          pool:          poolAddr,
          lpMint,
          tokenAVault:   vaultAPda(poolAddr),
          tokenBVault:   vaultBPda(poolAddr),
          tokenAProgram: programA,
          tokenBProgram: programB,
          // The LP mint the program creates is always classic SPL Token.
          tokenProgram:  TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent:          commonAccounts.rent,
        } as any)
        .instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setStatus(`✅ Pool created — ${tx.slice(0, 16)}…`);
      fetchPools(); setView("list");
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
    } catch (e: any) { console.error("tx failed:", e); setStatus(`❌ ${fmtErr(e)}`); }
    finally { setLoading(false); setBalTick(t => t + 1); }
  }

  async function addLiquidity() {
    if (!wallet || !selected || !addA || !addB) return;
    setLoading(true); setStatus("");
    try {
      const program   = getProgram(prov());
      const poolAddr  = new PublicKey(selected.address);
      const mintAPk   = new PublicKey(selected.mintA);
      const mintBPk   = new PublicKey(selected.mintB);
      const lpMint    = lpMintPda(poolAddr);
      const userLp    = getAssociatedTokenAddressSync(lpMint, wallet.publicKey);
      const deadLpAta = getAssociatedTokenAddressSync(lpMint, LP_DEAD, true);
      const decA      = decimalsForMint(selected.mintA, usdcMint);
      const decB      = decimalsForMint(selected.mintB, usdcMint);

      const preIxs: any[]  = [];
      const postIxs: any[] = [];

      if (isWsolA) {
        preIxs.push(...await buildWrapInstructions(connection, wallet.publicKey, Math.floor(+addA * 1e9)));
        postIxs.push(buildUnwrapInstruction(wallet.publicKey));
      }
      if (isWsolB) {
        preIxs.push(...await buildWrapInstructions(connection, wallet.publicKey, Math.floor(+addB * 1e9)));
        postIxs.push(buildUnwrapInstruction(wallet.publicKey));
      }

      const userLpIx = await ensureAtaIx(connection, wallet.publicKey, lpMint, wallet.publicKey);
      if (userLpIx) preIxs.push(userLpIx);

      const deadInfo = await connection.getAccountInfo(deadLpAta);
      if (!deadInfo)
        preIxs.push(createAssociatedTokenAccountInstruction(wallet.publicKey, deadLpAta, LP_DEAD, lpMint));

      const userInfoPda = lpUserInfoPda(poolAddr, wallet.publicKey);
      const userOSola   = userAta(oSolaM, wallet.publicKey);
      // ☢️ The pair's programs also decide ATA derivation: an associated-token address is
      // seeded with the token program, so deriving a Token-2022 ATA under Tokenkeg points at
      // an account that does not exist.
      const { programA, programB } = await getMintPrograms(connection, mintAPk, mintBPk);

      const addIx = await program.methods
        .addLiquidity(fromUiDecimals(+addA, decA), fromUiDecimals(+addB, decB), new BN(0))
        .accounts({
          user:                   wallet.publicKey,
          payer:                  wallet.publicKey,
          pool:                   poolAddr,
          lpMint,
          tokenAMint:             mintAPk,
          tokenBMint:             mintBPk,
          tokenAVault:            vaultAPda(poolAddr),
          tokenBVault:            vaultBPda(poolAddr),
          userTokenA:             userAta(mintAPk, wallet.publicKey, programA),
          userTokenB:             userAta(mintBPk, wallet.publicKey, programB),
          userLp,
          lpDeadAta:              deadLpAta,
          lpDead:                 LP_DEAD,
          lpUserInfo:             userInfoPda,
          protocolState:          statePda,
          oSolaMint:              oSolaM,
          userOSola,
          rent:                   SYSVAR_RENT_PUBKEY,
          tokenAProgram:          programA,
          tokenBProgram:          programB,
          tokenProgram:           TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram:          SystemProgram.programId,
        } as any)
        .instruction();

      const sig = await sendTx(connection, wallet, [...preIxs, addIx, ...postIxs]);
      setStatus(`✅ Liquidity added — ${sig.slice(0, 16)}…`);
      // meta.pool = which pool we deposited into, so the server can verify the
      // un-dustable LpUserInfo PDA directly (no all-pools scan). Same pattern as
      // claim_bribe's meta.
      trackQuest(wallet.publicKey.toBase58(), "liquidity", { pool: poolAddr.toBase58() });
      setAddA(""); setAddB("");
      fetchPools();
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
    } catch (e: any) { console.error("tx failed:", e); setStatus(`❌ ${fmtErr(e)}`); }
    finally { setLoading(false); setBalTick(t => t + 1); }
  }

  async function removeLiquidity() {
    if (!wallet || !selected || !lpAmt) return;
    setLoading(true); setStatus("");
    try {
      const program  = getProgram(prov());
      const poolAddr = new PublicKey(selected.address);
      const mintAPk  = new PublicKey(selected.mintA);
      const mintBPk  = new PublicKey(selected.mintB);
      const lpMint   = lpMintPda(poolAddr);

      const preIxs:  any[] = [];
      const postIxs: any[] = [];
      // Ensure BOTH destination ATAs exist before the burn — INCLUDING the wSOL
      // side. remove_liquidity declares user_token_a/b without init_if_needed, so
      // it expects them to already exist; a user who closed their wSOL ATA after a
      // prior unwrap (wallets do this automatically) otherwise hits
      // AccountNotInitialized (Custom 3012). The wSOL ATA is a normal ATA, so we
      // create it here too and close it again via the unwrap post-ix below.
      const { programA, programB } = await getMintPrograms(connection, mintAPk, mintBPk);
      const ixA = await ensureAtaIx(connection, wallet.publicKey, mintAPk, wallet.publicKey, programA); if (ixA) preIxs.push(ixA);
      const ixB = await ensureAtaIx(connection, wallet.publicKey, mintBPk, wallet.publicKey, programB); if (ixB) preIxs.push(ixB);
      if (isWsolA || isWsolB) postIxs.push(buildUnwrapInstruction(wallet.publicKey));

      const userInfoPda = lpUserInfoPda(poolAddr, wallet.publicKey);
      const userOSola   = userAta(oSolaM, wallet.publicKey);

      const removeIx = await program.methods
        .removeLiquidity(fromUiDecimals(+lpAmt, 6), new BN(1), new BN(1))
        .accounts({
          user:                   wallet.publicKey,
          payer:                  wallet.publicKey,
          pool:                   poolAddr,
          lpMint,
          tokenAMint:             mintAPk,
          tokenBMint:             mintBPk,
          tokenAVault:            vaultAPda(poolAddr),
          tokenBVault:            vaultBPda(poolAddr),
          userLp:                 getAssociatedTokenAddressSync(lpMint, wallet.publicKey),
          userTokenA:             userAta(mintAPk, wallet.publicKey, programA),
          userTokenB:             userAta(mintBPk, wallet.publicKey, programB),
          lpUserInfo:             userInfoPda,
          protocolState:          statePda,
          oSolaMint:              oSolaM,
          userOSola,
          rent:                   SYSVAR_RENT_PUBKEY,
          tokenAProgram:          programA,
          tokenBProgram:          programB,
          tokenProgram:           TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram:          SystemProgram.programId,
        } as any)
        .instruction();

      const sig = await sendTx(connection, wallet, [...preIxs, removeIx, ...postIxs]);
      setStatus(`✅ Liquidity removed — ${sig.slice(0, 16)}…`);
      setLpAmt(""); setRetA(null); setRetB(null);
      fetchPools();
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
    } catch (e: any) { console.error("tx failed:", e); setStatus(`❌ ${fmtErr(e)}`); }
    finally { setLoading(false); setBalTick(t => t + 1); }
  }

  async function claimRewards() {
    if (!wallet || !selected) return;
    setLoading(true); setStatus("");
    try {
      const program     = getProgram(prov());
      const poolAddr    = new PublicKey(selected.address);
      const lpMint      = lpMintPda(poolAddr);
      const userInfoPda = lpUserInfoPda(poolAddr, wallet.publicKey);
      const userOSola   = userAta(oSolaM, wallet.publicKey);
      const userLp      = userAta(lpMint, wallet.publicKey);

      // Ensure the oSOLA ATA exists, then route through sendTx (priority fee +
      // dedicated un-throttled connection + rebroadcast) instead of Anchor .rpc(),
      // which sends on the shared throttled connection and was failing with 429.
      const oSolaAtaIx = await ensureAtaIx(connection, wallet.publicKey, oSolaM, wallet.publicKey);
      const claimIx = await program.methods
        .claimLpRewards()
        .accounts({
          user:                   wallet.publicKey,
          payer:                  wallet.publicKey,
          pool:                   poolAddr,
          lpMint,
          userLp,
          lpUserInfo:             userInfoPda,
          protocolState:          statePda,
          oSolaMint:              oSolaM,
          userOSola,
          tokenProgram:           TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram:          SystemProgram.programId,
          rent:                   SYSVAR_RENT_PUBKEY,
        } as any)
        .instruction();
      const tx = await sendTx(connection, wallet, oSolaAtaIx ? [oSolaAtaIx, claimIx] : [claimIx]);
      setStatus(`✅ oSOLA received — tx: ${tx.slice(0, 16)}…`);
      trackQuest(wallet.publicKey.toBase58(), "claim_lp_osola");
      fetchPools();
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
    } catch (e: any) { console.error("tx failed:", e); setStatus(`❌ ${fmtErr(e)}`); }
    finally { setLoading(false); setBalTick(t => t + 1); }
  }

  // ── Claim all LP rewards ──────────────────────────────────────────────────

  async function claimAll() {
    if (!wallet) return;
    // Only pools with a positive pending balance. Including a 0-pending pool would
    // hit the program's `require!(pending > 0)` (NothingToClaim) and revert the
    // WHOLE batch — the bug that surfaced as a generic error for some testers.
    const eligible = pools.filter(p => (pendingOsola[p.address] ?? 0) > 0);
    if (eligible.length === 0) { setClaimAllMsg("Nothing to claim yet."); return; }
    setClaimAllBusy(true); setClaimAllMsg("");
    try {
      const program   = getProgram(prov());
      const userOSola  = userAta(oSolaM, wallet.publicKey);

      const buildClaimIx = (p: typeof eligible[number]) => {
        const poolAddr    = new PublicKey(p.address);
        const lpMint      = lpMintPda(poolAddr);
        const userInfoPda = lpUserInfoPda(poolAddr, wallet.publicKey);
        const userLp      = userAta(lpMint, wallet.publicKey);
        return program.methods
          .claimLpRewards()
          .accounts({
            user:                   wallet.publicKey,
            payer:                  wallet.publicKey,
            pool:                   poolAddr,
            lpMint,
            userLp,
            lpUserInfo:             userInfoPda,
            protocolState:          statePda,
            oSolaMint:              oSolaM,
            userOSola,
            tokenProgram:           TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram:          SystemProgram.programId,
            rent:                   SYSVAR_RENT_PUBKEY,
          } as any)
          .instruction();
      };

      // Create the oSOLA ATA once (first batch only — it exists after that).
      const oSolaAtaIx = await ensureAtaIx(connection, wallet.publicKey, oSolaM, wallet.publicKey);

      // Batch claims to stay under the 1232-byte tx size limit (~4 claims/tx is safe).
      const BATCH = 4;
      const sigs: string[] = [];
      for (let i = 0; i < eligible.length; i += BATCH) {
        const slice = eligible.slice(i, i + BATCH);
        const ixs   = await Promise.all(slice.map(buildClaimIx));
        const pre   = (i === 0 && oSolaAtaIx) ? [oSolaAtaIx] : [];
        const sig   = await sendTx(connection, wallet, [...pre, ...ixs]);
        sigs.push(sig);
      }

      const total = eligible.reduce((s, p) => s + (pendingOsola[p.address] ?? 0), 0);
      setClaimAllMsg(`✅ Claimed ~${total.toFixed(4)} oSOLA from ${eligible.length} pool(s) — ${sigs.length} tx`);
      trackQuest(wallet.publicKey.toBase58(), "claim_lp_osola");
      fetchPools();
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
    } catch (e: any) {
      console.error("claimAll failed:", e);
      setClaimAllMsg(`❌ ${fmtErr(e)}`);
    } finally {
      setClaimAllBusy(false);
    }
  }

  // ── Navigation helpers ────────────────────────────────────────────────────

  const symA = selected ? symbolByMint(selected.mintA, usdcMint) : "";
  const symB = selected ? symbolByMint(selected.mintB, usdcMint) : "";
  const myPools = wallet ? pools.filter(p => (userLpBals[p.address] ?? 0) > 0) : [];

  // Stop a deposit the chain is certain to reject, instead of letting it be signed and
  // come back as a raw error code. Two shapes reach us from devnet testers:
  //   • the SOL side asks for more than the wallet can wrap → System error 1 on the transfer;
  //   • the other side is a token the wallet does not hold at all, so its ATA does not exist
  //     and add_liquidity fails with AccountNotInitialized (3012) — the xStock pools.
  // EPS absorbs the 6-decimal rounding of the percentage buttons and the ratio field.
  const EPS = 1e-6;
  const overA = spendA !== null && !!addA && +addA - spendA > EPS;
  const overB = spendB !== null && !!addB && +addB - spendB > EPS;
  const depositHint =
    overB && balB === 0 ? `Your wallet holds no ${symB}, which this pool needs on the other side.`
    : overA ? `Not enough ${symA}${isWsolA ? ` — ${SOL_FEE_RESERVE} SOL is kept back for the network fee and account rent` : ""}.`
    : overB ? `Not enough ${symB} for the matching amount this pool requires${isWsolB ? `, ${SOL_FEE_RESERVE} SOL is kept back for the network fee and account rent` : ""}.`
    : null;

  function openManage(p: PoolInfo, tab: ManageTab) {
    setSelected(p); setView("manage"); setManageTab(tab); setStatus("");
    setAddA(""); setAddB(""); setLpAmt(""); setRetA(null); setRetB(null);
  }

  function backToList() { setView("list"); setStatus(""); }

  // ── Manage view ───────────────────────────────────────────────────────────

  if (view === "manage" && selected) {
    const userLp        = userLpBals[selected.address] ?? 0;
    const share         = selected.totalLp > 0 ? (userLp / selected.totalLp) * 100 : 0;
    const pending       = pendingOsola[selected.address] ?? 0;
    const lpValueUsdc   = selected.tvlUsdc !== null && selected.totalLp > 0 ? (userLp / selected.totalLp) * selected.tvlUsdc : null;

    return (
      <div className="space-y-4">
        {/* Back + title */}
        <div className="flex items-center gap-3">
          <button onClick={backToList}
            className="w-8 h-8 rounded-full border border-brand-border text-gray-400 hover:text-white hover:border-brand-green transition-colors flex items-center justify-center text-lg leading-none">
            ←
          </button>
          <div className="flex items-center gap-3">
            <PairBadge symA={symA} symB={symB} />
            <div>
              <p className="font-black text-white text-lg">{symA}/{symB}</p>
              <p className="text-xs text-gray-500">{(selected.feeRate / 100).toFixed(2)}% fee · Basic</p>
            </div>
          </div>
        </div>

        {/* Pool stats strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl bg-brand-dark border border-brand-border p-3 text-center">
            <p className="text-xs text-gray-500 mb-1">TVL</p>
            <p className="font-bold text-brand-green text-sm">
              {selected.tvlUsdc !== null
                ? `$${selected.tvlUsdc.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : "—"}
            </p>
          </div>
          <div className="rounded-xl bg-brand-dark border border-brand-border p-3 text-center">
            <p className="text-xs text-gray-500 mb-1">oSOLA APR</p>
            <p className="font-bold text-brand-green text-sm">
              {(() => {
                const apr = poolEmissionApr(selected.tvlUsdc, osolaPrice, emissionCfg, Math.floor(Date.now() / 1000), selected.rewardsEnabled);
                return apr !== null ? `${apr.toFixed(1)}%` : "—";
              })()}
            </p>
            <p className="text-[10px] text-gray-600 mt-0.5">emission rewards</p>
          </div>
          <div className="rounded-xl bg-brand-dark border border-brand-border p-3 text-center">
            <p className="text-xs text-gray-500 mb-1">{symA} Reserve</p>
            <p className="font-mono text-white text-sm">
              {selected.reserveA.toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </p>
          </div>
          <div className="rounded-xl bg-brand-dark border border-brand-border p-3 text-center">
            <p className="text-xs text-gray-500 mb-1">{symB} Reserve</p>
            <p className="font-mono text-white text-sm">
              {selected.reserveB.toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </p>
          </div>
        </div>

        {/* My position banner */}
        {wallet && userLp > 0 && (
          <div className="rounded-xl border border-brand-green/30 bg-brand-green/5 px-4 py-3 flex justify-between items-center">
            <div>
              <span className="text-sm text-brand-green/80 font-semibold">My position</span>
              {lpValueUsdc !== null && (
                <p className="text-xs text-brand-green font-mono mt-0.5">
                  ≈ ${lpValueUsdc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              )}
            </div>
            <span className="text-sm font-bold text-brand-green font-mono">
              {userLp.toLocaleString(undefined, { maximumFractionDigits: 4 })} LP
              <span className="text-xs text-brand-green/60 ml-2">({share.toFixed(3)}%)</span>
            </span>
          </div>
        )}

        {/* Tabs */}
        <div className="flex rounded-xl border border-brand-border overflow-hidden">
          {(["add", "remove", "claim"] as ManageTab[]).map(t => (
            <button key={t} onClick={() => { setManageTab(t); setStatus(""); }}
              className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${
                manageTab === t
                  ? "bg-brand-green text-black"
                  : "text-gray-400 hover:text-white"
              }`}>
              {t === "add" ? "Deposit" : t === "remove" ? "Withdraw" : "Claim"}
            </button>
          ))}
        </div>

        {/* Add tab */}
        {manageTab === "add" && (
          <div className="card space-y-3">
            <div className="rounded-xl bg-brand-dark border border-brand-border p-4">
              <div className="flex justify-between mb-2">
                <span className="text-xs font-semibold text-gray-400">{symA}</span>
                {balA !== null && (
                  <span className="text-xs text-gray-500">
                    Bal:{" "}
                    <button className="text-gray-300 hover:text-brand-green font-mono transition-colors"
                      onClick={() => applyPctA(100)}>
                      {balA.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    </button>
                  </span>
                )}
              </div>
              <input
                className="w-full bg-transparent text-right text-3xl font-black text-white placeholder-gray-700 focus:outline-none"
                type="text" inputMode="decimal" placeholder="0"
                value={addA} onChange={e => onChangeA(e.target.value)}
              />
              <div className="flex gap-2 mt-3">
                {PCT.map(p => (
                  <button key={p} onClick={() => applyPctA(p)} disabled={!spendA}
                    className="flex-1 text-xs py-1 rounded-md border border-brand-border text-gray-500
                               hover:border-brand-green hover:text-brand-green transition-colors
                               disabled:opacity-30 disabled:cursor-not-allowed">
                    {p === 100 ? "Max" : `${p}%`}
                  </button>
                ))}
              </div>
              {isWsolA && (
                <p className="text-xs text-gray-600 mt-2 text-right">
                  Max leaves {SOL_FEE_RESERVE} SOL for the fee and account rent
                </p>
              )}
            </div>

            <div className="flex justify-center text-gray-600 text-lg select-none">+</div>

            <div className={`rounded-xl border p-4 ${
              poolHasLiquidity ? "bg-brand-dark/50 border-brand-border/40" : "bg-brand-dark border-brand-border"
            }`}>
              <div className="flex justify-between mb-2">
                <span className="text-xs font-semibold text-gray-400">
                  {symB}
                  {poolHasLiquidity && <span className="ml-2 text-gray-600 font-normal">(auto)</span>}
                </span>
                {balB !== null && (
                  <span className="text-xs text-gray-500 font-mono">
                    Bal: {balB.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                  </span>
                )}
              </div>
              {poolHasLiquidity ? (
                <div className="text-right text-3xl font-black text-gray-500 font-mono py-0.5 select-none">
                  {addB || "0"}
                </div>
              ) : (
                <input
                  className="w-full bg-transparent text-right text-3xl font-black text-white placeholder-gray-700 focus:outline-none"
                  type="text" inputMode="decimal" placeholder="0"
                  value={addB} onChange={e => onChangeB(e.target.value)}
                />
              )}
              <p className="text-xs mt-2 text-right">
                {poolHasLiquidity
                  ? <span className="text-gray-600">1 {symA} = {(selected.reserveB / selected.reserveA).toFixed(6)} {symB}</span>
                  : <span className="text-yellow-500/70">First deposit — you set the initial price</span>
                }
              </p>
            </div>

            <button className="btn-primary w-full py-3 text-base font-bold"
              onClick={addLiquidity} disabled={loading || !addA || !addB || !wallet || overA || overB}>
              {loading ? "Processing…" : "Deposit"}
            </button>
            <ButtonHint text={depositHint} />
            <StatusBanner message={status} />
          </div>
        )}

        {/* Remove tab */}
        {manageTab === "remove" && (
          <div className="card space-y-3">
            <div className="rounded-xl bg-brand-dark border border-brand-border p-4">
              <div className="flex justify-between mb-2">
                <span className="text-xs font-semibold text-gray-400">LP tokens</span>
                {lpBal !== null && (
                  <span className="text-xs text-gray-500">
                    Bal:{" "}
                    <button className="text-gray-300 hover:text-brand-green font-mono transition-colors"
                      onClick={() => applyPctLp(100)}>
                      {lpBal.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    </button>
                  </span>
                )}
              </div>
              <input
                className="w-full bg-transparent text-right text-3xl font-black text-white placeholder-gray-700 focus:outline-none"
                type="text" inputMode="decimal" placeholder="0"
                value={lpAmt} onChange={e => onChangeLp(e.target.value)}
              />
              <div className="flex gap-2 mt-3">
                {PCT.map(p => (
                  <button key={p} onClick={() => applyPctLp(p)} disabled={!lpBal}
                    className="flex-1 text-xs py-1 rounded-md border border-brand-border text-gray-500
                               hover:border-brand-green hover:text-brand-green transition-colors
                               disabled:opacity-30 disabled:cursor-not-allowed">
                    {p === 100 ? "Max" : `${p}%`}
                  </button>
                ))}
              </div>
            </div>

            {retA !== null && retB !== null && (
              <div className="rounded-xl border border-brand-border p-4 space-y-3">
                <p className="text-xs text-gray-500 font-semibold uppercase tracking-wide">You will receive</p>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-black text-black"
                      style={{ background: tokenColor(symA) }}>
                      {symA.slice(0, 2)}
                    </span>
                    <span className="text-white font-semibold">{symA}</span>
                  </div>
                  <span className="font-mono text-brand-green font-bold">
                    {retA.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-black text-black"
                      style={{ background: tokenColor(symB) }}>
                      {symB.slice(0, 2)}
                    </span>
                    <span className="text-white font-semibold">{symB}</span>
                  </div>
                  <span className="font-mono text-brand-green font-bold">
                    {retB.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                  </span>
                </div>
              </div>
            )}

            <button className="btn-primary w-full py-3 text-base font-bold"
              onClick={removeLiquidity} disabled={loading || !lpAmt || !wallet}>
              {loading ? "Processing…" : "Withdraw"}
            </button>
            <StatusBanner message={status} />
          </div>
        )}

        {/* Claim tab */}
        {manageTab === "claim" && (
          <div className="card space-y-5">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-widest font-semibold mb-1">oSOLA Rewards</p>
              <p className="text-xs text-gray-600">
                Rewards accrue continuously from the moment you deposit liquidity.
                No epoch required — claim any time.
              </p>
            </div>

            {/* Live pending display */}
            <div className="rounded-xl bg-brand-dark border border-brand-border p-5 text-center">
              <p className="text-xs text-gray-500 mb-2">Claimable now</p>
              <p className={`text-4xl font-black ${pending > 0 ? "text-brand-green" : "text-gray-600"}`}>
                {pending.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}
              </p>
              <p className="text-sm text-gray-500 mt-1">oSOLA</p>
              {userLp > 0 && (
                <p className="text-xs text-gray-600 mt-3">
                  Emission: {(emissionCfg.ratePerSec / 1e6).toLocaleString(undefined, { maximumFractionDigits: 4 })} oSOLA/s shared across {selected.totalLp.toLocaleString(undefined, { maximumFractionDigits: 2 })} LP tokens
                </p>
              )}
            </div>

            {userLp === 0 && (
              <p className="text-xs text-center text-gray-500">
                Deposit liquidity first to start earning oSOLA rewards.
              </p>
            )}

            <button
              className="btn-primary w-full py-3 text-base font-bold"
              onClick={claimRewards}
              disabled={loading || !wallet || pending <= 0}
            >
              {loading ? "Claiming…" : pending > 0
                ? `Claim ${pending.toLocaleString(undefined, { maximumFractionDigits: 4 })} oSOLA`
                : "Nothing to claim yet"}
            </button>
            <StatusBanner message={status} />
          </div>
        )}
      </div>
    );
  }

  // ── Create pool view ──────────────────────────────────────────────────────

  if (view === "create") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <button onClick={backToList}
            className="w-8 h-8 rounded-full border border-brand-border text-gray-400 hover:text-white hover:border-brand-green transition-colors flex items-center justify-center text-lg leading-none">
            ←
          </button>
          <h2 className="text-lg font-black text-white">Create a pool</h2>
        </div>

        <div className="card space-y-5">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-widest mb-3 font-semibold">Token pair</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Token A</label>
                <select className="input w-full" value={newMintA}
                  onChange={e => setNewMintA(+e.target.value)}>
                  {tokens.map((t, i) => (
                    <option key={i} value={i} disabled={i === newMintB} className="bg-gray-900">{t.symbol}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Token B</label>
                <select className="input w-full" value={newMintB}
                  onChange={e => setNewMintB(+e.target.value)}>
                  {tokens.map((t, i) => (
                    <option key={i} value={i} disabled={i === newMintA} className="bg-gray-900">{t.symbol}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="h-px bg-brand-border" />

          <div>
            <p className="text-xs text-gray-500 uppercase tracking-widest mb-3 font-semibold">Fees</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Swap fee (bps)</label>
                <input className="input w-full" type="text" inputMode="decimal"
                  value={newFee} onChange={e => numInput(e.target.value, setNewFee)} />
                <span className="text-xs text-gray-600 mt-0.5 block">{(+newFee / 100).toFixed(2)}% per swap</span>
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Protocol share (bps)</label>
                <input className="input w-full" type="text" inputMode="decimal"
                  value={newProto} onChange={e => numInput(e.target.value, setNewProto)} />
                <span className="text-xs text-gray-600 mt-0.5 block">{(+newProto / 100).toFixed(0)}% of fees → stakers</span>
              </div>
            </div>
          </div>

          <button className="btn-primary w-full py-3 text-base font-bold"
            onClick={createPool} disabled={loading || !wallet || newMintA === newMintB}>
            {loading ? "Processing…" : "Create pool"}
          </button>
          <StatusBanner message={status} />
        </div>
      </div>
    );
  }

  // ── Pool list view ────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-white">Pools</h1>
          <p className="text-xs text-gray-500 mt-0.5">Provide liquidity and earn fees + oSOLA</p>
        </div>
        <button className="btn-secondary text-sm" onClick={() => { setView("create"); setStatus(""); }}>
          + Create pool
        </button>
      </div>

      {/* My Positions */}
      {wallet && myPools.length > 0 && (
        <section>
          {/* Header: title + Claim All */}
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest">My positions</p>
            {(() => {
              const totalPending = myPools.reduce((s, p) => s + (pendingOsola[p.address] ?? 0), 0);
              return (
                <div className="flex flex-col items-end gap-1">
                  <button
                    onClick={claimAll}
                    disabled={claimAllBusy || totalPending <= 0}
                    className="flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-lg
                               border border-brand-green/40 text-brand-green hover:bg-brand-green/10
                               transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {claimAllBusy ? (
                      "Claiming…"
                    ) : totalPending > 0 ? (
                      <>
                        <span>Claim All</span>
                        <span className="font-mono text-brand-green/80">
                          {totalPending.toLocaleString(undefined, { maximumFractionDigits: 4 })} oSOLA
                        </span>
                      </>
                    ) : (
                      "Claim All"
                    )}
                  </button>
                  {!claimAllBusy && totalPending <= 0 && (
                    <ButtonHint text="No pending rewards across your pools yet" />
                  )}
                </div>
              );
            })()}
          </div>
          {claimAllMsg && (
            <div className="mb-3"><StatusBanner message={claimAllMsg} /></div>
          )}
          <div className="rounded-2xl border border-brand-green/20 bg-brand-green/[0.03] divide-y divide-brand-green/10 overflow-hidden">
            {myPools.map(p => {
              const sA     = symbolByMint(p.mintA, usdcMint);
              const sB     = symbolByMint(p.mintB, usdcMint);
              const userLp = userLpBals[p.address] ?? 0;
              const share  = p.totalLp > 0 ? (userLp / p.totalLp) * 100 : 0;
              const estA        = p.totalLp > 0 ? (userLp * p.reserveA / p.totalLp) : 0;
              const estB        = p.totalLp > 0 ? (userLp * p.reserveB / p.totalLp) : 0;
              const lpValueUsdc = p.tvlUsdc !== null && p.totalLp > 0 ? (userLp / p.totalLp) * p.tvlUsdc : null;
              const earned      = pendingOsola[p.address] ?? 0;
              return (
                <div key={p.address} className="flex items-center gap-4 px-4 py-3.5 hover:bg-brand-green/[0.05] transition-colors">
                  <PairBadge symA={sA} symB={sB} />
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-white">{sA}/{sB}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {share.toFixed(3)}% pool share
                    </p>
                  </div>
                  <div className="text-right hidden sm:block">
                    <p className="text-xs text-gray-500 mb-0.5">Your position</p>
                    <p className="text-xs font-mono text-white">
                      {estA.toLocaleString(undefined, { maximumFractionDigits: 4 })} {sA}
                      {" "}<span className="text-gray-600">+</span>{" "}
                      {estB.toLocaleString(undefined, { maximumFractionDigits: 4 })} {sB}
                    </p>
                    {lpValueUsdc !== null && (
                      <p className="text-xs text-brand-green/70 font-mono mt-0.5">
                        ≈ ${lpValueUsdc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </p>
                    )}
                  </div>
                  {/* Earned oSOLA — live */}
                  <div className="text-right hidden md:block w-32">
                    <p className="text-xs text-gray-500 mb-0.5">Earned</p>
                    {earned > 0 ? (
                      <p className="text-sm font-bold text-brand-green font-mono">
                        {earned.toLocaleString(undefined, { maximumFractionDigits: 4 })} oSOLA
                      </p>
                    ) : (
                      <p className="text-xs text-gray-600">Accruing…</p>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button className="btn-primary text-xs px-3 py-1.5"
                      onClick={() => openManage(p, "claim")}>Claim</button>
                    <button className="btn-secondary text-xs px-3 py-1.5"
                      onClick={() => openManage(p, "add")}>Manage</button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* All Pools */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-widest">All pools</p>
          <button className="text-xs text-gray-600 hover:text-gray-300 transition-colors" onClick={fetchPools}>
            ↻ Refresh
          </button>
        </div>

        {poolsLoading ? (
          <div className="rounded-2xl border border-brand-border overflow-hidden p-4 space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : pools.length === 0 ? (
          <div className="card text-center py-12">
            <p className="text-4xl mb-3">💧</p>
            <p className="text-gray-400 text-sm mb-1">No AMM pool yet.</p>
            <p className="text-gray-600 text-xs mb-4">Be the first to create liquidity.</p>
            <button className="btn-primary text-sm"
              onClick={() => { setView("create"); setStatus(""); }}>
              Create the first pool
            </button>
          </div>
        ) : (
          <div className="rounded-2xl border border-brand-border overflow-hidden">
            {/* Table header */}
            <div className="hidden sm:grid grid-cols-[1fr_80px_90px_80px_auto] gap-4 px-5 py-2.5 bg-brand-dark/80 border-b border-brand-border text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <span>Pool</span>
              <span className="text-center">Type</span>
              <span className="text-right">TVL</span>
              <span className="text-right">Fee APR</span>
              <span />
            </div>

            {/* Rows */}
            <div className="divide-y divide-brand-border">
              {pools.map(p => {
                const sA = symbolByMint(p.mintA, usdcMint);
                const sB = symbolByMint(p.mintB, usdcMint);
                return (
                  <div key={p.address}
                    className="flex sm:grid sm:grid-cols-[1fr_80px_90px_80px_auto] gap-4 items-center px-5 py-4 hover:bg-brand-dark/50 transition-colors">

                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <PairBadge symA={sA} symB={sB} />
                      <div className="min-w-0">
                        <p className="font-bold text-white">{sA}/{sB}</p>
                        <p className="text-xs text-gray-500">{(p.feeRate / 100).toFixed(2)}% fee</p>
                      </div>
                    </div>

                    <div className="hidden sm:flex justify-center">
                      <span className="text-[10px] border border-brand-border/60 text-gray-500 rounded-full px-2.5 py-0.5 tracking-wide uppercase">
                        Basic
                      </span>
                    </div>

                    <div className="hidden sm:block text-right">
                      {p.tvlUsdc !== null ? (
                        <p className="font-bold text-brand-green">
                          ${p.tvlUsdc.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </p>
                      ) : (
                        <p className="text-gray-600">—</p>
                      )}
                    </div>

                    <div className="hidden sm:block text-right">
                      {(() => {
                        const apr = poolEmissionApr(p.tvlUsdc, osolaPrice, emissionCfg, Math.floor(Date.now() / 1000), p.rewardsEnabled);
                        return apr !== null ? (
                          <>
                            <p className="font-bold text-brand-green text-sm">{apr.toFixed(1)}%</p>
                            <p className="text-[10px] text-gray-600">oSOLA APR</p>
                          </>
                        ) : (
                          <p className="text-gray-600 text-sm">—</p>
                        );
                      })()}
                    </div>

                    <div className="shrink-0">
                      <button className="btn-primary text-xs px-4 py-2"
                        onClick={() => openManage(p, "add")}>
                        Manage
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
