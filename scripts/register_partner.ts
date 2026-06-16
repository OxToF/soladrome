/**
 * register_partner.ts
 * Authority-only: register a protocol partner for a STREAMING, bribe-indexed allocation.
 * The partner earns locked hiSOLA proportionally to the bribes they actually deposit
 * (via partner_deposit_bribe.ts), bounded by a cap:  entitled = min(cap, bribed × rate).
 * No bribe → no allocation → no voting power. They then run claim_partner.ts to mint the
 * earned tranche into ve_lock_vault (wallet never receives it → borrow blocked during lock).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   PARTNER=<wallet> BRIBE_MINT=<mint> AMOUNT=<cap_hi_sola_ui> EPOCHS=<lock_epochs> \
 *   [RATE_NUM=1 RATE_DEN=1] \
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/register_partner.ts
 *
 * Example (USDC bribe, 1:1 "Real Deal", cap 500k hiSOLA, 104-epoch / ~24-month lock):
 *   PARTNER=<wallet> BRIBE_MINT=EPjFWdd5...USDC AMOUNT=500000 EPOCHS=104
 *
 *   rate = RATE_NUM/RATE_DEN  hiSOLA per bribe base-unit (1:1 default).
 *   Lock = <lock_epochs> × EPOCH_DURATION  (min 1, max 104 epochs; 1 epoch = 604 800 s).
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";

// Known protocol partners — use PARTNER=<key> or set PARTNER=marinade etc.
// Addresses sourced from official docs / on-chain verification (Arkham confirmed).
const KNOWN_PARTNERS: Record<string, string> = {
  // Marinade Finance — DAO Treasury (Realms-controlled, mainnet)
  // Source: https://docs.marinade.finance  |  Arkham: B56RWQ…
  marinade: "B56RWQGf9RFw7t8gxPzrRvk5VRmB5DoF94aLoJ25YtvG",
};

const PROGRAM_ID     = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const PARTNER_SEED   = Buffer.from("partner");
const EPOCH_DURATION = 7 * 24 * 60 * 60; // 604 800 s — mirrors state.rs EPOCH_DURATION
const DECIMALS       = 6;

describe("register_partner (one-shot)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const partnerRaw = process.env.PARTNER ?? "";
  const partnerStr = KNOWN_PARTNERS[partnerRaw.toLowerCase()] ?? partnerRaw;
  const hiSolaUi     = parseFloat(process.env.AMOUNT ?? "0"); // cap = max hiSOLA earnable
  const lockEpochs   = parseInt(process.env.EPOCHS  ?? "1", 10);
  const bribeMintStr = process.env.BRIBE_MINT ?? "";              // committed bribe token (e.g. USDC mint)
  const rateNum      = parseInt(process.env.RATE_NUM ?? "1", 10); // rate = RATE_NUM/RATE_DEN (1:1 default)
  const rateDen      = parseInt(process.env.RATE_DEN ?? "1", 10);

  before(function () {
    if (!partnerStr || !bribeMintStr || isNaN(hiSolaUi) || hiSolaUi <= 0 || isNaN(lockEpochs) || lockEpochs < 1 || rateNum < 1 || rateDen < 1) {
      console.error("Usage: PARTNER=<wallet> BRIBE_MINT=<mint> AMOUNT=<cap_hi_sola_ui> EPOCHS=<lock_epochs> [RATE_NUM=1 RATE_DEN=1] yarn ts-mocha ... register_partner.ts");
      this.skip();
    }
  });

  it("registers the partner on-chain", async function () {
    if (!partnerStr || !bribeMintStr || isNaN(hiSolaUi) || hiSolaUi <= 0) this.skip();

    const program = anchor.workspace.Soladrome
      ?? new anchor.Program(require("../target/idl/soladrome.json"), provider);

    const partnerWallet   = new PublicKey(partnerStr);
    const bribeMint       = new PublicKey(bribeMintStr);
    const capHiSola       = new anchor.BN(Math.floor(hiSolaUi * 10 ** DECIMALS));
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
      .registerPartner(bribeMint, new anchor.BN(rateNum), new anchor.BN(rateDen), capHiSola, lockDurationSecs)
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
