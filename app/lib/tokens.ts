// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, solaM } from "./program";

export interface TokenInfo {
  symbol:   string;
  name:     string;
  mint:     string;
  decimals: number;
}

// wSOL mint is constant across all Solana clusters
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Build the token list at runtime.
 * - wSOL: hardcoded (same on all clusters)
 * - SOLA: derived from its PDA — no env var needed
 * - USDC: read from on-chain protocol state via SoladromeContext
 *
 * @param usdcMint - PublicKey from useSoladrome().usdcMint (null while loading)
 */
export function getTokenList(usdcMint: PublicKey | null): TokenInfo[] {
  const list: TokenInfo[] = [
    {
      symbol:   "SOL",
      name:     "Solana",
      mint:     WSOL_MINT,
      decimals: 9,
    },
    {
      symbol:   "SOLA",
      name:     "Soladrome SOLA",
      mint:     solaM.toString(),
      decimals: 6,
    },
  ];

  if (usdcMint) {
    list.push({
      symbol:   "USDC",
      name:     "USD Coin",
      mint:     usdcMint.toString(),
      decimals: 6,
    });
  }

  return list;
}

export function symbolByMint(mint: string, usdcMint: PublicKey | null): string {
  return getTokenList(usdcMint).find((t) => t.mint === mint)?.symbol
    ?? mint.slice(0, 4) + "…";
}

export function decimalsForMint(mint: string, usdcMint: PublicKey | null): number {
  return getTokenList(usdcMint).find((t) => t.mint === mint)?.decimals ?? 6;
}
