import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";

const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const PRECISION  = BigInt("1000000000000"); // 1e12
const statePda   = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID)[0];

function positionPda(u: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("position"), u.toBuffer()], PROGRAM_ID)[0];
}

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const idl  = JSON.parse(fs.readFileSync("./app/lib/soladrome.json", "utf8"));
  const prov = new anchor.AnchorProvider(connection, {} as any, {});
  const prog = new anchor.Program(idl, prov);

  // ── Read ProtocolState raw to get fees_per_hi_sola (u128 at known offset) ──
  // ProtocolState layout (after 8-byte discriminator):
  //   authority: Pubkey(32) | paused: bool(1) | pad(3?) | sola_mint: Pubkey(32) ...
  // Easier: use the IDL-typed fetch then cast
  const stateInfo = await connection.getAccountInfo(statePda);
  if (!stateInfo) { console.log("state not found"); return; }
  // fees_per_hi_sola is u128. Use program.account to deserialize
  const stateAccts: any[] = await (prog.account as any).protocolState.all();
  const state = stateAccts[0].account;
  const globalAcc = BigInt(state.feesPerHiSola.toString());
  const hiSolaMint = state.hiSolaMint as PublicKey;
  console.log("\n=== ProtocolState ===");
  console.log(`  fees_per_hi_sola: ${globalAcc}`);
  console.log(`  total_hi_sola   : ${(Number(state.totalHiSola)/1e6).toFixed(6)} hiSOLA`);

  // ── Wallets ────────────────────────────────────────────────────────────────
  const wallets: Record<string, string> = {
    "JAfXUr5": "JAfXUr5WNpj4wTeWAQ9KXmj9zRjBESTdgviAo1LLNrFn",
    "CL4yt4" : "CL4yt4Ep6N3AKbbHhQaidjVLNzQrdgT5NobQSE6FGHr3",
    "FOUNDER": "46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4",
  };

  console.log("\n=== UserPosition per wallet ===");
  for (const [label, addr] of Object.entries(wallets)) {
    const user = new PublicKey(addr);
    const pda  = positionPda(user);
    const posInfo = await connection.getAccountInfo(pda);
    if (!posInfo) { console.log(`  [${label}]: no position`); continue; }

    const pos: any = await (prog.account as any).userPosition.fetch(pda);
    const debt     = BigInt(pos.feesDebt.toString());
    const borrowed = Number(pos.usdcBorrowed) / 1e6;

    // hiSOLA balance
    const ata = anchor.utils.token.associatedAddress({ mint: hiSolaMint, owner: user });
    let hiSola = BigInt(0);
    try { hiSola = BigInt((await connection.getTokenAccountBalance(ata)).value.amount); }
    catch { /* no ATA */ }

    const diff    = globalAcc - debt;
    const pending = diff > BigInt(0) ? (diff * hiSola) / PRECISION : BigInt(0);

    console.log(`\n  [${label}]`);
    console.log(`    hiSOLA balance  : ${(Number(hiSola)/1e6).toFixed(4)}`);
    console.log(`    fees_debt       : ${debt}`);
    console.log(`    fees_per_hi - debt: ${diff}  ${diff < BigInt(0) ? "⚠️ DEBT > ACC" : ""}`);
    console.log(`    usdc_borrowed   : ${borrowed.toFixed(6)} USDC`);
    console.log(`    pending USDC    : ${(Number(pending)/1e6).toFixed(6)}`);
    console.log(`    account bytes   : ${posInfo.data.length}`);
  }
}

describe("fees", () => {
  it("check", async function() { this.timeout(30000); await main(); });
});
