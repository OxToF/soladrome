// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, utils } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getProgram, positionPda, statePda, hiSolaM, PROGRAM_ID } from "@/lib/program";
import { TRUSTED_MINTS } from "@/lib/tokens";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!, // service key = écriture via record_quest (RLS bypass)
);

const VALID_QUESTS = new Set([
  "connect", "faucet", "swap", "liquidity", "stake", "borrow", "repay", "vote",
  "follow_x", "like_video", "solana_id",
  "claim_lp_osola", "claim_bribe", "borrow_again", "exercise", "vote_again",
  "like_video2", "truemrr",
  "like_bridge", "like_fbomb",
]);
// "repost", "repost_video", "repost_video2", "repost_bridge" and "repost_fbomb"
// are intentionally NOT POSTable
// here anymore — they used to be honor-system click-to-claim and are now only
// credited by app/api/x-verify/route.ts after a real oEmbed-verified quote
// tweet carrying the wallet's code (same lockdown pattern as "discord" below).
// follow_x + like_video(2) + like_bridge/like_fbomb stay honor-system: X likes
// are private since June 2024 and follows leave nothing submittable —
// unverifiable without the paid X API on every platform, Zealy included.
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
// gate the "Genesis Tester" badge and the airdrop pool, so a bot can no longer
// farm them by POSTing to this endpoint directly — it must actually stake,
// borrow, vote, LP, repay, claim and exercise on-chain. Only the cheap quests
// (connect/faucet/swap) stay unverified; they don't qualify anyone on their own.
const GATED = new Set([
  "stake", "borrow", "borrow_again", "vote", "vote_again", "solana_id",
  "liquidity", "repay", "claim_bribe", "exercise",
]);
const EPOCH_DURATION = 604_800;

// Anti-dust floor for the BALANCE-derived checks (borrow/vote/repay/exercise
// amount, bribe size), in base units (all protocol tokens are 6 decimals). A
// bare `> 0` was dustable: receiving 1 base unit of hiSOLA and chaining tiny
// borrow/vote off it. 0.1 token keeps a real dust barrier while no longer
// locking out genuine sub-1-token testers (a 1.0 floor excluded them). `stake`
// no longer uses this floor at all — it now checks the un-dustable UserPosition
// PDA, which is both dust-proof AND inclusive of any real stake, however small.
const MIN_UNITS = 100_000n; // 0.1 token

// exercise_o_sola instruction discriminator (app/lib/soladrome.json).
const EXERCISE_DISC = Buffer.from([74, 214, 117, 160, 171, 161, 126, 242]);

// Reward mints the claim_bribe quest recognises: the shared trusted-token
// registry (protocol tokens + blue-chip/partner mints like JitoSOL/mSOL/JUP/…
// that a farmer can't cheaply self-mint) plus on-chain USDC. A self-minted
// random token won't match, so a self-dealt bribe of a worthless token can't
// farm the quest, while a genuine bribe in any recognised partner token does.
// Lazily fetched once per serverless instance — only USDC lives in ProtocolState.
let recognizedBribeMints: Set<string> | null = null;
async function getRecognizedBribeMints(): Promise<Set<string>> {
  if (recognizedBribeMints) return recognizedBribeMints;
  const st: any = await (program.account as any).protocolState.fetch(statePda);
  recognizedBribeMints = new Set<string>([...TRUSTED_MINTS, st.usdcMint.toBase58()]);
  return recognizedBribeMints;
}

// True if a single parsed tx contains an exercise_o_sola call where `user` is
// the instruction's own `user` account (accounts[0]) and the exercised amount
// clears the anti-dust floor. Shared by the meta.sig fast-path and the fallback
// history scan.
function txIsExerciseBy(tx: any, user: PublicKey): boolean {
  if (!tx || tx.meta?.err) return false;
  for (const ix of tx.transaction.message.instructions) {
    if (!("data" in ix)) continue;              // fully-parsed system/token ix — not ours
    if (!ix.programId.equals(PROGRAM_ID)) continue;
    const data = Buffer.from(utils.bytes.bs58.decode(ix.data));
    if (data.length < 16 || !EXERCISE_DISC.equals(data.subarray(0, 8))) continue;
    if (!ix.accounts[0]?.equals(user)) continue; // `user` account of ExerciseOSola
    if (data.readBigUInt64LE(8) >= MIN_UNITS) return true;
  }
  return false;
}

// Genesis Missions II quests require a TrueMRR vote first (free distribution ask).
// Minting a Solana ID is deliberately NOT gated — it costs 0.1 SOL, so it stays
// an incentive (its own +50 pt quest) rather than a hard requirement. Mirrors
// `gate: ["truemrr"]` on the GENESIS_2 group in app/lib/quests.ts — kept as its
// own consts here since this route doesn't import the client quest catalog.
const GENESIS2_QUESTS = new Set([
  "claim_lp_osola", "claim_bribe", "borrow_again", "exercise", "vote_again",
  "like_video2", // repost_video2 is x-verify only now — its gate lives there
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

async function checkOnce(quest: string, user: PublicKey, meta?: Record<string, unknown>): Promise<boolean> {
  switch (quest) {
    case "stake": {
      // Proof of stake = the user's UserPosition PDA exists with owner == user.
      // It is init'ed only inside the user's OWN stake_sola call (and other
      // hiSOLA-gated actions that all presuppose a stake), so it can't be dusted
      // onto a wallet from outside — unlike an hiSOLA balance, which is a
      // transferable SPL token. This is both dust-proof AND inclusive: any real
      // stake qualifies, however small (no MIN_UNITS floor needed).
      const pos: any = await (program.account as any).userPosition.fetchNullable(positionPda(user));
      return !!pos && pos.owner.equals(user);
    }
    case "borrow":
    case "borrow_again": {
      // Same check for both: "borrow" is the one-shot genesis mission, "borrow_again"
      // is the repeat-participation mission in Genesis II (mirrors vote/vote_again).
      const pos: any = await (program.account as any).userPosition.fetchNullable(positionPda(user));
      return !!pos && BigInt(pos.usdcBorrowed.toString()) >= MIN_UNITS;
    }
    case "repay": {
      // UserPosition has no repaid-cumulative field, but last_borrow_slot is only
      // ever written by borrow_usdc — so (borrowed at least once) + (zero debt
      // now) proves a full borrow→repay cycle. Partial repays don't count; the
      // user can claim again after clearing the loan (record_quest is idempotent
      // and a failed claim writes nothing).
      const pos: any = await (program.account as any).userPosition.fetchNullable(positionPda(user));
      if (!pos
        || BigInt(pos.lastBorrowSlot.toString()) === 0n
        || BigInt(pos.usdcBorrowed.toString()) !== 0n) return false;
      // Anti-dust: on-chain borrow_usdc has no minimum, so a wallet dusted with 1
      // base unit of hiSOLA could borrow 1 → repay 1 and pass. Require a real
      // staker (≥ MIN_UNITS hiSOLA) — repaying never burns collateral, so a
      // genuine borrow→repay wallet still holds it.
      try {
        const bal = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(hiSolaM, user));
        return BigInt(bal.value.amount) >= MIN_UNITS;
      } catch { return false; }
    }
    case "liquidity": {
      // Proof of deposit = LpUserInfo PDA ([b"lp_user", pool, user]): it is only
      // ever init'ed inside the user's OWN add/remove_liquidity call, so it can't
      // be dusted onto a wallet from outside, and it survives later staking or
      // exiting the LP position. We do NOT fall back to LP-token ATA balance: LP
      // tokens are freely transferable SPL tokens, so a single real LP could dust
      // sybil wallets past any balance threshold and farm this gated quest.
      const lpUser = (pool: PublicKey) => PublicKey.findProgramAddressSync(
        [Buffer.from("lp_user"), pool.toBuffer(), user.toBuffer()], PROGRAM_ID,
      )[0];
      // Preferred: the client tells us which pool it deposited into (same pattern
      // as claim_bribe) — one PDA lookup, no all-pools scan, no key-count cap.
      if (meta?.pool) {
        let pool: PublicKey;
        try { pool = new PublicKey(String(meta.pool)); } catch { return false; }
        return (await connection.getAccountInfo(lpUser(pool))) !== null;
      }
      // Fallback (older clients that send no meta): derive the LpUserInfo PDA for
      // every pool and batch the existence checks. One key per pool, chunked to
      // stay under getMultipleAccountsInfo's 100-account limit as pools grow.
      const pools: any[] = await (program.account as any).ammPool.all();
      if (pools.length === 0) return false;
      const keys = pools.map((p) => lpUser(p.publicKey));
      for (let i = 0; i < keys.length; i += 100) {
        const infos = await connection.getMultipleAccountsInfo(keys.slice(i, i + 100));
        if (infos.some((info) => info !== null)) return true;
      }
      return false;
    }
    case "claim_bribe": {
      // UserBribeClaim stores only its bump — the claimer is only in the PDA
      // seeds — so the client must say WHICH (pool, reward_mint, epoch) it
      // claimed. Deriving the PDA with THIS wallet in the seeds means nobody can
      // point at someone else's receipt: the account only exists if this wallet
      // ran claim_bribe itself (created with `init`, so it can't be spoofed).
      if (!meta) return false;
      let pool: PublicKey, rewardMint: PublicKey;
      try {
        pool       = new PublicKey(String(meta.pool));
        rewardMint = new PublicKey(String(meta.rewardMint));
      } catch { return false; }
      const epoch = Number(meta.epoch);
      if (!Number.isSafeInteger(epoch) || epoch < 0) return false;
      const epochLe = Buffer.alloc(8);
      epochLe.writeBigUInt64LE(BigInt(epoch));
      const claimPda = PublicKey.findProgramAddressSync(
        [Buffer.from("bribe_claim"), user.toBuffer(), pool.toBuffer(), rewardMint.toBuffer(), epochLe],
        PROGRAM_ID,
      )[0];
      if ((await connection.getAccountInfo(claimPda)) === null) return false;
      // Anti-self-farm: bribes are permissionless, so a receipt alone doesn't
      // prove a *real* reward was claimed — a farmer could self-mint a token,
      // deposit a dust bribe on a pool they made, vote, and claim it back. Only
      // count bribes in a protocol-controlled mint (USDC/SOLA/oSOLA — can't be
      // self-minted) whose vault held a non-dust total. (Residual: a real voting
      // wallet can still self-bribe in faucet USDC; that path needs a genuine
      // stake+vote and is caught by the separate airdrop sybil filter.)
      const mints = await getRecognizedBribeMints();
      if (!mints.has(rewardMint.toBase58())) return false;
      const vaultPda = PublicKey.findProgramAddressSync(
        [Buffer.from("bribe_vault"), pool.toBuffer(), rewardMint.toBuffer(), epochLe],
        PROGRAM_ID,
      )[0];
      const vault: any = await (program.account as any).bribeVault.fetchNullable(vaultPda);
      return !!vault && BigInt(vault.totalBribed.toString()) >= MIN_UNITS;
    }
    case "exercise": {
      // exercise_o_sola leaves no per-user account behind (oSOLA burned, SOLA
      // minted), so the only stateless proof is the transaction itself: an
      // exercise_o_sola instruction where THIS wallet is the instruction's `user`
      // account (accounts[0]) — a mere co-signer/fee-payer doesn't count — with
      // o_sola_amount ≥ MIN_UNITS (anti-dust).
      //
      // Preferred: the client passes the exercise tx signature in meta.sig, so we
      // fetch exactly that one tx. This is immune to the recall gap where a user
      // who did >20 txs after exercising (or came back later) would fall off the
      // recent-signature window below.
      const metaSig = meta?.sig;
      if (typeof metaSig === "string") {
        try {
          const tx = await connection.getParsedTransaction(metaSig, {
            maxSupportedTransactionVersion: 0, commitment: "confirmed",
          });
          if (txIsExerciseBy(tx, user)) return true;
          // fall through to the scan if the sig didn't check out (e.g. not yet
          // finalized) rather than failing a legit claim outright.
        } catch { /* fall through to history scan */ }
      }
      // Fallback (older clients / missing sig): scan the wallet's recent history.
      const sigs = await connection.getSignaturesForAddress(user, { limit: 20 }, "confirmed");
      if (sigs.length === 0) return false;
      const txs = await connection.getParsedTransactions(
        sigs.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      );
      return txs.some((tx) => txIsExerciseBy(tx, user));
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
      return !!ev && BigInt(ev.allocated.toString()) >= MIN_UNITS;
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
async function verifyOnChain(quest: string, walletStr: string, meta?: Record<string, unknown>): Promise<boolean> {
  if (!GATED.has(quest)) return true;
  let user: PublicKey;
  try { user = new PublicKey(walletStr); } catch { return false; }
  for (let attempt = 0; attempt < 2; attempt++) {
    try { if (await checkOnce(quest, user, meta)) return true; } catch { /* retry */ }
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

// POST { wallet, quest, meta? } → idempotent quest completion (points decided
// server-side, gated quests verified on-chain). `meta` is only read for
// claim_bribe ({ pool, rewardMint, epoch } → which receipt PDA to look up); it
// is untrusted input and never grants anything by itself.
export async function POST(req: NextRequest) {
  try {
    const { wallet, quest, meta } = await req.json();
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
    if (!(await verifyOnChain(quest, wallet, meta))) {
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
