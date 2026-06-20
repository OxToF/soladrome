// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, solaM, oSolaM } from "./program";

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
    {
      symbol:   "oSOLA",
      name:     "Option SOLA",
      mint:     oSolaM.toString(),
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

// ── Pool whitelist filter ─────────────────────────────────────────────────────
//
// Soladrome's AMM is permissionless — anyone can create a pool with any mint.
// To protect users from spam / unknown tokens, we only display pools where
// AT LEAST ONE token is in the trusted registry below.
//
// Add new protocol tokens here as partnerships are established (JitoSOL, JTO…).
// The list is checked at display time only — it does NOT affect on-chain state.

const TRUSTED_MINTS = new Set([
  // ── Soladrome protocol tokens ──
  solaM.toString(),
  oSolaM.toString(),
  // hiSOLA mint (PDA-derived, kept as constant address)
  "nc1errcnXjKN4aZYL7AP89op26EMn5a2VcDT82wrTwW",
  // ── Infrastructure ──
  WSOL_MINT,                                              // wSOL
  // ── Partners / blue-chip ──
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",       // JitoSOL
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",        // JTO
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",        // JUP
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",        // ORCA
  "MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTa3CbChoKBRP",        // MNDE (Marinade)
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",        // mSOL
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",        // bSOL (Blaze)
]);

/**
 * Returns true if the pool should be shown in the UI.
 * A pool passes if at least one of its token mints is trusted.
 * USDC is added dynamically from on-chain state.
 */
export function isPoolTrusted(
  mintA: string,
  mintB: string,
  usdcMint: PublicKey | null,
): boolean {
  const mints = new Set(TRUSTED_MINTS);
  if (usdcMint) mints.add(usdcMint.toString());
  return mints.has(mintA) || mints.has(mintB);
}
