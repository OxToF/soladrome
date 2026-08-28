/**
 * claim_partner.ts
 * Partner-only: claim the signature bag, once, whole.
 *
 * ⚠️ This script had been broken since hiSOLA became a position rather than a token
 * (2026-08-21): it still passed `hiSolaMint` and a `ve_lock_vault` that no longer exist, and
 * it computed the claimable amount from a 1:1 bribe rate that was removed on 2026-08-27. Both
 * are gone from here now.
 *
 * The bag is delivered in one call, in full, and only once the partner has escrowed their
 * bribe schedule — the schedule is what it is released against. What they earn for *performing*
 * is the retainer, credited epoch by epoch by `crank_partner_epoch` against their liquidity;
 * this instruction has nothing to do with that.
 *
 * hiSOLA never touches the wallet: it is written straight into the ve lock as
 * `permanent_amount`, so it votes from day one, earns protocol fees for life, borrows at 20%
 * through `borrow_against_locked` — and can never be unlocked, unstaked, or sold.
 *
 * Must be signed by the PARTNER wallet (not the authority).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/partner-id.json \
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/claim_partner.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

const PROGRAM_ID    = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");
const PARTNER_SEED  = Buffer.from("partner");
const VELOCK_SEED   = Buffer.from("velock");
const POSITION_SEED = Buffer.from("position");

describe("claim_partner_allocation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  it("locks the signature bag into the ve position, permanently", async function () {
    this.timeout(60000);

    const program = anchor.workspace.Soladrome
      ?? new anchor.Program(require("../target/idl/soladrome.json"), provider);

    const partnerKey = provider.wallet.publicKey;

    const [statePda]          = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
    const [partnerAllocation] = PublicKey.findProgramAddressSync([PARTNER_SEED,  partnerKey.toBuffer()], PROGRAM_ID);
    const [lockPosition]      = PublicKey.findProgramAddressSync([VELOCK_SEED,   partnerKey.toBuffer()], PROGRAM_ID);
    const [partnerPosition]   = PublicKey.findProgramAddressSync([POSITION_SEED, partnerKey.toBuffer()], PROGRAM_ID);

    const allocInfo = await provider.connection.getAccountInfo(partnerAllocation);
    if (!allocInfo) {
      throw new Error(
        `No partner allocation found for ${partnerKey.toBase58().slice(0, 8)}… — the authority runs register_partner.ts first`
      );
    }

    const state = await (program.account as any).protocolState.fetch(statePda);
    const alloc = await (program.account as any).partnerAllocation.fetch(partnerAllocation);

    if (Number(alloc.streamStartTs) === 0) {
      console.log(
        "⚠️  No bribe schedule escrowed — nothing accrues at all, bag or retainer. " +
        "Fund one from the Partner tab first; the bag is the consideration for it."
      );
      return;
    }
    if (alloc.bagClaimed) {
      console.log("⚠️  The bag has already been claimed — it is a one-off, and this is not it.");
      return;
    }

    const amountUi = Number(alloc.baseHiSola) / 1e6;
    console.log(`\nClaiming ${amountUi.toLocaleString()} hiSOLA — whole, once, permanent.`);

    const tx = await program.methods
      .claimPartnerAllocation()
      .accounts({
        partner:          partnerKey,
        protocolState:    statePda,
        solaMint:         state.solaMint,
        solaVault:        state.solaVault,
        marketVault:      state.marketVault,
        partnerAllocation,
        lockPosition,
        partnerPosition,
        tokenProgram:     TOKEN_PROGRAM_ID,
        systemProgram:    SystemProgram.programId,
        rent:             SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const lock = await (program.account as any).veLockPosition.fetch(lockPosition);
    const pos  = await (program.account as any).userPosition.fetch(partnerPosition);

    console.log(`✅ Signature bag claimed!`);
    console.log(`   hiSOLA locked:   ${Number(lock.amountLocked) / 1e6}`);
    console.log(`   Permanent:       ${Number(lock.permanentAmount) / 1e6} — all of it, never releasable`);
    console.log(`   Fee shares:      ${Number(pos.feeShares) / 1e6} — it earns protocol fees for life`);
    console.log(`   Wallet balance:  ${Number(pos.hiSola) / 1e6} (0 by design — borrow_usdc is blind to it)`);
    console.log(`   VeLockPosition:  ${lockPosition.toBase58()}`);
    console.log(`   TX:              ${tx}`);
    console.log(`   → Voting power is active immediately.`);
    console.log(`   → Liquidity: borrow_against_locked, up to 20%, no interest, no liquidation.`);
    console.log(`   → Each epoch must be cranked, or that epoch's retainer is lost, not deferred.`);
  });
});
