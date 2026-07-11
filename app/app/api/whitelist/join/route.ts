// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!, // service key = écriture via join_whitelist (RLS bypass)
);

// Message format signed client-side: "Soladrome Whitelist — <wallet> — <ts>".
// <ts> is Date.now() (ms) — the replay window below rejects anything stale,
// no server-side nonce store needed (same stateless pattern as the rest of the app).
const MESSAGE_RE = /^Soladrome Whitelist — (.+) — (\d+)$/;
const MAX_AGE_MS = 5 * 60 * 1000;

function isPubkey(s: unknown): s is string {
  return typeof s === "string" && s.length >= 32 && s.length <= 44;
}

function verifySignature(wallet: string, message: string, signature: string): boolean {
  const match = MESSAGE_RE.exec(message);
  if (!match) return false;
  const [, signedWallet, tsStr] = match;
  if (signedWallet !== wallet) return false; // message must be bound to this wallet

  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_AGE_MS) return false;

  try {
    const messageBytes   = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);
    const pubkeyBytes     = new PublicKey(wallet).toBytes();
    return nacl.sign.detached.verify(messageBytes, signatureBytes, pubkeyBytes);
  } catch {
    return false;
  }
}

// Live data — never serve a cached response.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// POST { wallet, signature, message, email? } → verify the signed message
// proves ownership of `wallet`, then persist the signup (idempotent).
export async function POST(req: NextRequest) {
  try {
    const { wallet, signature, message, email } = await req.json();

    if (!isPubkey(wallet)) {
      return NextResponse.json({ error: "wallet required" }, { status: 400 });
    }
    if (typeof signature !== "string" || typeof message !== "string") {
      return NextResponse.json({ error: "signature required" }, { status: 400 });
    }
    if (!verifySignature(wallet, message, signature)) {
      return NextResponse.json({ error: "invalid or expired signature" }, { status: 401 });
    }
    // email is optional; when present it must be a plausible, bounded address —
    // the signature doesn't cover it, so reject unbounded/garbage writes.
    if (email !== undefined && email !== null) {
      if (typeof email !== "string" || email.length > 254 || (email.trim() !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()))) {
        return NextResponse.json({ error: "invalid email" }, { status: 400 });
      }
    }

    const { error } = await supabase.rpc("join_whitelist", {
      p_wallet:    wallet,
      p_email:     email || null,
      p_signature: signature,
      p_message:   message,
    });
    if (error) {
      console.error("[whitelist/join]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
