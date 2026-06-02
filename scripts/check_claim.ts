import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "../target/idl/soladrome.json";

const PROGRAM_ID   = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const connection   = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
const provider     = new anchor.AnchorProvider(connection, {} as any, {});
const program      = new anchor.Program(idl as any, provider);

const TARGET_EPOCH = BigInt(Math.floor(Date.now() / 1000)) / 604_800n; // current 7-day epoch — override for a specific past epoch
const USER         = new PublicKey("HMY1hCg2aVpKLmXGiiEqVFDMTstPfcxji7zNf8UPRvtb");
const POOL         = new PublicKey("FimgpfoFkoTHHGRasUMhvCjxhzZwjSCM8PVGNUpNdRBs");

const KNOWN: Record<string, string> = {
  "2rAqBLBi2Fjdjqf5za7uzpbYgNiVV74XMDKQ5RdMuEJT": "oSOLA",
  "HENFwJCzmBAo2Qybrszr28tqLtEFYkXwN6h87AD5gS9p": "SOLA",
  "nc1errcnXjKN4aZYL7AP89op26EMn5a2VcDT82wrTwW":  "hiSOLA",
};

function epochBuf(epoch: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(epoch);
  return b;
}

async function main() {
  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
  const s = await (program.account as any).protocolState.fetch(statePda);
  KNOWN[(s.usdcMint as PublicKey).toBase58()] = "USDC";

  const nowEpoch = BigInt(Math.floor(Date.now() / 1000)) / 604_800n;
  console.log(`=== EPOCH ${TARGET_EPOCH} — vérification claim ===`);
  console.log(`Époque courante : ${nowEpoch}  |  Statut : ${TARGET_EPOCH < nowEpoch ? "TERMINÉE ✅" : "EN COURS"}\n`);

  let foundAnything = false;
  for (const [mintAddr, sym] of Object.entries(KNOWN)) {
    const mint = new PublicKey(mintAddr);

    const [bribeTokenVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("bribe_tokens"), POOL.toBuffer(), mint.toBuffer(), epochBuf(TARGET_EPOCH)], PROGRAM_ID
    );
    const [claimPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bribe_claim"), USER.toBuffer(), POOL.toBuffer(), mint.toBuffer(), epochBuf(TARGET_EPOCH)], PROGRAM_ID
    );

    let vaultBal: number | null = null;
    try {
      const r = await connection.getTokenAccountBalance(bribeTokenVault);
      vaultBal = r.value.uiAmount ?? 0;
    } catch { /* pas de vault */ }

    const claimInfo = await connection.getAccountInfo(claimPda);

    if (vaultBal !== null || claimInfo) {
      foundAnything = true;
      console.log(`── ${sym} ──`);
      if (vaultBal !== null) {
        console.log(`  Vault restant  : ${vaultBal > 0 ? vaultBal + " " + sym : "0 (vidé par le claim)"}`);
      }
      console.log(`  Claim PDA      : ${claimInfo
        ? "✅ EXISTS → claim bien enregistré on-chain (double-claim bloqué)"
        : "❌ absent → pas encore réclamé pour ce token"
      }`);
      console.log();
    }
  }

  if (!foundAnything) {
    console.log("Aucun vault ni claim trouvé pour cette époque/pool.");
    console.log("→ Soit aucune bribe n'a été déposée, soit les PDAs utilisent une autre pool.");
  }

  console.log("=== BALANCES WALLET ===");
  for (const [mintAddr, sym] of Object.entries(KNOWN)) {
    try {
      const ata = anchor.utils.token.associatedAddress({ mint: new PublicKey(mintAddr), owner: USER });
      const r = await connection.getTokenAccountBalance(ata);
      const amt = r.value.uiAmount ?? 0;
      if (amt > 0) console.log(`  ${sym.padEnd(8)}: ${amt.toLocaleString(undefined, { maximumFractionDigits: 6 })}`);
    } catch { /* pas d'ATA */ }
  }
}

main().catch(console.error);
