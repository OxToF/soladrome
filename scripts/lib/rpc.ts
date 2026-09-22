// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// Server-side RPC resolution for the scripts in this directory.
//
// ☢️ `NEXT_PUBLIC_RPC_URL` IS PUBLIC BY CONSTRUCTION, NOT BY ACCIDENT. Next.js inlines every
// `NEXT_PUBLIC_*` into the client bundle at compile time, so whatever key it carries is served
// to every visitor. Verified on 2026-09-22 by fetching two chunks of www.soladrome.finance and
// reading the key out of them: no authentication, no privileged access, two `curl` calls.
//
// Nothing in this directory runs in a browser, so nothing here has any reason to use that key.
// `RPC_URL` is the server key — never named `NEXT_PUBLIC_*`, never inlined, never shipped.
//
// ⚠️ THE FALLBACK IS THE MIGRATION. Until `RPC_URL` exists, everything keeps working on the
// single key it uses today, so this change breaks nothing on the day it lands. Creating the
// second key and setting `RPC_URL` is then a config change, not a code change — and the browser
// key can be restricted to the domain without taking the keeper and the authority scripts down
// with it, which is exactly the failure a half-converted codebase would have produced.
import * as fs from "fs";
import * as path from "path";

/// Read one key out of `app/.env.local`. Returns undefined when the file or the key is missing.
///
/// This used to be copy-pasted verbatim into eight scripts. It lives here now so that the
/// resolution ORDER below has exactly one definition — the whole point of the exercise being
/// that a single script still reaching for the browser key defeats restricting it.
export function envValue(key: string): string | undefined {
  try {
    const line = fs
      .readFileSync(path.join(__dirname, "..", "..", "app", ".env.local"), "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${key}=`));
    return line?.slice(key.length + 1).trim();
  } catch {
    return undefined;
  }
}

/// The endpoint a server-side script should use, in order of preference:
///
///   1. `RPC_URL` in the process environment — a one-off override for a single run;
///   2. `RPC_URL` in `app/.env.local` — the server key, once one exists;
///   3. `NEXT_PUBLIC_RPC_URL` in `app/.env.local` — the browser key, today's single key;
///   4. the public devnet endpoint, which is always reachable and always slow.
///
/// ⚠️ A malformed value is skipped rather than handed to `new Connection`, which throws only at
/// the first call — far from the line that set it. The shape that cost three days of a dead
/// faucet in August was `ttps://…helius-rpc.com/?api-key=3a3…`: a leading `h` lost and the key
/// truncated by a real U+2026, both from copy-pasting a dashboard's own elided display.
export function serverRpcUrl(): string {
  const candidates = [process.env.RPC_URL, envValue("RPC_URL"), envValue("NEXT_PUBLIC_RPC_URL")];
  for (const raw of candidates) {
    const url = raw?.trim();
    if (!url || url.includes("…")) continue;
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    return url;
  }
  return "https://api.devnet.solana.com";
}

/// Everything after the api key, for printing. A script that announces its endpoint must not
/// print the credential in it — these run in terminals that get pasted into issues and chats.
export function redactRpc(url: string): string {
  return url.replace(/(api-key=)[^&]*/i, "$1<redacted>");
}
