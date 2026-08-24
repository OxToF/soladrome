// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// Realloc the live ProtocolState singleton 416 → 448 and backfill `founder_wallet`.
//
// Required once per deployment after the 2026-08-23 upgrade that removed the `devnet` build
// feature. Until it runs, `founder_wallet` reads Pubkey::default(), which matches no signer —
// every founder guard fails CLOSED, so the protocol is safe but the founder paths are inert.
//
//   npx ts-node scripts/migrate_protocol_state.ts            # devnet (default)
//   FOUNDER_WALLET=<pubkey> npx ts-node scripts/migrate_protocol_state.ts
//
// ☢️ `founder_wallet` is WRITE-ONCE. The instruction refuses to overwrite a non-default value,
// and refuses to set one at all once `founder_allocated` is true — so this script cannot
// redirect a live allocation. But the FIRST run decides the address permanently: check the
// value printed below before confirming, because `mint_founder_allocation` does NOT require a
// founder signature and will commit the whole tranche to whatever is stored here.

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import idl from "../app/lib/soladrome.json";

const PROGRAM_ID = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");

// Devnet 2 hot wallet, chosen 2026-08-24. Deliberately NOT the mainnet Ledger
// (46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4): devnet has to stay operable without
// hardware, and the divergence that mattered was in the CODE. The binary is identical either
// way — the founder address is a parameter, not a build variant.
const DEFAULT_FOUNDER = "4T1gHVpLRDPJQrsW1QUfHMYuCBLzVLgP7tu1yuoWtYGH";

async function main() {
  const founderWallet = new PublicKey(
    process.env.FOUNDER_WALLET ?? DEFAULT_FOUNDER
  );

  const kp = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))
    )
  );
  const RPC = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new anchor.web3.Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(kp), {
    commitment: "confirmed",
  });
  const program = new anchor.Program(idl as any, provider);

  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("state")],
    PROGRAM_ID
  );

  const before = await conn.getAccountInfo(statePda);
  if (!before) throw new Error(`no ProtocolState at ${statePda.toBase58()}`);

  console.log("ProtocolState :", statePda.toBase58());
  console.log("size          :", before.data.length, "bytes");
  console.log("signer        :", kp.publicKey.toBase58());
  console.log("founder_wallet:", founderWallet.toBase58());

  if (before.data.length >= 448) {
    // Already reallocated — the call is still worth making if the field is unset, and is a
    // no-op otherwise. Read it rather than guessing.
    const st: any = await (program.account as any).protocolState.fetch(statePda);
    const current = st.founderWallet?.toBase58();
    if (current && current !== PublicKey.default.toBase58()) {
      console.log(`\nAlready migrated, founder_wallet = ${current}. Nothing to do.`);
      return;
    }
  }

  const tx = await program.methods
    .migrateProtocolState(founderWallet)
    .accounts({
      authority: kp.publicKey,
      protocolState: statePda,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  const after = await conn.getAccountInfo(statePda);
  const st: any = await (program.account as any).protocolState.fetch(statePda);

  console.log("\n✅ migrated — tx:", tx);
  console.log("   size          :", before.data.length, "→", after!.data.length);
  console.log("   founder_wallet:", st.founderWallet.toBase58());
  console.log("   authority     :", st.authority.toBase58());
  console.log("   usdc_mint     :", st.usdcMint.toBase58());
  console.log("   k             :", st.k.toString(), "(must be unchanged: 1e24)");

  if (st.founderWallet.toBase58() !== founderWallet.toBase58()) {
    throw new Error(
      `founder_wallet is ${st.founderWallet.toBase58()}, expected ${founderWallet.toBase58()} ` +
        `— it was already set and cannot be redirected`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
