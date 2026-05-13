import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import idl from "../app/lib/soladrome.json";

const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const USDC_MINT  = new PublicKey("8SvQXTGjygYUSpMFrdCRSByZe397nn78bJ7ebJasnKMg");

async function main() {
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8")))
  );
  const conn = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl as any, provider);

  const [statePda]    = PublicKey.findProgramAddressSync([Buffer.from("state")],        PROGRAM_ID);
  const [solaMint]    = PublicKey.findProgramAddressSync([Buffer.from("sola_mint")],    PROGRAM_ID);
  const [hiSolaMint]  = PublicKey.findProgramAddressSync([Buffer.from("hi_sola_mint")], PROGRAM_ID);
  const [oSolaMint]   = PublicKey.findProgramAddressSync([Buffer.from("o_sola_mint")],  PROGRAM_ID);
  const [floorVault]  = PublicKey.findProgramAddressSync([Buffer.from("floor_vault")],  PROGRAM_ID);
  const [marketVault] = PublicKey.findProgramAddressSync([Buffer.from("market_vault")], PROGRAM_ID);
  const [solaVault]   = PublicKey.findProgramAddressSync([Buffer.from("sola_vault")],   PROGRAM_ID);

  console.log("Initializing Soladrome on devnet...");
  const tx = await program.methods.initialize().accounts({
    authority: kp.publicKey,
    usdcMint: USDC_MINT,
    protocolState: statePda,
    solaMint,
    hiSolaMint,
    oSolaMint,
    floorVault,
    marketVault,
    solaVault,
    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
    systemProgram: anchor.web3.SystemProgram.programId,
    rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  } as any).rpc();
  console.log("✅ Initialized! Tx:", tx);
  console.log("USDC Mint devnet:", USDC_MINT.toBase58());
}
main().catch(console.error);
