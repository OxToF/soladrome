import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import idl from "./soladrome.json";

export const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");

// ── PDAs ─────────────────────────────────────────────────────────────────────
export const statePda       = PublicKey.findProgramAddressSync([Buffer.from("state")],        PROGRAM_ID)[0];
export const solaM          = PublicKey.findProgramAddressSync([Buffer.from("sola_mint")],    PROGRAM_ID)[0];
export const hiSolaM        = PublicKey.findProgramAddressSync([Buffer.from("hi_sola_mint")], PROGRAM_ID)[0];
export const oSolaM         = PublicKey.findProgramAddressSync([Buffer.from("o_sola_mint")],  PROGRAM_ID)[0];
export const floorVault     = PublicKey.findProgramAddressSync([Buffer.from("floor_vault")],  PROGRAM_ID)[0];
export const marketVault    = PublicKey.findProgramAddressSync([Buffer.from("market_vault")], PROGRAM_ID)[0];
export const solaVaultAddr  = PublicKey.findProgramAddressSync([Buffer.from("sola_vault")],   PROGRAM_ID)[0];

export function positionPda(user: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), user.toBuffer()],
    PROGRAM_ID
  )[0];
}

export function getProgram(provider: AnchorProvider) {
  return new Program(idl as any, provider);
}

export function userAta(mint: PublicKey, owner: PublicKey) {
  return getAssociatedTokenAddressSync(mint, owner);
}

// ── shared accounts helpers ───────────────────────────────────────────────────
export const commonAccounts = {
  tokenProgram:           TOKEN_PROGRAM_ID,
  associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  systemProgram:          SystemProgram.programId,
  rent:                   SYSVAR_RENT_PUBKEY,
};

export const DECIMALS = 6;
export const ONE = new BN(1_000_000);
export function toUi(raw: BN | number | bigint): number {
  const n = typeof raw === "bigint" ? Number(raw) : typeof raw === "number" ? raw : raw.toNumber();
  return n / 10 ** DECIMALS;
}
export function fromUi(ui: number): BN {
  return new BN(Math.floor(ui * 10 ** DECIMALS));
}
