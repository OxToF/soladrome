// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getProgram, positionPda, hiSolaM, PROGRAM_ID } from "@/lib/program";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!, // service key = écriture via record_quest (RLS bypass)
);

const VALID_QUESTS = new Set([
  "connect", "faucet", "swap", "liquidity", "stake", "borrow", "repay", "vote", "bug",
  "follow_x", "repost",
]);

// ── On-chain verification ────────────────────────────────────────────────────
// These quests require real protocol state on-chain before we credit them. They
// gate the "Genesis Tester" badge (all 8) and the airdrop pool, so a bot can no
// longer farm them by POSTing to this endpoint directly — it must actually stake,
// borrow and vote on-chain. The cheap quests (connect/faucet/swap/liquidity/repay)
// stay unverified, but you can't qualify without these three.
const GATED = new Set(["stake", "borrow", "vote"]);
const EPOCH_DURATION = 604_800;

const RPC = process.env.NEXT_PUBLIC_RPC_URL || process.env.RPC_URL || "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");
// Read-only provider: fetches never sign, so a dummy wallet is fine.
const readonlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: async (t: any) => t,
  signAllTransactions: async (t: any) => t,
};
const program = getProgram(new AnchorProvider(connection, readonlyWallet as any, { commitment: "confirmed" }));

function currentEpoch() {
  return Math.floor(Date.now() / 1000 / EPOCH_DURATION);
}

async function checkOnce(quest: string, user: PublicKey): Promise<boolean> {
  switch (quest) {
    case "stake": {
      // Proof of stake = holds hiSOLA. (Borrowing and voting both require it too.)
      try {
        const bal = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(hiSolaM, user));
        return BigInt(bal.value.amount) > 0n;
      } catch { return false; } // ATA doesn't exist → never staked
    }
    case "borrow": {
      const pos: any = await (program.account as any).userPosition.fetchNullable(positionPda(user));
      return !!pos && BigInt(pos.usdcBorrowed.toString()) > 0n;
    }
    case "vote": {
      const epochLe = Buffer.alloc(8);
      epochLe.writeBigUInt64LE(BigInt(currentEpoch()));
      const uev = PublicKey.findProgramAddressSync(
        [Buffer.from("uev"), user.toBuffer(), epochLe], PROGRAM_ID,
      )[0];
      const ev: any = await (program.account as any).userEpochVotes.fetchNullable(uev);
      return !!ev && BigInt(ev.allocated.toString()) > 0n;
    }
    default:
      return true; // not gated on-chain
  }
}

// A legit user calls this right after their tx confirms; absorb RPC lag with a
// short retry so we don't drop their credit. Idempotent server-side either way.
async function verifyOnChain(quest: string, walletStr: string): Promise<boolean> {
  if (!GATED.has(quest)) return true;
  let user: PublicKey;
  try { user = new PublicKey(walletStr); } catch { return false; }
  for (let attempt = 0; attempt < 2; attempt++) {
    try { if (await checkOnce(quest, user)) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

// When a wallet has completed all three GATED quests, it is a verified on-chain
// Genesis Tester (those rows only exist after on-chain verification above). At
// that point, credit its referrer's one-time +25 'referral' quest. The referrer
// earns it ONCE regardless of how many it refers (unique wallet+quest), and only
// for a genuinely on-chain referral — so referral farming doesn't pay.
async function maybeRewardReferrer(wallet: string) {
  try {
    const { data: done } = await supabase
      .from("quest_completions").select("quest_id").eq("wallet_address", wallet);
    const have = new Set((done ?? []).map((r) => r.quest_id));
    if (!(have.has("stake") && have.has("borrow") && have.has("vote"))) return;

    const { data: ref } = await supabase
      .from("referrals").select("referrer_wallet, rewarded")
      .eq("referred_wallet", wallet).maybeSingle();
    if (!ref || ref.rewarded) return;

    await supabase.rpc("record_quest", { p_wallet: ref.referrer_wallet, p_quest: "referral" });
    await supabase.from("referrals").update({ rewarded: true }).eq("referred_wallet", wallet);
  } catch (e) {
    console.error("[track-quest referral]", e);
  }
}

// Live data — never serve a cached response.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// POST { wallet, quest } → idempotent quest completion (points decided server-side,
// gated quests verified on-chain).
export async function POST(req: NextRequest) {
  try {
    const { wallet, quest } = await req.json();
    if (!wallet || typeof wallet !== "string") {
      return NextResponse.json({ error: "wallet required" }, { status: 400 });
    }
    if (!quest || !VALID_QUESTS.has(quest)) {
      return NextResponse.json({ error: "unknown quest" }, { status: 400 });
    }

    // Reject quests whose on-chain action we can't find — kills direct API farming.
    if (!(await verifyOnChain(quest, wallet))) {
      return NextResponse.json(
        { ok: false, reason: "on-chain action not found for this wallet" },
        { status: 422 },
      );
    }

    const { error } = await supabase.rpc("record_quest", {
      p_wallet: wallet,
      p_quest:  quest,
    });
    if (error) {
      console.error("[track-quest]", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // A gated quest just landed → this wallet may now be a full Genesis Tester;
    // credit its referrer if so.
    if (GATED.has(quest)) await maybeRewardReferrer(wallet);

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

// GET ?wallet=… → list of quest ids this wallet has already completed.
export async function GET(req: NextRequest) {
  try {
    const wallet = req.nextUrl.searchParams.get("wallet");
    if (!wallet) return NextResponse.json({ completed: [] });

    const { data, error } = await supabase
      .from("quest_completions")
      .select("quest_id")
      .eq("wallet_address", wallet);

    if (error) {
      console.error("[track-quest GET]", error);
      return NextResponse.json({ completed: [] });
    }
    return NextResponse.json({ completed: (data ?? []).map((r) => r.quest_id) });
  } catch {
    return NextResponse.json({ completed: [] });
  }
}
