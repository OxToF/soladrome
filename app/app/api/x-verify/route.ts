// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// X (Twitter) quest verification — replaces the honor-system click-to-claim
// for the quote/repost quests. The tester quote-tweets the quest's target post
// with their per-(wallet, quest) code (see app/lib/xcode.ts), then submits
// their tweet URL here. We fetch the tweet through X's public oEmbed endpoint
// (free, keyless — the paid X API stays out of the loop) and only credit when:
//   1. the tweet text contains THIS wallet's code for THIS quest, and
//   2. the tweet actually quotes the quest's target post, and
//   3. the tweet hasn't already been consumed by another wallet.
// The per-(wallet, quest) code binds a tweet's INTENDED beneficiary, but one
// post can physically carry many codes, so we also consume each tweet_id once
// (claim_x_tweet in supabase/quests.sql) — first wallet to claim it wins.
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

// fetch with a hard timeout — these are unauthenticated outbound calls to
// twitter.com / t.co, so a slow/hanging peer must not pin a serverless
// invocation open indefinitely.
function fetchT(url: string, init: RequestInit = {}, ms = 5000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

// Does the tweet actually QUOTE the target post (not merely mention its id as
// typed text)? oEmbed shortens the quoted permalink to a t.co link, so the
// reliable signal is a t.co link that RESOLVES to the target status. We do NOT
// treat a bare `/status/<target>` substring as proof: a user can type that
// string as plain text without quoting anything. (Residual limitation: a real
// quote and a "comment + pasted link" tweet both shorten to t.co and are
// indistinguishable via keyless oEmbed — closing that gap needs the paid X API.)
async function quotesTarget(html: string, target: string): Promise<boolean> {
  // Only accept `/status/<target>` when it appears inside an href="" X emits —
  // i.e. a real rendered link, not text the author typed.
  const hrefRe = new RegExp(`href="https://(www\\.)?(x|twitter)\\.com/[^/"]+/status/${target}([/?"]|$)`);
  if (hrefRe.test(html)) return true;
  const tcoLinks = [...new Set(html.match(/https:\/\/t\.co\/[A-Za-z0-9]+/g) ?? [])].slice(0, 4);
  // Resolve the t.co links concurrently; the first that lands on the target wins.
  const checks = tcoLinks.map(async (link) => {
    const res = await fetchT(link, { method: "HEAD", redirect: "manual" }, 4000);
    const loc = res.headers.get("location") ?? "";
    // Accept path suffixes (/video/1, /photo/1) and query params.
    return new RegExp(`^https://(www\\.)?(x|twitter)\\.com/[^/]+/status/${target}([/?]|$)`).test(loc);
  });
  const results = await Promise.allSettled(checks);
  return results.some((r) => r.status === "fulfilled" && r.value);
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
    const oembedRes = await fetchT(
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

    // Consume the tweet: bind it to THIS wallet (first claimant wins). A single
    // post carrying several wallets' codes can therefore credit only one wallet,
    // so per-wallet friction (one genuine quote each) is enforced.
    const { data: claimed, error: claimErr } = await supabase.rpc("claim_x_tweet", {
      p_tweet: tweetId, p_wallet: wallet, p_quest: quest,
    });
    if (claimErr) {
      console.error("[x-verify] claim_x_tweet", claimErr);
      return bad("could not record the quest", 500);
    }
    if (!claimed) return bad("that post was already used to verify another wallet");

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
