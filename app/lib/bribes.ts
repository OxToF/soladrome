// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
import { Connection, PublicKey } from "@solana/web3.js";
import { getMintDecimals, solaM, oSolaM } from "./program";
import { symbolByMint, decimalsForMint } from "./tokens";

// ── One description of a bribe, shared by every screen that shows one ─────────
//
// ☢️ This file exists because three screens each kept their own copy of "which mints do I know"
// and "how many decimals does a bribe have", and every copy was wrong in the same two ways:
//
//   1. The symbol table was a hardcoded list of the mints derived from the program ID burned on
//      2026-08-08, so `oSOLA` rendered as `Cam9BN…` and every xStock as its raw address — the
//      Bribe screen was fixed on 2026-09-15 and Claim / Vote were not.
//   2. `total_bribed` was divided by 1e6, the PROTOCOL's decimals. A bribe's reward mint is
//      arbitrary (`bribes.rs`) and the devnet xStocks are 8, so a 301.31 TSLAx pot displayed as
//      30 131.0981 and the claim preview promised 100× what the chain pays.
//
// Symbols come from the shared registry and decimals from the mint account itself, so a screen
// can no longer disagree with the chain or with another screen.

export interface BribeToken {
  mint:     PublicKey;
  symbol:   string;
  color:    string;
  /** `BribeVault.total_bribed`, in the reward mint's OWN base units — never scaled to 1e6. */
  raw:      bigint;
  /** Read from the mint account; falls back to the registry only if the read failed. */
  decimals: number;
}

const SYMBOL_COLORS: Record<string, string> = {
  SOLA:  "#4ade80",
  oSOLA: "#bbf7d0",
  USDC:  "#2775ca",
  SOL:   "#9945ff",
};

/**
 * A stable dot colour for a bribe token.
 *
 * The protocol's own mints keep the palette the screens already used; anything else gets a hue
 * derived from its address, so two xStocks in the same list are told apart at a glance instead
 * of sharing one grey dot.
 */
export function colorForBribe(mint: string, symbol: string): string {
  const known = SYMBOL_COLORS[symbol];
  if (known) return known;
  if (mint === solaM.toBase58())  return SYMBOL_COLORS.SOLA;
  if (mint === oSolaM.toBase58()) return SYMBOL_COLORS.oSOLA;
  let hash = 0;
  for (let i = 0; i < mint.length; i++) hash = (hash * 31 + mint.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 65%, 62%)`;
}

/**
 * Turn raw `(reward_mint, total_bribed)` pairs into something a screen can render.
 *
 * One `getMultipleAccountsInfo` for every mint in the batch (memoised across calls), so adding a
 * bribe token to a pool costs no extra round trip.
 */
export async function describeBribes(
  connection: Connection,
  vaults: { mint: PublicKey; raw: bigint }[],
  usdcMint: PublicKey | null,
): Promise<BribeToken[]> {
  const decimals = await getMintDecimals(connection, vaults.map((v) => v.mint)).catch(
    () => new Map<string, number>(),
  );
  return vaults.map(({ mint, raw }) => {
    const key    = mint.toBase58();
    const symbol = symbolByMint(key, usdcMint);
    return {
      mint,
      symbol,
      color:    colorForBribe(key, symbol),
      raw,
      // The chain first, the registry only as a fallback for a mint that could not be read.
      decimals: decimals.get(key) ?? decimalsForMint(key, usdcMint),
    };
  });
}

/** Base units → a number, for display only. All arithmetic stays in `bigint`. */
export function uiRaw(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** Locale-grouped amount, scaled by the mint's own decimals. */
export function fmtRaw(raw: bigint, decimals: number, maxFrac = 4): string {
  return uiRaw(raw, decimals).toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

/**
 * What `claim_bribe` will actually pay, mirrored exactly:
 * `claimable = total_bribed × user_votes / total_votes`, a u128 muldiv that TRUNCATES.
 *
 * Kept in `bigint` for the same reason the program uses u128: the product overflows a float's
 * exact range long before it overflows the chain's, and a preview that rounds up reads as a
 * promise the program then breaks.
 */
export function expectedClaim(totalBribed: bigint, userVotes: bigint, totalVotes: bigint): bigint {
  if (totalVotes <= 0n) return 0n;
  return (totalBribed * userVotes) / totalVotes;
}
