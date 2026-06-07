/**
 * claim_contributor.ts
 * Contributor-only: claim vested hiSOLA and/or oSOLA after the cliff.
 * Must be signed by the CONTRIBUTOR wallet (not authority).
 *
 * Devnet schedule (current deployed program):
 *   Cliff:    1 h  (CONTRIBUTOR_CLIFF_SECS)
 *   Duration: 12 h (CONTRIBUTOR_DURATION_SECS)  — linear after cliff
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/contributor-id.json \
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/claim_contributor.ts \
 *     [-- hi]        claim hiSOLA only
 *     [-- o]         claim oSOLA only
 *     [-- hi o]      claim both (default if no flag)
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, TOKEN_PROGRAM_ID, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

const PROGRAM_ID        = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const CONTRIBUTOR_SEED  = Buffer.from("contributor");
const POSITION_SEED     = Buffer.from("position");

// Devnet constants — mirrors state.rs #[cfg(feature = "devnet")]
const CLIFF_SECS    = 1 * 3_600;   // 1 h
const DURATION_SECS = 12 * 3_600;  // 12 h

describe("claim_contributor", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const rawArgs   = process.argv.slice(process.argv.indexOf("--") + 1).filter(Boolean);
  const claimHi   = rawArgs.length === 0 || rawArgs.includes("hi");
  const claimOsola = rawArgs.length === 0 || rawArgs.includes("o");

  it("claims contributor vesting", async function () {
    this.timeout(60000);

    const program = anchor.workspace.Soladrome
      ?? new anchor.Program(require("../target/idl/soladrome.json"), provider);

    const contributorKey = provider.wallet.publicKey;

    const [statePda]          = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
    const [contributorVesting] = PublicKey.findProgramAddressSync(
      [CONTRIBUTOR_SEED, contributorKey.toBuffer()],
      PROGRAM_ID
    );
    const [contributorPosition] = PublicKey.findProgramAddressSync(
      [POSITION_SEED, contributorKey.toBuffer()],
      PROGRAM_ID
    );

    // Pre-checks
    const vestInfo = await provider.connection.getAccountInfo(contributorVesting);
    if (!vestInfo) {
      throw new Error(`No contributor vesting found for ${contributorKey.toBase58().slice(0,8)}… — authority must run register_contributor.ts first`);
    }

    const state   = await (program.account as any).protocolState.fetch(statePda);
    const vesting = await (program.account as any).contributorVesting.fetch(contributorVesting);

    const hiSolaMint = state.hiSolaMint as PublicKey;
    const oSolaMint  = state.oSolaMint  as PublicKey;
    const solaMint   = state.solaMint   as PublicKey;

    const now     = Math.floor(Date.now() / 1000);
    const elapsed = now - Number(vesting.startTs);
    const totalHi = Number(vesting.hiSolaAmount) / 1e6;
    const totalO  = Number(vesting.oSolaAmount)  / 1e6;
    const claimedHi = Number(vesting.hiSolaClaimed) / 1e6;
    const claimedO  = Number(vesting.oSolaClaimed)  / 1e6;

    const vestedFrac = Math.min(1, Math.max(0, elapsed / DURATION_SECS));
    const vestedHi   = totalHi * vestedFrac;
    const vestedO    = totalO  * vestedFrac;
    const remainHi   = Math.max(0, vestedHi - claimedHi);
    const remainO    = Math.max(0, vestedO  - claimedO);

    console.log(`\n=== Contributor vesting for ${contributorKey.toBase58().slice(0,8)}… ===`);
    console.log(`  elapsed    : ${Math.floor(elapsed/3600)}h ${Math.floor((elapsed%3600)/60)}m`);
    console.log(`  cliff      : ${elapsed >= CLIFF_SECS ? "✅ PASSED" : `⏳ ${Math.floor((CLIFF_SECS-elapsed)/60)}m left`}`);
    console.log(`  hiSOLA     : ${claimedHi.toFixed(2)} / ${totalHi.toFixed(2)} claimed — claimable: ${remainHi.toFixed(2)}`);
    console.log(`  oSOLA      : ${claimedO.toFixed(2)}  / ${totalO.toFixed(2)} claimed  — claimable: ${remainO.toFixed(2)}`);

    if (elapsed < CLIFF_SECS) {
      const wait = CLIFF_SECS - elapsed;
      console.log(`\n⏳ Cliff not reached yet. Come back in ${Math.ceil(wait/60)} min.`);
      return;
    }

    // ── Claim hiSOLA ─────────────────────────────────────────────────────────
    if (claimHi && remainHi > 0.000001) {
      const hiSolaAta = anchor.utils.token.associatedAddress({ mint: hiSolaMint, owner: contributorKey });

      const txHi = await program.methods
        .claimContributorHiSola()
        .accounts({
          contributor:         contributorKey,
          protocolState:       statePda,
          solaMint,
          hiSolaMint,
          solaVault:           state.solaVault,
          marketVault:         state.marketVault,
          contributorHiSola:   hiSolaAta,
          contributorPosition,
          contributorVesting,
          tokenProgram:              TOKEN_PROGRAM_ID,
          associatedTokenProgram:    ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram:             SystemProgram.programId,
        } as any)
        .rpc();

      console.log(`\n✅ claimContributorHiSola — ${remainHi.toFixed(2)} hiSOLA`);
      console.log(`   TX: ${txHi}`);
    } else if (claimHi) {
      console.log(`\n⚠️  hiSOLA: nothing claimable (${remainHi.toFixed(6)} available)`);
    }

    // ── Claim oSOLA ──────────────────────────────────────────────────────────
    if (claimOsola && remainO > 0.000001) {
      const oSolaAta = anchor.utils.token.associatedAddress({ mint: oSolaMint, owner: contributorKey });

      const txO = await program.methods
        .claimContributorVesting()
        .accounts({
          contributor:        contributorKey,
          protocolState:      statePda,
          oSolaMint,
          contributorVesting,
          contributorOSola:   oSolaAta,
          tokenProgram:              TOKEN_PROGRAM_ID,
          associatedTokenProgram:    ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram:             SystemProgram.programId,
        } as any)
        .rpc();

      console.log(`✅ claimContributorVesting — ${remainO.toFixed(2)} oSOLA`);
      console.log(`   TX: ${txO}`);
    } else if (claimOsola) {
      console.log(`⚠️  oSOLA: nothing claimable (${remainO.toFixed(6)} available)`);
    }
  });
});
