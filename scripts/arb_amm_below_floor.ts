// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// Close a SOLA/USDC pool price that has fallen BELOW the 1 USDC floor.
//
// WHY THIS IS A SCRIPT AND NOT AN INSTRUCTION — the asymmetry worth knowing:
//
//   `flash_arbitrage` handles the OTHER direction only. It burns oSOLA, mints floor-backed
//   SOLA and sells it into the pool, and its profitability check is
//       require!(usdc_out > amount_osola)
//   i.e. the pool must pay MORE than 1 USDC per SOLA. When the pool is below the floor it
//   correctly refuses with NotProfitable — it is the tool for an overpriced pool, and it
//   routes 90% of the profit to hiSOLA stakers.
//
//   For a pool BELOW the floor the protocol has no dedicated instruction at all. The
//   correcting trade needs none: buy SOLA cheap on the AMM, redeem it at exactly 1.00 through
//   `sell_sola`, which reads only `floor_vault` and never the pool. Two ordinary calls,
//   permissionless, and profitable to anyone who notices.
//
//   So the protocol is instrumented for the deviation that ENRICHES it and not for the one
//   that damages its headline promise. Not a vulnerability — the downward correction is
//   automatic and open to all — but a design asymmetry, and the reason a devnet pool can sit
//   under the floor indefinitely: there are no bots watching a test cluster.
//
// The profit here comes from the LP, not from the protocol. The SOLA being redeemed was
// financed through the curve and is already backed; `sell_sola` burns it and decrements
// `total_purchased_sola` by the same amount, so the solvency invariant is untouched.
//
// Usage:
//   TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/arb_amm_below_floor.ts [--dry-run]
//
// Sizing is computed, not guessed: the amount that brings the pool to exactly 1.000000 is
// `sqrt(k) - reserve_usdc`, adjusted for the swap fee.
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction, createMintToInstruction,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";

const DEC = 1_000_000;
const FEE_BPS = 30; // pool fee, 0.30%

function envValue(key: string): string | undefined {
  try {
    const line = fs.readFileSync(path.join(__dirname, "..", "app", ".env.local"), "utf8")
      .split("\n").find((l) => l.startsWith(`${key}=`));
    return line?.slice(key.length + 1).trim();
  } catch { return undefined; }
}
function readRpc(): string {
  const url = envValue("NEXT_PUBLIC_RPC_URL");
  if (!url || !url.startsWith("http")) throw new Error("NEXT_PUBLIC_RPC_URL missing/malformed");
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
  const dryRun = process.argv.includes("--dry-run");
  const connection = new Connection(readRpc(), "confirmed");
  const payer = loadKeypair();
  const program = new anchor.Program(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "lib", "soladrome.json"), "utf8")),
    new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" }));
  const programId = program.programId;

  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], programId);
  const s: any = await (program.account as any).protocolState.fetch(statePda);
  const usdcMint = s.usdcMint as PublicKey;
  const solaMint = s.solaMint as PublicKey;

  const [mintA, mintB] = Buffer.compare(usdcMint.toBuffer(), solaMint.toBuffer()) <= 0
    ? [usdcMint, solaMint] : [solaMint, usdcMint];
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("amm_pool"), mintA.toBuffer(), mintB.toBuffer()], programId);
  const [vaultA] = PublicKey.findProgramAddressSync([Buffer.from("vault_a"), pool.toBuffer()], programId);
  const [vaultB] = PublicKey.findProgramAddressSync([Buffer.from("vault_b"), pool.toBuffer()], programId);

  const p: any = await (program.account as any).ammPool.fetchNullable(pool);
  if (!p) throw new Error("SOLA/USDC pool not found");

  const usdcIsA = mintA.equals(usdcMint);
  const rUsdc = Number(usdcIsA ? p.reserveA : p.reserveB);
  const rSola = Number(usdcIsA ? p.reserveB : p.reserveA);
  const poolPrice = rUsdc / rSola;

  console.log("── état ─────────────────────────────────────────────");
  console.log("pool        :", pool.toBase58());
  console.log(`réserves    : ${(rUsdc / DEC).toFixed(2)} USDC / ${(rSola / DEC).toFixed(2)} SOLA`);
  console.log(`prix pool   : ${poolPrice.toFixed(6)} USDC/SOLA`);
  console.log(`floor       : 1.000000 (sell_sola, inconditionnel)`);

  if (poolPrice >= 1) {
    console.log("\nLe pool est au niveau ou au-dessus du floor — rien à arbitrer dans ce sens.");
    console.log("Pour un pool AU-DESSUS du floor, l'outil est `flash_arbitrage` (page Arb).");
    return;
  }

  // Amount that brings USDC/SOLA to exactly 1: with x*y = k, price 1 means both sides sqrt(k).
  const k = rUsdc * rSola;
  const target = Math.sqrt(k);
  const feeMul = 1 - FEE_BPS / 10_000;
  const amountIn = Math.floor((target - rUsdc) / feeMul);
  const amountNet = amountIn * feeMul;
  const solaOut = rSola - k / (rUsdc + amountNet);
  const profit = solaOut - amountIn; // sell_sola pays exactly 1.0 per SOLA

  console.log("\n── plan ─────────────────────────────────────────────");
  console.log(`1. acheter  : ${(amountIn / DEC).toFixed(6)} USDC → ~${(solaOut / DEC).toFixed(6)} SOLA sur l'AMM`);
  console.log(`2. racheter : ${(solaOut / DEC).toFixed(6)} SOLA → ${(solaOut / DEC).toFixed(6)} USDC via sell_sola (1.00 exact)`);
  console.log(`profit      : ${(profit / DEC).toFixed(6)} USDC  (${((profit / amountIn) * 100).toFixed(2)} % sans risque)`);
  console.log(`prix après  : ~1.000000`);
  console.log("─────────────────────────────────────────────────────");
  if (dryRun) { console.log("\n--dry-run: rien envoyé."); return; }

  const userUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
  const userSola = getAssociatedTokenAddressSync(solaMint, payer.publicKey);

  // ── fund the leg ──────────────────────────────────────────────────────────
  const faucet = loadFaucet();
  const pre: anchor.web3.TransactionInstruction[] = [];
  for (const [ata, mint] of [[userUsdc, usdcMint], [userSola, solaMint]] as [PublicKey, PublicKey][]) {
    if (!(await connection.getAccountInfo(ata))) {
      pre.push(createAssociatedTokenAccountInstruction(payer.publicKey, ata, payer.publicKey, mint));
    }
  }
  const haveUsdc = (await connection.getAccountInfo(userUsdc))
    ? Number((await connection.getTokenAccountBalance(userUsdc)).value.amount) : 0;
  const need = Math.max(0, amountIn - haveUsdc);
  if (need > 0) pre.push(createMintToInstruction(usdcMint, userUsdc, faucet.publicKey, need));
  if (pre.length) {
    const sig = await anchor.web3.sendAndConfirmTransaction(
      connection, new anchor.web3.Transaction().add(...pre), [payer, faucet], { commitment: "confirmed" });
    console.log("[1/3] USDC prêt:", sig);
  } else {
    console.log("[1/3] USDC déjà en main");
  }

  // ── 2. buy SOLA on the AMM ────────────────────────────────────────────────
  // a_to_b = true means "spend mint A, receive mint B". USDC is the token we spend.
  const aToB = usdcIsA;
  const minOut = new anchor.BN(Math.floor(solaOut * 0.99)); // 1% slippage guard
  const sig2 = await (program.methods as any)
    .ammSwap(new anchor.BN(amountIn), minOut, aToB)
    .accountsPartial({
      user: payer.publicKey, pool,
      tokenAVault: vaultA, tokenBVault: vaultB,
      userTokenIn: userUsdc, userTokenOut: userSola,
      marketVault: s.marketVault, protocolState: statePda,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("[2/3] acheté sur l'AMM:", sig2);

  const solaBal = Number((await connection.getTokenAccountBalance(userSola)).value.amount);
  console.log("      SOLA en main:", (solaBal / DEC).toFixed(6));

  // ── 3. redeem at the floor ────────────────────────────────────────────────
  const usdcBefore = Number((await connection.getTokenAccountBalance(userUsdc)).value.amount);
  const sig3 = await (program.methods as any)
    .sellSola(new anchor.BN(solaBal))
    .accountsPartial({
      user: payer.publicKey, protocolState: statePda, solaMint,
      userSola, floorVault: s.floorVault, userUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("[3/3] racheté au floor:", sig3);

  const usdcAfter = Number((await connection.getTokenAccountBalance(userUsdc)).value.amount);
  const after: any = await (program.account as any).ammPool.fetch(pool);
  const sAfter: any = await (program.account as any).protocolState.fetch(statePda);
  const rU = Number(usdcIsA ? after.reserveA : after.reserveB);
  const rS = Number(usdcIsA ? after.reserveB : after.reserveA);

  console.log("\n── après ────────────────────────────────────────────");
  console.log(`prix pool   : ${(rU / rS).toFixed(6)} USDC/SOLA   (était ${poolPrice.toFixed(6)})`);
  console.log(`réservés    : ${(rU / DEC).toFixed(2)} USDC / ${(rS / DEC).toFixed(2)} SOLA`);
  console.log(`USDC reçu   : ${((usdcAfter - usdcBefore) / DEC).toFixed(6)} au floor`);
  console.log(`profit net  : ${((usdcAfter - usdcBefore - amountIn) / DEC).toFixed(6)} USDC`);
  const floorBal = Number((await connection.getTokenAccountBalance(s.floorVault)).value.amount);
  const purchased = Number(sAfter.totalPurchasedSola);
  const borrowed = Number(sAfter.totalUsdcBorrowed);
  console.log("\n── invariant de solvabilité ─────────────────────────");
  console.log(`floor ${(floorBal / DEC).toFixed(6)} + emprunté ${(borrowed / DEC).toFixed(6)}`);
  console.log(`  = ${((floorBal + borrowed) / DEC).toFixed(6)}  vs purchased ${(purchased / DEC).toFixed(6)}`);
  console.log(`  → ${floorBal + borrowed >= purchased ? "✅ tenu" : "❌ VIOLÉ"}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
