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

const PROGRAM_ID     = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const FOUNDER_WALLET = new PublicKey("46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4");

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
      console.log("⚠️  Already allocated — skipping.");
      return;
    }

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

    console.log("✅ mint_founder_allocation — tx:", tx);
    console.log("   Cliff:    6 h devnet  → claimable after cliff");
    console.log("   Duration: 24 h devnet → fully vested after 24 h");
    console.log("   → Connect Ledger on soladrome.finance, 👑 Founder panel is now live");
  });
});
