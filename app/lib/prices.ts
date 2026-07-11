// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// Shared price helpers. The bonding curve has TWO prices that must not be
// conflated:
//   • curve price (virtual_usdc / virtual_sola) — the BUY/mint price; sells
//     never move the virtual reserves, so it only ratchets up and is NOT what a
//     holder can realise.
//   • realisable price — what a holder can actually get out: the SOLA/USDC AMM
//     market price if such a pool exists, otherwise the $1 floor (sell_sola
//     redeems 1:1 from the floor vault).
// Portfolio valuation uses the realisable price so it never overstates a balance
// a user could never cash out at the curve price.
import { BN } from "@coral-xyz/anchor";
import { toUi } from "./program";

export const FLOOR_PRICE = 1; // 1 USDC per SOLA, guaranteed by sell_sola

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
