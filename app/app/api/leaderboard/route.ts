// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getProgram, hiSolaM } from "@/lib/program";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

// Never cache the HTTP response: the leaderboard is live data.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const MAX_ROWS = 2000;

// ── On-chain "verified" set ──────────────────────────────────────────────────
// A wallet is verified if it has a real on-chain footprint: holds hiSOLA, OR
// carries USDC debt, OR has a vote receipt. Pure API-spam bots have none of
// these. Computed in 3 getProgramAccounts calls (not per-wallet) and cached.
const RPC = process.env.NEXT_PUBLIC_RPC_URL || process.env.RPC_URL || "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");
const program = getProgram(new AnchorProvider(
  connection,
  { publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any,
  { commitment: "confirmed" },
));

let cache: { set: Set<string>; ts: number } | null = null;
const TTL_MS = 60_000;

async function verifiedSet(): Promise<Set<string> | null> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.set;
  try {
    const [hiAccts, positions, receipts] = await Promise.all([
      connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
        filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: hiSolaM.toBase58() } }],
      }),
      program.account.userPosition.all(),
      program.account.userVoteReceipt.all(),
    ]);
    const set = new Set<string>();
    for (const a of hiAccts) {
      const info: any = (a.account.data as any).parsed?.info;
      if (info && BigInt(info.tokenAmount.amount) > 0n) set.add(info.owner);
    }
    for (const p of positions as any[]) if (BigInt(p.account.usdcBorrowed.toString()) > 0n) set.add(p.account.owner.toBase58());
    for (const r of receipts as any[]) set.add(r.account.user.toBase58());
    cache = { set, ts: Date.now() };
    return set;
  } catch (e) {
    console.error("[leaderboard verifiedSet]", e);
    return cache?.set ?? null; // graceful: serve stale or skip verification
  }
}

// GET → full ranked leaderboard + on-chain "verified" flag per wallet.
export async function GET() {
  try {
    const [{ data, error }, verified] = await Promise.all([
      supabase.from("leaderboard")
        .select("wallet_address, points, quests, last_active")
        .order("points", { ascending: false })
        .order("last_active", { ascending: true })
        .limit(MAX_ROWS),
      verifiedSet(),
    ]);

    if (error) {
      console.error("[leaderboard]", error);
      return NextResponse.json({ rows: [], total: 0, error: error.message }, { status: 500 });
    }
    const rows = (data ?? []).map((r) => ({
      ...r,
      verified: verified ? verified.has(r.wallet_address) : null,
    }));
    const verifiedCount = verified ? rows.filter((r) => r.verified).length : null;
    return NextResponse.json({ rows, total: rows.length, verifiedCount });
  } catch (e: any) {
    return NextResponse.json({ rows: [], total: 0, error: e?.message ?? String(e) }, { status: 500 });
  }
}
