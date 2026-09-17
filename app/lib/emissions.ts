// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs

/**
 * JS mirror of `math::decayed_emission` — the oSOLA pot for ONE epoch of the gauge channel.
 *
 * ☢️ Read the schedule from `ProtocolState`, never from a constant in a component. The figure
 * has moved twice (800 000 → 20 000 per epoch on 2026-08-09, then ÷10 on devnet on 2026-08-19)
 * and every hardcoded copy went stale silently — `LpEmissions.tsx` still announced "10 000
 * oSOLA/epoch" to anyone about to checkpoint, against a chain emitting a tenth of that.
 *
 * Exact integer arithmetic in `bigint`, including the same fixed-point exponentiation by
 * squaring, so the preview cannot drift from what `emit_pool_rewards` allocates.
 */
const PREC = 1_000_000_000_000n; // 1e12, as in math.rs

export function decayedEmission(
  initial: bigint,
  decayBps: number,
  elapsedEpochs: number,
  floorBps: number,
): bigint {
  if (elapsedEpochs <= 0 || decayBps >= 10_000) return initial;

  const base = BigInt(decayBps) * (PREC / 10_000n);
  let result = PREC; // 1.0
  let b = base;
  let n = BigInt(elapsedEpochs);
  while (n > 0n) {
    if (n & 1n) result = (result * b) / PREC;
    b = (b * b) / PREC;
    n >>= 1n;
  }

  const decayed = (initial * result) / PREC;
  const floor   = (initial * BigInt(floorBps)) / 10_000n;
  return decayed > floor ? decayed : floor;
}

/** The current epoch's pot, in whole oSOLA, straight from a fetched `ProtocolState`. */
export function epochEmissionUi(protocolState: any | null, epoch: number): number | null {
  if (!protocolState) return null;
  try {
    const initial = BigInt(protocolState.osolaEmissionInitial.toString());
    const elapsed = epoch - Number(protocolState.osolaEmissionStartEpoch.toString());
    const pot = decayedEmission(
      initial,
      Number(protocolState.osolaEmissionDecayBps),
      elapsed,
      Number(protocolState.osolaEmissionFloorBps),
    );
    return Number(pot) / 1e6;
  } catch {
    return null;
  }
}
