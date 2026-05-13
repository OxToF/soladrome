// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant

export interface TokenInfo {
  symbol:   string;
  name:     string;
  mint:     string;  // resolved at runtime
  decimals: number;
  logo?:    string;
}

// wSOL mint is constant across all Solana clusters
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * All tokens available in the AMM selectors.
 * Add new entries here to expose them everywhere.
 */
export function getTokenList(): TokenInfo[] {
  return [
    {
      symbol:   "wSOL",
      name:     "Wrapped SOL",
      mint:     WSOL_MINT,
      decimals: 9,
    },
    {
      symbol:   "SOLA",
      name:     "Soladrome SOLA",
      mint:     process.env.NEXT_PUBLIC_SOLA_MINT ?? "",
      decimals: 6,
    },
    {
      symbol:   "USDC",
      name:     "USD Coin",
      mint:     process.env.NEXT_PUBLIC_USDC_MINT ?? "",
      decimals: 6,
    },
  ].filter((t) => t.mint !== ""); // drop tokens whose env var is unset
}

export function tokenByMint(mint: string): TokenInfo | undefined {
  return getTokenList().find((t) => t.mint === mint);
}

export function symbolByMint(mint: string): string {
  return tokenByMint(mint)?.symbol ?? mint.slice(0, 4) + "…";
}
