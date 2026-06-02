import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";

const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const TARGET_EPOCH = 494541;

function epochBuf(epoch: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(epoch >>> 0, 0);
  b.writeUInt32LE(Math.floor(epoch / 2**32), 4);
  return b;
}

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const idl = JSON.parse(fs.readFileSync("./app/lib/soladrome.json", "utf8"));
  const provider = new anchor.AnchorProvider(connection, {} as any, {});
  const program = new anchor.Program(idl, provider);

  const eb = epochBuf(TARGET_EPOCH);
  console.log(`\n=== Epoch ${TARGET_EPOCH} ===  bytes: ${eb.toString("hex")}`);

  // GaugeState
  console.log("\n--- GaugeState ---");
  const gauges = await (program.account as any).gaugeState.all();
  const gm = gauges.filter((g: any) => Number(g.account.epoch) === TARGET_EPOCH);
  if (!gm.length) { console.log("  (aucun)"); }
  for (const g of gm) {
    console.log(`  Pool: ${g.account.poolId.toBase58()}`);
    console.log(`  total_votes: ${(Number(g.account.totalVotes) / 1e6).toFixed(6)} hiSOLA`);
  }

  // BribeVault
  console.log("\n--- BribeVault ---");
  const vaults = await (program.account as any).bribeVault.all();
  const vm = vaults.filter((v: any) => Number(v.account.epoch) === TARGET_EPOCH);
  if (!vm.length) { console.log("  (aucun)"); }
  for (const v of vm) {
    console.log(`  Pool:         ${v.account.poolId.toBase58()}`);
    console.log(`  Reward mint:  ${v.account.rewardMint.toBase58()}`);
    console.log(`  total_bribed: ${(Number(v.account.totalBribed) / 1e6).toFixed(6)}`);
    console.log(`  PDA:          ${v.publicKey.toBase58()}`);
  }

  // UserVoteReceipt
  console.log("\n--- UserVoteReceipt ---");
  const receipts = await (program.account as any).userVoteReceipt.all();
  const rm = receipts.filter((r: any) => Number(r.account.epoch) === TARGET_EPOCH);
  if (!rm.length) { console.log("  (aucun)"); }
  for (const r of rm) {
    console.log(`  User:   ${r.account.user.toBase58()}`);
    console.log(`  Pool:   ${r.account.poolId.toBase58()}`);
    console.log(`  votes:  ${(Number(r.account.votes) / 1e6).toFixed(6)} hiSOLA`);
  }

  // GlobalEpochVotes
  console.log("\n--- GlobalEpochVotes ---");
  try {
    const [gevPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("epoch_votes"), eb], PROGRAM_ID
    );
    const gev = await (program.account as any).globalEpochVotes.fetch(gevPda);
    console.log(`  PDA:         ${gevPda.toBase58()}`);
    console.log(`  total_votes: ${(Number(gev.totalVotes) / 1e6).toFixed(6)} hiSOLA`);
  } catch { console.log("  (non initialisé)"); }

  // UserBribeClaim
  console.log("\n--- UserBribeClaim (tous) ---");
  try {
    const claims = await (program.account as any).userBribeClaim.all();
    console.log(`  Total: ${claims.length} claim(s)`);
    for (const c of claims) { console.log(`  PDA: ${c.publicKey.toBase58()}`); }
  } catch { console.log("  (erreur)"); }
}

describe("epoch check", () => {
  it("fetch epoch 494541", async function() {
    this.timeout(60000);
    await main();
  });
});
