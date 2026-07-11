import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";

const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const EPOCH_DURATION = 604_800;

// Read the RPC (with its Helius API key) from app/.env.local at run time — never
// hardcode the key in a committed file. Falls back to the public devnet RPC.
function readRpc(): string {
  try {
    const line = fs.readFileSync("./app/.env.local", "utf8")
      .split("\n").find((l) => l.startsWith("NEXT_PUBLIC_RPC_URL="));
    if (line) return line.slice("NEXT_PUBLIC_RPC_URL=".length).trim();
  } catch { /* fall through to the public default */ }
  return process.env.RPC_URL || "https://api.devnet.solana.com";
}
const RPC = readRpc();

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const curEpoch = Math.floor(now / EPOCH_DURATION);
  const connection = new Connection(RPC, "confirmed");
  const idl = JSON.parse(fs.readFileSync("./app/lib/soladrome.json", "utf8"));
  const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, {} as any, {}));

  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
  const st: any = await (program.account as any).protocolState.fetch(statePda);
  console.log("=== ProtocolState ===");
  console.log("  continuous_rate_per_sec :", Number(st.continuousRatePerSec ?? -1));
  console.log("  continuous_end_epoch    :", Number(st.continuousEndEpoch ?? -1));
  console.log("  current_epoch (now)     :", curEpoch);
  console.log("  window active?          :", curEpoch < Number(st.continuousEndEpoch ?? 0));

  console.log("\n=== AmmPools ===");
  const pools = await (program.account as any).ammPool.all();
  for (const p of pools) {
    const a = p.account;
    console.log("  pool:", p.publicKey.toBase58());
    console.log("     mints:", a.tokenAMint.toBase58(), a.tokenBMint.toBase58());
    console.log("     rewards_enabled :", a.rewardsEnabled);
    console.log("     last_reward_ts  :", Number(a.lastRewardTs ?? 0), "(now=" + now + ")");
    console.log("     total_lp        :", Number(a.totalLp ?? 0) / 1e6);
    console.log("     osola_reward_per_lp:", (a.osolaRewardPerLp ?? new anchor.BN(0)).toString());
  }
}

describe("emissions check", () => {
  it("dumps emission state", async function () { this.timeout(60000); await main(); });
});
