// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// X (Twitter) quest verification — shared client/server helpers.
//
// The verification trick: each (wallet, quest) pair gets a deterministic short
// code. The tester must include their code in a quote tweet of the quest's
// target post, then submit their tweet's URL. The server fetches the tweet via
// X's public oEmbed endpoint (free, no API key) and checks that (a) the text
// contains the wallet's code and (b) the tweet actually quotes the target.
// The code binds the tweet to exactly one wallet+quest, so a submitted URL can
// never credit anyone else's wallet or a different quest — which also means we
// need no submissions table for dedupe.

/** Quests verified through the X quote-tweet flow → the status id they must quote. */
export const X_VERIFIED: Record<string, { target: string; targetUrl: string }> = {
  repost:        { target: "2067971567770804567", targetUrl: "https://x.com/soladrome/status/2067971567770804567" },
  repost_video:  { target: "2069730059821175111", targetUrl: "https://x.com/soladrome/status/2069730059821175111" },
  repost_video2: { target: "2074079950903128238", targetUrl: "https://x.com/soladrome/status/2074079950903128238" },
};

/**
 * Deterministic per-(wallet, quest) code, e.g. "SOLA-4F2A9C". FNV-1a (not
 * cryptographic) is enough here: the server recomputes the expected code from
 * the claimed wallet, so a forged code can only ever credit the forger's own
 * wallet — collision strength buys nothing. Sync + dependency-free matters
 * more (must produce identical output in the browser and the API route).
 */
export function questCode(wallet: string, quest: string): string {
  let h = 0xcbf29ce484222325n;
  const s = `${wallet}|${quest}`;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return "SOLA-" + h.toString(16).padStart(16, "0").slice(0, 6).toUpperCase();
}

/** Prefilled X compose link: quest text + code, quoting the target post. */
export function questIntentUrl(wallet: string, quest: string): string {
  const conf = X_VERIFIED[quest];
  const code = questCode(wallet, quest);
  const text = `Testing @soladrome on Solana devnet — bonding curve, floor price, no liquidation.\n\nGenesis code: ${code}`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(conf.targetUrl)}`;
}
