/**
 * register_partner.ts
 * Authority-only: register a protocol partner with a one-time locked hiSOLA allocation.
 * Unlike contributors (cliff + linear), the partner claims the full amount at once —
 * hiSOLA goes directly to ve_lock_vault (wallet never receives it → borrow blocked during lock).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   PARTNER=<wallet_address> AMOUNT=<hi_sola_ui> EPOCHS=<lock_epochs> \
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/register_partner.ts
 *
 * Examples (devnet — EPOCH_DURATION = 3 600 s / 1 h):
 *   PARTNER=HMY1hCg2aVpKLmXGiiEqVFDMTstPfcxji7zNf8UPRvtb AMOUNT=500000 EPOCHS=1 \
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/register_partner.ts
 *
 * Lock duration:
 *   <lock_epochs> × EPOCH_DURATION  (min: 1, max: 104)
 *   1 epoch = 604 800 s (7 days)
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";

const PROGRAM_ID     = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const PARTNER_SEED   = Buffer.from("partner");
const EPOCH_DURATION = 7 * 24 * 60 * 60; // 604 800 s — mirrors state.rs EPOCH_DURATION
const DECIMALS       = 6;

describe("register_partner (one-shot)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const partnerStr = process.env.PARTNER ?? "";
  const hiSolaUi   = parseFloat(process.env.AMOUNT ?? "0");
  const lockEpochs = parseInt(process.env.EPOCHS  ?? "1", 10);

  before(function () {
    if (!partnerStr || isNaN(hiSolaUi) || hiSolaUi <= 0 || isNaN(lockEpochs) || lockEpochs < 1) {
      console.error("Usage: PARTNER=<wallet> AMOUNT=<hi_sola_ui> EPOCHS=<lock_epochs> yarn ts-mocha ... register_partner.ts");
      this.skip();
    }
  });

  it("registers the partner on-chain", async function () {
    if (!partnerStr || isNaN(hiSolaUi) || hiSolaUi <= 0) this.skip();

    const program = anchor.workspace.Soladrome
      ?? new anchor.Program(require("../target/idl/soladrome.json"), provider);

    const partnerWallet   = new PublicKey(partnerStr);
    const hiSolaAmount    = new anchor.BN(Math.floor(hiSolaUi * 10 ** DECIMALS));
    const lockDurationSecs = new anchor.BN(lockEpochs * EPOCH_DURATION);

    const [statePda]         = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
    const [partnerAllocation] = PublicKey.findProgramAddressSync(
      [PARTNER_SEED, partnerWallet.toBuffer()],
      PROGRAM_ID
    );

    // Guard: already registered?
    const existing = await provider.connection.getAccountInfo(partnerAllocation);
    if (existing) {
      console.log(`⚠️  Wallet ${partnerStr.slice(0, 8)}… is already registered as partner — skipping.`);
      return;
    }

    const tx = await program.methods
      .registerPartner(hiSolaAmount, lockDurationSecs)
      .accounts({
        authority:        provider.wallet.publicKey,
        protocolState:    statePda,
        partnerWallet:    partnerWallet,
        partnerAllocation,
        systemProgram:    SystemProgram.programId,
        rent:             SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const lockHours = (lockEpochs * EPOCH_DURATION) / 3600;
    const maxBorrow = hiSolaUi * 0.10;

    console.log(`✅ Partner registered!`);
    console.log(`   Wallet:           ${partnerStr}`);
    console.log(`   hiSOLA:           ${hiSolaUi.toLocaleString()} hiSOLA (locked, minted to ve_lock_vault)`);
    console.log(`   Lock duration:    ${lockEpochs} epoch(s) = ${lockHours}h (devnet)`);
    console.log(`   Borrow:           blocked during lock — wallet hiSOLA balance stays 0`);
    console.log(`   After unlock:     max borrow = ${maxBorrow.toLocaleString()} USDC (10% of allocation)`);
    console.log(`   Allocation PDA:   ${partnerAllocation.toBase58()}`);
    console.log(`   TX:               ${tx}`);
    console.log(`   → Partner must now run scripts/claim_partner.ts to lock their hiSOLA`);
  });
});
