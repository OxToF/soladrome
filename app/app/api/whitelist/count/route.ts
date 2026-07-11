// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

// Never cache — this feeds the public "whitelisted users" counter.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET → { count } — number of wallets that are both signed up AND have at
// least one on-chain-verified quest (whitelist_eligible view, supabase/whitelist.sql).
export async function GET() {
  try {
    const { count, error } = await supabase
      .from("whitelist_eligible")
      .select("wallet_address", { count: "exact", head: true });

    if (error) {
      console.error("[whitelist/count]", error);
      return NextResponse.json({ count: 0 }, { status: 500 });
    }
    return NextResponse.json({ count: count ?? 0 });
  } catch (e: any) {
    return NextResponse.json({ count: 0, error: e?.message ?? String(e) }, { status: 500 });
  }
}
