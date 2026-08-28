/**
 * crank_partner_epoch.ts
 * Permissionless: run one epoch of a partner's deal — release their escrowed bribe tranche,
 * and buy this epoch of their retainer if their liquidity is still in place.
 *
 * ☢️ THIS IS THE SCRIPT THAT HAS TO RUN EVERY WEEK. The bribe half slips harmlessly if it is
 * missed — the schedule simply ends one epoch later — but the retainer half cannot: the chain
 * keeps no history of an SPL balance, so there is no way to establish afterwards that the LP
 * was there. The crank IS the attestation, and an epoch nobody cranks is lost, not deferred.
 *
 * Anyone may call it, which is deliberate: the epoch's voters are the ones owed the bribe, so
 * leaving the trigger to the partner would put them behind the party whose incentive is to
 * delay. The caller pays the rent for that epoch's bribe vault and, on the first crank, for the
 * partner's lock and position PDAs.
 *
 * It replaces partner_deposit_bribe.ts, which was deleted with its instruction on 2026-08-27:
 * once the 1:1 match was gone, that call was `deposit_bribe` under another name.
 *
 * Usage (one partner):
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   PARTNER=<wallet> \
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/crank_partner_epoch.ts
 *
 * Everything else is read from the chain: the gauge and reward mint come from the escrowed
 * stream, the LP mint and threshold from the allocation.
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

const PROGRAM_ID     = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");
const PARTNER_SEED   = Buffer.from("partner");
const STREAM_SEED    = Buffer.from("bribe_stream");
const STREAM_TOKENS  = Buffer.from("stream_tokens");
const VELOCK_SEED    = Buffer.from("velock");
const POSITION_SEED  = Buffer.from("position");
const EPOCH_DURATION = 7 * 24 * 60 * 60; // 604 800 s, every cluster

const le8 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

describe("crank_partner_epoch", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const partnerStr = process.env.PARTNER ?? "";

  before(function () {
    if (!partnerStr) {
      console.error("Usage: PARTNER=<wallet> yarn ts-mocha … crank_partner_epoch.ts");
      this.skip();
    }
  });

  it("runs this epoch for the partner", async function () {
    this.timeout(60000);

    const program = anchor.workspace.Soladrome
      ?? new anchor.Program(require("../target/idl/soladrome.json"), provider);

    const partner = new PublicKey(partnerStr);

    const [statePda]          = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
    const [partnerAllocation] = PublicKey.findProgramAddressSync([PARTNER_SEED, partner.toBuffer()], PROGRAM_ID);
    const [bribeStream]       = PublicKey.findProgramAddressSync([STREAM_SEED, partner.toBuffer()], PROGRAM_ID);
    const [streamVault]       = PublicKey.findProgramAddressSync([STREAM_TOKENS, partner.toBuffer()], PROGRAM_ID);
    const [lockPosition]      = PublicKey.findProgramAddressSync([VELOCK_SEED, partner.toBuffer()], PROGRAM_ID);
    const [partnerPosition]   = PublicKey.findProgramAddressSync([POSITION_SEED, partner.toBuffer()], PROGRAM_ID);

    const streamInfo = await provider.connection.getAccountInfo(bribeStream);
    if (!streamInfo) {
      console.log(
        `⚠️  ${partnerStr.slice(0, 8)}… has never escrowed a bribe schedule. Nothing accrues ` +
        `until they do — not the bag, not a single epoch of retainer.`
      );
      return;
    }

    const state  = await (program.account as any).protocolState.fetch(statePda);
    const alloc  = await (program.account as any).partnerAllocation.fetch(partnerAllocation);
    const stream = await (program.account as any).partnerBribeStream.fetch(bribeStream);

    const slot  = await provider.connection.getSlot();
    const nowTs = (await provider.connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
    const epoch = Math.floor(nowTs / EPOCH_DURATION);

    const poolId     = stream.poolId as PublicKey;
    const rewardMint = stream.bribeMint as PublicKey;
    const lpMint     = alloc.lpMint as PublicKey;
    const partnerLp  = getAssociatedTokenAddressSync(lpMint, partner);

    // Say out loud what this call will and will not do, before it does it.
    const lpBal = await provider.connection
      .getTokenAccountBalance(partnerLp)
      .then((b) => BigInt(b.value.amount))
      .catch(() => BigInt(0));
    const threshold = BigInt(alloc.lpThreshold.toString());
    const lpOk = lpBal >= threshold;
    const epochOpen = Number(alloc.lastCreditedEpoch) < epoch;
    const trancheDue =
      Number(stream.epochsReleased) < Number(stream.epochsTotal) &&
      Number(stream.lastReleaseEpoch) < epoch;

    console.log(`\nEpoch ${epoch} — ${partnerStr.slice(0, 8)}…`);
    console.log(`  bribe tranche : ${trancheDue ? "due" : "already released this epoch, or the schedule is spent"}`);
    console.log(`  liquidity     : ${lpBal} of ${threshold} required → ${lpOk ? "met" : "NOT met"}`);
    console.log(`  retainer      : ${lpOk && epochOpen ? "will be credited" : epochOpen ? "will NOT be credited — and this epoch is then lost" : "already credited this epoch"}`);

    const tx = await program.methods
      .crankPartnerEpoch(new anchor.BN(epoch))
      .accounts({
        caller:            provider.wallet.publicKey,
        protocolState:     statePda,
        partner,
        bribeStream,
        partnerAllocation,
        streamVault,
        poolId,
        rewardMint,
        bribeVault: PublicKey.findProgramAddressSync(
          [Buffer.from("bribe_vault"), poolId.toBuffer(), rewardMint.toBuffer(), le8(epoch)],
          PROGRAM_ID
        )[0],
        bribeTokenVault: PublicKey.findProgramAddressSync(
          [Buffer.from("bribe_tokens"), poolId.toBuffer(), rewardMint.toBuffer(), le8(epoch)],
          PROGRAM_ID
        )[0],
        lpMint,
        partnerLpToken:    partnerLp,
        solaMint:          state.solaMint,
        solaVault:         state.solaVault,
        marketVault:       state.marketVault,
        lockPosition,
        partnerPosition,
        tokenProgram:      TOKEN_PROGRAM_ID,
        systemProgram:     SystemProgram.programId,
        rent:              SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const after = await (program.account as any).partnerAllocation.fetch(partnerAllocation);
    console.log(`✅ Epoch run. TX: ${tx}`);
    console.log(`   Epochs earned so far : ${after.epochsQualified}`);
    console.log(`   hiSOLA credited      : ${Number(after.hiSolaClaimed) / 1e6}`);
  });
});
