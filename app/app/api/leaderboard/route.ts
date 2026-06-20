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

// The `leaderboard` view (supabase/quests.sql) already filters to wallets with
// at least one on-chain-verified quest (stake/borrow/vote), so bots that only
// spam connect/faucet never appear — no per-request RPC needed. PostgREST caps
// responses at its db-max-rows (1000) regardless of .limit, but the verified
// cohort is far smaller, so that's moot.
export async function GET() {
  try {
    const { data, error } = await supabase
      .from("leaderboard")
      .select("wallet_address, points, quests, last_active")
      .order("points", { ascending: false })
      .order("last_active", { ascending: true });

    if (error) {
      console.error("[leaderboard]", error);
      return NextResponse.json({ rows: [], total: 0, error: error.message }, { status: 500 });
    }
    const rows = data ?? [];
    return NextResponse.json({ rows, total: rows.length });
  } catch (e: any) {
    return NextResponse.json({ rows: [], total: 0, error: e?.message ?? String(e) }, { status: 500 });
  }
}
