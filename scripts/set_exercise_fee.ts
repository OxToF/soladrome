// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// oSOLA exercise-fee setter.
//
// WHY THIS EXISTS: `exercise_fee_bps` is written ONLY inside `initialize`, and the field
// was added on 2026-08-05 — after every live singleton had already been initialized. So a
// live ProtocolState reads it out of spare bytes as **0**, i.e. NO FEE. That is not a
// configuration choice, it is the same migration artefact as the phase flags, and the
// program says so itself (lib.rs, DEFAULT_EXERCISE_FEE_BPS doc comment):
//
//     "Only written by initialize; live singletons read 0 (no fee) until the authority
//      calls set_exercise_fee."
//
// It differs from the phase flags in one important way: forgetting the flags BRICKS entry
// paths, which is loud. Forgetting this one is SILENT — exercise simply runs fee-free and
// nothing reverts. That is precisely why it needs a script and an order, not a memory.
//
// ☢️ ORDER IS BINDING: run this BEFORE `set_phase_flags exercise=true`, never after.
// Between the flip and this call, every exercise pays the protocol nothing, and the gain
// it should have shared with hiSOLA stakers is gone for good — there is no retroactive
// charge. On mainnet that window falls inside stage 2, next to the curve opening, the TGE
// and the airdrop, which is the busiest moment of the launch. See MAINNET_RUNBOOK.md §7.
//
// Usage:
//   RPC read from app/.env.local (NEXT_PUBLIC_RPC_URL); authority keypair from
//   $ANCHOR_WALLET or ~/.config/solana/id.json.
//     yarn ts-node scripts/set_exercise_fee.ts           # 1000 bps = 10 % of the gain
//     yarn ts-node scripts/set_exercise_fee.ts 1500      # explicit value
//     yarn ts-node scripts/set_exercise_fee.ts --check   # read only, sends nothing
//
// The fee is a share of the GAIN (`bps × (curve_price − 1) × amount`), charged on top of
// the 1 USDC strike and never carved out of it, so the floor is untouched at any value and
// exercise stays profitable by construction below 10 000 bps.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey(
  "DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe"
);

// Mirrors the on-chain constants. `MAX` is enforced by the program too — checked here only
// to fail before signing rather than after.
const DEFAULT_EXERCISE_FEE_BPS = 1_000; // 10 % of the gain
const MAX_EXERCISE_FEE_BPS = 5_000; // 50 % — economic guard, not a solvency bound

function readRpc(): string {
  const envPath = path.join(__dirname, "..", "app", ".env.local");
  try {
    const line = fs
      .readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("NEXT_PUBLIC_RPC_URL="));
    if (line) return line.slice("NEXT_PUBLIC_RPC_URL=".length).trim();
  } catch {
    /* fall through */
  }
  return process.env.RPC_URL || "https://api.devnet.solana.com";
}

function loadKeypair(): Keypair {
  const kpPath =
    process.env.ANCHOR_WALLET ||
    path.join(os.homedir(), ".config", "solana", "id.json");
  const secret = JSON.parse(fs.readFileSync(kpPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const positional = args.filter((a) => !a.startsWith("--"));

  if (positional.length > 1) {
    throw new Error(
      `expected at most one bps value, got: ${positional.join(" ")}`
    );
  }
  const bps =
    positional.length === 1 ? Number(positional[0]) : DEFAULT_EXERCISE_FEE_BPS;
  if (!Number.isInteger(bps) || bps < 0) {
    throw new Error(
      `bps must be a non-negative integer, got: ${positional[0]}`
    );
  }
  if (bps > MAX_EXERCISE_FEE_BPS) {
    throw new Error(
      `bps ${bps} exceeds MAX_EXERCISE_FEE_BPS (${MAX_EXERCISE_FEE_BPS}) — the program ` +
        `would reject this with InvalidAmount`
    );
  }

  const connection = new Connection(readRpc(), "confirmed");
  const wallet = new anchor.Wallet(loadKeypair());
  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "app", "lib", "soladrome.json"),
      "utf8"
    )
  );
  const program = new anchor.Program(
    idl,
    new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" })
  );
  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("state")],
    PROGRAM_ID
  );

  console.log("RPC        :", readRpc());
  console.log("authority  :", wallet.publicKey.toBase58());

  const pre: any = await (program.account as any).protocolState.fetch(statePda);
  const vu = BigInt(pre.virtualUsdc.toString());
  const vs = BigInt(pre.virtualSola.toString());
  const price = Number(vu) / Number(vs);
  const gain = price - 1;

  console.log("pre-state  :", {
    exerciseFeeBps: pre.exerciseFeeBps,
    exerciseEnabled: pre.exerciseEnabled,
  });
  console.log(
    `curve price: ${price.toFixed(6)} → gain per oSOLA = ${gain.toFixed(
      6
    )} USDC` +
      `, fee at ${bps} bps = ${((gain * bps) / 10_000).toFixed(
        8
      )} USDC per oSOLA`
  );

  // The order guard. This is the entire reason the script exists rather than a one-liner.
  if (pre.exerciseEnabled) {
    console.warn(
      "\n☢️  exercise_enabled is ALREADY true.\n" +
        "    The binding order was not followed: every exercise since the flip paid a fee " +
        `of ${pre.exerciseFeeBps} bps.\n` +
        "    Setting the fee now applies only from this transaction onward — there is no " +
        "retroactive charge.\n" +
        "    Proceeding anyway, since arming the fee late still beats leaving it at 0.\n"
    );
  } else {
    console.log(
      "\n✅ exercise_enabled is false — correct order. Flip it only AFTER this " +
        "transaction confirms:\n" +
        "     yarn ts-node scripts/set_phase_flags.ts exercise=true\n"
    );
  }

  if (checkOnly) {
    console.log("--check: nothing sent.");
    return;
  }
  if (bps === pre.exerciseFeeBps) {
    console.log(`already ${bps} bps — nothing to do.`);
    return;
  }

  const sig = await (program.methods as any)
    .setExerciseFee(bps)
    .accounts({ authority: wallet.publicKey, protocolState: statePda })
    .rpc();
  console.log("set_exercise_fee tx:", sig);

  const post: any = await (program.account as any).protocolState.fetch(
    statePda
  );
  console.log("post-state :", {
    exerciseFeeBps: post.exerciseFeeBps,
    exerciseEnabled: post.exerciseEnabled,
  });
  if (post.exerciseFeeBps !== bps) {
    throw new Error(
      `fee did not take: expected ${bps}, on-chain reads ${post.exerciseFeeBps}`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
