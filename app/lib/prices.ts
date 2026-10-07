// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// Shared price helpers.
//
// Since 2026-10-07 the curve price is realisable: `sell_sola` sells back down the curve, so a
// holder gets the curve's price less the 1 % fee, never less than the $1 floor. Before that it
// paid the floor and nothing else, and this file valued every balance at $1 for that reason.
// Portfolio uses the AMM price when a SOLA/USDC pool exists, the curve sell price otherwise
// (`curve.ts::marginalSellPrice`).
import { BN } from "@coral-xyz/anchor";
import { toUi } from "./program";

export const FLOOR_PRICE = 1; // 1 USDC per SOLA: the least sell_sola ever pays

/**
 * Spot price of `mint` quoted in USDC from a direct `mint`/USDC AMM pool.
 * Returns null when no such pool exists or it has empty reserves.
 */
export function ammPriceVsUsdc(
  ammPools: any[],
  mint: string,
  usdcMint: string,
): number | null {
  const p = ammPools.find((p: any) => {
    const a = p.account.tokenAMint.toString();
    const b = p.account.tokenBMint.toString();
    return (a === mint && b === usdcMint) || (a === usdcMint && b === mint);
  });
  if (!p) return null;
  const a  = p.account.tokenAMint.toString();
  const ra = toUi(p.account.reserveA as BN);
  const rb = toUi(p.account.reserveB as BN);
  if (ra === 0 || rb === 0) return null;
  return a === mint ? rb / ra : ra / rb;
}
