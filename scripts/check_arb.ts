import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "../target/idl/soladrome.json";

const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const connection = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
const provider = new anchor.AnchorProvider(connection, {} as any, {});
const program = new anchor.Program(idl as any, provider);

const toUi = (bn: anchor.BN) => bn.toNumber() / 1_000_000;

function sortMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return a.toBase58() < b.toBase58() ? [a, b] : [b, a];
}
function poolPda(a: PublicKey, b: PublicKey) {
  const [m0, m1] = sortMints(a, b);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("amm_pool"), m0.toBuffer(), m1.toBuffer()], PROGRAM_ID
  )[0];
}

async function main() {
  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
  const s = await (program.account as any).protocolState.fetch(statePda);

  const curvePrice = toUi(s.virtualUsdc) / toUi(s.virtualSola);

  console.log("=== PROTOCOL STATE ===");
  console.log(`SOLA Supply:     ${toUi(s.totalSola).toFixed(4)}`);
  console.log(`hiSOLA Staked:   ${toUi(s.totalHiSola).toFixed(4)}`);
  console.log(`Prix courbe:     ${curvePrice.toFixed(6)} USDC/SOLA`);
  console.log(`Virtual USDC:    ${toUi(s.virtualUsdc).toFixed(4)}`);
  console.log(`Virtual SOLA:    ${toUi(s.virtualSola).toFixed(4)}`);
  console.log(`Fees accumulés:  ${toUi(s.accumulatedFees).toFixed(4)} USDC`);

  const solaM  = new PublicKey("HENFwJCzmBAo2Qybrszr28tqLtEFYkXwN6h87AD5gS9p");
  const oSolaM = new PublicKey("2rAqBLBi2Fjdjqf5za7uzpbYgNiVV74XMDKQ5RdMuEJT");
  const usdcMint = s.usdcMint as PublicKey;

  const pools = [
    { name: "SOLA/USDC",  pda: poolPda(solaM, usdcMint),  refA: solaM,  refB: usdcMint },
    { name: "oSOLA/USDC", pda: poolPda(oSolaM, usdcMint), refA: oSolaM, refB: usdcMint },
    { name: "oSOLA/SOLA", pda: poolPda(oSolaM, solaM),    refA: oSolaM, refB: solaM    },
  ];

  console.log("\n=== AMM POOLS ===");
  const prices: Record<string, number> = {};
  for (const p of pools) {
    try {
      const pool = await (program.account as any).ammPool.fetch(p.pda);
      const mintA = (pool.tokenAMint as PublicKey).toBase58();
      const ra = toUi(pool.reserveA as anchor.BN);
      const rb = toUi(pool.reserveB as anchor.BN);
      const isRefA = mintA === p.refA.toBase58();
      const price = isRefA ? rb / ra : ra / rb;
      prices[p.name] = price;
      const [tA, tB] = p.name.split("/");
      console.log(`${p.name.padEnd(12)}: rA=${ra.toFixed(4).padStart(12)} rB=${rb.toFixed(4).padStart(12)} → 1 ${tA} = ${price.toFixed(6)} ${tB}`);
    } catch {
      console.log(`${p.name}: pool introuvable`);
    }
  }

  console.log("\n=== ARBITRAGE CHECK ===");
  const solaPriceAmm  = prices["SOLA/USDC"]  ?? null;
  const osolaPriceAmm = prices["oSOLA/USDC"] ?? null;
  const osolaPriceSola = prices["oSOLA/SOLA"] ?? null;

  if (solaPriceAmm !== null) {
    const spreadAbs = solaPriceAmm - curvePrice;
    const spreadPct = (spreadAbs / curvePrice) * 100;
    console.log(`SOLA prix AMM :    ${solaPriceAmm.toFixed(6)} USDC`);
    console.log(`SOLA prix courbe : ${curvePrice.toFixed(6)} USDC`);
    console.log(`Spread :           ${spreadAbs >= 0 ? "+" : ""}${spreadAbs.toFixed(6)} USDC (${spreadPct.toFixed(2)}%)`);
    if (spreadAbs > 0.0001)     console.log(`→ Acheter via buy_sola moins cher que l'AMM`);
    else if (spreadAbs < -0.0001) console.log(`→ Acheter sur AMM moins cher que la courbe`);
    else                          console.log(`→ Prix AMM ≈ courbe, marché équilibré`);
  }

  if (osolaPriceAmm !== null && solaPriceAmm !== null) {
    const profitExercice = solaPriceAmm - 1 - osolaPriceAmm;
    console.log(`\noSOLA prix AMM :   ${osolaPriceAmm.toFixed(6)} USDC`);
    console.log(`Exercice :         payer 1 USDC + brûler 1 oSOLA → recevoir 1 SOLA (floor)`);
    console.log(`Profit/unité :     ${solaPriceAmm.toFixed(4)} - 1.00 - ${osolaPriceAmm.toFixed(4)} = ${profitExercice >= 0 ? "+" : ""}${profitExercice.toFixed(6)} USDC`);
    if (profitExercice > 0.001)
      console.log(`→ ✅ Exercice profitable ! Arbitrage disponible (${profitExercice.toFixed(4)} USDC/oSOLA)`);
    else if (profitExercice > 0)
      console.log(`→ ⚖️  Exercice légèrement profitable (fees peuvent annuler)`);
    else
      console.log(`→ ❌ Pas d'arbitrage oSOLA rentable — prix convergé ou AMM sous le peg`);
  }

  if (osolaPriceSola !== null && solaPriceAmm !== null) {
    const osolaPriceInUsdc = osolaPriceSola * solaPriceAmm;
    const profitViaSola = solaPriceAmm - 1 - osolaPriceInUsdc;
    console.log(`\noSOLA/SOLA pool :  1 oSOLA = ${osolaPriceSola.toFixed(6)} SOLA = ${osolaPriceInUsdc.toFixed(6)} USDC`);
    console.log(`Profit exercice via oSOLA/SOLA : ${profitViaSola >= 0 ? "+" : ""}${profitViaSola.toFixed(6)} USDC/unité`);
  }

  // Floor vault
  try {
    const [floorVault] = PublicKey.findProgramAddressSync([Buffer.from("floor_vault")], PROGRAM_ID);
    const bal = await connection.getTokenAccountBalance(floorVault);
    const floorAmt = +bal.value.amount / 1_000_000;
    const backingRatio = toUi(s.totalSola) > 0 ? floorAmt / toUi(s.totalSola) : 0;
    console.log(`\n=== FLOOR RESERVE ===`);
    console.log(`Floor vault :     ${floorAmt.toFixed(4)} USDC`);
    console.log(`SOLA supply :     ${toUi(s.totalSola).toFixed(4)}`);
    console.log(`Backing ratio :   ${(backingRatio * 100).toFixed(2)}% (cible 100%)`);
  } catch {
    console.log("\nFloor vault: impossible à fetch");
  }
}

main().catch(console.error);
