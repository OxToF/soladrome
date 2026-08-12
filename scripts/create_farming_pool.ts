// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// Create the one pool that farms, and approve it for emissions.
//
// WHY A SCRIPT AND NOT THE UI: `create_pool` is permissionless, but which pool *farms* is
// not — `set_pool_rewards` is authority-only, and `rewards_enabled` defaults to false. The
// launch shape ("a single farming pool") is therefore a sequence of authority decisions,
// and it belongs in a reviewable artifact rather than in three clicks nobody can audit.
//
// The intended devnet-2 / mainnet-day-1 sequence is:
//
//   1. set_phase_flags lp=true          ← opens pool creation
//   2. this script                      ← creates the pair, then approves it for rewards
//   3. set_phase_flags lp=false         ← closes creation for everyone, permanently until reopened
//
// Step 3 is what makes "one farming pool" real without a line of Rust: `lp_enabled` is read
// in exactly one place (amm.rs, inside `create_pool`). `add_liquidity` and `swap` only check
// `paused`, so closing the gate stops new pools appearing while deposits and trading on the
// existing one carry on untouched. It also closes the `pool_multipliers` hole, whose default
// is ×1 for any pool the authority has never heard of.
//
// Usage:
//   npx ts-node scripts/create_farming_pool.ts <mintA> <mintB>
//   npx ts-node scripts/create_farming_pool.ts wsol usdc     # aliases for the launch pair
//
// Idempotent: an existing pool is detected and only the rewards approval is (re)applied.

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";

const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Matches the frontend's defaults (Pools.tsx): 0.30 % swap fee, 20 % of it to the protocol.
const FEE_RATE_BPS = 30;
const PROTOCOL_FEE_BPS = 2_000;

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
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
}

async function main() {
  const idl = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "app", "lib", "soladrome.json"), "utf8"));
  const programId = new PublicKey(idl.address);

  const connection = new Connection(readRpc(), "confirmed");
  const wallet = new anchor.Wallet(loadKeypair());
  const program = new anchor.Program(
    idl, new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" }));

  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], programId);
  const state: any = await (program.account as any).protocolState.fetch(statePda);

  // Resolve the two mints. `usdc` is read from chain rather than hardcoded: the devnet mock
  // has been re-minted before, and a stale constant would silently create the wrong pair.
  const resolve = (arg: string): PublicKey => {
    const a = arg.toLowerCase();
    if (a === "wsol" || a === "sol") return new PublicKey(WSOL_MINT);
    if (a === "usdc") return state.usdcMint as PublicKey;
    if (a === "sola") return state.solaMint as PublicKey;
    return new PublicKey(arg);
  };

  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error("usage: create_farming_pool.ts <mintA> <mintB>");
  const m1 = resolve(args[0]);
  const m2 = resolve(args[1]);
  if (m1.equals(m2)) throw new Error("the two mints must differ");

  // sort_mints() orders lexicographically on-chain, so (A,B) and (B,A) are one pool.
  const [mintA, mintB] = Buffer.compare(m1.toBuffer(), m2.toBuffer()) <= 0 ? [m1, m2] : [m2, m1];

  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm_pool"), mintA.toBuffer(), mintB.toBuffer()], programId);
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint"), pool.toBuffer()], programId);
  const [tokenAVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_a"), pool.toBuffer()], programId);
  const [tokenBVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_b"), pool.toBuffer()], programId);

  console.log("RPC        :", readRpc().replace(/api-key=.*/, "api-key=***"));
  console.log("authority  :", wallet.publicKey.toBase58());
  console.log("mint A     :", mintA.toBase58());
  console.log("mint B     :", mintB.toBase58());
  console.log("pool       :", pool.toBase58());
  console.log("lp mint    :", lpMint.toBase58());

  const existing = await (program.account as any).ammPool.fetchNullable(pool);
  if (existing) {
    console.log("pool already exists — skipping creation");
  } else {
    const sig = await (program.methods as any)
      .createPool(FEE_RATE_BPS, PROTOCOL_FEE_BPS)
      .accounts({
        creator: wallet.publicKey,
        protocolState: statePda,
        tokenAMint: mintA,
        tokenBMint: mintB,
        pool,
        lpMint,
        tokenAVault,
        tokenBVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log(`create_pool tx: ${sig}  (fee ${FEE_RATE_BPS} bps, protocol share ${PROTOCOL_FEE_BPS} bps)`);
  }

  const sig2 = await (program.methods as any)
    .setPoolRewards(true)
    .accounts({ authority: wallet.publicKey, protocolState: statePda, pool })
    .rpc();
  console.log("set_pool_rewards(true) tx:", sig2);

  const after: any = await (program.account as any).ammPool.fetch(pool);
  console.log("post-state :", {
    rewardsEnabled: after.rewardsEnabled,
    totalLp: after.totalLp.toString(),
    reserveA: after.reserveA.toString(),
    reserveB: after.reserveB.toString(),
  });
  console.log("\n⚠️  Now close creation:  npx ts-node scripts/set_phase_flags.ts lp=false");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
