// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// Seed the devnet oSOLA/USDC pool.
//
// WHY: oSOLA is a call option struck at the 1 USDC floor, so it is worth `exit_price - 1`.
// Until 2026-08-21 the only exit was `sell_sola` at exactly the strike, which made every
// oSOLA structurally worth zero; the SOLA/USDC pool fixed that by creating an exit price.
// This pool does the next thing: it lets a holder realise that value WITHOUT exercising,
// which is what "oSOLA is tradeable" actually means.
//
// Two differences from seed_sola_usdc_pool.ts, both worth knowing:
//
//   • The oSOLA side does NOT come from the curve. It is minted by `distribute_o_sola`,
//     authority-only and capped by `ecosystem_o_sola_minted` against ECOSYSTEM_TOTAL (1.75M).
//     So unlike the SOLA pool, seeding this one does not move the bonding curve at all.
//
//   • ⚠️ The protocol fee reaches `market_vault` ONLY when the input mint is USDC (amm.rs).
//     Buying oSOLA with USDC pays hiSOLA stakers; SELLING oSOLA for USDC does not, the fee
//     stays with the LPs. The sell side is the one an emissions farmer uses, so stakers earn
//     nothing from the flow this pool mostly exists to serve. That is the current design,
//     stated here so it is a known trade-off rather than a surprise.
//
// The pool is created with `--no-rewards`: farming oSOLA with an oSOLA pool is circular, and
// the continuous stream is PER POOL, so approving a third pool would raise total emissions.
//
// Usage:
//   TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/seed_osola_usdc_pool.ts [--usdc 500] [--dry-run]
//
// Order: set_phase_flags.ts lp=true → create_farming_pool.ts osola usdc --no-rewards →
//        this → set_phase_flags.ts lp=false
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";

const DEC = 1_000_000; // 6 dp everywhere in this protocol

function envValue(key: string): string | undefined {
  try {
    const line = fs.readFileSync(path.join(__dirname, "..", "app", ".env.local"), "utf8")
      .split("\n").find((l) => l.startsWith(`${key}=`));
    return line?.slice(key.length + 1).trim();
  } catch { return undefined; }
}

function readRpc(): string {
  const url = envValue("NEXT_PUBLIC_RPC_URL");
  if (!url || !url.startsWith("http")) {
    throw new Error("NEXT_PUBLIC_RPC_URL missing or malformed in app/.env.local");
  }
  return url;
}

function loadKeypair(): Keypair {
  const p = process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function loadFaucet(): Keypair {
  const raw = envValue("FAUCET_KEYPAIR");
  if (!raw) throw new Error("FAUCET_KEYPAIR missing from app/.env.local");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const usdcArgIdx = argv.indexOf("--usdc");
  const usdcUi = usdcArgIdx >= 0 ? Number(argv[usdcArgIdx + 1]) : 500;
  if (!Number.isFinite(usdcUi) || usdcUi <= 0) throw new Error("--usdc must be a positive number");
  const usdcToSpend = Math.round(usdcUi * DEC);

  const connection = new Connection(readRpc(), "confirmed");
  const payer = loadKeypair();
  const wallet = new anchor.Wallet(payer);
  const idl = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "app", "lib", "soladrome.json"), "utf8"));
  const program = new anchor.Program(
    idl, new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" }));
  const programId = program.programId;

  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], programId);
  const s: any = await (program.account as any).protocolState.fetch(statePda);
  const usdcMint = s.usdcMint as PublicKey;
  const oSolaMint = s.oSolaMint as PublicKey;

  // sort_mints() orders lexicographically on-chain, so (A,B) and (B,A) are one pool.
  const [mintA, mintB] = Buffer.compare(usdcMint.toBuffer(), oSolaMint.toBuffer()) <= 0
    ? [usdcMint, oSolaMint] : [oSolaMint, usdcMint];
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm_pool"), mintA.toBuffer(), mintB.toBuffer()], programId);
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_mint"), pool.toBuffer()], programId);
  const [vaultA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_a"), pool.toBuffer()], programId);
  const [vaultB] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_b"), pool.toBuffer()], programId);

  const userUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
  const userOSola = getAssociatedTokenAddressSync(oSolaMint, payer.publicKey);
  const userLp = getAssociatedTokenAddressSync(lpMint, payer.publicKey);
  const lpDead = SystemProgram.programId; // LP_DEAD_PUBKEY
  const lpDeadAta = getAssociatedTokenAddressSync(lpMint, lpDead, true);

  const faucet = loadFaucet();

  // Price the seed at oSOLA's INTRINSIC value, `curve price - 1`. An option is worth at least
  // its intrinsic value and usually more (time value), so seeding here is the conservative
  // choice: the first trades can only push it up, and an LP is not handed free upside.
  const curvePrice = Number(s.virtualUsdc) / Number(s.virtualSola);
  const intrinsic = curvePrice - 1;
  if (intrinsic <= 0) throw new Error(`curve price is ${curvePrice}, oSOLA has no intrinsic value yet`);
  const oSolaToSeed = Math.round((usdcUi / intrinsic) * DEC);

  const minted = Number(s.ecosystemOSolaMinted);
  const ECOSYSTEM_TOTAL = 1_750_000 * DEC;

  console.log("── plan ─────────────────────────────────────────────");
  console.log("RPC            :", readRpc().replace(/api-key=.*/, "api-key=***"));
  console.log("payer          :", payer.publicKey.toBase58());
  console.log("pool           :", pool.toBase58());
  console.log("mint A / B     :", mintA.toBase58(), "/", mintB.toBase58());
  console.log(`curve price    : ${curvePrice.toFixed(6)} USDC/SOLA`);
  console.log(`oSOLA intrinsic: ${intrinsic.toFixed(6)} USDC  (curve - 1 USDC strike)`);
  console.log(`seed           : ${usdcUi.toLocaleString()} USDC + ${(oSolaToSeed / DEC).toLocaleString()} oSOLA`);
  console.log(`ecosystem used : ${(minted / DEC).toLocaleString()} / 1,750,000 oSOLA`);
  console.log(`after this     : ${((minted + oSolaToSeed) / DEC).toLocaleString()} / 1,750,000 oSOLA`);
  console.log("─────────────────────────────────────────────────────");

  if (minted + oSolaToSeed > ECOSYSTEM_TOTAL) {
    throw new Error("would exceed ECOSYSTEM_TOTAL — distribute_o_sola would revert");
  }
  const poolAcc = await (program.account as any).ammPool.fetchNullable(pool);
  if (!poolAcc) {
    throw new Error("pool does not exist — run create_farming_pool.ts osola usdc --no-rewards first (needs lp=true)");
  }
  if (Number(poolAcc.totalLp) > 0) {
    console.log("\npool is already seeded (total_lp > 0) — nothing to do.");
    return;
  }
  if (dryRun) { console.log("\n--dry-run: nothing sent."); return; }

  // ── 1. mock USDC for the seed leg ─────────────────────────────────────────
  // Idempotent: only top up what is missing, so a re-run after a mid-script failure does not
  // mint a second batch.
  const pre: anchor.web3.TransactionInstruction[] = [];
  if (!(await connection.getAccountInfo(userUsdc))) {
    pre.push(createAssociatedTokenAccountInstruction(payer.publicKey, userUsdc, payer.publicKey, usdcMint));
  }
  const haveUsdc = (await connection.getAccountInfo(userUsdc))
    ? Number((await connection.getTokenAccountBalance(userUsdc)).value.amount) : 0;
  const needUsdc = Math.max(0, usdcToSpend - haveUsdc);
  if (needUsdc > 0) pre.push(createMintToInstruction(usdcMint, userUsdc, faucet.publicKey, needUsdc));
  if (pre.length > 0) {
    const tx1 = new anchor.web3.Transaction().add(...pre);
    const sig1 = await anchor.web3.sendAndConfirmTransaction(connection, tx1, [payer, faucet], { commitment: "confirmed" });
    console.log("[1/3] minted mock USDC:", sig1);
  } else {
    console.log("[1/3] mock USDC already in hand — nothing minted");
  }

  // ── 2. oSOLA from the ecosystem budget ────────────────────────────────────
  const haveOSola = (await connection.getAccountInfo(userOSola))
    ? Number((await connection.getTokenAccountBalance(userOSola)).value.amount) : 0;
  const needOSola = Math.max(0, oSolaToSeed - haveOSola);
  if (needOSola > 0) {
    const sig2 = await (program.methods as any)
      .distributeOSola(new anchor.BN(needOSola))
      .accountsPartial({
        authority: payer.publicKey, recipient: payer.publicKey, protocolState: statePda,
        oSolaMint, recipientOSola: userOSola,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("[2/3] distributed oSOLA:", sig2);
  } else {
    console.log("[2/3] oSOLA already in hand — nothing distributed");
  }

  // ── 3. seed the pool ──────────────────────────────────────────────────────
  const usdcIsA = mintA.equals(usdcMint);
  const amountA = new anchor.BN(usdcIsA ? usdcToSpend : oSolaToSeed);
  const amountB = new anchor.BN(usdcIsA ? oSolaToSeed : usdcToSpend);

  const seedPre: anchor.web3.TransactionInstruction[] = [];
  for (const [ata, owner] of [[userLp, payer.publicKey], [lpDeadAta, lpDead]] as [PublicKey, PublicKey][]) {
    if (!(await connection.getAccountInfo(ata))) {
      seedPre.push(createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, lpMint));
    }
  }
  const [lpUserInfo] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_user"), pool.toBuffer(), payer.publicKey.toBuffer()], programId);

  const sig3 = await (program.methods as any)
    .addLiquidity(amountA, amountB, new anchor.BN(0))
    .accountsPartial({
      user: payer.publicKey, protocolState: statePda, pool, lpMint,
      tokenAVault: vaultA, tokenBVault: vaultB,
      userTokenA: usdcIsA ? userUsdc : userOSola,
      userTokenB: usdcIsA ? userOSola : userUsdc,
      userLp, lpDeadAta, lpDead, lpUserInfo,
      oSolaMint, userOSola,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions(seedPre)
    .rpc();
  console.log("[3/3] seeded pool:", sig3);

  const after: any = await (program.account as any).ammPool.fetch(pool);
  const rA = Number(after.reserveA) / DEC, rB = Number(after.reserveB) / DEC;
  console.log("\n── on-chain after ───────────────────────────────────");
  console.log("reserve A / B  :", rA.toFixed(2), "/", rB.toFixed(2));
  console.log("pool price     :", (usdcIsA ? rA / rB : rB / rA).toFixed(6), "USDC/oSOLA");
  console.log("intrinsic      :", intrinsic.toFixed(6), "USDC/oSOLA");
  console.log("rewards enabled:", after.rewardsEnabled, "(false on purpose — see the header)");
  console.log("─────────────────────────────────────────────────────");
  console.log("⚠️  Now close creation:  npx ts-node scripts/set_phase_flags.ts lp=false");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
