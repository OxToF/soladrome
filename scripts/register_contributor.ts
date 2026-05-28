/**
 * register_contributor.ts
 * Register a contributor wallet with dual hiSOLA + oSOLA vesting allocation.
 * Creates ContributorVesting PDA — callable once per wallet (re-run = error).
 * Vesting starts immediately at registration time.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/register_contributor.ts \
 *     -- <wallet_address> <hi_sola_amount_ui> <o_sola_amount_ui>
 *
 * Examples:
 *   # Register CM1 with 120 000 hiSOLA + 80 000 oSOLA
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/register_contributor.ts \
 *     -- 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU 120000 80000
 *
 *   # Re-running for an already-registered wallet will skip (guard check) or fail with ConstraintSeeds.
 *   # That's expected — each wallet can only be registered once.
 *
 * Amounts:
 *   <hi_sola_amount_ui>  — hiSOLA allocation (governance + borrow collateral)
 *   <o_sola_amount_ui>   — oSOLA allocation  (liquid options, exercisable at floor price)
 *
 * Vesting schedule (devnet):
 *   Cliff:    1 h → 1 month mainnet
 *   Duration: 12 h → 12 months mainnet  (linear after cliff)
 *
 * Borrow cap (hiSOLA tranche):
 *   max_borrow = hi_sola_claimed × 10%  (dynamic — scales with vesting progress)
 *   e.g. after claiming 10 000 hiSOLA → cap = 1 000 USDC
 *   After full vest (120 000 hiSOLA) → cap = 12 000 USDC
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";

const PROGRAM_ID        = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const CONTRIBUTOR_SEED  = Buffer.from("contributor");
const DECIMALS          = 6;

describe("register_contributor (one-shot)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // ── Parse args passed after "--" ────────────────────────────────────────────
  // When run via ts-mocha the extra args are in process.argv after "--"
  const rawArgs = process.argv.slice(process.argv.indexOf("--") + 1).filter(Boolean);
  const contributorStr   = rawArgs[0];
  const hiSolaUi         = parseFloat(rawArgs[1]);
  const oSolaUi          = parseFloat(rawArgs[2]);

  before(function () {
    if (!contributorStr || isNaN(hiSolaUi) || hiSolaUi <= 0 || isNaN(oSolaUi) || oSolaUi < 0) {
      console.error("Usage: scripts/register_contributor.ts -- <wallet_address> <hi_sola_amount_ui> <o_sola_amount_ui>");
      console.error("Example: ... -- 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU 120000 80000");
      this.skip();
    }
  });

  it("registers the contributor on-chain", async function () {
    if (!contributorStr || isNaN(hiSolaUi) || hiSolaUi <= 0 || isNaN(oSolaUi) || oSolaUi < 0) this.skip();

    const program = anchor.workspace.Soladrome
      ?? new anchor.Program(require("../target/idl/soladrome.json"), provider);

    const contributorWallet = new PublicKey(contributorStr);
    const hiSolaAmount      = new anchor.BN(Math.floor(hiSolaUi * 10 ** DECIMALS));
    const oSolaAmount       = new anchor.BN(Math.floor(oSolaUi  * 10 ** DECIMALS));

    const [statePda]           = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
    const [contributorVesting] = PublicKey.findProgramAddressSync(
      [CONTRIBUTOR_SEED, contributorWallet.toBuffer()],
      PROGRAM_ID
    );

    // Guard: already registered?
    const existing = await provider.connection.getAccountInfo(contributorVesting);
    if (existing) {
      console.log(`⚠️  Wallet ${contributorStr.slice(0, 8)}… is already registered — skipping.`);
      return;
    }

    const tx = await program.methods
      .registerContributor(hiSolaAmount, oSolaAmount)
      .accounts({
        authority:          provider.wallet.publicKey,
        protocolState:      statePda,
        contributorWallet:  contributorWallet,
        contributorVesting: contributorVesting,
        systemProgram:      SystemProgram.programId,
        rent:               SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const maxBorrowAtFullVest = hiSolaUi * 0.10; // 10% of total allocation

    console.log(`✅ Contributor registered!`);
    console.log(`   Wallet:           ${contributorStr}`);
    console.log(`   hiSOLA:           ${hiSolaUi.toLocaleString()} hiSOLA  (governance + borrow collateral)`);
    console.log(`   oSOLA:            ${oSolaUi.toLocaleString()} oSOLA   (liquid options at floor price)`);
    console.log(`   Borrow cap:       dynamic — 10% of claimed hiSOLA at borrow time`);
    console.log(`   Max borrow cap:   ${maxBorrowAtFullVest.toLocaleString(undefined, {maximumFractionDigits: 2})} USDC (after full vest)`);
    console.log(`   Vesting PDA:   ${contributorVesting.toBase58()}`);
    console.log(`   TX:            ${tx}`);
    console.log(`   Cliff:         1 h devnet (→ 1 month mainnet)`);
    console.log(`   Duration:      12 h devnet (→ 12 months mainnet)`);
    console.log(`   → The contributor will see 🤝 My Allocation on soladrome.finance after cliff`);
  });
});
