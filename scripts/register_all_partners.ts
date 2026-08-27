/**
 * register_all_partners.ts
 * Authority-only: register Jito, Marinade and Solayer as Soladrome protocol partners.
 *
 * Each partner gets a signature bag and then a RETAINER (2026-08-27):
 *   - a one-off `base_hi_sola` bag, delivered whole once they escrow their bribe schedule
 *   - then `retainer_per_epoch` hiSOLA for every epoch they still hold `lp_threshold` of
 *     `lp_mint`, cranked by anyone through crank_partner_epoch — no total, no cap, no end date
 *   - the bribe schedule is escrowed once (fund_partner_bribe_stream) and pays one tranche
 *     per epoch to the gauge; it is the commitment the bag is released against
 *   - everything credited is permanent: it votes, earns fees and borrows at 20%, and can
 *     never be unlocked, unstaked or sold at a floor it never financed
 *
 * The partner then escrows their schedule and claims the bag from the Partner tab.
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

const PROGRAM_ID     = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");
const PARTNER_SEED   = Buffer.from("partner");
const DECIMALS       = 6;

// ── Lock schedule ─────────────────────────────────────────────────────────────

// One binary since 2026-08-23: EPOCH_DURATION is 604 800 on every cluster. The devnet
// 1-hour variant this script carried was a leftover of the `devnet` feature, and it would
// have written a lock term four hundred times shorter than the one negotiated.
const EPOCH_DURATION = 604_800; // 7 days, everywhere
const LOCK_EPOCHS            = 208;     // ≈ 4 years on mainnet (= MAX_LOCK_DURATION, full 4× ve-power)
// The bribe rhythm, fixed at registration: fund_partner_bribe_stream refuses any other length.
const SCHEDULE_EPOCHS        = 52;      // one year

// ── Partners ─────────────────────────────────────────────────────────────────
// ⚠️  Confirm each wallet address with the protocol team before running.
//     The wallet listed here is the one that must sign claim_partner_allocation.

// The tiers settled 2026-08-26 — 10 / 15 / 20 % of the committed LP over a year of maintained
// liquidity, and monotone, unlike the 10/24/25 % gradient they replaced (which gave a partner no
// reason to double their liquidity from T2 to T1):
//
//   T1  1 000 000 LP → 20 000 bag + 3 450/epoch     T3  200 000 LP → 2 000 bag + 350/epoch
//   T2    500 000 LP →  7 500 bag + 1 300/epoch
//
// ⚠️ `lpThresholdUi` is in the LP MINT's units, and the tier is negotiated in dollars. There is
// no oracle: what gets frozen on-chain is the LP token count that matched the agreed size on the
// day. Imprecise on value, exact on "did they withdraw".
// ⚠️ `minBribePerEpochUi` is in the BRIBE MINT's units and must be set from that mint's decimals
// — this script reads them from the chain rather than assuming 6.
const PARTNERS: {
  name: string;
  wallet: string;
  bribeMint: string;
  lpMint: string;
  lpThresholdUi: number;
  baseHiSolaUi: number;
  retainerUi: number;
  minBribePerEpochUi: number;
}[] = [
  {
    name:        "Jito",
    wallet:      "TODO_JITO_WALLET",        // ← Jito team multisig / contact wallet
    bribeMint:   "TODO_JITO_BRIBE_MINT",    // ← e.g. JTO mint, or a USDC mint
    lpMint:      "TODO_JITO_LP_MINT",       // ← LP mint of the pool they seed (jitoSOL/USDC)
    lpThresholdUi: 1_000_000,
    baseHiSolaUi: 20_000, retainerUi: 3_450, minBribePerEpochUi: 300,
  },
  {
    name:        "Marinade",
    wallet:      "TODO_MARINADE_WALLET",
    bribeMint:   "TODO_MARINADE_BRIBE_MINT", // ← e.g. MNDE mint, or a USDC mint
    lpMint:      "TODO_MARINADE_LP_MINT",
    lpThresholdUi: 500_000,
    baseHiSolaUi: 7_500, retainerUi: 1_300, minBribePerEpochUi: 150,
  },
  {
    name:        "Solayer",
    wallet:      "TODO_SOLAYER_WALLET",
    bribeMint:   "TODO_SOLAYER_BRIBE_MINT",
    lpMint:      "TODO_SOLAYER_LP_MINT",
    lpThresholdUi: 200_000,
    baseHiSolaUi: 2_000, retainerUi: 350, minBribePerEpochUi: 60,
  },
];

/// Decimals from the chain, never assumed. A 9-decimal mint read as 6 puts an immutable
/// threshold out by 1000×, in the direction that makes the condition meaningless.
async function mintDecimals(
  conn: anchor.web3.Connection, mint: PublicKey
): Promise<number> {
  const info = await conn.getParsedAccountInfo(mint);
  const dec = (info.value?.data as any)?.parsed?.info?.decimals;
  if (typeof dec !== "number") throw new Error(`${mint.toBase58()} is not an SPL mint`);
  return dec;
}

/// Whole-token string → base units, without parseFloat: these figures are written once and
/// can never be edited, and `x * 10 ** d` silently rounds past 2^53.
function toBase(ui: number, decimals: number): anchor.BN {
  const s = ui.toString();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a plain amount: ${s}`);
  const [whole = "", frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`${s} has more decimals than the mint`);
  return new anchor.BN(whole + (frac + "0".repeat(decimals)).slice(0, decimals));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Validate partner addresses before doing anything
  const todos = PARTNERS.filter(
    p => p.wallet.startsWith("TODO_") || p.bribeMint.startsWith("TODO_") ||
         p.lpMint.startsWith("TODO_")
  );
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
  const lockDurationSecs = new anchor.BN(LOCK_EPOCHS * EPOCH_DURATION);

  const conn     = new anchor.web3.Connection(rpcUrl, "confirmed");
  const wallet   = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const program  = new anchor.Program(idl as any, provider);

  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);

  const lockLabel = `${LOCK_EPOCHS} epochs = ~4 years`;

  console.log("\n🤝  Soladrome — Register protocol partners");
  console.log("   Authority :", kp.publicKey.toBase58());
  console.log("   Network   :", isDevnet ? "devnet" : "mainnet-beta");
  console.log("   Lock      :", lockLabel);
  console.log("   Model     : signature bag, then a retainer per epoch of maintained LP\n");

  let registered = 0;
  let skipped    = 0;

  for (const partner of PARTNERS) {
    const partnerWallet = new PublicKey(partner.wallet);
    const bribeMint     = new PublicKey(partner.bribeMint);
    const lpMint        = new PublicKey(partner.lpMint);
    const baseHiSola    = toBase(partner.baseHiSolaUi, DECIMALS);
    const retainer      = toBase(partner.retainerUi, DECIMALS);
    const lpThreshold   = toBase(partner.lpThresholdUi, await mintDecimals(conn, lpMint));
    const minBribe      = toBase(
      partner.minBribePerEpochUi, await mintDecimals(conn, bribeMint)
    );

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
        .registerPartner(
          bribeMint, lpMint, lpThreshold, retainer, baseHiSola, lockDurationSecs,
          new anchor.BN(SCHEDULE_EPOCHS), minBribe
        )
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
