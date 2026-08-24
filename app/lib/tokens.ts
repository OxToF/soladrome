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

  list.push(...LAUNCH_TOKENS);
  return list;
}

// Mainnet launch pool tokens — classic SPL only (the AMM's `Account<Mint>` /
// `Program<Token>` reject Token-2022, so USDG/CASH/PYUSD and the xStocks are
// intentionally NOT here: they cannot be pooled without an AMM upgrade).
// Decimals verified against mainnet 2026-07-24 (getMultipleAccounts). The
// points snapshot job reads decimals on-chain and does not rely on these, but
// the Pools/Points UI does — so keep them correct.
export const LAUNCH_TOKENS: TokenInfo[] = [
  // LSTs (9 decimals)
  { symbol: "jitoSOL", name: "Jito Staked SOL",     mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", decimals: 9 },
  { symbol: "mSOL",    name: "Marinade Staked SOL",  mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", decimals: 9 },
  { symbol: "jupSOL",  name: "Jupiter Staked SOL",   mint: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", decimals: 9 },
  { symbol: "bSOL",    name: "BlazeStake Staked SOL", mint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", decimals: 9 },
  { symbol: "hubSOL",  name: "Hub Staked SOL",       mint: "HUBsveNpjo5pWqNkH57QzxjQASdTVXcSK7bVKTSZtcSX", decimals: 9 },
  // Stables (6 decimals)
  { symbol: "USDS",      name: "Sky USDS",       mint: "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", decimals: 6 },
  { symbol: "USDT",      name: "Tether USD",     mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
  { symbol: "syrupUSDC", name: "Maple syrupUSDC", mint: "AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj", decimals: 6 },
  // BTC / ETH (8 decimals)
  { symbol: "cbBTC",  name: "Coinbase Wrapped BTC", mint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", decimals: 8 },
  { symbol: "ETH",    name: "Ether (Portal)",       mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", decimals: 8 },
  { symbol: "wstETH", name: "Wrapped stETH",        mint: "ZScHuTtqZukUrtZS43teTKGs2VqkKL8k4QCouR2n6Uo", decimals: 8 },
  // Tether Gold (6 decimals)
  { symbol: "xAUt", name: "Tether Gold", mint: "AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P", decimals: 6 },
];

export function symbolByMint(mint: string, usdcMint: PublicKey | null): string {
  return getTokenList(usdcMint).find((t) => t.mint === mint)?.symbol
    ?? mint.slice(0, 4) + "…";
}

// Scales for mints that are trusted for *display* (see TRUSTED_MINTS) but are
// not in the picker, so `getTokenList` never carries their decimals. Without
// this, `decimalsForMint` falls back to 6 and a 9-decimal partner token renders
// at 1000x its real size the day a pool opens for it — silent, and only visible
// as a number that looks plausible. Verified by `scripts/check_token_registry.ts`,
// which fails any trusted-only entry whose chain decimals are neither 6 nor
// listed here.
export const TRUSTED_DECIMALS: Record<string, number> = {
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL": 9,  // JTO
  "MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey": 9,  // MNDE
};

export function decimalsForMint(mint: string, usdcMint: PublicKey | null): number {
  return getTokenList(usdcMint).find((t) => t.mint === mint)?.decimals
    ?? TRUSTED_DECIMALS[mint]
    ?? 6;
}

// ── Pool whitelist filter ─────────────────────────────────────────────────────
//
// Soladrome's AMM is permissionless — anyone can create a pool with any mint.
// To protect users from spam / unknown tokens, we only display pools where
// AT LEAST ONE token is in the trusted registry below.
//
// Add new protocol tokens here as partnerships are established (JitoSOL, JTO…).
// The list is checked at display time only — it does NOT affect on-chain state.

export const TRUSTED_MINTS = new Set([
  // ── Soladrome protocol tokens ──
  solaM.toString(),
  oSolaM.toString(),
  // hiSOLA is deliberately absent: it is a position (`UserPosition.hi_sola`),
  // not a mint, so no pool can ever hold it. The entry that stood here was
  // `nc1errcn…`, hardcoded rather than derived — and hardcoding is what let it
  // rot past the 2026-08-08 program-ID rotation, since `hi_sola_mint` under
  // `DgD37Vjs` derives to `3uP7Jo1n…`. Caught by `scripts/check_token_registry.ts`.
  // ⚠️ The same stale address still stands in `claims.ts`, `Vote.tsx`,
  // `ClaimBribe.tsx` and `Gauge.tsx`, where it is offered as a *bribe* reward
  // mint — a bribe deposited there lands in the old program's orphaned mint.
  // ── Infrastructure ──
  WSOL_MINT,                                              // wSOL
  // ── Partners / blue-chip ──
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",       // JitoSOL
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",        // JTO
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",        // JUP
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",        // ORCA
  "MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey",        // MNDE (Marinade) — 9 dec, verified on-chain
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",        // mSOL
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",        // bSOL (Blaze)
  // ── Mainnet launch pool tokens (classic SPL — Token-2022 excluded, see LAUNCH_TOKENS) ──
  ...LAUNCH_TOKENS.map((t) => t.mint),
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
