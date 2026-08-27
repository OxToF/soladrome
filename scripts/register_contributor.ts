/**
 * register_contributor.ts
 * Register a contributor wallet with a dual hiSOLA + oSOLA allocation. Creates the
 * ContributorVesting PDA — `init`, so one wallet cannot be registered twice.
 *
 * ⚠️ There is no vesting, despite the account's name: the cliff and the linear schedule were
 * removed on 2026-07-18 and both tranches are claimable in full immediately.
 *
 * Two rules the program enforces since 2026-08-27, and the reason this script can now be
 * refused where it used to succeed:
 *   - the split must be exactly 50/50 (HI === OSOLA)
 *   - the CUMULATIVE total across every contributor ever registered is capped at 100 000 of
 *     each, counted in a `contributor_registry` singleton. There was no bound before; the only
 *     limit on what could be promised was the field the operator typed into.
 *
 * The Founder panel's Register Contributor form does the same thing with both figures restated
 * on screen before signing, and should be preferred; this exists for headless runs.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   CONTRIBUTOR=<wallet_address> HI=<hi_sola_ui> OSOLA=<o_sola_ui> \
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/register_contributor.ts
 *
 * Example:
 *   CONTRIBUTOR=JAfXUr5WNpj4wTeWAQ9KXmj9zRjBESTdgviAo1LLNrFn HI=10000 OSOLA=10000 \
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/register_contributor.ts
 *
 * The two tranches are not the same instrument:
 *   HI    — hiSOLA into a LIFETIME ve lock. Never unlockable, never sellable. It votes (up to
 *           4×), borrows 20% via borrow_against_locked, and earns a real share of protocol
 *           fees for life — that yield is the actual compensation, since the bag itself can
 *           never be sold.
 *   OSOLA — an option, not a payment. Exercising burns it and pays 1 USDC per unit into the
 *           floor, so the contributor finances every SOLA they take. Worth nothing at or
 *           below the floor.
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";

const PROGRAM_ID        = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");
const CONTRIBUTOR_SEED  = Buffer.from("contributor");
const DECIMALS          = 6;

describe("register_contributor (one-shot)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const contributorStr = process.env.CONTRIBUTOR ?? "";
  const hiSolaUi       = parseFloat(process.env.HI    ?? "0");
  const oSolaUi        = parseFloat(process.env.OSOLA ?? "0");

  before(function () {
    if (!contributorStr || isNaN(hiSolaUi) || hiSolaUi <= 0 || isNaN(oSolaUi) || oSolaUi < 0) {
      console.error("Usage: CONTRIBUTOR=<wallet> HI=<hi_sola_ui> OSOLA=<o_sola_ui> yarn ts-mocha ... register_contributor.ts");
      this.skip();
    }
    // Refused on-chain as ContributorSplitMismatch — say so here rather than spend a signature
    // discovering it.
    if (hiSolaUi !== oSolaUi) {
      console.error(`❌ The split is 50/50 and enforced on-chain: HI=${hiSolaUi} but OSOLA=${oSolaUi}.`);
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
        contributorRegistry: PublicKey.findProgramAddressSync(
          [Buffer.from("contributor_registry")], PROGRAM_ID
        )[0],
        systemProgram:      SystemProgram.programId,
        rent:               SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    console.log(`✅ Contributor registered!`);
    console.log(`   Wallet:        ${contributorStr}`);
    console.log(`   hiSOLA:        ${hiSolaUi.toLocaleString()} — lifetime ve lock: votes, earns protocol fees, borrows 20%`);
    console.log(`   oSOLA:         ${oSolaUi.toLocaleString()} — an option, exercised at 1 USDC each into the floor`);
    console.log(`   Vesting PDA:   ${contributorVesting.toBase58()}`);
    console.log(`   TX:            ${tx}`);
    console.log(`   No cliff, no vesting — both tranches are claimable in full immediately`);
    console.log(`   (removed 2026-07-18; the account name is the last trace of it)`);
    console.log(`   → The contributor claims from 🤝 My Allocation on soladrome.finance`);
  });
});
