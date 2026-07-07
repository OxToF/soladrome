// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { getProgram, statePda, hiSolaM, marketVault, positionPda, userAta, PROGRAM_ID } from "@/lib/program";
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
    const [stateRes, posRes, mktRes, hiRes] = await Promise.allSettled([
      (program.account as any).protocolState.fetch(statePda),
      (program.account as any).userPosition.fetch(positionPda(wallet.publicKey)),
      connection.getTokenAccountBalance(marketVault),
      connection.getTokenAccountBalance(userAta(hiSolaM, wallet.publicKey)),
    ]);

    if (stateRes.status !== "fulfilled" || posRes.status !== "fulfilled") return 0;
    const s      = stateRes.value as any;
    const pos    = posRes.value as any;
    const mktBal = mktRes.status === "fulfilled" ? BigInt(mktRes.value.value.amount) : 0n;
    const hiBal  = hiRes.status  === "fulfilled" ? BigInt(hiRes.value.value.amount)  : 0n;

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
// Same well-known reward mints ClaimBribe.tsx / Gauge.tsx already hardcode.
const KNOWN_BRIBE_MINTS = [
  new PublicKey("2rAqBLBi2Fjdjqf5za7uzpbYgNiVV74XMDKQ5RdMuEJT"), // oSOLA
  new PublicKey("HENFwJCzmBAo2Qybrszr28tqLtEFYkXwN6h87AD5gS9p"),  // SOLA
  new PublicKey("nc1errcnXjKN4aZYL7AP89op26EMn5a2VcDT82wrTwW"),   // hiSOLA
];

function epochBuf(epoch: number) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(epoch >>> 0, 0);
  b.writeUInt32LE(Math.floor(epoch / 2 ** 32), 4);
  return b;
}
function bribeVaultPda(pool: PublicKey, mint: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bribe_vault"), pool.toBuffer(), mint.toBuffer(), epochBuf(epoch)], PROGRAM_ID)[0];
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
// Generalizes ClaimBribe.tsx's own chunked getMultipleAccountsInfo probe
// (loadVoteReceipts, ClaimBribe.tsx:88-148) to also check vault existence, not
// just claim-status — this is the one genuinely new RPC surface in the
// Portfolio redesign, so it must stay wallet-gated and chunked at 100/call.
export async function computeClaimableBribesSummary(
  connection: Connection,
  wallet: AnchorWallet,
  usdcMint: PublicKey | null,
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

    const tokens = usdcMint ? [...KNOWN_BRIBE_MINTS, usdcMint] : KNOWN_BRIBE_MINTS;
    const probes = entries.flatMap((e) =>
      tokens.map((mint) => ({
        pool: e.pool,
        vaultPda: bribeVaultPda(e.pool, mint, e.epoch),
        claimPda: claimPda(wallet.publicKey, e.pool, mint, e.epoch),
      }))
    );

    const allKeys = probes.flatMap((p) => [p.vaultPda, p.claimPda]);
    const infos: (Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>>[number])[] = [];
    for (let i = 0; i < allKeys.length; i += 100) {
      const chunk = allKeys.slice(i, i + 100);
      const res = await connection.getMultipleAccountsInfo(chunk);
      infos.push(...res);
    }

    let claimableCount = 0;
    const poolsWithClaimable = new Set<string>();
    probes.forEach((p, i) => {
      const vaultInfo = infos[i * 2];
      const claimInfo = infos[i * 2 + 1];
      if (!vaultInfo || claimInfo) return; // no bribe deposited, or already claimed
      // total_bribed field — same offset Gauge.tsx already reads (offset 80).
      const totalBribed = vaultInfo.data.length >= 88 ? vaultInfo.data.readBigUInt64LE(80) : 0n;
      if (totalBribed > 0n) {
        claimableCount++;
        poolsWithClaimable.add(p.pool.toBase58());
      }
    });

    return { claimableCount, poolCount: poolsWithClaimable.size };
  } catch {
    return { claimableCount: 0, poolCount: 0 };
  }
}
