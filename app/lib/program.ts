// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import {
  Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
  Transaction, TransactionInstruction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import idl from "./soladrome.json";

export const PROGRAM_ID = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");

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

// ── hiSOLA is a position, not a token ─────────────────────────────────────────
// There is no hiSOLA mint balance to read: the balance lives in `UserPosition.hi_sola`.
// Decoded by byte offset rather than through Anchor so any caller with a `Connection` can
// use it — no provider, no wallet. Offsets are exact because Borsh writes fields back to
// back; they are listed here rather than scattered across the components that need them.
//
//   8 owner(32) · 40 usdc_borrowed(8) · 48 fees_debt(16) · 64 bump(1)
//  65 last_borrow_slot(8) · 73 vote_escrowed(8, legacy) · 81 escrow_epoch(8, legacy)
//  89 staked_amount(8) · 97 hi_sola(8) · 105 vote_locked(8) · 113 vote_lock_epoch(8)
export const POS_OFF = {
  usdcBorrowed: 40,
  voteEscrowed: 73,
  stakedAmount: 89,
  hiSola: 97,
  voteLocked: 105,
  voteLockEpoch: 113,
} as const;

export type HiSolaPosition = {
  /// Spendable hiSOLA balance, in base units.
  hiSola: bigint;
  /// The financed subset — the ceiling on `borrow_usdc`.
  stakedAmount: bigint;
  /// Immobilised by this epoch's votes; 0 once the stamped epoch has passed.
  voteLocked: bigint;
  /// The epoch `voteLocked` was stamped for.
  voteLockEpoch: number;
  /// Legacy SPL balance still sitting in the old escrow vault, awaiting `convert_hi_sola`.
  voteEscrowed: bigint;
  usdcBorrowed: bigint;
};

/// Read a wallet's hiSOLA position. Returns all-zero when the position does not exist yet,
/// which is the correct reading: no position, no balance.
export async function readPosition(
  connection: { getAccountInfo: (k: PublicKey) => Promise<{ data: Buffer } | null> },
  owner: PublicKey,
  atEpoch?: number
): Promise<HiSolaPosition> {
  const zero = {
    hiSola: BigInt(0),
    stakedAmount: BigInt(0),
    voteLocked: BigInt(0),
    voteLockEpoch: 0,
    voteEscrowed: BigInt(0),
    usdcBorrowed: BigInt(0),
  };
  const info = await connection.getAccountInfo(positionPda(owner));
  if (!info || info.data.length < POS_OFF.voteLockEpoch + 8) return zero;
  const d = Buffer.from(info.data);
  const stampedEpoch = d.readBigUInt64LE(POS_OFF.voteLockEpoch);
  const locked = d.readBigUInt64LE(POS_OFF.voteLocked);
  return {
    hiSola: d.readBigUInt64LE(POS_OFF.hiSola),
    stakedAmount: d.readBigUInt64LE(POS_OFF.stakedAmount),
    // A stamp from an earlier epoch is spent — the program reads it the same way
    // (`UserPosition::vote_locked_now`), so showing it as still locked would be a lie.
    voteLocked:
      atEpoch !== undefined && stampedEpoch !== BigInt(atEpoch)
        ? BigInt(0)
        : locked,
    voteLockEpoch: Number(stampedEpoch),
    voteEscrowed: d.readBigUInt64LE(POS_OFF.voteEscrowed),
    usdcBorrowed: d.readBigUInt64LE(POS_OFF.usdcBorrowed),
  };
}

export function userAta(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
) {
  return getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
}

// ── Which token program owns a mint ───────────────────────────────────────────
//
// Since the Token-2022 migration a pool's two sides may be served by DIFFERENT programs — an
// xStock (Token-2022) quoted in USDC (classic SPL Token) is the flagship case — so the caller
// can no longer assume `TOKEN_PROGRAM_ID`. It also decides ATA derivation: the associated-token
// address is seeded with the token program, so deriving a Token-2022 ATA under Tokenkeg yields
// an address that simply does not exist.
//
// The protocol's own mints (SOLA, oSOLA, every LP mint) are deliberately still classic SPL
// Token, so callers that only touch those keep using the default and need none of this.
const mintProgramCache = new Map<string, PublicKey>();

/// The program that owns `mint`, read from the chain and memoised.
///
/// A mint's owner cannot change, so caching for the life of the tab is safe. Falls back to
/// classic SPL Token when the account cannot be read, which keeps a transient RPC failure from
/// silently producing a Token-2022 address for an SPL mint — the transaction then fails loudly
/// at simulation rather than sending tokens to an address nobody controls.
export async function getMintProgram(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const key = mint.toBase58();
  const hit = mintProgramCache.get(key);
  if (hit) return hit;
  const info = await connection.getAccountInfo(mint);
  const owner =
    info && info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  mintProgramCache.set(key, owner);
  return owner;
}

/// Both sides of a pair in one round trip.
export async function getMintPrograms(
  connection: Connection,
  mintA: PublicKey,
  mintB: PublicKey,
): Promise<{ programA: PublicKey; programB: PublicKey }> {
  const [programA, programB] = await Promise.all([
    getMintProgram(connection, mintA),
    getMintProgram(connection, mintB),
  ]);
  return { programA, programB };
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
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): Promise<TransactionInstruction | null> {
  const ata  = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const info = await connection.getAccountInfo(ata);
  return info
    ? null
    : createAssociatedTokenAccountInstruction(payer, ata, owner, mint, tokenProgram);
}

/**
 * Send and confirm a transaction via the wallet adapter's sendTransaction,
 * which routes through Phantom's transaction preview system.
 */
/// Turn a raw on-chain failure into something a human can act on.
///
/// `getSignatureStatus` returns the runtime's own structure, e.g.
///   {"InstructionError":[2,{"Custom":6037}]}
/// which we used to print verbatim. 6037 means FeatureDisabled, and the IDL already carries
/// that message — there is no reason to make anyone look it up.
///
/// Falls back to the raw JSON when the code is not one of ours: a runtime error (insufficient
/// lamports, account in use) is not in the IDL and its own shape is more informative than any
/// wording we could invent for it.
export function explainTxError(err: unknown): string {
  const raw = JSON.stringify(err);
  const code = extractCustomCode(err);
  if (code === null) return `Transaction failed on-chain: ${raw}`;

  const entry = (idl as any).errors?.find((e: any) => e.code === code);
  if (!entry) return `Transaction failed on-chain: ${raw}`;

  // The IDL message is written for a developer; prepend the name so a report is greppable,
  // and keep the code so it can be matched against the program source.
  return `${entry.name} (${code}): ${entry.msg ?? "no message in the IDL"}`;
}

/// Dig the `Custom` code out of the runtime's error shape, whatever depth it sits at.
function extractCustomCode(err: unknown): number | null {
  if (err === null || typeof err !== "object") return null;
  const o = err as Record<string, unknown>;
  if (typeof o.Custom === "number") return o.Custom;
  for (const v of Object.values(o)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        const found = extractCustomCode(item);
        if (found !== null) return found;
      }
    } else if (v && typeof v === "object") {
      const found = extractCustomCode(v);
      if (found !== null) return found;
    }
  }
  return null;
}

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
      throw new Error(`${explainTxError(status.err)} (tx ${sig.slice(0, 12)}…)`);
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
