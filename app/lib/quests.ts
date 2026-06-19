// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
//
// Genesis Testnet Airdrop — mission catalog + campaign terms (client side).
// Point values here are for DISPLAY only — the authoritative values live in the
// `record_quest` Postgres function (supabase/quests.sql) and can't be forged
// from the browser.

// Server-backed quest ids — these must match the `record_quest` Postgres function
// (supabase/quests.sql). Only these can be tracked/awarded. New campaigns that
// aren't wired server-side yet use plain string ids and live on a "coming soon"
// group (live: false), so they display but can't be completed.
export type QuestId =
  | "connect" | "faucet" | "swap" | "liquidity"
  | "stake" | "borrow" | "repay" | "vote" | "bug";

export interface Quest {
  /** Server-backed ids (QuestId) are trackable; any string is allowed for teasers. */
  id:     QuestId | string;
  label:  string;
  desc:   string;
  points: number;
  icon:   string;
  /** Where the "Go" button sends the user: an app page, optionally an inner tab. */
  page?:  string;
  tab?:   "swap" | "earn" | "lend";
  /** Awarded out-of-band (e.g. verified bug report) — shown under "Bonus". */
  bonus?: boolean;
  /** Off-app action (Discord, X…) — shows a label instead of a "Go" button. */
  external?: string;
}

// ── A quest GROUP = one campaign page in the Missions card ───────────────────
// Add a new object to QUEST_GROUPS to ship a new campaign. Set `live: false`
// until its quest ids are wired into supabase/quests.sql + the track-quest route.
export interface QuestGroup {
  id:    string;
  title: string;
  blurb: string;
  /** Badge label shown when every non-bonus quest in the group is complete. */
  badge?: string;
  quests: Quest[];
  bonus?: Quest[];
  /** false → "Coming soon": rows are shown but disabled (no Go, no tracking). */
  live:  boolean;
}

// ── Campaign #1 — Genesis missions (complete all → "Genesis Tester") ─────────
const GENESIS: QuestGroup = {
  id:    "genesis",
  title: "Genesis Missions",
  blurb: "Complete all 8 missions to become a Genesis Tester and qualify for the airdrop. Each mission counts once — no farming.",
  badge: "Genesis Tester",
  live:  true,
  quests: [
    { id: "connect",   label: "Connect your wallet",   desc: "Link a Solana wallet to the Soladrome devnet",        points: 5,  icon: "🔌" },
    { id: "faucet",    label: "Claim the faucet",      desc: "Get free devnet SOL + 500 test USDC on the swap card", points: 5,  icon: "🚰", page: "home", tab: "swap" },
    { id: "swap",      label: "Swap USDC → $SOLA",     desc: "Trade your test USDC for SOLA on the swap card",       points: 10, icon: "🔄", page: "home", tab: "swap" },
    { id: "liquidity", label: "Deposit liquidity",     desc: "Add liquidity to an AMM pool",                         points: 20, icon: "💧", page: "pools" },
    { id: "stake",     label: "Stake $SOLA → hiSOLA",  desc: "Lock SOLA to mint hiSOLA",                             points: 15, icon: "🔒", page: "home", tab: "earn" },
    { id: "borrow",    label: "Borrow USDC",           desc: "Borrow USDC against your hiSOLA position",             points: 15, icon: "🏦", page: "home", tab: "lend" },
    { id: "repay",     label: "Repay USDC",            desc: "Repay your USDC debt to free your collateral",         points: 10, icon: "💸", page: "home", tab: "lend" },
    { id: "vote",      label: "Vote this epoch",       desc: "Vote on a gauge for the current epoch",                points: 20, icon: "🗳️", page: "vote" },
  ],
  bonus: [
    { id: "bug", label: "Report a bug", desc: "Find an issue → post it in Discord #bugs", points: 50, icon: "🐛", bonus: true, external: "Discord" },
  ],
};

// ── Campaign #2 — Social (TEASER, not yet live) ──────────────────────────────
// To activate: add these ids + point values to record_quest (supabase/quests.sql)
// and VALID_QUESTS (app/api/track-quest/route.ts), then flip `live` to true.
const SOCIAL: QuestGroup = {
  id:    "social",
  title: "Social Campaign",
  blurb: "Spread the word and earn more $SOLA. These missions go live soon — get ready.",
  badge: "Amplifier",
  live:  false,
  quests: [
    { id: "follow_x",  label: "Follow @Soladrome on X", desc: "Follow the official account",                 points: 5,  icon: "🐦", external: "X" },
    { id: "repost",    label: "Repost the launch thread", desc: "Repost our genesis announcement",            points: 10, icon: "🔁", external: "X" },
    { id: "referral",  label: "Refer a tester",         desc: "Bring a friend who completes the Genesis set", points: 25, icon: "🤝", external: "Link" },
  ],
};

export const QUEST_GROUPS: QuestGroup[] = [GENESIS, SOCIAL];

/** Sum of a group's core (non-bonus) quest points. */
export function groupPoints(g: QuestGroup): number {
  return g.quests.reduce((s, q) => s + q.points, 0);
}

// ── Backward-compatible exports (genesis = the original 8 + bonus) ───────────
export const QUESTS: Quest[]       = GENESIS.quests;
export const BONUS_QUESTS: Quest[] = GENESIS.bonus ?? [];
export const ALL_QUESTS            = [...QUESTS, ...BONUS_QUESTS];
export const TOTAL_POINTS          = groupPoints(GENESIS); // 100 (core only)

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
