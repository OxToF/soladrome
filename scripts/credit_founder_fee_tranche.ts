// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs
//
// One-shot, authority-only: move 500K of the founder's 7M out of the vesting schedule into a
// lifetime lock that EARNS FEES (no vote, no borrow), to fund the operating company
// (decided 2026-11-20). Same instruction on devnet and mainnet.
//
// ☢️ Mainnet order: `mint_founder_allocation` first (the schedule must exist), then this,
// before any fee has accrued is fine but not required — the share is credited with the
// accumulator carried across, so it never claims fees from before it existed.
//
// Usage:
//   RPC from scripts/lib/rpc.ts (RPC_URL first); authority keypair from $ANCHOR_WALLET or
//   ~/.config/solana/id.json.
//     yarn ts-node scripts/credit_founder_fee_tranche.ts --check   # read only, sends nothing
//     yarn ts-node scripts/credit_founder_fee_tranche.ts           # send
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import { redactRpc, serverRpcUrl } from "./lib/rpc";

const PROGRAM_ID = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");
const FOUNDER_STAKE = BigInt(7_000_000_000_000);
const FOUNDER_FEE_TRANCHE = BigInt(500_000_000_000);

function loadKeypair(): Keypair {
  const kpPath =
    process.env.ANCHOR_WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const connection = new Connection(serverRpcUrl(), "confirmed");
  const wallet = new anchor.Wallet(loadKeypair());
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "app", "lib", "soladrome.json"), "utf8")
  );
  const program = new anchor.Program(
    idl,
    new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" })
  );
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
  const statePda = pda(Buffer.from("state"));
  const vestingPda = pda(Buffer.from("founder_hi_vesting"));

  const st: any = await (program.account as any).protocolState.fetch(statePda);
  const founder: PublicKey = st.founderWallet;
  const v: any = await (program.account as any).founderHiSolaVesting.fetch(vestingPda);
  const total = BigInt(v.totalAmount.toString());
  const claimed = BigInt(v.claimed.toString());

  console.log("RPC        :", redactRpc(serverRpcUrl())); // ⚠️ never print the key itself
  console.log("authority  :", wallet.publicKey.toBase58(), st.authority.equals(wallet.publicKey) ? "✅" : "❌ NOT the protocol authority");
  console.log("founder    :", founder.toBase58());
  console.log("schedule   :", { total: total.toString(), claimed: claimed.toString() });

  if (total !== FOUNDER_STAKE) {
    console.log("\n✅ Already done: the schedule holds", total.toString(), "— nothing to send.");
    return;
  }
  if (total - claimed < FOUNDER_FEE_TRANCHE) {
    throw new Error("less than 500K left unreleased in the schedule — the program would refuse");
  }
  if (checkOnly) {
    console.log("\n--check: would credit 500 000 hiSOLA of fee shares to the founder. Nothing sent.");
    return;
  }

  const sig = await (program.methods as any)
    .creditFounderFeeTranche()
    .accounts({
      authority: wallet.publicKey,
      protocolState: statePda,
      founder,
      solaMint: st.solaMint,
      solaVault: st.solaVault,
      marketVault: st.marketVault,
      lockPosition: pda(Buffer.from("velock"), founder.toBuffer()),
      founderPosition: pda(Buffer.from("position"), founder.toBuffer()),
      founderHiVesting: vestingPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("\n✅ sent:", sig);
  const pos: any = await (program.account as any).userPosition.fetch(
    pda(Buffer.from("position"), founder.toBuffer())
  );
  console.log("founder fee_shares:", pos.feeShares.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
