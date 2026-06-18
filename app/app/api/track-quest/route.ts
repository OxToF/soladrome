// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!, // service key = écriture via record_quest (RLS bypass)
);

const VALID_QUESTS = new Set([
  "connect", "faucet", "swap", "liquidity", "stake", "borrow", "repay", "vote", "bug",
]);

// Live data — never serve a cached response.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// POST { wallet, quest } → idempotent quest completion (points decided server-side).
export async function POST(req: NextRequest) {
  try {
    const { wallet, quest } = await req.json();
    if (!wallet || typeof wallet !== "string") {
      return NextResponse.json({ error: "wallet required" }, { status: 400 });
    }
    if (!quest || !VALID_QUESTS.has(quest)) {
      return NextResponse.json({ error: "unknown quest" }, { status: 400 });
    }

    const { error } = await supabase.rpc("record_quest", {
      p_wallet: wallet,
      p_quest:  quest,
    });
    if (error) {
      console.error("[track-quest]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

// GET ?wallet=… → list of quest ids this wallet has already completed.
export async function GET(req: NextRequest) {
  try {
    const wallet = req.nextUrl.searchParams.get("wallet");
    if (!wallet) return NextResponse.json({ completed: [] });

    const { data, error } = await supabase
      .from("quest_completions")
      .select("quest_id")
      .eq("wallet_address", wallet);

    if (error) {
      console.error("[track-quest GET]", error);
      return NextResponse.json({ completed: [] });
    }
    return NextResponse.json({ completed: (data ?? []).map((r) => r.quest_id) });
  } catch {
    return NextResponse.json({ completed: [] });
  }
}
