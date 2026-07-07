// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

// Never cache the HTTP response: the leaderboard is live data.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// How many ranked rows we actually ship to the client. A leaderboard with
// 1000+ rows has no UX value and forces us to pump the whole view on every hit;
// we send the top N and report the *exact* total separately.
const TOP_N = 100;

// The `leaderboard` view (supabase/quests.sql) already filters to wallets with
// at least one on-chain-verified quest (stake/borrow/vote), so bots that only
// spam connect/faucet never appear. NOTE: PostgREST caps any response at its
// db-max-rows (1000) regardless of .limit — once the verified cohort grew past
// 1000 the old `total: rows.length` silently truncated *and* under-counted
// (it reported 1000 when there were more). We now (a) page to the top N and
// (b) read the real count from the `count=exact` header, which is NOT capped.

// Wallets flagged non-HUMAN_LIKE by scripts/sybil_scan.mjs (see
// supabase/wallet_verdicts.sql) are hidden from this public view — a display
// filter only, not a data deletion: quest_completions is untouched, and
// airdrop eligibility is decided separately at snapshot time. Wallets with no
// verdict yet (not scanned since they last completed a quest) default to
// shown — this is a display convenience, not the eligibility gate, so failing
// open here is the right default.
async function hiddenWallets(): Promise<Set<string>> {
  const hidden = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("wallet_verdicts")
      .select("wallet_address")
      .neq("verdict", "HUMAN_LIKE")
      .range(from, from + 999);
    if (error || !data) break; // most likely: migration not run yet — fail open, show everyone
    for (const r of data) hidden.add(r.wallet_address);
    if (data.length < 1000) break;
  }
  return hidden;
}

async function pullAllLeaderboardRows() {
  let all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("leaderboard")
      .select("wallet_address, points, quests, last_active")
      .order("points", { ascending: false })
      .order("last_active", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all = all.concat(data ?? []);
    if (!data || data.length < 1000) break;
  }
  return all;
}

export async function GET(req: Request) {
  try {
    const me = new URL(req.url).searchParams.get("me");

    const [hidden, allRows] = await Promise.all([hiddenWallets(), pullAllLeaderboardRows()]);
    const visible = allRows.filter((r) => !hidden.has(r.wallet_address));
    // Already ordered by points desc / last_active asc from the query above.
    const rows  = visible.slice(0, TOP_N);
    const total = visible.length;

    // If the caller's wallet is verified but ranks outside the top N (or is
    // itself hidden), it won't be in `rows` — resolve its row + rank among the
    // visible set so the UI can show "your position" instead of falsely
    // claiming "not verified yet". A hidden wallet simply gets no meInfo,
    // same as an unverified one.
    let meInfo: { row: any; rank: number } | null = null;
    if (me && !rows.some((r) => r.wallet_address === me) && !hidden.has(me)) {
      const idx = visible.findIndex((r) => r.wallet_address === me);
      if (idx >= 0) meInfo = { row: visible[idx], rank: idx + 1 };
    }

    return NextResponse.json({ rows, total, me: meInfo });
  } catch (e: any) {
    console.error("[leaderboard]", e);
    return NextResponse.json({ rows: [], total: 0, me: null, error: e?.message ?? String(e) }, { status: 500 });
  }
}
