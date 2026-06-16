/**
 * partner_deposit_bribe.ts
 * Partner-only: deposit a bribe in your committed bribe_mint and get credited toward
 * your STREAMING hiSOLA allocation. The tokens flow into the normal bribe vault
 * (voters of that gauge claim them as usual); your PartnerAllocation.total_bribed_credited
 * increases by the same amount. Afterwards, run claim_partner.ts to mint the earned,
 * locked hiSOLA (entitled = min(cap, credited × rate) − already claimed).
 *
 * Must be signed by the PARTNER wallet (the one registered via register_partner.ts).
 * The bribe token (reward_mint) is read automatically from your on-chain allocation.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/partner-id.json \
 *   POOL=<pool_pubkey> AMOUNT=<bribe_ui> [EPOCH_SECS=604800] \
 *   yarn run ts-mocha -p ./tsconfig.json -t 60000 scripts/partner_deposit_bribe.ts
 *
 * EPOCH_SECS must match the on-chain EPOCH_DURATION (604 800 s on mainnet & devnet).
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";

const PROGRAM_ID   = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const PARTNER_SEED = Buffer.from("partner");
const STATE_SEED   = Buffer.from("state");
const EPOCH_SECS   = parseInt(process.env.EPOCH_SECS ?? "604800", 10); // must match on-chain EPOCH_DURATION

describe("partner_deposit_bribe", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  it("deposits a bribe and credits the partner allocation", async function () {
    this.timeout(60000);

    const poolStr  = process.env.POOL ?? "";
    const amountUi = parseFloat(process.env.AMOUNT ?? "0");
    if (!poolStr || isNaN(amountUi) || amountUi <= 0) {
      console.error(
        "Usage: POOL=<pool_pubkey> AMOUNT=<bribe_ui> [EPOCH_SECS=604800] " +
          "yarn ts-mocha ... scripts/partner_deposit_bribe.ts",
      );
      this.skip();
      return;
    }

    const program = anchor.workspace.Soladrome
      ?? new anchor.Program(require("../target/idl/soladrome.json"), provider);

    const partnerKey = provider.wallet.publicKey;
    const poolId     = new PublicKey(poolStr);

    const [statePda]          = PublicKey.findProgramAddressSync([STATE_SEED], PROGRAM_ID);
    const [partnerAllocation] = PublicKey.findProgramAddressSync(
      [PARTNER_SEED, partnerKey.toBuffer()],
      PROGRAM_ID,
    );

    const allocInfo = await provider.connection.getAccountInfo(partnerAllocation);
    if (!allocInfo) {
      throw new Error(
        `No partner allocation for ${partnerKey.toBase58().slice(0, 8)}… — run register_partner.ts first.`,
      );
    }

    const alloc      = await (program.account as any).partnerAllocation.fetch(partnerAllocation);
    const rewardMint = alloc.bribeMint as PublicKey;

    // Convert UI amount → base units using the bribe token's own decimals.
    const mintInfo = await getMint(provider.connection, rewardMint);
    const amount   = new anchor.BN(Math.floor(amountUi * 10 ** mintInfo.decimals));

    // Current epoch = unix_ts / EPOCH_DURATION (must match current_epoch on-chain).
    const epoch   = Math.floor(Math.floor(Date.now() / 1000) / EPOCH_SECS);
    const epochBN = new anchor.BN(epoch);
    const epochLe = epochBN.toArrayLike(Buffer, "le", 8);

    const [bribeVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("bribe_vault"), poolId.toBuffer(), rewardMint.toBuffer(), epochLe],
      PROGRAM_ID,
    );
    const [bribeTokenVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("bribe_tokens"), poolId.toBuffer(), rewardMint.toBuffer(), epochLe],
      PROGRAM_ID,
    );

    const partnerToken = getAssociatedTokenAddressSync(rewardMint, partnerKey);

    console.log(
      `\nPartner bribe: ${amountUi} (mint ${rewardMint.toBase58().slice(0, 8)}…) ` +
        `on pool ${poolStr.slice(0, 8)}… epoch ${epoch}`,
    );

    const tx = await program.methods
      .partnerDepositBribe(epochBN, amount)
      .accounts({
        partner:          partnerKey,
        protocolState:    statePda,
        partnerAllocation,
        poolId,
        rewardMint,
        partnerToken,
        bribeVault,
        bribeTokenVault,
        tokenProgram:     TOKEN_PROGRAM_ID,
        systemProgram:    SystemProgram.programId,
        rent:             SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    console.log(`✅ Bribe deposited + allocation credited. TX: ${tx}`);
    console.log(`   Now run claim_partner.ts to mint the earned, locked hiSOLA.`);
  });
});
