// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

// Never cache — signup/whitelist state changes as soon as a quest lands.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET ?wallet=… → { signedUp, whitelisted, email, completed[] }
// `completed` mirrors /api/track-quest's shape so the frontend can reuse the
// same quest-catalog logic to render the tasks checklist without a second fetch shape.
export async function GET(req: NextRequest) {
  try {
    const wallet = req.nextUrl.searchParams.get("wallet");
    if (!wallet) {
      return NextResponse.json({ signedUp: false, whitelisted: false, email: null, completed: [] });
    }

    const [{ data: signup }, { data: eligible }, { data: completions }] = await Promise.all([
      supabase.from("whitelist_signups").select("email").eq("wallet_address", wallet).maybeSingle(),
      supabase.from("whitelist_eligible").select("wallet_address").eq("wallet_address", wallet).maybeSingle(),
      supabase.from("quest_completions").select("quest_id").eq("wallet_address", wallet),
    ]);

    return NextResponse.json({
      signedUp:    !!signup,
      whitelisted: !!eligible,
      email:       signup?.email ?? null,
      completed:   (completions ?? []).map((r) => r.quest_id),
    });
  } catch (e: any) {
    return NextResponse.json(
      { signedUp: false, whitelisted: false, email: null, completed: [], error: e?.message ?? String(e) },
      { status: 500 },
    );
  }
}
