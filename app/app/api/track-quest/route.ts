// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
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
  "connect", "faucet", "swap", "liquidity", "stake", "borrow", "repay", "vote",
  "follow_x", "repost", "like_video", "repost_video", "solana_id",
  "claim_lp_osola", "claim_bribe", "borrow_again", "exercise", "vote_again",
  "like_video2", "repost_video2", "truemrr",
]);
// "bug" is intentionally NOT POSTable through this public endpoint. It's a
// manually-awarded bonus (verified bug reports, severity-weighted) credited only
// via the Supabase record_quest RPC (service key / SQL editor) — so it can't be
// self-farmed by curling this route. Same server-side-only rationale as "referral".
//
// "discord" is also intentionally excluded — it used to be honor-system
// click-to-claim (open the invite, then self-report), which meant any wallet
// could POST {quest:"discord"} directly without ever joining the server.
// Reported exploited in the community Discord; now only credited by
// app/api/discord/callback/route.ts after a real OAuth + bot-verified guild
// membership check.

// ── On-chain verification ────────────────────────────────────────────────────
// These quests require real protocol state on-chain before we credit them. They
// gate the "Genesis Tester" badge (all 8) and the airdrop pool, so a bot can no
// longer farm them by POSTing to this endpoint directly — it must actually stake,
// borrow and vote on-chain. The cheap quests (connect/faucet/swap/liquidity/repay)
// stay unverified, but you can't qualify without these three.
const GATED = new Set(["stake", "borrow", "borrow_again", "vote", "vote_again", "solana_id"]);
const EPOCH_DURATION = 604_800;

// Genesis Missions II quests require a TrueMRR vote first (free distribution ask).
// Minting a Solana ID is deliberately NOT gated — it costs 0.1 SOL, so it stays
// an incentive (its own +50 pt quest) rather than a hard requirement. Mirrors
// `gate: ["truemrr"]` on the GENESIS_2 group in app/lib/quests.ts — kept as its
// own consts here since this route doesn't import the client quest catalog.
const GENESIS2_QUESTS = new Set([
  "claim_lp_osola", "claim_bribe", "borrow_again", "exercise", "vote_again",
  "like_video2", "repost_video2",
]);
const GENESIS2_GATE = ["truemrr"];

async function hasCompletedQuest(wallet: string, questId: string): Promise<boolean> {
  const { data } = await supabase
    .from("quest_completions")
    .select("quest_id")
    .eq("wallet_address", wallet)
    .eq("quest_id", questId)
    .limit(1);
  return !!data && data.length > 0;
}

async function missingGates(wallet: string): Promise<string[]> {
  const results = await Promise.all(GENESIS2_GATE.map(async (id) => ({ id, done: await hasCompletedQuest(wallet, id) })));
  return results.filter((r) => !r.done).map((r) => r.id);
}

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
    case "borrow":
    case "borrow_again": {
      // Same check for both: "borrow" is the one-shot genesis mission, "borrow_again"
      // is the repeat-participation mission in Genesis II (mirrors vote/vote_again).
      const pos: any = await (program.account as any).userPosition.fetchNullable(positionPda(user));
      return !!pos && BigInt(pos.usdcBorrowed.toString()) > 0n;
    }
    case "vote":
    case "vote_again": {
      // Same check for both: a UserEpochVotes PDA with allocated > 0 for whatever
      // epoch is current when the tx lands. "vote" is the one-shot genesis
      // mission; "vote_again" is the repeat-participation mission in Genesis II —
      // completing it later (a subsequent epoch) just re-runs this same check.
      const epochLe = Buffer.alloc(8);
      epochLe.writeBigUInt64LE(BigInt(currentEpoch()));
      const uev = PublicKey.findProgramAddressSync(
        [Buffer.from("uev"), user.toBuffer(), epochLe], PROGRAM_ID,
      )[0];
      const ev: any = await (program.account as any).userEpochVotes.fetchNullable(uev);
      return !!ev && BigInt(ev.allocated.toString()) > 0n;
    }
    case "solana_id": {
      // Verify via Solana ID Score API — isSolanaIdUser = true means the wallet
      // has minted its Solana ID NFT. API key is server-side only (never exposed).
      try {
        const apiKey = process.env.SOLANA_ID_API_KEY;
        if (!apiKey) return false;
        // Endpoint shape per Solana ID docs: /api/solid-score/address/<wallet>
        // (the bare /solid-score/<wallet> path 404s). Response is nested under
        // `solidUser`, so the flag is json.solidUser.isSolanaIdUser — reading
        // json.isSolanaIdUser is always undefined and never credits the quest.
        const res = await fetch(
          `https://score.solana.id/api/solid-score/address/${user.toBase58()}`,
          { headers: { "Content-Type": "application/json", "x-api-key": apiKey } },
        );
        if (!res.ok) {
          console.error("[track-quest solana_id] score API", res.status, await res.text().catch(() => ""));
          return false;
        }
        const json = await res.json();
        return json?.solidUser?.isSolanaIdUser === true;
      } catch { return false; }
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
// that point, credit its referrer +25 'referral' points. A referrer can refer
// MULTIPLE testers and earn +25 for each one — quest_completions' unique
// (wallet, quest_id) constraint would only ever let a plain "referral" id land
// once per referrer, so each successful referral is recorded under its own
// per-referred-wallet id (`referral:<referred_wallet>`), scoped by the
// `referrals` table's one-row-per-referred-wallet key + its `rewarded` flag —
// so a given referred wallet still only ever pays out once.
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

    await supabase.rpc("record_quest", { p_wallet: ref.referrer_wallet, p_quest: `referral:${wallet}` });
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

    if (GENESIS2_QUESTS.has(quest)) {
      const missing = await missingGates(wallet);
      if (missing.length > 0) {
        return NextResponse.json(
          { ok: false, reason: "gate required", missing },
          { status: 403 },
        );
      }
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
    // Each successful referral is stored under its own `referral:<wallet>` id
    // (see maybeRewardReferrer) — collapse them back to the bare "referral" id
    // so the client's completion checklist can check off "Refer a tester" as
    // soon as there's at least one, without needing to know the per-referral ids.
    const completed = (data ?? []).map((r) => (r.quest_id.startsWith("referral:") ? "referral" : r.quest_id));
    return NextResponse.json({ completed: [...new Set(completed)] });
  } catch {
    return NextResponse.json({ completed: [] });
  }
}
