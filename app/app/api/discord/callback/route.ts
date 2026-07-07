// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// Step 2 of Discord quest verification. Exchanges the OAuth code for the
// caller's Discord identity, checks real membership in the Soladrome guild
// via the bot token (a user-scoped OAuth token alone can't do this — guild
// member lookups require the bot's Authorization: Bot header), then credits
// the "discord" quest directly via the same record_quest RPC the public
// track-quest endpoint uses. This route is the only place "discord" can be
// credited from now on — see the removed entry in VALID_QUESTS
// (app/api/track-quest/route.ts).
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { PublicKey } from "@solana/web3.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

// Soladrome Discord server — kept in sync with DISCORD_URL in app/app/page.tsx
// and DISCORD_INVITE in app/lib/quests.ts (same guild, different link shapes).
const DISCORD_GUILD_ID = "1506249630218715218";

function fail(req: NextRequest, reason: string) {
  return NextResponse.redirect(new URL(`/?discord_error=${encodeURIComponent(reason)}`, req.url));
}

export async function GET(req: NextRequest) {
  const code   = req.nextUrl.searchParams.get("code");
  const wallet = req.nextUrl.searchParams.get("state");
  if (!code || !wallet) return fail(req, "missing_params");

  try { new PublicKey(wallet); } catch { return fail(req, "bad_wallet"); }

  const clientId     = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const botToken      = process.env.DISCORD_BOT_TOKEN;
  if (!clientId || !clientSecret || !botToken) return fail(req, "not_configured");

  const redirectUri = new URL("/api/discord/callback", req.url).toString();

  try {
    // 1. Exchange the authorization code for a user access token.
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    "authorization_code",
        code,
        redirect_uri:  redirectUri,
      }),
    });
    if (!tokenRes.ok) return fail(req, "token_exchange_failed");
    const { access_token } = await tokenRes.json();

    // 2. Identify the Discord user behind that token.
    const meRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!meRes.ok) return fail(req, "identify_failed");
    const me = await meRes.json();

    // 3. Real membership check — only the bot token can query guild members.
    const memberRes = await fetch(
      `https://discord.com/api/guilds/${DISCORD_GUILD_ID}/members/${me.id}`,
      { headers: { Authorization: `Bot ${botToken}` } },
    );
    if (memberRes.status !== 200) return fail(req, "not_a_member");

    // 4. Credit the quest. record_quest is idempotent (unique wallet+quest),
    // so re-verifying an already-credited wallet is harmless.
    const { error } = await supabase.rpc("record_quest", { p_wallet: wallet, p_quest: "discord" });
    if (error) {
      console.error("[discord/callback] record_quest", error);
      return fail(req, "record_failed");
    }

    return NextResponse.redirect(new URL("/?discord_verified=1", req.url));
  } catch (e) {
    console.error("[discord/callback]", e);
    return fail(req, "unexpected_error");
  }
}
