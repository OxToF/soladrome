// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// Seed the devnet SOLA/USDC pool.
//
// WHY THIS EXISTS: until 2026-08-21 the protocol quoted "buy at P >= 1, sell at exactly 1"
// and nothing else, so trading SOLA was a guaranteed loss and the curve never moved. Worse,
// an oSOLA is an option worth `exit_price - 1`, and the only exit was `sell_sola` at exactly
// the strike — so every oSOLA was structurally worth ZERO no matter how high the curve went.
// A SOLA/USDC pool is what creates an exit price, and therefore what gives oSOLA, the
// emissions and the whole gauge system any value at all.
//
// It must be SOLA/**USDC** specifically, for two reasons that are in the code:
//   • `flash_arbitrage` hard-constrains its pool to the SOLA/USDC pair (lib.rs) — a
//     SOLA/wSOL pool would leave the entire arbitrage path inert.
//   • the AMM only routes its protocol fee to `market_vault` when the input mint matches
//     that vault's mint, i.e. USDC (amm.rs) — on any other pair, hiSOLA stakers earn nothing.
//
// The SOLA side can only come from the bonding curve (there is no other source), so seeding
// necessarily walks the curve up. That is the ONLY effect this has on it: `buy_sola` is one
// of just two instructions that move the virtual reserves, and an AMM swap is not one of them.
//
// Usage:
//   TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/seed_sola_usdc_pool.ts [--usdc 5000] [--dry-run]
//
// Order: run `set_phase_flags.ts lp=true` and `create_farming_pool.ts sola usdc` FIRST,
// then this, then `set_phase_flags.ts lp=false`.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
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
  // Validate the SHAPE, not mere presence — a defined-but-corrupt value disarms the
  // fallback it was meant to improve (16/08 incident).
  if (url && (url.startsWith("http://") || url.startsWith("https://"))) return url;
  return "https://api.devnet.solana.com";
}

function loadKeypair(): Keypair {
  const kpPath = process.env.ANCHOR_WALLET
    || path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
}

/// The mock-USDC mint authority. Never printed — only its derived pubkey is.
function loadFaucet(): Keypair {
  const raw = envValue("FAUCET_KEYPAIR");
  if (!raw) throw new Error("FAUCET_KEYPAIR missing from app/.env.local");
  if (raw.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  const bs58 = require("bs58");
  return Keypair.fromSecretKey((bs58.default ?? bs58).decode(raw));
}

const flag = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (n: string) => process.argv.includes(`--${n}`);

async function main() {
  const usdcToSpend = Math.round(parseFloat(flag("usdc") ?? "5000") * DEC);
  const dryRun = has("dry-run");

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "lib", "soladrome.json"), "utf8"));
  const programId = new PublicKey(idl.address);
  const connection = new Connection(readRpc(), "confirmed");
  const payer = loadKeypair();
  const wallet = new anchor.Wallet(payer);
  const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" }));

  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], programId);
  const s: any = await (program.account as any).protocolState.fetch(statePda);
  const usdcMint = s.usdcMint as PublicKey;
  const solaMint = s.solaMint as PublicKey;

  const [mintA, mintB] = Buffer.compare(solaMint.toBuffer(), usdcMint.toBuffer()) <= 0
    ? [solaMint, usdcMint] : [usdcMint, solaMint];
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from("amm_pool"), mintA.toBuffer(), mintB.toBuffer()], programId);
  const [lpMint] = PublicKey.findProgramAddressSync([Buffer.from("lp_mint"), pool.toBuffer()], programId);
  const [vaultA] = PublicKey.findProgramAddressSync([Buffer.from("vault_a"), pool.toBuffer()], programId);
  const [vaultB] = PublicKey.findProgramAddressSync([Buffer.from("vault_b"), pool.toBuffer()], programId);

  const userUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
  const userSola = getAssociatedTokenAddressSync(solaMint, payer.publicKey);
  const userLp = getAssociatedTokenAddressSync(lpMint, payer.publicKey);
  const lpDead = SystemProgram.programId; // LP_DEAD_PUBKEY
  const lpDeadAta = getAssociatedTokenAddressSync(lpMint, lpDead, true);

  const faucet = loadFaucet();
  const vu = Number(s.virtualUsdc) / DEC, vs = Number(s.virtualSola) / DEC;
  const price = vu / vs;
  // sola_out = vs - k/(vu + in), with k = vu*vs
  const inUi = usdcToSpend / DEC;
  const solaOut = vs - (vu * vs) / (vu + inUi);

  console.log("── plan ─────────────────────────────────────────────");
  console.log("RPC            :", readRpc().replace(/api-key=.*/, "api-key=***"));
  console.log("payer          :", payer.publicKey.toBase58());
  console.log("usdc mint      :", usdcMint.toBase58(), "| mint authority:", faucet.publicKey.toBase58());
  console.log("pool           :", pool.toBase58());
  console.log(`curve price    : ${price.toFixed(6)} USDC/SOLA`);
  console.log(`buy            : ${inUi.toLocaleString()} USDC -> ~${solaOut.toFixed(2)} SOLA`);
  console.log(`curve after    : ~${((vu + inUi) / (vs - solaOut)).toFixed(6)} USDC/SOLA`);
  console.log(`seed           : ~${solaOut.toFixed(2)} SOLA + ${inUi.toLocaleString()} USDC`);
  console.log(`mint needed    : ${(inUi * 2).toLocaleString()} mock USDC (buy + seed)`);
  console.log("─────────────────────────────────────────────────────");

  const poolAcc = await (program.account as any).ammPool.fetchNullable(pool);
  if (!poolAcc) throw new Error("pool does not exist — run create_farming_pool.ts sola usdc first (needs lp=true)");
  if (dryRun) { console.log("\n--dry-run: nothing sent."); return; }

  // ── 1. mint mock USDC (buy leg + seed leg) ────────────────────────────────
  const pre: anchor.web3.TransactionInstruction[] = [];
  if (!(await connection.getAccountInfo(userUsdc))) {
    pre.push(createAssociatedTokenAccountInstruction(payer.publicKey, userUsdc, payer.publicKey, usdcMint));
  }
  // Idempotent: only top up what is missing, so re-running after a mid-script failure
  // does not mint a second batch.
  const haveUsdc = (await connection.getAccountInfo(userUsdc))
    ? Number((await connection.getTokenAccountBalance(userUsdc)).value.amount) : 0;
  const need = Math.max(0, usdcToSpend * 2 - haveUsdc);
  if (need > 0) pre.push(createMintToInstruction(usdcMint, userUsdc, faucet.publicKey, need));
  if (pre.length > 0) {
    const tx1 = new anchor.web3.Transaction().add(...pre);
    const sig1 = await anchor.web3.sendAndConfirmTransaction(connection, tx1, [payer, faucet], { commitment: "confirmed" });
    console.log("[1/3] minted mock USDC:", sig1);
  } else {
    console.log("[1/3] mock USDC already in hand — nothing minted");
  }

  // ── 2. buy SOLA on the curve ──────────────────────────────────────────────
  // `buy_sola(usdc_in, min_sola_out)` — the second arg is the slippage guard. 1 % below the
  // quote computed above: the curve is monotonic, so the only way to get less is somebody
  // buying between our quote and our landing.
  const minSolaOut = new anchor.BN(Math.floor(solaOut * DEC * 0.99));
  const sig2 = await (program.methods as any)
    .buySola(new anchor.BN(usdcToSpend), minSolaOut)
    .accountsPartial({
      user: payer.publicKey, protocolState: statePda, solaMint,
      userUsdc, userSola, floorVault: s.floorVault, marketVault: s.marketVault,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("[2/3] bought SOLA:", sig2);

  const solaBal = (await connection.getTokenAccountBalance(userSola)).value.amount;
  console.log("      SOLA in hand:", (Number(solaBal) / DEC).toFixed(6));

  // ── 3. seed the pool ──────────────────────────────────────────────────────
  const solaIsA = mintA.equals(solaMint);
  const amountA = solaIsA ? new anchor.BN(solaBal) : new anchor.BN(usdcToSpend);
  const amountB = solaIsA ? new anchor.BN(usdcToSpend) : new anchor.BN(solaBal);

  const seedPre: anchor.web3.TransactionInstruction[] = [];
  for (const [ata, owner] of [[userLp, payer.publicKey], [lpDeadAta, lpDead]] as [PublicKey, PublicKey][]) {
    if (!(await connection.getAccountInfo(ata))) {
      seedPre.push(createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, lpMint));
    }
  }
  const [lpUserInfo] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp_user"), pool.toBuffer(), payer.publicKey.toBuffer()], programId);
  const oSolaMint = s.oSolaMint as PublicKey;
  const userOSola = getAssociatedTokenAddressSync(oSolaMint, payer.publicKey);

  const sig3 = await (program.methods as any)
    .addLiquidity(amountA, amountB, new anchor.BN(0))
    .accountsPartial({
      user: payer.publicKey, protocolState: statePda, pool, lpMint,
      tokenAVault: vaultA, tokenBVault: vaultB,
      userTokenA: solaIsA ? userSola : userUsdc,
      userTokenB: solaIsA ? userUsdc : userSola,
      userLp, lpDeadAta, lpDead, lpUserInfo,
      oSolaMint, userOSola,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions(seedPre)
    .rpc();
  console.log("[3/3] seeded pool:", sig3);

  const after: any = await (program.account as any).ammPool.fetch(pool);
  const sAfter: any = await (program.account as any).protocolState.fetch(statePda);
  console.log("\n── on-chain after ───────────────────────────────────");
  console.log("reserve A / B  :", (Number(after.reserveA) / DEC).toFixed(2), "/", (Number(after.reserveB) / DEC).toFixed(2));
  console.log("pool price     :", (solaIsA
    ? Number(after.reserveB) / Number(after.reserveA)
    : Number(after.reserveA) / Number(after.reserveB)).toFixed(6), "USDC/SOLA");
  console.log("curve price    :", (Number(sAfter.virtualUsdc) / Number(sAfter.virtualSola)).toFixed(6), "USDC/SOLA");
  console.log("rewards enabled:", after.rewardsEnabled);
  console.log("─────────────────────────────────────────────────────");
  console.log("⚠️  Now: set_phase_flags.ts lp=false, and halve the continuous rate so two");
  console.log("    approved pools still total 8 000 oSOLA/epoch (the rate is PER POOL).");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
