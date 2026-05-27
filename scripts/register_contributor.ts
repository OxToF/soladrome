/**
 * register_contributor.ts
 * Register a marketing / contributor wallet with an oSOLA vesting allocation.
 * Creates ContributorVesting PDA — callable once per wallet (re-run = error).
 * Vesting starts immediately at registration time.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/register_contributor.ts \
 *     -- <wallet_address> <amount_osola_ui>
 *
 * Examples:
 *   # Register CM1 with 500 000 oSOLA (6 dec → 500_000_000_000 raw)
 *   yarn run ts-mocha ... -- 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU 500000
 *
 *   # Re-running for an already-registered wallet will fail with ConstraintSeeds.
 *   # That's expected — each wallet can only be registered once.
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
  const contributorStr = rawArgs[0];
  const amountUi       = parseFloat(rawArgs[1]);

  before(function () {
    if (!contributorStr || isNaN(amountUi) || amountUi <= 0) {
      console.error("Usage: scripts/register_contributor.ts -- <wallet_address> <amount_osola_ui>");
      console.error("Example: ... -- 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU 500000");
      this.skip();
    }
  });

  it("registers the contributor on-chain", async function () {
    if (!contributorStr || isNaN(amountUi) || amountUi <= 0) this.skip();

    const program = anchor.workspace.Soladrome
      ?? new anchor.Program(require("../target/idl/soladrome.json"), provider);

    const contributorWallet = new PublicKey(contributorStr);
    const totalAmount       = new anchor.BN(Math.floor(amountUi * 10 ** DECIMALS));

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
      .registerContributor(totalAmount)
      .accounts({
        authority:          provider.wallet.publicKey,
        protocolState:      statePda,
        contributorWallet:  contributorWallet,
        contributorVesting: contributorVesting,
        systemProgram:      SystemProgram.programId,
        rent:               SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    console.log(`✅ Contributor registered!`);
    console.log(`   Wallet:      ${contributorStr}`);
    console.log(`   oSOLA:       ${amountUi.toLocaleString()} oSOLA`);
    console.log(`   Vesting PDA: ${contributorVesting.toBase58()}`);
    console.log(`   TX:          ${tx}`);
    console.log(`   Cliff:       1 h devnet (→ 1 month mainnet)`);
    console.log(`   Duration:    12 h devnet (→ 12 months mainnet)`);
    console.log(`   Borrow cap:  10% of claimed oSOLA at any time`);
    console.log(`   → The contributor can now see 🤝 My Allocation on soladrome.finance`);
  });
});
