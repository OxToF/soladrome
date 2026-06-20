// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!, // service key = écriture sans RLS
);

function isPubkey(s: unknown): s is string {
  return typeof s === "string" && s.length >= 32 && s.length <= 44;
}

export async function POST(req: NextRequest) {
  try {
    const { wallet, ref } = await req.json();
    if (!wallet || typeof wallet !== "string") {
      return NextResponse.json({ error: "wallet required" }, { status: 400 });
    }

    // Upsert : crée la ligne ou met à jour last_seen + incrémente connection_count
    const { error } = await supabase.rpc("upsert_wallet", {
      p_wallet_address: wallet,
    });

    if (error) {
      console.error("[register-wallet]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Award the "connect" quest on first connection (idempotent server-side).
    const { error: questErr } = await supabase.rpc("record_quest", {
      p_wallet: wallet,
      p_quest:  "connect",
    });
    if (questErr) console.error("[register-wallet] connect quest", questErr);

    // First-touch referral attribution. Ignored on self-referral or if this
    // wallet already has a referrer (primary key + ignoreDuplicates).
    if (isPubkey(ref) && ref !== wallet) {
      const { error: refErr } = await supabase
        .from("referrals")
        .upsert(
          { referred_wallet: wallet, referrer_wallet: ref },
          { onConflict: "referred_wallet", ignoreDuplicates: true },
        );
      if (refErr) console.error("[register-wallet] referral", refErr);
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
