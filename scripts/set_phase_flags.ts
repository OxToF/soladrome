// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// Post-upgrade phase-flag setter.
//
// WHY THIS EXISTS: the six phase-gate flags (lp/bribes/voting/exercise/curve/
// emissions) are written ONLY inside `initialize`, which is one-time and already
// ran on the live devnet ProtocolState. After a program upgrade the existing
// account's spare bytes read `false`, so buy_sola / create_pool / exercise_o_sola
// / deposit_bribe / vote_gauge / replay_vote / burn_o_sola_for_votes /
// flash_arbitrage all revert with `FeatureDisabled`, AND both emission paths
// (emit_pool_rewards + the continuous stream) stay dormant, until the authority
// flips them. On DEVNET we want everything open so the tester flow keeps working
// (emission included), so run this immediately after `solana program deploy`.
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

const PROGRAM_ID = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");
const FLAGS = ["lp", "bribes", "voting", "exercise", "curve", "emissions"] as const;
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
  // Args accept `flag` (enable), `flag=true`, or `flag=false`. Anything not named is left
  // UNTOUCHED — the instruction takes Option<bool>, so silence means "keep as is", never
  // "set to false". Bare `flag` stays equivalent to `flag=true` for backwards compatibility.
  //
  // The explicit `=false` form exists because closing a gate is a real operation, not just
  // the absence of opening it: the devnet-2 sequence is `lp=true` → create the one pool →
  // `lp=false`, which is what makes "a single farming pool" a decision of authority rather
  // than a property of the code (`lp_enabled` is only ever read by `create_pool`).
  const args = process.argv.slice(2);
  const wanted = new Map<Flag, boolean>();
  for (const a of args) {
    const [name, val] = a.split("=") as [Flag, string | undefined];
    if (!FLAGS.includes(name)) {
      throw new Error(`unknown flag: ${name} — valid: ${FLAGS.join(", ")}`);
    }
    if (val !== undefined && val !== "true" && val !== "false") {
      throw new Error(`flag ${name} takes true|false, got: ${val}`);
    }
    wanted.set(name, val !== "false");
  }
  // No args at all = enable everything (the historical devnet form).
  if (wanted.size === 0) FLAGS.forEach((f) => wanted.set(f, true));

  const connection = new Connection(readRpc(), "confirmed");
  const wallet = new anchor.Wallet(loadKeypair());
  const idl = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "app", "lib", "soladrome.json"), "utf8"));
  const program = new anchor.Program(
    idl, new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" }));
  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);

  // Option<bool>: the value if named, `null` to leave the gate untouched.
  const arg = (f: Flag): boolean | null => (wanted.has(f) ? wanted.get(f)! : null);
  console.log("RPC        :", readRpc());
  console.log("authority  :", wallet.publicKey.toBase58());
  console.log(
    "setting    :",
    [...wanted].map(([f, v]) => `${f}=${v}`).join(", ") || "(nothing)"
  );

  const pre: any = await (program.account as any).protocolState.fetch(statePda);
  console.log("pre-state  :", {
    lp: pre.lpEnabled, bribes: pre.bribesEnabled, voting: pre.votingEnabled,
    exercise: pre.exerciseEnabled, curve: pre.curveEnabled, emissions: pre.emissionsEnabled,
  });

  const sig = await (program.methods as any)
    .setPhaseFlags(arg("lp"), arg("bribes"), arg("voting"), arg("exercise"), arg("curve"), arg("emissions"))
    .accounts({ authority: wallet.publicKey, protocolState: statePda })
    .rpc();
  console.log("set_phase_flags tx:", sig);

  const st: any = await (program.account as any).protocolState.fetch(statePda);
  console.log("post-state :", {
    lp: st.lpEnabled, bribes: st.bribesEnabled, voting: st.votingEnabled,
    exercise: st.exerciseEnabled, curve: st.curveEnabled, emissions: st.emissionsEnabled,
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
