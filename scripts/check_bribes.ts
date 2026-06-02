import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "../target/idl/soladrome.json";

const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const connection  = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
const provider    = new anchor.AnchorProvider(connection, {} as any, {});
const program     = new anchor.Program(idl as any, provider);

const EPOCH_S      = 604_800n;                                     // 7 days — matches on-chain EPOCH_DURATION
const nowSec       = BigInt(Math.floor(Date.now() / 1000));
const curEpoch     = nowSec / EPOCH_S;
const TARGET_EPOCH = curEpoch;                                     // ← override to check a specific past epoch
const toUi         = (bn: anchor.BN) => bn.toNumber() / 1_000_000;

function epochBuf(epoch: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(epoch);
  return b;
}

function sortMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return a.toBase58() < b.toBase58() ? [a, b] : [b, a];
}
function poolPda(a: PublicKey, b: PublicKey) {
  const [m0, m1] = sortMints(a, b);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("amm_pool"), m0.toBuffer(), m1.toBuffer()], PROGRAM_ID
  )[0];
}

const KNOWN: Record<string, string> = {
  "2rAqBLBi2Fjdjqf5za7uzpbYgNiVV74XMDKQ5RdMuEJT": "oSOLA",
  "HENFwJCzmBAo2Qybrszr28tqLtEFYkXwN6h87AD5gS9p": "SOLA",
  "nc1errcnXjKN4aZYL7AP89op26EMn5a2VcDT82wrTwW":  "hiSOLA",
};

function label(mint: string) { return KNOWN[mint] ?? mint.slice(0, 6) + "…"; }

async function main() {
  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
  const s = await (program.account as any).protocolState.fetch(statePda);
  const usdcMint = s.usdcMint as PublicKey;
  KNOWN[usdcMint.toBase58()] = "USDC";

  console.log(`Époque cible   : ${TARGET_EPOCH}`);
  console.log(`Époque courante: ${curEpoch}`);
  console.log(`Statut         : ${TARGET_EPOCH < curEpoch ? "TERMINÉE ✅ (claimable)" : TARGET_EPOCH === curEpoch ? "EN COURS 🔵" : "FUTURE ⏳"}\n`);

  // ── Gauges for target epoch ───────────────────────────────────────────────
  const allGauges = await (program.account as any).gaugeState.all();
  const targetGauges = allGauges.filter((g: any) => BigInt(g.account.epoch.toString()) === TARGET_EPOCH);
  console.log(`=== GAUGES epoch ${TARGET_EPOCH} (${targetGauges.length} trouvés) ===`);
  for (const g of targetGauges) {
    const pool       = g.account.poolId as PublicKey;
    const totalVotes = toUi(g.account.totalVotes as anchor.BN);
    console.log(`  Pool ${pool.toBase58().slice(0,12)}…  total_votes=${totalVotes.toFixed(6)}`);
    for (const [mintAddr, sym] of Object.entries(KNOWN)) {
      const mintPk = new PublicKey(mintAddr);
      const [bribeVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("bribe_vault"), pool.toBuffer(), mintPk.toBuffer(), epochBuf(TARGET_EPOCH)], PROGRAM_ID
      );
      try {
        const bal = await connection.getTokenAccountBalance(bribeVault);
        const amt = bal.value.uiAmount ?? 0;
        if (amt > 0) console.log(`    └─ Bribe ${sym}: ${amt.toLocaleString(undefined, {maximumFractionDigits:6})} tokens`);
      } catch { /* vault vide */ }
    }
  }
  if (targetGauges.length === 0) console.log("  Aucun gauge créé pour cette époque.");

  // ── Votes for target epoch ────────────────────────────────────────────────
  const allVotes = await (program.account as any).userVoteReceipt.all();
  const targetVotes = allVotes.filter((v: any) => BigInt(v.account.epoch.toString()) === TARGET_EPOCH);
  console.log(`\n=== VOTES epoch ${TARGET_EPOCH} (${targetVotes.length} trouvés) ===`);
  for (const v of targetVotes) {
    const user  = (v.account.user as PublicKey).toBase58();
    const pool  = (v.account.poolId as PublicKey).toBase58();
    const rawW  = v.account.voteWeight ?? v.account.votes ?? v.account.weight;
    const poids = rawW ? (typeof rawW === "number" ? rawW / 1e6 : toUi(rawW as anchor.BN)) : 0;
    console.log(`  ${user.slice(0,8)}… → Pool ${pool.slice(0,8)}…  poids=${poids.toFixed(6)}`);
  }
  if (targetVotes.length === 0) console.log("  Aucun vote pour cette époque.");

  // ── Claims for target epoch ───────────────────────────────────────────────
  try {
    const allClaims = await (program.account as any).userBribeClaim.all();
    const targetClaims = allClaims.filter((c: any) => BigInt(c.account.epoch.toString()) === TARGET_EPOCH);
    console.log(`\n=== CLAIMS epoch ${TARGET_EPOCH} (${targetClaims.length}) ===`);
    for (const c of targetClaims) {
      console.log(`  ${(c.account.user as PublicKey).toBase58().slice(0,8)}… → déjà réclamé`);
    }
    if (targetClaims.length === 0) console.log("  Aucun claim effectué.");
  } catch { console.log("\n  (userBribeClaim non disponible)"); }
}

main().catch(console.error);
