// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import {
  Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
  Transaction, TransactionInstruction, ComputeBudgetProgram,
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
 * Send and confirm a transaction via the wallet adapter's sendTransaction,
 * which routes through Phantom's transaction preview system.
 */
export async function sendTx(
  connection: Connection,
  wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
  ixs: TransactionInstruction[],
): Promise<string> {
  // Use a DEDICATED connection for the time-critical send/confirm path, bypassing
  // the global request throttle on the shared `connection` (providers.tsx spaces
  // RPC starts to avoid 429s on background reads). If the confirmation polling is
  // starved behind that throttle, the blockhash window lapses and the tx reports
  // "block height exceeded" even when it would have landed. Transactions are
  // low-volume and latency-critical, so they should not be throttled.
  const txConn = new Connection(connection.rpcEndpoint, "confirmed");

  // Guard: catch the "no record of a prior credit" runtime error before it happens.
  // On devnet a fresh wallet has 0 SOL — without at least one tx-fee worth of lamports
  // every transaction is rejected by the runtime before any instruction runs.
  const lamports = await txConn.getBalance(wallet.publicKey);
  if (lamports < 5_000) {
    throw new Error(
      "Your wallet has no devnet SOL. Click « Get SOL + USDC » to receive test tokens before trading."
    );
  }

  // Prepend a priority fee + compute-unit limit. Without these, a devnet tx with
  // no priority can fail to be included within the blockhash validity window
  // (~150 blocks) → "Signature … has expired: block height exceeded". The fee is
  // tiny (price × limit ≈ 0.00002 SOL) but materially improves landing under load.
  const budgetIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ];

  const { blockhash, lastValidBlockHeight } = await txConn.getLatestBlockhash();
  const tx = new Transaction().add(...budgetIxs, ...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer        = wallet.publicKey;
  // Sign with the wallet, but SEND through the dApp's own (Helius) connection —
  // NOT wallet.sendTransaction, which routes via the wallet extension's own RPC
  // and was returning a bare -32603 "Internal error" (WalletSendTransactionError)
  // on devnet under load. skipPreflight: these txs are pre-validated.
  const signed = await wallet.signTransaction(tx);
  const raw = signed.serialize();
  const sig = await txConn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 });

  // Robust confirm: poll signature status and periodically REBROADCAST the same
  // signed tx until it confirms or the blockhash truly expires. Rebroadcasting
  // keeps the tx alive in validators' mempools on a congested cluster instead of
  // relying on a single send + one-shot confirmTransaction.
  while (true) {
    const status = (await txConn.getSignatureStatus(sig)).value;
    if (status?.err) {
      throw new Error(`Transaction failed on-chain (${sig}): ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return sig;
    }
    const height = await txConn.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight) {
      throw new Error(
        `Transaction expired before confirmation (${sig}). The network may be congested — please try again.`
      );
    }
    await txConn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
  }
}
