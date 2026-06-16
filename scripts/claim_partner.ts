/**
 * claim_partner.ts
 * Partner-only: claim the one-time hiSOLA allocation.
 * hiSOLA is minted directly to ve_lock_vault — the wallet never receives it.
 * Borrow remains blocked until lock_end_ts passes (call unlock_hi_sola then).
 *
 * Must be signed by the PARTNER wallet (not authority).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/partner-id.json \
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/claim_partner.ts
 *
 * The script reads the partner wallet from ANCHOR_WALLET automatically.
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, TOKEN_PROGRAM_ID, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

const PROGRAM_ID    = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const PARTNER_SEED  = Buffer.from("partner");
const VELOCK_SEED   = Buffer.from("velock");
const VE_VAULT_SEED = Buffer.from("ve_vault");
const POSITION_SEED = Buffer.from("position");

describe("claim_partner_allocation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  it("locks hiSOLA allocation into ve_lock_vault", async function () {
    this.timeout(60000);

    const program = anchor.workspace.Soladrome
      ?? new anchor.Program(require("../target/idl/soladrome.json"), provider);

    const partnerKey = provider.wallet.publicKey;

    const [statePda]         = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
    const [partnerAllocation] = PublicKey.findProgramAddressSync([PARTNER_SEED, partnerKey.toBuffer()], PROGRAM_ID);
    const [lockPosition]     = PublicKey.findProgramAddressSync([VELOCK_SEED,   partnerKey.toBuffer()], PROGRAM_ID);
    const [veLockVault]      = PublicKey.findProgramAddressSync([VE_VAULT_SEED, partnerKey.toBuffer()], PROGRAM_ID);
    const [partnerPosition]  = PublicKey.findProgramAddressSync([POSITION_SEED, partnerKey.toBuffer()], PROGRAM_ID);

    // Pre-checks
    const allocInfo = await provider.connection.getAccountInfo(partnerAllocation);
    if (!allocInfo) {
      throw new Error(`No partner allocation found for ${partnerKey.toBase58().slice(0,8)}… — run register_partner.ts first`);
    }

    const state = await (program.account as any).protocolState.fetch(statePda);
    const alloc = await (program.account as any).partnerAllocation.fetch(partnerAllocation);

    const hiSolaMint = state.hiSolaMint as PublicKey;
    const solaMint   = state.solaMint as PublicKey;

    // Streaming model: claimable = min(cap, credited × rate) − already claimed.
    const credited  = Number(alloc.totalBribedCredited);
    const entitled  = Math.min(
      Number(alloc.capHiSola),
      Math.floor((credited * Number(alloc.rateNum)) / Number(alloc.rateDen)),
    );
    const claimable = entitled - Number(alloc.hiSolaClaimed);
    if (claimable <= 0) {
      console.log("⚠️  Nothing to claim yet — deposit bribes first via partner_deposit_bribe.ts.");
      return;
    }

    const amountUi = claimable / 1e6;
    const lockSecs = Number(alloc.lockDurationSecs);
    console.log(`\nClaiming ${amountUi.toLocaleString()} hiSOLA (earned tranche) → ve_lock_vault (${(lockSecs/3600).toFixed(1)}h lock)`);

    const tx = await program.methods
      .claimPartnerAllocation()
      .accounts({
        partner:          partnerKey,
        protocolState:    statePda,
        solaMint,
        hiSolaMint,
        solaVault:        state.solaVault,
        marketVault:      state.marketVault,
        partnerAllocation,
        lockPosition,
        veLockVault,
        partnerPosition,
        tokenProgram:     TOKEN_PROGRAM_ID,
        systemProgram:    SystemProgram.programId,
      } as any)
      .rpc();

    console.log(`✅ Partner allocation claimed!`);
    console.log(`   hiSOLA locked:    ${amountUi.toLocaleString()} hiSOLA`);
    console.log(`   Lock vault:       ${veLockVault.toBase58()}`);
    console.log(`   VeLockPosition:   ${lockPosition.toBase58()}`);
    console.log(`   Lock ends:        ${new Date((Date.now()/1000 + lockSecs)*1000).toISOString()}`);
    console.log(`   TX:               ${tx}`);
    console.log(`   → Wallet hiSOLA balance = 0 (borrow blocked until unlock)`);
    console.log(`   → Voting power active immediately via VeLockPosition`);

    // Verify: wallet hiSOLA balance = 0
    const walletHiSolaAta = getAssociatedTokenAddressSync(hiSolaMint, partnerKey);
    try {
      const bal = await provider.connection.getTokenAccountBalance(walletHiSolaAta);
      const walletBal = Number(bal.value.amount) / 1e6;
      console.log(`   Wallet hiSOLA balance: ${walletBal} (expected 0)`);
    } catch { console.log(`   Wallet hiSOLA ATA not initialized (expected — hiSOLA went to vault)`); }

    // Verify: ve_lock_vault balance
    const vaultBal = await provider.connection.getTokenAccountBalance(veLockVault);
    console.log(`   ve_lock_vault balance: ${Number(vaultBal.value.amount)/1e6} hiSOLA ✅`);
  });
});
