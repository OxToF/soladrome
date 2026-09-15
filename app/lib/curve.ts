// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// Client-side mirror of the bonding-curve math in `programs/soladrome/src/math.rs`.
//
// ☢️ THIS FILE MUST TRACK `math.rs::sola_out` EXACTLY. It is a *quote*, so a divergence does
// not corrupt state — but it puts a number in front of the user that the chain will not
// honour, which is worse than showing nothing. Two rules keep them equal:
//
//   1. **BigInt only, never `number`.** The program works in u128 and `k = 1e24`, which is
//      ~1e8 times past `Number.MAX_SAFE_INTEGER`. Floating point loses the low digits of
//      `k / new_vu` silently, and the error lands precisely in the base units the user is
//      buying.
//   2. **Integer division, same order of operations.** `new_vs = k / new_vu` truncates
//      on-chain. Reproducing the algebra in a different order (or in floats) rounds the other
//      way and quotes a base unit the program will not mint.

/** Raw u128/u64 reserves, exactly as `ProtocolState` stores them. */
export interface CurveReserves {
  virtualUsdc: bigint;
  virtualSola: bigint;
  k:           bigint;
}

/**
 * SOLA minted for `usdcIn`, in base units.
 *
 * Mirrors `math.rs::sola_out`:
 *   new_vu = vU + usdc_in
 *   new_vs = k / new_vu        (integer division, truncating)
 *   out    = vS - new_vs
 *
 * Returns `null` where the program would error rather than guessing a number: a
 * non-positive input (`InvalidAmount`) or reserves that would underflow (`Overflow`).
 */
export function solaOut(r: CurveReserves, usdcIn: bigint): bigint | null {
  if (usdcIn <= 0n) return null;
  const newVu = r.virtualUsdc + usdcIn;
  if (newVu <= 0n) return null;
  const newVs = r.k / newVu;
  if (newVs > r.virtualSola) return null;
  const out = r.virtualSola - newVs;
  return out > 0n ? out : null;
}

/**
 * USDC returned for `solaIn`, in base units.
 *
 * `sell_sola` is not a curve trade: it redeems against the floor at 1:1 and never touches the
 * virtual reserves (`usdc_out = sola_amount`, both mints at 6 decimals). The identity is the
 * whole point of the floor, so it is spelled out here rather than left implicit at the call
 * site — and it is why a sell quote can never move with demand.
 *
 * The caller must still check the floor vault covers it: `sell_sola` requires
 * `floor_vault.amount >= usdc_out` and fails `InsufficientFloorReserve` otherwise.
 */
export function usdcOut(solaIn: bigint): bigint {
  return solaIn;
}

/**
 * Marginal spot price in USDC per SOLA, as a float, for display only.
 *
 * This is `vU / vS`, the price of an infinitesimal buy. A real buy pays strictly more,
 * because the trade moves the curve as it executes — so never derive an expected output from
 * it. Use `solaOut` for anything the user will act on.
 */
export function spotPrice(r: CurveReserves): number {
  if (r.virtualSola === 0n) return 1;
  return Number(r.virtualUsdc) / Number(r.virtualSola);
}

/**
 * Average price actually paid across a buy, in USDC per SOLA.
 *
 * `usdcIn / solaOut`. This is the number a buyer can check against the quote, and it is
 * always ≥ `spotPrice`.
 */
export function effectivePrice(usdcIn: bigint, solaOut: bigint): number {
  if (solaOut === 0n) return 0;
  return Number(usdcIn) / Number(solaOut);
}

/**
 * How far the effective price sits above the floor, as a percentage.
 *
 * Reported instead of "price impact against spot" because the floor — 1 USDC, guaranteed by
 * `sell_sola` — is the number that bounds the buyer's downside. A buy at 1.04 means 4% of the
 * outlay is above what the floor will redeem, which is the premium at risk.
 */
export function premiumOverFloorPct(usdcIn: bigint, solaOut: bigint): number {
  if (solaOut === 0n) return 0;
  // The floor pays 1 USDC per SOLA, both at 6 decimals, so `solaOut` base units *are* the
  // USDC the floor would return for them.
  return (Number(usdcIn - solaOut) / Number(solaOut)) * 100;
}
