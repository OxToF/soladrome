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
export async function GET(req: Request) {
  try {
    const me = new URL(req.url).searchParams.get("me");

    const { data, error, count } = await supabase
      .from("leaderboard")
      .select("wallet_address, points, quests, last_active", { count: "exact" })
      .order("points", { ascending: false })
      .order("last_active", { ascending: true })
      .range(0, TOP_N - 1);

    if (error) {
      console.error("[leaderboard]", error);
      return NextResponse.json({ rows: [], total: 0, me: null, error: error.message }, { status: 500 });
    }

    const rows = data ?? [];
    const total = count ?? rows.length;

    // If the caller's wallet is verified but ranks outside the top N, it won't
    // be in `rows` — resolve its row + approximate rank so the UI can still
    // show "your position" instead of falsely claiming "not verified yet".
    let meInfo: { row: any; rank: number } | null = null;
    if (me && !rows.some((r) => r.wallet_address === me)) {
      const { data: mine } = await supabase
        .from("leaderboard")
        .select("wallet_address, points, quests, last_active")
        .eq("wallet_address", me)
        .maybeSingle();
      if (mine) {
        // rank = (# wallets strictly ahead on points) + 1. Ties are reported at
        // the same rank; good enough for a "you're #N" badge.
        const { count: ahead } = await supabase
          .from("leaderboard")
          .select("wallet_address", { count: "exact", head: true })
          .gt("points", mine.points);
        meInfo = { row: mine, rank: (ahead ?? 0) + 1 };
      }
    }

    return NextResponse.json({ rows, total, me: meInfo });
  } catch (e: any) {
    return NextResponse.json({ rows: [], total: 0, me: null, error: e?.message ?? String(e) }, { status: 500 });
  }
}
