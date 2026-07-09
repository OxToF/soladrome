// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// X (Twitter) quest verification — replaces the honor-system click-to-claim
// for the quote/repost quests. The tester quote-tweets the quest's target post
// with their per-(wallet, quest) code (see app/lib/xcode.ts), then submits
// their tweet URL here. We fetch the tweet through X's public oEmbed endpoint
// (free, keyless — the paid X API stays out of the loop) and only credit when:
//   1. the tweet text contains THIS wallet's code for THIS quest, and
//   2. the tweet actually quotes the quest's target post.
// The code makes cross-wallet and cross-quest reuse structurally impossible,
// so no submissions table is needed; record_quest is idempotent per wallet.
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { PublicKey } from "@solana/web3.js";
import { questCode, X_VERIFIED } from "@/lib/xcode";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

// Genesis II quests stay gated behind the TrueMRR vote, mirroring
// GENESIS2_GATE in app/api/track-quest/route.ts (this route credits
// repost_video2 directly, so the gate has to be enforced here too).
const GENESIS2_X_QUESTS = new Set(["repost_video2"]);

// Live data — never serve a cached response.
export const dynamic = "force-dynamic";
export const revalidate = 0;

function bad(reason: string, status = 422) {
  return NextResponse.json({ ok: false, reason }, { status });
}

// oEmbed HTML shortens links to t.co, so the quoted target usually isn't
// visible verbatim. Resolve each t.co link (one manual-redirect hop) and check
// whether any lands on the target status.
async function quotesTarget(html: string, target: string): Promise<boolean> {
  if (html.includes(`/status/${target}`)) return true; // sometimes unshortened
  const tcoLinks = [...new Set(html.match(/https:\/\/t\.co\/[A-Za-z0-9]+/g) ?? [])].slice(0, 4);
  for (const link of tcoLinks) {
    try {
      const res = await fetch(link, { method: "HEAD", redirect: "manual" });
      const loc = res.headers.get("location") ?? "";
      // Accept path suffixes (/video/1, /photo/1) and query params — media
      // links inside a quote resolve with those, and any link to the target
      // post still proves the tweet points at the right mission.
      if (new RegExp(`^https://(www\\.)?(x|twitter)\\.com/[^/]+/status/${target}([/?]|$)`).test(loc)) return true;
    } catch { /* try the next link */ }
  }
  return false;
}

// POST { wallet, quest, url } → verify the quote tweet and credit the quest.
export async function POST(req: NextRequest) {
  try {
    const { wallet, quest, url } = await req.json();
    if (!wallet || typeof wallet !== "string") return bad("wallet required", 400);
    try { new PublicKey(wallet); } catch { return bad("bad wallet", 400); }
    const conf = X_VERIFIED[quest];
    if (!conf) return bad("unknown quest", 400);
    if (!url || typeof url !== "string") return bad("tweet url required", 400);

    // Extract the status id; accept x.com / twitter.com in any casing.
    const m = url.trim().match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i);
    if (!m) return bad("not a tweet url");
    const tweetId = m[1];
    // Submitting the target post itself (or another quest's target) is not a quote.
    if (Object.values(X_VERIFIED).some((c) => c.target === tweetId)) return bad("that's our post — submit YOUR quote of it");

    if (GENESIS2_X_QUESTS.has(quest)) {
      const { data } = await supabase
        .from("quest_completions").select("quest_id")
        .eq("wallet_address", wallet).eq("quest_id", "truemrr").limit(1);
      if (!data || data.length === 0) {
        return NextResponse.json({ ok: false, reason: "gate required", missing: ["truemrr"] }, { status: 403 });
      }
    }

    // Public oEmbed lookup — 404s for deleted/private tweets. The /i/status/
    // form resolves regardless of the author handle in the submitted URL.
    const oembedRes = await fetch(
      `https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://twitter.com/i/status/${tweetId}`)}&omit_script=1&dnt=1`,
      { headers: { Accept: "application/json" } },
    );
    if (oembedRes.status === 404) return bad("tweet not found — is it public?");
    if (!oembedRes.ok) {
      console.error("[x-verify] oembed", oembedRes.status, await oembedRes.text().catch(() => ""));
      return bad("could not fetch the tweet — try again shortly", 502);
    }
    const { html } = await oembedRes.json();
    if (typeof html !== "string" || !html) return bad("could not read the tweet");

    const code = questCode(wallet, quest);
    if (!html.toUpperCase().includes(code.toUpperCase())) {
      return bad(`your code ${code} is not in that post`);
    }
    if (!(await quotesTarget(html, conf.target))) {
      return bad("that post doesn't quote the mission's target post");
    }

    const { error } = await supabase.rpc("record_quest", { p_wallet: wallet, p_quest: quest });
    if (error) {
      console.error("[x-verify] record_quest", error);
      return bad("could not record the quest", 500);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[x-verify]", e);
    return bad("unexpected error", 500);
  }
}
