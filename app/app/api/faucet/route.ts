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

const RPC      = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
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

    // ── Devnet SOL airdrop if wallet has < 0.1 SOL ───────────────────────────
    // Without SOL, the user can't pay tx fees and every transaction will fail.
    let solAirdropped = false;
    try {
      const solBalance = await connection.getBalance(recipient);
      if (solBalance < 100_000_000) { // < 0.1 SOL
        const airdropSig = await connection.requestAirdrop(recipient, 1_000_000_000); // 1 SOL
        const { blockhash: abh, lastValidBlockHeight: alvbh } = await connection.getLatestBlockhash();
        await connection.confirmTransaction({ signature: airdropSig, blockhash: abh, lastValidBlockHeight: alvbh });
        solAirdropped = true;
      }
    } catch {
      // Devnet airdrop is rate-limited — continue with USDC mint regardless
    }

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

    return NextResponse.json({ sig, amount: AMOUNT / 1e6, solAirdropped });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
