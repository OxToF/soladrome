// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// Meme contest submission + verification — TWO-part, X + Discord.
//
// A valid entry requires BOTH:
//   • an X post tagging @soladrome (the contest vehicle judged for the 5x 50
//     SOLA prize by views/engagement/aesthetics — captured here so the jury has
//     the link), verified via X's public keyless oEmbed, and
//   • the meme IMAGE shared in the #memes-art Discord channel with the wallet in
//     the message text (an X post can't be checked for a real drawing via
//     oEmbed, but a Discord message can be fetched with the bot token and
//     inspected for an image attachment; the wallet in the message binds the
//     entry to this wallet).
// Only when both check out do we log the entry in `meme_submissions` (keyed on
// the Discord message id, first wallet wins) and credit the one-shot +10
// `meme_contest` quest. The prize itself stays a manual, out-of-band payout.
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { PublicKey } from "@solana/web3.js";
import { SOLADROME_HANDLE } from "@/lib/xcode";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

// Kept in sync with DISCORD_GUILD_ID in app/api/discord/callback/route.ts and
// DISCORD_MEME_ART in app/lib/quests.ts (same guild + channel, link shapes vary).
const DISCORD_GUILD_ID    = "1506249630218715218";
const MEME_ART_CHANNEL_ID = "1521055571569152040";

// Live data — never serve a cached response.
export const dynamic = "force-dynamic";
export const revalidate = 0;

function bad(reason: string, status = 422) {
  return NextResponse.json({ ok: false, reason }, { status });
}

// fetch with a hard timeout — outbound calls to twitter.com / discord.com must
// not pin a serverless invocation open indefinitely.
function fetchT(url: string, init: RequestInit = {}, ms = 6000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

// Does the oEmbed html tag @soladrome? A mention renders either as the literal
// "@soladrome" text or as a link to the profile — accept both, case-insensitive.
function mentionsSoladrome(html: string): boolean {
  const h = html.toLowerCase();
  const handle = SOLADROME_HANDLE.toLowerCase();
  return h.includes(`@${handle}`)
    || new RegExp(`(?:x|twitter)\\.com/${handle}(?:[/"?]|$)`).test(h);
}

// Verify the X post exists and tags @soladrome. Returns null on success, or an
// NextResponse error to return to the caller.
async function verifyXPost(xUrl: string): Promise<NextResponse | null> {
  const m = xUrl.trim().match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i);
  if (!m) return bad("your X post link isn't valid");
  const tweetId = m[1];
  const res = await fetchT(
    `https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://twitter.com/i/status/${tweetId}`)}&omit_script=1&dnt=1`,
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 404) return bad("X post not found — is it public?");
  if (!res.ok) {
    console.error("[meme-verify] oembed", res.status, await res.text().catch(() => ""));
    return bad("couldn't fetch your X post — try again shortly", 502);
  }
  const { html } = await res.json();
  if (typeof html !== "string" || !html) return bad("couldn't read your X post");
  if (!mentionsSoladrome(html)) return bad(`your X post must tag @${SOLADROME_HANDLE}`);
  return null;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i;
// A real drawing is present if the message either uploads an image file OR
// auto-embeds a link (e.g. the X post) whose preview carries an image. Accepting
// the embed matters two ways: it's how testers naturally share (paste the X
// link, Discord renders the tweet), AND Discord only builds an image preview
// when the linked post actually HAS an image — so it doubles as proof the X post
// isn't a bare text link (the original "link with no drawing" loophole).
function hasImage(msg: any): boolean {
  const atts = Array.isArray(msg?.attachments) ? msg.attachments : [];
  if (atts.some((a: any) =>
    (typeof a?.content_type === "string" && a.content_type.startsWith("image/")) ||
    (typeof a?.filename === "string" && IMAGE_EXT.test(a.filename)),
  )) return true;
  const embeds = Array.isArray(msg?.embeds) ? msg.embeds : [];
  return embeds.some((e: any) =>
    (e?.image && typeof e.image.url === "string") ||
    (e?.thumbnail && typeof e.thumbnail.url === "string"),
  );
}

// Verify the Discord #memes-art message: image attachment + wallet in content.
// Returns the parsed message id on success, or a NextResponse error.
async function verifyDiscordPost(discordUrl: string, wallet: string): Promise<{ messageId: string } | NextResponse> {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return bad("discord not configured", 500);

  // Parse a Discord message link: .../channels/<guild>/<channel>/<message>
  // (accept the ptb/canary subdomains and the legacy discordapp.com host).
  const m = discordUrl.trim().match(
    /^https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/i,
  );
  if (!m) return bad("that's not a Discord message link — right-click your message → Copy Message Link");
  const [, guildId, channelId, messageId] = m;
  if (channelId !== MEME_ART_CHANNEL_ID) return bad("post it in the #memes-art channel, then copy THAT message's link");
  if (guildId !== DISCORD_GUILD_ID) return bad("that message isn't in the Soladrome server");

  // Fetch the message with the bot token (REST). Requires View Channel + Read
  // Message History on #memes-art AND the Message Content privileged intent
  // (Discord empties content/attachments for bots without it — even over REST).
  const res = await fetchT(
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
    { headers: { Authorization: `Bot ${botToken}` } },
  );
  if (res.status === 404) return bad("Discord message not found — is the link right and the message still up?");
  if (res.status === 403) {
    console.error("[meme-verify] 403 missing access to #memes-art");
    return bad("the bot can't read #memes-art yet — ping the team", 502);
  }
  if (!res.ok) {
    console.error("[meme-verify] discord", res.status, await res.text().catch(() => ""));
    return bad("couldn't fetch the Discord message — try again shortly", 502);
  }
  const msg = await res.json();

  if (msg?.channel_id && msg.channel_id !== MEME_ART_CHANNEL_ID) return bad("post it in the #memes-art channel");
  if (!hasImage(msg)) return bad("that #memes-art message has no image — put your meme (attached, or your X post link) in the SAME message as your wallet");

  const content = typeof msg?.content === "string" ? msg.content : "";
  if (content === "" && (Array.isArray(msg?.attachments) ? msg.attachments.length : 0) === 0) {
    // Truly empty read on a message that should have text/files → likely the bot
    // is missing the Message Content intent. (An image-only message legitimately
    // has empty content, so only flag this when there are no attachments either.)
    console.error("[meme-verify] empty message content — enable the Message Content intent?");
    return bad("couldn't read the message text — the bot may need the Message Content intent enabled", 502);
  }
  if (!content.includes(wallet)) return bad("put your wallet address in the SAME message as your meme image / X link");

  return { messageId };
}

// POST { wallet, xUrl, discordUrl } → verify BOTH, log the entry, credit +10.
export async function POST(req: NextRequest) {
  try {
    const { wallet, xUrl, discordUrl } = await req.json();
    if (!wallet || typeof wallet !== "string") return bad("wallet required", 400);
    try { new PublicKey(wallet); } catch { return bad("bad wallet", 400); }
    if (!xUrl || typeof xUrl !== "string") return bad("X post link required", 400);
    if (!discordUrl || typeof discordUrl !== "string") return bad("discord message link required", 400);

    // 1. X post must exist and tag @soladrome.
    const xErr = await verifyXPost(xUrl);
    if (xErr) return xErr;

    // 2. Discord #memes-art message must carry an image + this wallet.
    const dc = await verifyDiscordPost(discordUrl, wallet);
    if (dc instanceof NextResponse) return dc;

    // Log the entry (keyed on the Discord message id, first wallet wins) with
    // both links, then credit the one-shot quest.
    const { data: claimed, error: claimErr } = await supabase.rpc("claim_meme_submission", {
      p_tweet:  dc.messageId,
      p_wallet: wallet,
      p_url:    discordUrl.trim(),
      p_x_url:  xUrl.trim(),
    });
    if (claimErr) {
      console.error("[meme-verify] claim_meme_submission", claimErr);
      return bad("could not record the submission", 500);
    }
    if (!claimed) return bad("that Discord message was already submitted by another wallet");

    const { error } = await supabase.rpc("record_quest", { p_wallet: wallet, p_quest: "meme_contest" });
    if (error) {
      console.error("[meme-verify] record_quest", error);
      return bad("could not record the quest", 500);
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[meme-verify]", e);
    return bad("unexpected error", 500);
  }
}
