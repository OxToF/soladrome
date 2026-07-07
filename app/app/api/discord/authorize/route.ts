// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// Step 1 of Discord quest verification: redirect the wallet's owner into
// Discord's OAuth consent screen. The wallet address rides along as `state`
// (Discord echoes it back verbatim on the callback) so /api/discord/callback
// knows which wallet to credit once membership is confirmed — this replaces
// the old honor-system "click Join, then click Claim" flow that let anyone
// self-credit the quest without ever joining the server.
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  if (!wallet) return NextResponse.redirect(new URL("/", req.url));

  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) {
    return NextResponse.redirect(new URL("/?discord_error=not_configured", req.url));
  }

  const redirectUri = new URL("/api/discord/callback", req.url).toString();
  const authorizeUrl = new URL("https://discord.com/api/oauth2/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "identify");
  authorizeUrl.searchParams.set("state", wallet);

  return NextResponse.redirect(authorizeUrl.toString());
}
