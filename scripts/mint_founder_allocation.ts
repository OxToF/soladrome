/**
 * mint_founder_allocation.ts
 * One-shot: initialise the founder vesting PDAs on devnet.
 * Called once by the authority (id.json). Sets start_ts = now.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/mint_founder_allocation.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import idl from "../target/idl/soladrome.json";

const PROGRAM_ID = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");

// ☢️ The founder address is NOT hardcoded any more. It lives in
// `ProtocolState.founder_wallet`, written once at `initialize`, and the `founder` account on
// this instruction is constrained to it — passing anything else fails with Unauthorized.
// Reading it from chain is also the safest possible pre-flight: what the script prints is
// exactly what the 12.25M will be committed to.

describe("mint_founder_allocation (one-shot)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Soladrome
    ?? new anchor.Program(idl as any, provider);

  const [statePda]     = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("state")],              PROGRAM_ID);
  const [hiVestingPda] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("founder_hi_vesting")], PROGRAM_ID);
  const [oVestingPda]  = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("founder_vesting")],    PROGRAM_ID);

  it("initialises founder vesting schedules", async () => {
    // Guard: skip if already done
    const state = await (program.account as any).protocolState.fetch(statePda);
    if (state.founderAllocated) {
      console.log("⚠️  Already allocated — skipping. This instruction is one-shot.");
      return;
    }

    const FOUNDER_WALLET = state.founderWallet as PublicKey;
    if (FOUNDER_WALLET.equals(PublicKey.default)) {
      throw new Error(
        "founder_wallet is unset — run scripts/migrate_protocol_state.ts first. " +
          "Every founder guard fails closed until it is set."
      );
    }

    // ☢️ Last chance to notice a wrong address. `mint_founder_allocation` needs NO founder
    // signature (the account is an address-checked SystemAccount, the authority alone signs),
    // so nothing physical stands between a wrong value here and a permanent misallocation.
    console.log("authority      :", provider.wallet.publicKey.toBase58());
    console.log("founder_wallet :", FOUNDER_WALLET.toBase58());
    console.log("⚠️  ONE-SHOT and irreversible. founder_allocated is set for good.");

    const tx = await program.methods
      .mintFounderAllocation()
      .accounts({
        authority:        provider.wallet.publicKey,
        protocolState:    statePda,
        founder:          FOUNDER_WALLET,
        founderHiVesting: hiVestingPda,
        founderVesting:   oVestingPda,
        systemProgram:    SystemProgram.programId,
        rent:             SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const cliff = new Date(Date.now() + 180 * 86400 * 1000).toISOString().slice(0, 10);
    console.log("✅ mint_founder_allocation — tx:", tx);
    console.log("   Cliff:    180 days, every cluster → first claim on", cliff);
    console.log("   Duration: 720 days linear after the cliff");
    console.log("   The 5 s / 24 h devnet variants are gone with the `devnet` feature:");
    console.log("   one binary, one schedule. The cliff is now REAL on devnet too.");
  });
});
