// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

// Never cache: the leaderboard is live data. Without this, the App Router caches
// the first (empty) response and serves it forever.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET → top 100 testnet contributors, ranked by points.
export async function GET() {
  try {
    const { data, error } = await supabase
      .from("leaderboard")
      .select("wallet_address, points, quests, last_active")
      .limit(100);

    if (error) {
      console.error("[leaderboard]", error);
      return NextResponse.json({ rows: [], error: error.message }, { status: 500 });
    }
    return NextResponse.json({ rows: data ?? [] });
  } catch (e: any) {
    return NextResponse.json({ rows: [], error: e?.message ?? String(e) }, { status: 500 });
  }
}
