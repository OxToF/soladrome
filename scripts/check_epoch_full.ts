import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "../target/idl/soladrome.json";

const PROGRAM_ID   = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const connection   = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
const provider     = new anchor.AnchorProvider(connection, {} as any, {});
const program      = new anchor.Program(idl as any, provider);

const TARGET_EPOCH = BigInt(Math.floor(Date.now() / 1000)) / 604_800n; // current 7-day epoch — override for a specific past epoch
const USER         = new PublicKey("HMY1hCg2aVpKLmXGiiEqVFDMTstPfcxji7zNf8UPRvtb");

const KNOWN: Record<string, string> = {
  "2rAqBLBi2Fjdjqf5za7uzpbYgNiVV74XMDKQ5RdMuEJT": "oSOLA",
  "HENFwJCzmBAo2Qybrszr28tqLtEFYkXwN6h87AD5gS9p": "SOLA",
  "nc1errcnXjKN4aZYL7AP89op26EMn5a2VcDT82wrTwW":  "hiSOLA",
};

function epochBuf(ep: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(ep);
  return b;
}

async function main() {
  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
  const s = await (program.account as any).protocolState.fetch(statePda);
  KNOWN[(s.usdcMint as PublicKey).toBase58()] = "USDC";

  const nowEpoch = BigInt(Math.floor(Date.now() / 1000)) / 604_800n;
  console.log(`Epoch ${TARGET_EPOCH} — scan complet`);
  console.log(`Époque courante : ${nowEpoch}\n`);

  const allPools  = await (program.account as any).ammPool.all();
  const allGauges = await (program.account as any).gaugeState.all();
  const epochGauges = allGauges.filter((g: any) => BigInt(g.account.epoch.toString()) === TARGET_EPOCH);

  for (const pool of allPools) {
    const poolPk = pool.publicKey as PublicKey;
    const gauge  = epochGauges.find((g: any) =>
      (g.account.poolId as PublicKey).toBase58() === poolPk.toBase58()
    );
    const totalVotes = gauge ? (gauge.account.totalVotes as anchor.BN).toNumber() / 1e6 : 0;

    const lines: string[] = [];
    let found = false;

    for (const [mintAddr, sym] of Object.entries(KNOWN)) {
      const mint = new PublicKey(mintAddr);
      const [bribeTokenVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("bribe_tokens"), poolPk.toBuffer(), mint.toBuffer(), epochBuf(TARGET_EPOCH)], PROGRAM_ID
      );
      const [claimPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bribe_claim"), USER.toBuffer(), poolPk.toBuffer(), mint.toBuffer(), epochBuf(TARGET_EPOCH)], PROGRAM_ID
      );

      let vaultBal: number | null = null;
      try {
        const r = await connection.getTokenAccountBalance(bribeTokenVault);
        vaultBal = r.value.uiAmount ?? 0;
        found = true;
      } catch { }

      const claimInfo = await connection.getAccountInfo(claimPda);
      if (claimInfo) found = true;

      if (vaultBal !== null || claimInfo) {
        lines.push(
          `  ${sym.padEnd(8)}: vault=${vaultBal !== null ? String(vaultBal).padStart(12) : "     —      "}` +
          `  claim=${claimInfo ? "✅ RÉCLAMÉ" : "❌ pas réclamé"}`
        );
      }
    }

    if (found || totalVotes > 0) {
      const mA = KNOWN[pool.account.tokenAMint.toString()] ?? pool.account.tokenAMint.toString().slice(0, 6) + "…";
      const mB = KNOWN[pool.account.tokenBMint.toString()] ?? pool.account.tokenBMint.toString().slice(0, 6) + "…";
      console.log(`Pool ${mA}/${mB}  [${poolPk.toBase58()}]`);
      console.log(`  votes: ${totalVotes.toFixed(4)}`);
      if (lines.length > 0) lines.forEach(l => console.log(l));
      else console.log("  (aucun bribe vault trouvé)");
      console.log();
    }
  }

  // Wallet balances
  console.log("=== BALANCES WALLET ===");
  for (const [mintAddr, sym] of Object.entries(KNOWN)) {
    try {
      const ata = anchor.utils.token.associatedAddress({ mint: new PublicKey(mintAddr), owner: USER });
      const r = await connection.getTokenAccountBalance(ata);
      const amt = r.value.uiAmount ?? 0;
      if (amt > 0) console.log(`  ${sym.padEnd(8)}: ${amt.toLocaleString(undefined, { maximumFractionDigits: 6 })}`);
    } catch { }
  }
}

main().catch(console.error);
