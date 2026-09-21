// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs
//
// Bring a fresh localnet up to a state you can actually click through.
//
// Not `init_devnet.ts`: that one expects the mock USDC mint `3N8EKeBP…` to already exist, which
// on a fresh ledger it does not, and nobody holds the key that would recreate it at that exact
// address. Here the mint is made on the spot and written into `ProtocolState`, which is where
// the frontend reads it from anyway — so its address never needs to match devnet's.
//
// Run, with the validator already up:
//   solana-test-validator --reset --quiet --ledger /tmp/local-ledger \
//       --bpf-program DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe target/deploy/soladrome.so &
//   npx ts-node scripts/init_localnet.ts <wallet-to-fund> [more wallets…]
//
// Every wallet named gets SOL, mock USDC and oSOLA — enough to arm a standing order and watch
// it fire. The deployer is funded whether or not it is named.
import * as anchor from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } from "@solana/web3.js";
import {
  MINT_SIZE, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeMint2Instruction, createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { readFileSync } from "fs";
import { homedir } from "os";

// Read rather than imported: the root tsconfig does not enable `resolveJsonModule`, and
// turning it on for one script would change how every other file in the tree compiles.
const idl = JSON.parse(readFileSync(`${__dirname}/../app/lib/soladrome.json`, "utf8"));

const PROGRAM_ID = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");
const RPC = process.env.LOCALNET_RPC_URL ?? "http://127.0.0.1:8899";
const UNIT = 1_000_000;

const USDC_PER_WALLET = 5_000 * UNIT;
const OSOLA_PER_WALLET = 5_000 * UNIT;

async function main() {
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8")))
  );
  const conn = new anchor.web3.Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(kp), {
    commitment: "confirmed",
  });
  const program = new anchor.Program(idl as any, provider);

  const pda = (seed: string) =>
    PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0];
  const statePda = pda("state");
  const solaMint = pda("sola_mint");
  const hiSolaMint = pda("hi_sola_mint");
  const oSolaMint = pda("o_sola_mint");
  const floorVault = pda("floor_vault");
  const marketVault = pda("market_vault");
  const solaVault = pda("sola_vault");

  const targets = process.argv
    .slice(2)
    .filter((a) => !a.startsWith("-"))
    .map((a) => new PublicKey(a));
  const wallets = [kp.publicKey, ...targets].filter(
    (p, i, all) => all.findIndex((q) => q.equals(p)) === i
  );

  console.log(`RPC        ${RPC}`);
  console.log(`deployer   ${kp.publicKey.toBase58()}`);

  // ── SOL for everyone, including the deployer ────────────────────────────
  for (const w of wallets) {
    const balance = await conn.getBalance(w);
    if (balance < 50 * LAMPORTS_PER_SOL) {
      const sig = await conn.requestAirdrop(w, 100 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) });
    }
  }

  // ── Mock USDC ───────────────────────────────────────────────────────────
  const usdcKp = Keypair.generate();
  {
    const rent = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: kp.publicKey,
        newAccountPubkey: usdcKp.publicKey,
        space: MINT_SIZE,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(usdcKp.publicKey, 6, kp.publicKey, null)
    );
    await provider.sendAndConfirm(tx, [usdcKp]);
  }
  console.log(`mock USDC  ${usdcKp.publicKey.toBase58()}`);

  // ── initialize ──────────────────────────────────────────────────────────
  //
  // A THROWAWAY founder wallet, deliberately not the deployer: the founder guards (no voting,
  // no unlock, no oSOLA burn) would otherwise fire on the wallet doing the testing.
  const founder = Keypair.generate().publicKey;
  await program.methods
    .initialize(founder)
    .accounts({
      authority: kp.publicKey,
      protocolState: statePda,
      usdcMint: usdcKp.publicKey,
      solaM: solaMint,
      hiSolaM: hiSolaMint,
      oSolaM: oSolaMint,
      floorVault,
      marketVault,
      solaVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();
  console.log(`state      ${statePda.toBase58()}  (founder ${founder.toBase58().slice(0, 8)}… — throwaway)`);

  // Everything on: lp, bribes, voting, exercise, curve, emissions.
  await program.methods
    .setPhaseFlags(true, true, true, true, true, true)
    .accounts({ authority: kp.publicKey, protocolState: statePda } as any)
    .rpc();

  // ── Fund the wallets ────────────────────────────────────────────────────
  for (const w of wallets) {
    const usdcAta = getAssociatedTokenAddressSync(usdcKp.publicKey, w);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, usdcAta, w, usdcKp.publicKey),
      createMintToInstruction(usdcKp.publicKey, usdcAta, kp.publicKey, USDC_PER_WALLET)
    );
    await provider.sendAndConfirm(tx);

    // oSOLA comes from the ecosystem channel — the one mint path that exists for it.
    await program.methods
      .distributeOSola(new anchor.BN(OSOLA_PER_WALLET))
      .accounts({
        authority: kp.publicKey,
        recipient: w,
        protocolState: statePda,
        oSolaMint,
        recipientOSola: getAssociatedTokenAddressSync(oSolaMint, w),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    console.log(
      `funded     ${w.toBase58()}  ${USDC_PER_WALLET / UNIT} USDC · ${OSOLA_PER_WALLET / UNIT} oSOLA · 100 SOL`
    );
  }

  const state: any = await (program.account as any).protocolState.fetch(statePda);
  console.log("");
  console.log(`exercise_enabled ${state.exerciseEnabled}   exercise_fee_bps ${state.exerciseFeeBps}`);
  console.log(`curve            ${Number(state.virtualUsdc) / Number(state.virtualSola)} USDC / SOLA`);
  console.log("");
  console.log("Point the wallet extension at http://127.0.0.1:8899 before connecting.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
