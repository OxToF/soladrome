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

// GET → full ranked leaderboard (ordered server-side; paginated on the client).
// Capped at MAX_ROWS as a safety bound; on devnet scale (hundreds of wallets)
// this is a few KB. If it ever grows past a few thousand, switch to
// server-side range pagination + a rank RPC.
const MAX_ROWS = 2000;

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("leaderboard")
      .select("wallet_address, points, quests, last_active")
      .order("points", { ascending: false })
      .order("last_active", { ascending: true })
      .limit(MAX_ROWS);

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
