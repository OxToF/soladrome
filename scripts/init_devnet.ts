import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import idl from "../app/lib/soladrome.json";

const PROGRAM_ID = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");
// Mock USDC, reminted 2026-08-08: the previous mint (8SvQXTG…) had its mint authority on the
// compromised deployer key. Authority is now the faucet keypair — the only key that needs to mint.
const USDC_MINT  = new PublicKey("3N8EKeBPF8Gp9ayQ3WJzcxmDcWAMYKjwnuZXWC71FLtd");

// The founder wallet is passed to `initialize` and is IMMUTABLE afterwards — it left the
// binary on 2026-08-23 so devnet and mainnet could run the same build. Devnet 2 uses a HOT
// wallet (chosen 2026-08-24), deliberately not the mainnet Ledger: devnet has to stay operable
// without hardware, and the divergence that mattered was in the CODE — the binary is identical
// either way. Override with DEVNET_FOUNDER_WALLET.
const FOUNDER_WALLET = new PublicKey(
  process.env.DEVNET_FOUNDER_WALLET ?? "4T1gHVpLRDPJQrsW1QUfHMYuCBLzVLgP7tu1yuoWtYGH"
);

async function main() {
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8")))
  );
  const RPC = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new anchor.web3.Connection(RPC, "confirmed");
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
  const tx = await program.methods.initialize(FOUNDER_WALLET).accounts({
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
