import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";

const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const EPOCH = 494541;

const JUSERS = {
  JAfXUr5: new PublicKey("JAfXUr5WNpj4wTeWAQ9KXmj9zRjBESTdgviAo1LLNrFn"),
  CL4yt4:  new PublicKey("CL4yt4Ep6N3AKbbHhQaidjVLNzQrdgT5NobQSE6FGHr3"),
};
const POOLS = {
  "6kaScSj": new PublicKey("6kaScSjPv7sXhmtv9oLmBzZoK3YprSg3Bs423qzpwemD"),
  "8SQM3BM": new PublicKey("8SQM3BMkJdmhbqcCW1kJvKL47DntAsDWyD6pFfPLiZEf"),
  "FimgpfoF": new PublicKey("FimgpfoFkoTHuGoFgNnCAzUgauB8YnEX5uhAMjxbusYu"),
  "E6QWjBN": new PublicKey("E6QWjBNpWx5rEEGTtXD98vFtEMZbNT9bVPXt8XYtFEWw"),
};
const TOKENS = {
  oSOLA: new PublicKey("2rAqBLBi2Fjdjqf5za7uzpbYgNiVV74XMDKQ5RdMuEJT"),
  SOLA:  new PublicKey("HENFwJCzmBAo2Qybrszr28tqLtEFYkXwN6h87AD5gS9p"),
};

function epochBuf(epoch: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(epoch >>> 0, 0);
  b.writeUInt32LE(Math.floor(epoch / 2**32), 4);
  return b;
}

const eb = epochBuf(EPOCH);

function claimPda(user: PublicKey, pool: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bribe_claim"), user.toBuffer(), pool.toBuffer(), mint.toBuffer(), eb],
    PROGRAM_ID
  )[0];
}
function bribeTokenPda(pool: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bribe_tokens"), pool.toBuffer(), mint.toBuffer(), eb],
    PROGRAM_ID
  )[0];
}

describe("claim check", () => {
  it("check all claim PDAs + vault balances for epoch 494541", async function() {
    this.timeout(60000);
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");
    const idl = JSON.parse(fs.readFileSync("./app/lib/soladrome.json", "utf8"));
    const provider = new anchor.AnchorProvider(connection, {} as any, {});
    const program = new anchor.Program(idl, provider);

    console.log("\n=== Vault balances (bribe_token_vault) ===");
    for (const [poolName, pool] of Object.entries(POOLS)) {
      for (const [tokenName, mint] of Object.entries(TOKENS)) {
        const vaultPda = bribeTokenPda(pool, mint);
        try {
          const bal = await connection.getTokenAccountBalance(vaultPda);
          const amount = Number(bal.value.amount) / 1e6;
          console.log(`  ${poolName}/${tokenName}: vault balance = ${amount.toFixed(6)} (PDA: ${vaultPda.toBase58().slice(0,8)}…)`);
        } catch {
          console.log(`  ${poolName}/${tokenName}: vault does not exist`);
        }
      }
    }

    console.log("\n=== UserBribeClaim PDAs (exist = already claimed) ===");
    for (const [userName, user] of Object.entries(JUSERS)) {
      for (const [poolName, pool] of Object.entries(POOLS)) {
        for (const [tokenName, mint] of Object.entries(TOKENS)) {
          const pda = claimPda(user, pool, mint);
          const info = await connection.getAccountInfo(pda);
          if (info) {
            // Compute expected claimable
            const gaugeData = await connection.getAccountInfo(
              PublicKey.findProgramAddressSync([Buffer.from("gauge"), pool.toBuffer(), eb], PROGRAM_ID)[0]
            );
            const bribeData = await connection.getAccountInfo(
              PublicKey.findProgramAddressSync([Buffer.from("bribe_vault"), pool.toBuffer(), mint.toBuffer(), eb], PROGRAM_ID)[0]
            );
            const receiptData = await connection.getAccountInfo(
              PublicKey.findProgramAddressSync([Buffer.from("vote"), user.toBuffer(), pool.toBuffer(), eb], PROGRAM_ID)[0]
            );
            if (gaugeData && bribeData && receiptData) {
              const totalVotes  = Number(gaugeData.data.readBigUInt64LE(48));
              const totalBribed = Number(bribeData.data.readBigUInt64LE(80));
              const userVotes   = Number(receiptData.data.readBigUInt64LE(72));
              const claimable   = Math.floor((totalBribed * userVotes) / totalVotes);
              console.log(`  ✅ ${userName}/${poolName}/${tokenName}: CLAIMED ${(claimable/1e6).toFixed(4)} (${(userVotes/totalVotes*100).toFixed(1)}% of ${(totalBribed/1e6).toFixed(0)})`);
            } else {
              console.log(`  ✅ ${userName}/${poolName}/${tokenName}: CLAIMED (data incomplete)`);
            }
          }
        }
      }
    }
  });
});
