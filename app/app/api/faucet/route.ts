import { NextRequest, NextResponse } from "next/server";
import {
  Connection, Keypair, PublicKey, Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
} from "@solana/spl-token";
import { createClient } from "@supabase/supabase-js";

// Server-side faucet: use public devnet RPC to avoid burning Helius free-tier quota
// (the frontend throttle doesn't apply here — Connection is created raw with no gate)
const RPC      = process.env.FAUCET_RPC_URL ?? "https://api.devnet.solana.com";
const KP_JSON  = process.env.FAUCET_KEYPAIR!;      // JSON array of secret key bytes
const USDC_STR = process.env.FAUCET_USDC_MINT!;    // devnet USDC mint
const AMOUNT   = 500_000_000;                       // 500 USDC (6 decimals)

// One claim per wallet per window. Without this the faucet is an unbounded free
// mint, and since LP points accrue on the USD value of a position (with mock
// USDC anchored at $1), an unbounded mint is an unbounded score. Override with
// FAUCET_WINDOW_SECONDS to tighten or relax without a migration.
const WINDOW_S = Number(process.env.FAUCET_WINDOW_SECONDS ?? 86_400);

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!, // service key — faucet_claims is RLS-closed
);

export async function POST(req: NextRequest) {
  try {
    const { wallet } = await req.json();
    if (!wallet) return NextResponse.json({ error: "wallet required" }, { status: 400 });

    const recipient  = new PublicKey(wallet);

    // Rate limit BEFORE minting, keyed on the normalised base58 so "same wallet,
    // different spelling" can't open a second slot. Fails CLOSED: if the RPC is
    // missing or errors we refuse rather than mint, because a rate limit that
    // silently degrades to "no limit" is the bug it exists to prevent.
    const { data: allowed, error: rlError } = await supabase.rpc("claim_faucet", {
      p_wallet: recipient.toBase58(),
      p_window_seconds: WINDOW_S,
    });
    if (rlError) {
      console.error("[faucet] claim_faucet", rlError);
      return NextResponse.json({ error: "faucet unavailable" }, { status: 503 });
    }
    if (allowed !== true) {
      return NextResponse.json(
        { error: `Faucet already claimed. Try again in ${Math.round(WINDOW_S / 3600)}h.` },
        { status: 429 },
      );
    }

    // From here on the slot is consumed: any failure must hand it back, or a
    // flaky RPC costs the tester a full day of cooldown for nothing.
    try {
    const mintAuth   = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(KP_JSON)));
    const usdcMint   = new PublicKey(USDC_STR);
    const connection = new Connection(RPC, "confirmed");

    // USDC only — no SOL airdrop. The devnet airdrop was rate-limited into
    // uselessness anyway; the UI points users at faucet.solana.com for fee SOL.

    const recipientAta = await getAssociatedTokenAddress(usdcMint, recipient);
    const ixs = [];

    try { await getAccount(connection, recipientAta); }
    catch {
      ixs.push(createAssociatedTokenAccountInstruction(
        mintAuth.publicKey, recipientAta, recipient, usdcMint,
      ));
    }

    ixs.push(createMintToInstruction(usdcMint, recipientAta, mintAuth.publicKey, AMOUNT));

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = blockhash;
    tx.feePayer        = mintAuth.publicKey;
    tx.sign(mintAuth);

    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });

    return NextResponse.json({ sig, amount: AMOUNT / 1e6 });
    } catch (mintErr) {
      // Best effort — a failed release must never mask the real mint error.
      try {
        await supabase.rpc("release_faucet_claim", { p_wallet: recipient.toBase58() });
      } catch { /* ignore */ }
      throw mintErr;
    }
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
