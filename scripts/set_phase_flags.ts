// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// Post-upgrade phase-flag setter.
//
// WHY THIS EXISTS: the five phase-gate flags (lp/bribes/voting/exercise/curve)
// are written ONLY inside `initialize`, which is one-time and already ran on the
// live devnet ProtocolState. After a program upgrade the existing account's
// spare bytes read `false`, so buy_sola / create_pool / exercise_o_sola /
// deposit_bribe / vote_gauge / replay_vote / burn_o_sola_for_votes /
// flash_arbitrage all revert with `FeatureDisabled` until the authority flips
// them. On DEVNET we want everything open so the tester flow keeps working, so
// run this immediately after `solana program deploy`.
//
// Usage:
//   RPC read from app/.env.local (NEXT_PUBLIC_RPC_URL); authority keypair from
//   $ANCHOR_WALLET or ~/.config/solana/id.json.
//     yarn ts-node scripts/set_phase_flags.ts            # enable ALL (devnet)
//     yarn ts-node scripts/set_phase_flags.ts lp voting  # enable only these
//
// For MAINNET do NOT run the enable-all form: follow the two-stage plan in
// MAINNET_RUNBOOK.md (stage 1 enables lp/bribes/voting only; curve stays false).
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const FLAGS = ["lp", "bribes", "voting", "exercise", "curve"] as const;
type Flag = (typeof FLAGS)[number];

function readRpc(): string {
  const envPath = path.join(__dirname, "..", "app", ".env.local");
  try {
    const line = fs.readFileSync(envPath, "utf8")
      .split("\n").find((l) => l.startsWith("NEXT_PUBLIC_RPC_URL="));
    if (line) return line.slice("NEXT_PUBLIC_RPC_URL=".length).trim();
  } catch { /* fall through */ }
  return process.env.RPC_URL || "https://api.devnet.solana.com";
}

function loadKeypair(): Keypair {
  const kpPath = process.env.ANCHOR_WALLET
    || path.join(os.homedir(), ".config", "solana", "id.json");
  const secret = JSON.parse(fs.readFileSync(kpPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  // Which flags to enable? Default = all (devnet). Any CLI args restrict the set.
  const requested = process.argv.slice(2) as Flag[];
  const bad = requested.filter((f) => !FLAGS.includes(f));
  if (bad.length) throw new Error(`unknown flag(s): ${bad.join(", ")} — valid: ${FLAGS.join(", ")}`);
  const enable = new Set<Flag>(requested.length ? requested : FLAGS);

  const connection = new Connection(readRpc(), "confirmed");
  const wallet = new anchor.Wallet(loadKeypair());
  const idl = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "app", "lib", "soladrome.json"), "utf8"));
  const program = new anchor.Program(
    idl, new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" }));
  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);

  // Option<bool> args: `true` to enable a gate, `null` to leave it untouched.
  const arg = (f: Flag): boolean | null => (enable.has(f) ? true : null);
  console.log("RPC        :", readRpc());
  console.log("authority  :", wallet.publicKey.toBase58());
  console.log("enabling   :", [...enable].join(", ") || "(none)");

  const sig = await (program.methods as any)
    .setPhaseFlags(arg("lp"), arg("bribes"), arg("voting"), arg("exercise"), arg("curve"))
    .accounts({ authority: wallet.publicKey, protocolState: statePda })
    .rpc();
  console.log("set_phase_flags tx:", sig);

  const st: any = await (program.account as any).protocolState.fetch(statePda);
  console.log("post-state :", {
    lp: st.lpEnabled, bribes: st.bribesEnabled, voting: st.votingEnabled,
    exercise: st.exerciseEnabled, curve: st.curveEnabled,
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
