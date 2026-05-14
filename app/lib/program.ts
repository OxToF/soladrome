// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import {
  Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
  Transaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import idl from "./soladrome.json";

export const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");

// wSOL mint is the same on all clusters
export const WSOL_MINT_STR = "So11111111111111111111111111111111111111112";

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

// ── AMM pool PDAs ─────────────────────────────────────────────────────────────

export function sortMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) <= 0 ? [a, b] : [b, a];
}

export function poolPda(mintA: PublicKey, mintB: PublicKey): PublicKey {
  const [ma, mb] = sortMints(mintA, mintB);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("amm_pool"), ma.toBuffer(), mb.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export function lpMintPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("lp_mint"), pool.toBuffer()], PROGRAM_ID)[0];
}

export function vaultAPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault_a"), pool.toBuffer()], PROGRAM_ID)[0];
}

export function vaultBPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault_b"), pool.toBuffer()], PROGRAM_ID)[0];
}

// ── Unit conversions ──────────────────────────────────────────────────────────

export const DECIMALS = 6;
export const ONE = new BN(1_000_000);

export function toUi(raw: BN | number | bigint): number {
  const n = typeof raw === "bigint" ? Number(raw) : typeof raw === "number" ? raw : raw.toNumber();
  return n / 10 ** DECIMALS;
}

export function toUiDecimals(raw: BN | number | bigint, decimals: number): number {
  const n = typeof raw === "bigint" ? Number(raw) : typeof raw === "number" ? raw : raw.toNumber();
  return n / 10 ** decimals;
}

export function fromUi(ui: number): BN {
  return new BN(Math.floor(ui * 10 ** DECIMALS));
}

export function fromUiDecimals(ui: number, decimals: number): BN {
  return new BN(Math.floor(ui * 10 ** decimals));
}

// ── Native SOL ↔ wSOL wrap/unwrap helpers ────────────────────────────────────

/**
 * Build pre-instructions to wrap native SOL into the user's wSOL ATA.
 * Creates the ATA if it doesn't exist, transfers lamports, then syncs.
 */
export async function buildWrapInstructions(
  connection: Connection,
  payer: PublicKey,
  lamports: number,
): Promise<TransactionInstruction[]> {
  const wsolMint = new PublicKey(WSOL_MINT_STR);
  const wsolAta  = getAssociatedTokenAddressSync(wsolMint, payer);
  const ixs: TransactionInstruction[] = [];

  const info = await connection.getAccountInfo(wsolAta);
  if (!info) {
    ixs.push(createAssociatedTokenAccountInstruction(payer, wsolAta, payer, wsolMint));
  }
  ixs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: wsolAta, lamports }));
  ixs.push(createSyncNativeInstruction(wsolAta));
  return ixs;
}

/**
 * Build a post-instruction that closes the wSOL ATA and returns native SOL to the owner.
 * Safe to call even if the ATA had 0 balance (just reclaims rent).
 */
export function buildUnwrapInstruction(owner: PublicKey): TransactionInstruction {
  const wsolMint = new PublicKey(WSOL_MINT_STR);
  const wsolAta  = getAssociatedTokenAddressSync(wsolMint, owner);
  return createCloseAccountInstruction(wsolAta, owner, owner);
}

/**
 * Ensure an SPL token ATA exists; returns a creation instruction or null.
 */
export async function ensureAtaIx(
  connection: Connection,
  payer: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
): Promise<TransactionInstruction | null> {
  const ata  = getAssociatedTokenAddressSync(mint, owner);
  const info = await connection.getAccountInfo(ata);
  return info ? null : createAssociatedTokenAccountInstruction(payer, ata, owner, mint);
}

/**
 * Sign, send, and confirm a transaction using the wallet adapter.
 */
export async function sendTx(
  connection: Connection,
  wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
  ixs: TransactionInstruction[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash  = blockhash;
  tx.feePayer         = wallet.publicKey;
  const signed = await wallet.signTransaction(tx);
  const sig    = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
  return sig;
}
