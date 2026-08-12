import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import idl from "../app/lib/soladrome.json";

const PROGRAM_ID = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");

// Calibrage 2026-08-08 — emission de SOUTIEN visant 1-2% d'APR.
// L'ancien 800 000/epoch donnait 163% d'APR a $10M de TVL des que SOLA fait x1,5.
// Le plancher passe de 10% a 50% : sans lui, le decay s'effondre pendant que la TVL
// croit, et les deux compressions se multiplient (TVL x10 + emission /10 = APR /100).
const INITIAL   = 20_000_000_000; // 20 000 oSOLA (6 dec) par epoch — pull de lancement
const DECAY_BPS = 9_900;          // -1 %/epoch
const FLOOR_BPS = 2_500;          // plancher = 5 000 oSOLA/epoch (25 % de l'initial)

async function main() {
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8")))
  );
  const RPC = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new anchor.web3.Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(kp), {
    commitment: "confirmed",
  });
  const program = new anchor.Program(idl as any, provider);

  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);

  const before: any = await (program.account as any).protocolState.fetch(statePda);
  console.log("avant :",
    "initial =", before.osolaEmissionInitial.toString(),
    "| decay =", before.osolaEmissionDecayBps,
    "| floor =", before.osolaEmissionFloorBps);

  const tx = await program.methods
    .configureEmissions(new anchor.BN(INITIAL), DECAY_BPS, FLOOR_BPS)
    .accounts({ authority: kp.publicKey, protocolState: statePda } as any)
    .rpc();

  const after: any = await (program.account as any).protocolState.fetch(statePda);
  console.log("apres :",
    "initial =", after.osolaEmissionInitial.toString(),
    "| decay =", after.osolaEmissionDecayBps,
    "| floor =", after.osolaEmissionFloorBps,
    "| start_epoch =", after.osolaEmissionStartEpoch.toString());
  console.log("tx:", tx);
}
main().catch((e) => { console.error(e); process.exit(1); });
