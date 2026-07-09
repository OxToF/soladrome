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

// Server-side faucet: use public devnet RPC to avoid burning Helius free-tier quota
// (the frontend throttle doesn't apply here — Connection is created raw with no gate)
const RPC      = process.env.FAUCET_RPC_URL ?? "https://api.devnet.solana.com";
const KP_JSON  = process.env.FAUCET_KEYPAIR!;      // JSON array of secret key bytes
const USDC_STR = process.env.FAUCET_USDC_MINT!;    // devnet USDC mint
const AMOUNT   = 500_000_000;                       // 500 USDC (6 decimals)

export async function POST(req: NextRequest) {
  try {
    const { wallet } = await req.json();
    if (!wallet) return NextResponse.json({ error: "wallet required" }, { status: 400 });

    const recipient  = new PublicKey(wallet);
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
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
