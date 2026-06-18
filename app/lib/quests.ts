// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
//
// Genesis Testnet Airdrop — mission catalog + campaign terms (client side).
// Point values here are for DISPLAY only — the authoritative values live in the
// `record_quest` Postgres function (supabase/quests.sql) and can't be forged
// from the browser.

export type QuestId =
  | "connect" | "faucet" | "swap" | "liquidity"
  | "stake" | "borrow" | "repay" | "vote" | "bug";

export interface Quest {
  id:     QuestId;
  label:  string;
  desc:   string;
  points: number;
  icon:   string;
  /** Where the "Go" button sends the user: an app page, optionally an inner tab. */
  page?:  string;
  tab?:   "swap" | "earn" | "lend";
  /** Awarded out-of-band (verified bug report) — not part of the core checklist. */
  bonus?: boolean;
}

// ── The 8 core missions (complete all → "Genesis Tester") ────────────────────
export const QUESTS: Quest[] = [
  { id: "connect",   label: "Connect your wallet",   desc: "Link a Solana wallet to the Soladrome devnet",        points: 5,  icon: "🔌" },
  { id: "faucet",    label: "Claim the faucet",      desc: "Get free devnet SOL + 500 test USDC on the swap card", points: 5,  icon: "🚰", page: "home", tab: "swap" },
  { id: "swap",      label: "Swap USDC → $SOLA",     desc: "Trade your test USDC for SOLA on the swap card",       points: 10, icon: "🔄", page: "home", tab: "swap" },
  { id: "liquidity", label: "Deposit liquidity",     desc: "Add liquidity to an AMM pool",                         points: 20, icon: "💧", page: "pools" },
  { id: "stake",     label: "Stake $SOLA → hiSOLA",  desc: "Lock SOLA to mint hiSOLA",                             points: 15, icon: "🔒", page: "home", tab: "earn" },
  { id: "borrow",    label: "Borrow USDC",           desc: "Borrow USDC against your hiSOLA position",             points: 15, icon: "🏦", page: "home", tab: "lend" },
  { id: "repay",     label: "Repay USDC",            desc: "Repay your USDC debt to free your collateral",         points: 10, icon: "💸", page: "home", tab: "lend" },
  { id: "vote",      label: "Vote this epoch",       desc: "Vote on a gauge for the current epoch",                points: 20, icon: "🗳️", page: "vote" },
];

// ── Bonus mission (manual award) ─────────────────────────────────────────────
export const BONUS_QUESTS: Quest[] = [
  { id: "bug", label: "Report a bug", desc: "Find an issue → post it in Discord #bugs", points: 50, icon: "🐛", bonus: true },
];

export const ALL_QUESTS  = [...QUESTS, ...BONUS_QUESTS];
export const TOTAL_POINTS = QUESTS.reduce((s, q) => s + q.points, 0); // 100 (core only)

// ── Campaign terms ───────────────────────────────────────────────────────────
// Edit these numbers to change what the Airdrop page advertises.
export const CAMPAIGN = {
  name:      "Genesis Testnet Airdrop",
  totalSola: 200_000,
  // How the pool is split. Percentages should sum to 100.
  pools: [
    {
      label: "Genesis Tester pool",
      pct:   90,
      desc:  "Split equally between every wallet that completes all 8 missions. Capital doesn't matter — completing the missions does.",
    },
    {
      label: "Bug bounty pool",
      pct:   10,
      desc:  "Verified bug reports, severity-weighted, allocated manually to the testers who make the protocol safer.",
    },
  ],
  claim:  "Winners are airdropped at launch, directly on-chain via a dedicated distribution instruction — no manual claim, no signup.",
  window: "Open now → snapshot at the end of the devnet phase, before mainnet.",
} as const;

/**
 * Fire-and-forget: record that a wallet completed a quest. Never throws, never
 * blocks the UX — a failed track must not break a successful on-chain action.
 */
export function trackQuest(wallet: string | undefined | null, quest: QuestId): void {
  if (!wallet) return;
  fetch("/api/track-quest", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ wallet, quest }),
  })
    .then(() => {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("quests:refresh"));
      }
    })
    .catch(() => {});
}
