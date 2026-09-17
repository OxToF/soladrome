// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { getProgram, statePda, marketVault, positionPda, userAta, PROGRAM_ID } from "@/lib/program";
import { currentEpoch } from "@/lib/epoch";

const PRECISION = BigInt("1000000000000"); // 1e12

// Exported so callers that already hold some of the inputs (e.g. Portfolio.tsx,
// which already fetches userPosition + the hiSOLA balance for other rows) can
// compute claimable fees with only the *missing* RPC calls instead of
// re-fetching everything computeClaimableFees() below fetches from scratch.
export function jsAdvanceAccumulator(acc: bigint, mktBal: bigint, lastBal: bigint, totalHi: bigint): bigint {
  if (mktBal <= lastBal || totalHi === 0n) return acc;
  return acc + (mktBal - lastBal) * PRECISION / totalHi;
}

export function jsPendingFees(acc: bigint, debt: bigint, hiBal: bigint): bigint {
  const delta = acc > debt ? acc - debt : 0n;
  return delta * hiBal / PRECISION;
}

// Live claimable USDC fees for a wallet. Batches 4 concurrent RPC calls via
// Promise.allSettled (protocolState, userPosition, 2x token balance) — the
// same accumulator math ClaimFees.tsx uses, hoisted here so ClaimFees.tsx and
// Portfolio.tsx never drift apart on what "claimable" means.
export async function computeClaimableFees(
  connection: Connection,
  wallet: AnchorWallet,
  usdcMint: PublicKey | null,
): Promise<number> {
  if (!wallet || !usdcMint) return 0;
  try {
    const provider = new AnchorProvider(connection, wallet, {});
    const program  = getProgram(provider);
    const [stateRes, posRes, mktRes] = await Promise.allSettled([
      (program.account as any).protocolState.fetch(statePda),
      (program.account as any).userPosition.fetch(positionPda(wallet.publicKey)),
      connection.getTokenAccountBalance(marketVault),
    ]);

    if (stateRes.status !== "fulfilled" || posRes.status !== "fulfilled") return 0;
    const s      = stateRes.value as any;
    const pos    = posRes.value as any;
    const mktBal = mktRes.status === "fulfilled" ? BigInt(mktRes.value.value.amount) : 0n;
    // Mirror `math::fee_basis`: the financed part of the position, never the raw balance.
    // hiSOLA is no longer a token, so there is no ATA to read here either.
    const hiSola = BigInt(pos.hiSola.toString());
    const staked = BigInt(pos.stakedAmount.toString());
    const hiBal  = hiSola < staked ? hiSola : staked;

    const acc = jsAdvanceAccumulator(
      BigInt(s.feesPerHiSola.toString()),
      mktBal,
      BigInt(s.lastMarketVaultBalance.toString()),
      BigInt(s.totalHiSola.toString()),
    );
    const raw = jsPendingFees(acc, BigInt(pos.feesDebt.toString()), hiBal);
    return Number(raw) / 1e6;
  } catch {
    return 0;
  }
}

// ── Bribe-claimable summary ──────────────────────────────────────────────
//
// ☢️ There is no list of reward mints here any more, and there must never be one again.
// `deposit_bribe` takes an arbitrary mint, so any fixed list answers a question the chain
// alone can answer — and the list that stood here named the three mints derived from the
// program ID burned on 2026-08-08, so it probed vaults that cannot exist under `DgD37Vjs…`
// and the Portfolio reported "0 claimable" over a wallet holding claimable xStock bribes.
// The vaults are discovered instead, exactly as ClaimBribe.tsx discovers them.

function epochBuf(epoch: number) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(epoch >>> 0, 0);
  b.writeUInt32LE(Math.floor(epoch / 2 ** 32), 4);
  return b;
}
function claimPda(user: PublicKey, pool: PublicKey, mint: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bribe_claim"), user.toBuffer(), pool.toBuffer(), mint.toBuffer(), epochBuf(epoch)], PROGRAM_ID)[0];
}

export interface ClaimableBribesSummary {
  claimableCount: number; // distinct (pool, token, epoch) bribes ready to claim
  poolCount:      number; // distinct pools with at least one claimable bribe
}

// Aggregates "how many bribes can I claim right now" across every past-epoch
// vote the wallet has, without requiring the user to pick a pool first (unlike
// ClaimBribe.tsx, which only scans bribe vaults once a vote entry is selected).
// It must stay wallet-gated and off the balance timer: it is the one genuinely
// new RPC surface in the Portfolio redesign.
//
// No `usdcMint` any more — it only existed to extend a guessed mint list, and the
// vaults are read from the chain now.
export async function computeClaimableBribesSummary(
  connection: Connection,
  wallet: AnchorWallet,
): Promise<ClaimableBribesSummary> {
  if (!wallet) return { claimableCount: 0, poolCount: 0 };
  try {
    const provider = new AnchorProvider(connection, wallet, {});
    const program  = getProgram(provider);
    const epoch = currentEpoch();

    const receipts = await (program.account as any).userVoteReceipt.all([{
      memcmp: { offset: 8, bytes: wallet.publicKey.toBase58() },
    }]);
    const entries: { pool: PublicKey; epoch: number }[] = receipts
      .map((r: any) => ({ pool: r.account.poolId as PublicKey, epoch: Number(r.account.epoch) }))
      .filter((e: { pool: PublicKey; epoch: number }) => e.epoch < epoch);
    if (entries.length === 0) return { claimableCount: 0, poolCount: 0 };

    // One getProgramAccounts per DISTINCT pool the wallet voted on (memcmp on `pool_id`), not
    // one per (pool × epoch × guessed mint). A voter has a handful of pools, and this runs only
    // on connect and on "soladrome:refresh" — never on the 8 s balance timer.
    const pools = [...new Map(entries.map((e) => [e.pool.toBase58(), e.pool])).values()];
    const vaultsByPool = await Promise.all(
      pools.map((pool) =>
        (program.account as any).bribeVault
          .all([{ memcmp: { offset: 8, bytes: pool.toBase58() } }])
          .catch(() => [] as any[])
      )
    );

    // (pool, epoch) the wallet actually holds a receipt for — a bribe on a pool it did not vote
    // on that epoch pays nothing, so it must not be counted.
    const voted = new Set(entries.map((e) => `${e.pool.toBase58()}:${e.epoch}`));
    const probes = vaultsByPool.flat()
      .filter((v: any) =>
        voted.has(`${v.account.poolId.toBase58()}:${Number(v.account.epoch)}`) &&
        BigInt(v.account.totalBribed.toString()) > 0n
      )
      .map((v: any) => ({
        pool:     v.account.poolId as PublicKey,
        claimPda: claimPda(
          wallet.publicKey,
          v.account.poolId as PublicKey,
          v.account.rewardMint as PublicKey,
          Number(v.account.epoch),
        ),
      }));
    if (probes.length === 0) return { claimableCount: 0, poolCount: 0 };

    const infos: (Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>>[number])[] = [];
    for (let i = 0; i < probes.length; i += 100) {
      const chunk = probes.slice(i, i + 100);
      infos.push(...(await connection.getMultipleAccountsInfo(chunk.map((p) => p.claimPda))));
    }

    let claimableCount = 0;
    const poolsWithClaimable = new Set<string>();
    probes.forEach((p, i) => {
      if (infos[i]) return; // UserBribeClaim exists → already claimed
      claimableCount++;
      poolsWithClaimable.add(p.pool.toBase58());
    });

    return { claimableCount, poolCount: poolsWithClaimable.size };
  } catch {
    return { claimableCount: 0, poolCount: 0 };
  }
}
