/**
 * distribute_osola.ts
 * Mint oSOLA directly to a wallet via distribute_o_sola (authority-only).
 * Usage: ts-node scripts/distribute_osola.ts <recipient_pubkey> <amount_ui>
 * Example: ts-node scripts/distribute_osola.ts <your_wallet> 100
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";
import idl from "../target/idl/soladrome.json";

const PROGRAM_ID  = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const STATE_SEED  = Buffer.from("state");
const RPC_URL     = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: ts-node scripts/distribute_osola.ts <recipient_pubkey> <amount_ui>");
    process.exit(1);
  }

  const recipientPk = new PublicKey(args[0]);
  const amountUi    = parseFloat(args[1]);
  const amountRaw   = new BN(Math.floor(amountUi * 1_000_000));

  // Load authority keypair (same as deployer)
  const walletPath = process.env.ANCHOR_WALLET
    ?? path.join(process.env.HOME!, ".config/solana/id.json");
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet     = new anchor.Wallet(kp);
  const provider   = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const program = new Program(idl as any, provider);

  const [statePda] = PublicKey.findProgramAddressSync([STATE_SEED], PROGRAM_ID);
  const state: any = await (program.account as any).protocolState.fetch(statePda);
  const oSolaMint  = state.oSolaMint as PublicKey;

  const recipientOSola = getAssociatedTokenAddressSync(oSolaMint, recipientPk);

  console.log(`Minting ${amountUi} oSOLA → ${recipientPk.toBase58()}`);

  const tx = await program.methods
    .distributeOSola(amountRaw)
    .accounts({
      authority:       kp.publicKey,
      recipient:       recipientPk,
      protocolState:   statePda,
      oSolaMint,
      recipientOSola,
      tokenProgram:             TOKEN_PROGRAM_ID,
      associatedTokenProgram:   ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram:            anchor.web3.SystemProgram.programId,
    } as any)
    .rpc();

  console.log(`✅ Done — tx: ${tx}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
