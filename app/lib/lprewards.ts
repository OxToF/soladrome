// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// The continuous per-pool oSOLA stream, as the client sees it.
//
// This lived inside `Pools.tsx` until the recipe engine needed the same answer. Two copies of
// "what can I claim right now" is exactly the drift the fee accumulator was hoisted into
// `claims.ts` to avoid: a recipe that admits a pool the Pools screen shows as empty reverts
// with `NothingToClaim`, and it reverts for the WHOLE batch.
//
// ☢️ Do not confuse this with the gauge channel. There are two LP emission paths — this
// continuous stream (`claim_lp_rewards`, rate per second, authority-approved per pool) and the
// per-epoch gauge pot (`checkpoint_lp` → `emit_pool_rewards` → `claim_lp_emissions`). They pay
// from different places and neither implies the other.
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./program";

/// Must match the program constant of the same name.
export const LP_REWARD_PRECISION = BigInt("1000000000000"); // 1e12
/// Must match `EPOCH_DURATION` in the program.
export const EPOCH_DURATION = 604_800; // 7 days, seconds

/// The live continuous-emission window, read from `ProtocolState` — never a constant in a
/// component. The rate is dynamic and the window auto-sunsets, and every hardcoded copy of
/// either has gone stale silently at least once.
export interface EmissionCfg {
  /// Base units of oSOLA per second, per APPROVED pool.
  ratePerSec: number;
  /// The stream is live while `current_epoch < endEpoch`.
  endEpoch: number;
}

export const EMISSIONS_OFF: EmissionCfg = { ratePerSec: 0, endEpoch: 0 };

/// Read the window straight off a fetched `ProtocolState`.
export function emissionCfgOf(protocolState: any | null): EmissionCfg {
  if (!protocolState) return EMISSIONS_OFF;
  return {
    ratePerSec: Number(protocolState.continuousRatePerSec ?? 0),
    endEpoch: Number(protocolState.continuousEndEpoch ?? 0),
  };
}

export function continuousActive(nowSec: number, endEpoch: number): boolean {
  return Math.floor(Math.max(0, nowSec) / EPOCH_DURATION) < endEpoch;
}

/// The fields of an `AmmPool` this calculation needs, and nothing else — so a caller that has
/// only read the reward columns does not have to fabricate a whole `PoolInfo`.
export interface PoolRewardState {
  totalLp: number;
  osolaRewardPerLp: bigint;
  lastRewardTs: number;
  rewardsEnabled: boolean;
}

export function lpUserInfoPda(pool: PublicKey, user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp_user"), pool.toBuffer(), user.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/// The figure the program actually pays on — `reward_basis` in amm.rs, `min(lp_amount, wallet)`.
///
/// ☢️ NOT the wallet's LP balance. `LpUserInfo.lp_amount` is what the program itself recorded
/// through `add_liquidity`, and the payout needs BOTH a recorded deposit AND the tokens still
/// in hand: LP that arrived by transfer earns on neither side. Reading only the wallet balance
/// is how the Pools screen came to announce 1 000.73 LP of earnings to a devnet tester whose
/// recorded deposit was 0.73 — a figure ~1 376× what the chain would mint, and, for a wallet
/// whose recorded amount is 0, an "Earned" line whose claim reverts with `NothingToClaim`
/// (6007) and takes every other claim in the same transaction with it.
export function rewardBasis(recordedLpAmount: bigint, walletLpRaw: bigint): bigint {
  return recordedLpAmount < walletLpRaw ? recordedLpAmount : walletLpRaw;
}

/// Pending oSOLA for one wallet in one pool, in UI units.
///
/// Mirrors the program's `update_pool_rewards` (amm.rs) INCLUDING its gates: accrual happens
/// only when the pool is authority-approved, the continuous window is still open, a rate is set
/// and time has elapsed. ⚠️ `rewardsEnabled` is false by default and can only be set by the
/// authority, so a pool created permissionlessly farms nothing — skipping that gate shows an
/// "Earned" figure the chain refuses to mint, and the claim reverts with `NothingToClaim`
/// (6007).
///
/// `basisRaw` must come from `rewardBasis`, never from a wallet balance alone.
export function computePendingOsola(
  pool: PoolRewardState,
  userRewardDebt: bigint,
  basisRaw: bigint,
  nowSec: number,
  cfg: EmissionCfg,
): number {
  if (basisRaw === BigInt(0) || pool.totalLp <= 0) return 0;

  let acc = pool.osolaRewardPerLp;
  if (
    pool.lastRewardTs > 0 &&
    pool.rewardsEnabled &&
    cfg.ratePerSec > 0 &&
    continuousActive(nowSec, cfg.endEpoch)
  ) {
    const elapsed = BigInt(Math.max(0, nowSec - pool.lastRewardTs));
    const totalLpRaw = BigInt(Math.floor(pool.totalLp * 1e6));
    if (elapsed > BigInt(0) && totalLpRaw > BigInt(0)) {
      const newRewards = BigInt(cfg.ratePerSec) * elapsed;
      acc = acc + (newRewards * LP_REWARD_PRECISION) / totalLpRaw;
    }
  }

  if (acc <= userRewardDebt) return 0;
  const pendingRaw = ((acc - userRewardDebt) * basisRaw) / LP_REWARD_PRECISION;
  return Number(pendingRaw) / 1e6;
}
