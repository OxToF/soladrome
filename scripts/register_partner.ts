/**
 * register_partner.ts
 * Authority-only: register ONE protocol partner. The Founder panel's Register Partner form
 * does the same thing with the deal restated on screen before it is signed, and should be
 * preferred; this exists for headless runs.
 *
 * The deal has two money terms and no total (2026-08-27):
 *   - BASE       — the signature bag, delivered whole once the partner escrows their bribe
 *                  schedule (fund_partner_bribe_stream). It is the only unconditional part.
 *   - RETAINER   — hiSOLA per epoch, credited by crank_partner_epoch for every epoch the
 *                  partner still holds LP_FLOOR of LP_MINT. No cap and no end date: stay
 *                  three years and it pays for three years.
 *
 * Everything credited is permanent — it votes, earns protocol fees and borrows at 20%, and can
 * never be unlocked, unstaked, or sold at a floor it never financed.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   PARTNER=<wallet> BRIBE_MINT=<mint> LP_MINT=<mint> LP_FLOOR=<lp tokens> \
 *   RETAINER=<hiSOLA per epoch> BASE=<hiSOLA bag> MIN_BRIBE=<bribe tokens per epoch> \
 *   EPOCHS=<lock epochs> [SCHEDULE=52] \
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/register_partner.ts
 *
 * Tier 1 example (1M LP committed, one-year bribe schedule, 4-year lock):
 *   PARTNER=<wallet> BRIBE_MINT=<JTO> LP_MINT=<jitoSOL/USDC LP> LP_FLOOR=1000000 \
 *   RETAINER=3450 BASE=20000 MIN_BRIBE=300 EPOCHS=208 SCHEDULE=52
 *
 * ⚠️ LP_FLOOR is in the LP mint's units and MIN_BRIBE in the bribe mint's; both are read from
 *    the chain, never assumed to be 6. The tier is negotiated in dollars and there is no
 *    oracle, so what is frozen on-chain is the token count that matched it on the day.
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

const PROGRAM_ID     = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");
const PARTNER_SEED   = Buffer.from("partner");
// One binary since 2026-08-23 — 604 800 on every cluster, no devnet variant.
const EPOCH_DURATION = 7 * 24 * 60 * 60;
const DECIMALS       = 6; // hiSOLA

/// Whole-token string → base units. Not `parseFloat(x) * 10 ** d`: these figures are written
/// once into an account with no editor, and that route silently rounds past 2^53.
function toBase(ui: string, decimals: number): anchor.BN {
  const s = ui.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a plain amount: "${ui}"`);
  const [whole = "", frac = ""] = s.split(".");
  if (frac.length > decimals)
    throw new Error(`"${ui}" has more decimals than the mint has (${decimals})`);
  return new anchor.BN(whole + (frac + "0".repeat(decimals)).slice(0, decimals));
}

describe("register_partner", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const partnerRaw = process.env.PARTNER ?? "";
  const partnerStr = KNOWN_PARTNERS[partnerRaw.toLowerCase()] ?? partnerRaw;
  const bribeMintStr = process.env.BRIBE_MINT ?? "";
  const lpMintStr    = process.env.LP_MINT ?? "";
  const lpFloorUi    = process.env.LP_FLOOR ?? "";
  const retainerUi   = process.env.RETAINER ?? "";
  const baseUi       = process.env.BASE ?? "0";
  const minBribeUi   = process.env.MIN_BRIBE ?? "";
  const lockEpochs   = parseInt(process.env.EPOCHS ?? "0", 10);
  const scheduleEps  = parseInt(process.env.SCHEDULE ?? "52", 10);

  before(function () {
    const missing = !partnerStr || !bribeMintStr || !lpMintStr || !lpFloorUi ||
      !retainerUi || !minBribeUi || !Number.isFinite(lockEpochs) || lockEpochs < 1;
    if (missing) {
      console.error(
        "Usage: PARTNER=<wallet> BRIBE_MINT=<mint> LP_MINT=<mint> LP_FLOOR=<lp> " +
        "RETAINER=<hiSOLA/epoch> BASE=<hiSOLA> MIN_BRIBE=<bribe/epoch> EPOCHS=<lock> " +
        "[SCHEDULE=52] yarn ts-mocha … register_partner.ts"
      );
      this.skip();
    }
  });

  it("registers the partner on-chain", async function () {
    const program = anchor.workspace.Soladrome
      ?? new anchor.Program(require("../target/idl/soladrome.json"), provider);

    const partnerWallet = new PublicKey(partnerStr);
    const bribeMint     = new PublicKey(bribeMintStr);
    const lpMint        = new PublicKey(lpMintStr);

    // Decimals from the chain. Assuming 6 on a 9-decimal mint puts an immutable threshold out
    // by 1000×, in the direction that makes the liquidity condition meaningless.
    const decimalsOf = async (m: PublicKey) => {
      const info = await provider.connection.getParsedAccountInfo(m);
      const dec = (info.value?.data as any)?.parsed?.info?.decimals;
      if (typeof dec !== "number") throw new Error(`${m.toBase58()} is not an SPL mint`);
      return dec as number;
    };

    const lpThreshold = toBase(lpFloorUi, await decimalsOf(lpMint));
    const minBribe    = toBase(minBribeUi, await decimalsOf(bribeMint));
    const retainer    = toBase(retainerUi, DECIMALS);
    const baseHiSola  = toBase(baseUi, DECIMALS);
    const lockDurationSecs = new anchor.BN(lockEpochs * EPOCH_DURATION);

    const [statePda]          = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
    const [partnerAllocation] = PublicKey.findProgramAddressSync(
      [PARTNER_SEED, partnerWallet.toBuffer()],
      PROGRAM_ID
    );

    // Guard: already registered? `init`, so a second call fails on-chain anyway — but say so
    // here rather than surface it as a raw account-already-in-use error.
    const existing = await provider.connection.getAccountInfo(partnerAllocation);
    if (existing) {
      console.log(`⚠️  Wallet ${partnerStr.slice(0, 8)}… is already registered as partner — skipping.`);
      return;
    }

    const tx = await program.methods
      .registerPartner(
        bribeMint, lpMint, lpThreshold, retainer, baseHiSola, lockDurationSecs,
        new anchor.BN(scheduleEps), minBribe
      )
      .accounts({
        authority:        provider.wallet.publicKey,
        protocolState:    statePda,
        partnerWallet:    partnerWallet,
        partnerAllocation,
        systemProgram:    SystemProgram.programId,
        rent:             SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    console.log(`✅ Partner registered!`);
    console.log(`   Wallet:         ${partnerStr}`);
    console.log(`   Signature bag:  ${baseUi} hiSOLA — delivered whole once they escrow a schedule`);
    console.log(`   Retainer:       ${retainerUi} hiSOLA/epoch while they hold ${lpFloorUi} LP`);
    console.log(`   Bribe schedule: ${scheduleEps} epochs × ≥ ${minBribeUi} ${bribeMintStr.slice(0, 8)}…`);
    console.log(`   Lock:           ${lockEpochs} epochs — and every credit is permanent regardless`);
    console.log(`   Allocation PDA: ${partnerAllocation.toBase58()}`);
    console.log(`   TX:             ${tx}`);
    console.log(`   → The partner escrows their schedule and claims the bag from the Partner tab.`);
    console.log(`   → Then someone must crank each epoch, or that epoch's retainer is lost.`);
  });
});
