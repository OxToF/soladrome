/**
 * register_all_partners.ts
 * Authority-only: register Jito, Marinade and Solayer as Soladrome protocol partners.
 *
 * Each partner gets a STREAMING, bribe-indexed allocation:
 *   - earns locked hiSOLA = min(cap, bribed × rate) as they deposit bribes (partner_deposit_bribe.ts)
 *   - cap + bribe_mint + rate are negotiated per partner (see PARTNERS config below)
 *   - lock = 104 epochs (≈ 24 months mainnet) — the max lock, full 4× ve-power
 *   - hiSOLA minted directly to ve_lock_vault on claim → wallet never receives it → borrow blocked
 *   - no bribe → no allocation → no voting power (self-aligning)
 *
 * The partner must then run scripts/claim_partner.ts (signed by their own wallet) to execute
 * the actual on-chain lock.
 *
 * ── Before running ────────────────────────────────────────────────────────────
 *  1. Confirm the correct partner wallet addresses below (see PARTNERS config).
 *     Each wallet is the one that will sign claim_partner_allocation.
 *  2. Make sure the protocol is initialized (init_mainnet.ts done).
 *  3. Make sure the authority wallet has SOL for rent.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   Mainnet:
 *     ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *     ANCHOR_WALLET=~/.config/solana/id.json \
 *     npx ts-node scripts/register_all_partners.ts
 *
 *   Devnet (test — 1h epochs):
 *     ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *     ANCHOR_WALLET=~/.config/solana/id.json \
 *     npx ts-node scripts/register_all_partners.ts
 *
 * ── After this script ─────────────────────────────────────────────────────────
 *   Each protocol must run scripts/claim_partner.ts from their own wallet.
 *   Share that script + instructions with each partner contact.
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Keypair } from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import idl from "../app/lib/soladrome.json";

// ── Program ───────────────────────────────────────────────────────────────────

const PROGRAM_ID     = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const PARTNER_SEED   = Buffer.from("partner");
const DECIMALS       = 6;

// ── Lock schedule ─────────────────────────────────────────────────────────────

const EPOCH_DURATION_MAINNET = 604_800; // 7 days in seconds
const EPOCH_DURATION_DEVNET  =   3_600; // 1 hour in seconds
const LOCK_EPOCHS            = 104;     // ≈ 24 months on mainnet (= MAX_LOCK_DURATION, full 4× ve-power)

// ── Partners ─────────────────────────────────────────────────────────────────
// ⚠️  Confirm each wallet address with the protocol team before running.
//     The wallet listed here is the one that must sign claim_partner_allocation.

// capHiSolaUi = max hiSOLA earnable (= negotiated commitment / cap).
// bribeMint   = token the partner commits to bribe with — ONLY this mint credits.
// rateNum/rateDen = hiSOLA per bribe base-unit (1/1 = 1:1 "Real Deal").
const PARTNERS: {
  name: string;
  wallet: string;
  bribeMint: string;
  capHiSolaUi: number;
  rateNum: number;
  rateDen: number;
}[] = [
  {
    name:        "Jito",
    wallet:      "TODO_JITO_WALLET",        // ← Jito team multisig / contact wallet
    bribeMint:   "TODO_JITO_BRIBE_MINT",    // ← e.g. JTO mint, or a USDC mint
    capHiSolaUi: 100_000,
    rateNum: 1, rateDen: 1,
  },
  {
    name:        "Marinade",
    wallet:      "TODO_MARINADE_WALLET",
    bribeMint:   "TODO_MARINADE_BRIBE_MINT", // ← e.g. MNDE mint, or a USDC mint
    capHiSolaUi: 100_000,
    rateNum: 1, rateDen: 1,
  },
  {
    name:        "Solayer",
    wallet:      "TODO_SOLAYER_WALLET",
    bribeMint:   "TODO_SOLAYER_BRIBE_MINT",
    capHiSolaUi: 100_000,
    rateNum: 1, rateDen: 1,
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Validate partner addresses before doing anything
  const todos = PARTNERS.filter(p => p.wallet.startsWith("TODO_") || p.bribeMint.startsWith("TODO_"));
  if (todos.length > 0) {
    console.error("\n❌  Missing wallet addresses for:");
    todos.forEach(p => console.error(`   ${p.name}: ${p.wallet}`));
    console.error("\n   Update PARTNERS config in this script then re-run.\n");
    process.exit(1);
  }

  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8")))
  );

  const rpcUrl   = process.env.ANCHOR_PROVIDER_URL ?? "https://api.mainnet-beta.solana.com";
  const isDevnet = rpcUrl.includes("devnet");
  const epochDuration = isDevnet ? EPOCH_DURATION_DEVNET : EPOCH_DURATION_MAINNET;
  const lockDurationSecs = new anchor.BN(LOCK_EPOCHS * epochDuration);

  const conn     = new anchor.web3.Connection(rpcUrl, "confirmed");
  const wallet   = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const program  = new anchor.Program(idl as any, provider);

  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);

  const lockLabel = isDevnet
    ? `${LOCK_EPOCHS} epochs = ${LOCK_EPOCHS}h (devnet)`
    : `${LOCK_EPOCHS} epochs = ~24 months (mainnet)`;

  console.log("\n🤝  Soladrome — Register protocol partners");
  console.log("   Authority :", kp.publicKey.toBase58());
  console.log("   Network   :", isDevnet ? "devnet" : "mainnet-beta");
  console.log("   Lock      :", lockLabel);
  console.log("   Model     : streaming — earn locked hiSOLA = min(cap, bribed × rate)\n");

  let registered = 0;
  let skipped    = 0;

  for (const partner of PARTNERS) {
    const partnerWallet = new PublicKey(partner.wallet);
    const bribeMint     = new PublicKey(partner.bribeMint);
    const capHiSola     = new anchor.BN(Math.floor(partner.capHiSolaUi * 10 ** DECIMALS));

    const [partnerAllocation] = PublicKey.findProgramAddressSync(
      [PARTNER_SEED, partnerWallet.toBuffer()],
      PROGRAM_ID
    );

    // Skip if already registered
    const existing = await conn.getAccountInfo(partnerAllocation);
    if (existing) {
      console.log(`[skip] ${partner.name.padEnd(10)} already registered — skipping`);
      skipped++;
      continue;
    }

    try {
      const tx = await program.methods
        .registerPartner(bribeMint, new anchor.BN(partner.rateNum), new anchor.BN(partner.rateDen), capHiSola, lockDurationSecs)
        .accounts({
          authority:        kp.publicKey,
          protocolState:    statePda,
          partnerWallet,
          partnerAllocation,
          systemProgram:    SystemProgram.programId,
          rent:             SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();

      console.log(`[ok]   ${partner.name.padEnd(10)} registered`);
      console.log(`    Wallet : ${partner.wallet}`);
      console.log(`    PDA    : ${partnerAllocation.toBase58()}`);
      console.log(`    TX     : ${tx}\n`);
      registered++;

    } catch (err: any) {
      console.error(`[err]  ${partner.name} — TX failed: ${err.message ?? err}\n`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log("─".repeat(60));
  console.log(`   Registered : ${registered} / ${PARTNERS.length}`);
  if (skipped > 0) console.log(`   Skipped    : ${skipped} (already on-chain)`);
  console.log("");
  if (registered > 0) {
    console.log("📋  Next steps (streaming flow):");
    console.log("    1. Partner deposits bribes via scripts/partner_deposit_bribe.ts (signed by them).");
    console.log("    2. Partner runs scripts/claim_partner.ts → mints the EARNED tranche of locked hiSOLA.");
    console.log("    3. Repeat: more bribes → more claimable hiSOLA, up to the cap.");
    console.log("    4. Borrow stays blocked while locked; unlock_hi_sola after lock expiry.\n");
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
