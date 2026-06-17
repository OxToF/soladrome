/**
 * init_mainnet.ts — Soladrome mainnet launch sequence
 *
 * Runs 3 one-shot instructions in order:
 *   1. initialize           → bonding curve + mints + vaults
 *   2. mint_founder_allocation → starts the 7M hiSOLA vesting clock
 *   3. mint_ecosystem_allocation → 1.75M SOLA to authority + 250k SOLA to founder wallet
 *
 * Run AFTER: anchor build --no-default-features && anchor deploy
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx ts-node scripts/init_mainnet.ts
 *
 * ⚠️  LAST STEP (not in this script): call transfer_authority → Squads vault
 *     BxYTiKyDxWpK4hPDZEiYVW9qBj8YpzhSHEBCWpaZbWQ4
 *     Do it AFTER verifying all 3 steps above are confirmed on-chain.
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { readFileSync } from "fs";
import { homedir } from "os";
import idl from "../app/lib/soladrome.json";

// ── Config ────────────────────────────────────────────────────────────────────

const PROGRAM_ID     = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const USDC_MINT      = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // mainnet USDC
const FOUNDER_WALLET = new PublicKey("46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4");
// Separate ops wallet that receives the 250k liquid SOLA (votes as an ordinary user).
const FOUNDER_OPS_WALLET = new PublicKey("CL4yt4Ep6N3AKbbHhQaidjVLNzQrdgT5NobQSE6FGHr3");
const SQUADS_VAULT   = new PublicKey("BxYTiKyDxWpK4hPDZEiYVW9qBj8YpzhSHEBCWpaZbWQ4");

// ── PDAs ──────────────────────────────────────────────────────────────────────

const [statePda]      = PublicKey.findProgramAddressSync([Buffer.from("state")],              PROGRAM_ID);
const [solaMint]      = PublicKey.findProgramAddressSync([Buffer.from("sola_mint")],          PROGRAM_ID);
const [hiSolaMint]    = PublicKey.findProgramAddressSync([Buffer.from("hi_sola_mint")],       PROGRAM_ID);
const [oSolaMint]     = PublicKey.findProgramAddressSync([Buffer.from("o_sola_mint")],        PROGRAM_ID);
const [floorVault]    = PublicKey.findProgramAddressSync([Buffer.from("floor_vault")],        PROGRAM_ID);
const [marketVault]   = PublicKey.findProgramAddressSync([Buffer.from("market_vault")],       PROGRAM_ID);
const [solaVault]     = PublicKey.findProgramAddressSync([Buffer.from("sola_vault")],         PROGRAM_ID);
const [hiVestingPda]  = PublicKey.findProgramAddressSync([Buffer.from("founder_hi_vesting")], PROGRAM_ID);
const [oVestingPda]   = PublicKey.findProgramAddressSync([Buffer.from("founder_vesting")],    PROGRAM_ID);

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8")))
  );

  const conn     = new anchor.web3.Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const wallet   = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const program  = new anchor.Program(idl as any, provider);

  console.log("\n🚀 Soladrome mainnet init");
  console.log("   Deployer  :", kp.publicKey.toBase58());
  console.log("   Program   :", PROGRAM_ID.toBase58());
  console.log("   USDC mint :", USDC_MINT.toBase58());
  console.log("   SOL balance:", (await conn.getBalance(kp.publicKey)) / 1e9, "SOL\n");

  const state = await (program.account as any).protocolState
    .fetchNullable(statePda)
    .catch(() => null);

  // ── Step 1 : initialize ────────────────────────────────────────────────────
  if (!state) {
    console.log("Step 1/3 — initialize...");
    const tx = await program.methods
      .initialize()
      .accounts({
        authority:     kp.publicKey,
        usdcMint:      USDC_MINT,
        protocolState: statePda,
        solaMint,
        hiSolaMint,
        oSolaMint,
        floorVault,
        marketVault,
        solaVault,
        tokenProgram:  TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent:          SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
    console.log("   ✅ initialize — tx:", tx);
  } else {
    console.log("Step 1/3 — initialize: already done, skipping.");
  }

  const freshState = await (program.account as any).protocolState.fetch(statePda);

  // ── Step 2 : mint_founder_allocation ──────────────────────────────────────
  if (!freshState.founderAllocated) {
    console.log("\nStep 2/3 — mint_founder_allocation (starts vesting clock)...");
    const tx = await program.methods
      .mintFounderAllocation()
      .accounts({
        authority:        kp.publicKey,
        protocolState:    statePda,
        founder:          FOUNDER_WALLET,
        founderHiVesting: hiVestingPda,
        founderVesting:   oVestingPda,
        systemProgram:    SystemProgram.programId,
        rent:             SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
    console.log("   ✅ mint_founder_allocation — tx:", tx);
    console.log("   Vesting clock started — cliff: 6 months, linear: 24 months");
  } else {
    console.log("\nStep 2/3 — mint_founder_allocation: already done, skipping.");
  }

  // ── Step 3 : mint_ecosystem_allocation ────────────────────────────────────
  if (!freshState.ecosystemAllocated) {
    console.log("\nStep 3/3 — mint_ecosystem_allocation...");

    // ATAs computed client-side (init_if_needed on-chain handles creation)
    const authoritySola = getAssociatedTokenAddressSync(solaMint, kp.publicKey);
    const founderOpsSola = getAssociatedTokenAddressSync(solaMint, FOUNDER_OPS_WALLET);

    const tx = await program.methods
      .mintEcosystemAllocation()
      .accounts({
        authority:              kp.publicKey,
        protocolState:          statePda,
        solaMint,
        authoritySola,
        founderOps:             FOUNDER_OPS_WALLET,
        founderOpsSola,
        tokenProgram:           TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:          SystemProgram.programId,
        rent:                   SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
    console.log("   ✅ mint_ecosystem_allocation — tx:", tx);
    console.log("   → Authority wallet : 1 750 000 SOLA (marketing + airdrop)");
    console.log("   → Founder ops wallet:  250 000 SOLA (immediate income, votes as user)");
  } else {
    console.log("\nStep 3/3 — mint_ecosystem_allocation: already done, skipping.");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n────────────────────────────────────────");
  console.log("✅ Init sequence complete.");
  console.log("\n⚠️  NEXT STEP (manual, via Squads proposal):");
  console.log("   transfer_authority → Squads vault");
  console.log("  ", SQUADS_VAULT.toBase58());
  console.log("\n   Only do this after confirming all 3 steps on-chain.");
  console.log("   After transfer, all admin instructions require Squads multisig.");
  console.log("────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error("❌ Init failed:", err);
  process.exit(1);
});
