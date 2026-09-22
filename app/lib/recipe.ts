// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// ── The recipe engine ────────────────────────────────────────────────────────
//
// A recipe composes instructions that already exist into ONE transaction the user signs.
// Nothing here holds a key, and nothing here decides for anybody: the engine computes and
// proposes, the human signs.
//
// Three problems stand between "these five instructions" and "one signature", and this file
// is those three problems and nothing else. The recipes themselves live in `recipes.ts`.
//
//  1. ☢️ THE AMOUNT CHAINING PROBLEM. `exercise_o_sola(amount)` and `stake_sola(amount)` take
//     their amount as an ARGUMENT, but that amount is produced by an earlier instruction of the
//     SAME transaction — the oSOLA does not exist in the wallet when the transaction is built.
//     The engine simulates the head of the recipe, reads the token accounts it leaves behind,
//     and sizes the tail from the delta. Between simulation and landing an accrual can only
//     GROW, never shrink, so a floored amount never reverts: at worst it leaves dust behind,
//     and the preview says how much.
//
//  2. THE WIRE. A legacy transaction is capped at 1232 bytes, signature included. The engine
//     measures rather than guesses (`measureIxs`), reserves room for the tail before it starts
//     admitting claims, and when the discovered work does not fit it plans the largest prefix
//     that does — a second round, not a silently truncated recipe. One recipe is one signature,
//     always; that invariant is what makes the failure modes explainable.
//
//  3. THE DRY RUN. The assembled recipe is simulated end to end before the wallet is asked for
//     anything. A recipe that would revert shows its decoded error instead of a wallet prompt,
//     and the same simulation reports `unitsConsumed`, which becomes the transaction's compute
//     budget — a recipe sets its own budget from measurement instead of inheriting the 400k
//     default that a single-instruction screen was sized for.
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";

/// `PACKET_DATA_SIZE` — the hard cap on a serialized transaction.
export const WIRE_LIMIT = 1232;

/// A base58 blockhash that is structurally valid and semantically meaningless. Measurement only
/// cares about the 32 bytes it occupies, and simulation replaces it (`replaceRecentBlockhash`).
const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111";

/// SPL token account layout: mint(32) · owner(32) · amount(u64). Token-2022 appends its
/// extensions after the 165-byte base, so the offset is the same for both programs.
const TOKEN_AMOUNT_OFFSET = 64;

// ── What a recipe is made of ─────────────────────────────────────────────────

/// One line of the plan, as the user reads it, with the instructions that make it true.
export type Step = {
  /// Stable across a re-plan, so the UI can keep a row's disclosure open.
  id: string;
  /// One line, carrying its own numbers: "Claim 12.4013 oSOLA — wSOL/USDC".
  label: string;
  ixs: TransactionInstruction[];
  /// A step the engine may drop to a later round to make the recipe fit. Only claims are:
  /// dropping a claim costs a round, dropping the exercise it feeds changes the recipe.
  optional?: boolean;
};

/// A row of the before/after the user reads before signing.
export type PreviewRow = {
  label: string;
  /// Signed, already in display units and already formatted — the engine never guesses decimals.
  delta: string;
  tone: "in" | "out" | "note";
  /// Why this number is what it is, shown on disclosure.
  note?: string;
};

export type Plan = {
  title: string;
  /// Null when the recipe can run. A string when it cannot, and it says which condition failed.
  blocked: string | null;
  steps: Step[];
  /// Claims that did not fit this round. Their presence is the whole "second round" message.
  deferred: Step[];
  preview: PreviewRow[];
  /// Things true of this plan that the user would rather know before signing than after.
  warnings: string[];
  /// Measured, not estimated: the exact wire size of the transaction they are about to sign.
  bytes: number;
  /// The budget the transaction will ask for, derived from the measurement below.
  computeUnits?: number;
  /// What the dry run actually consumed. Kept beside the budget deliberately: `budgetFor`
  /// clamps to a 400 000 floor, so a budget of 400 000 alone cannot be told apart from a
  /// simulation that reported nothing at all. Undefined means the cluster did not say.
  measuredUnits?: number;
  /// The transaction, ready for `sendTx`.
  ixs: TransactionInstruction[];
};

// ── 2. The wire ──────────────────────────────────────────────────────────────

/// The exact serialized size of the transaction these instructions would produce.
///
/// Measured against a real legacy `Transaction`, because that is what `sendTx` builds and sends.
/// A v0 message would measure one byte differently and an estimate by account count would be
/// wrong in both directions — an instruction that reuses an account already named by an earlier
/// one costs 0 extra bytes in the account table, so marginal cost falls as a recipe grows.
export function measureIxs(ixs: TransactionInstruction[], feePayer: PublicKey): number {
  // `Transaction.add()` throws on an empty argument list, and an empty recipe is a perfectly
  // ordinary thing to measure — it is what the packer starts from.
  const tx = new Transaction();
  if (ixs.length > 0) tx.add(...ixs);
  tx.recentBlockhash = PLACEHOLDER_BLOCKHASH;
  tx.feePayer = feePayer;
  try {
    // The message, plus the compact-u16 signature count (1 byte for any count under 128) and the
    // single 64-byte signature this wallet will add. No recipe has a second signer: every
    // instruction is signed by the user alone, which is the property that makes them composable.
    return tx.serializeMessage().length + 1 + 64;
  } catch {
    // ☢️ `serializeMessage` encodes into a fixed buffer and THROWS on a message far past the
    // wire, so a packer that measures candidates one by one walks into it by construction.
    // Too large to encode is, for every decision made here, too large to send — so it answers
    // with a size no limit can accommodate instead of taking the whole plan down.
    return Number.POSITIVE_INFINITY;
  }
}

/// The two compute-budget instructions `sendTx` prepends to everything it sends. They occupy
/// wire space like any other instruction, so a measurement that leaves them out is a
/// measurement that will be wrong by about 60 bytes at the exact moment it matters.
export function budgetPreamble(units: number): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ];
}

/// Admit steps in order while they fit, and hand back the ones that do not.
///
/// ☢️ The tail is passed as INSTRUCTIONS, not as a byte count, and every candidate is measured
/// with it in place. Reserving a figure measured on the tail alone double-counts two things at
/// once: the fixed transaction overhead (header, blockhash, fee payer, signature — about 130
/// bytes), and every account the tail shares with the head, which is most of them — the user,
/// the protocol state, the oSOLA mint, the token programs. Measured that way a recipe with 487
/// free bytes deferred four claims that would each have cost 151.
///
/// Only `optional` steps are ever deferred. A required step that does not fit is a recipe that
/// cannot run at all, and the caller is told so — by a `bytes` over the limit — rather than
/// handed a plan that quietly does something else.
export function fitSteps(
  steps: Step[],
  feePayer: PublicKey,
  opts: {
    /// What `sendTx` will prepend. Measured, because it occupies the same wire.
    preamble?: TransactionInstruction[];
    /// A placeholder of the instructions that will follow the fitted steps. Their SIZE does
    /// not depend on their amounts — an exercise of one unit names exactly the accounts an
    /// exercise of a million names — which is what makes a probe a valid measurement.
    tail?: TransactionInstruction[];
    limit?: number;
  } = {},
): { included: Step[]; deferred: Step[]; bytes: number } {
  const { preamble = [], tail = [], limit = WIRE_LIMIT } = opts;
  const included: Step[] = [];
  const deferred: Step[] = [];
  const sizeOf = (chosen: Step[]) =>
    measureIxs([...preamble, ...chosen.flatMap((s) => s.ixs), ...tail], feePayer);

  let bytes = sizeOf([]);
  for (const step of steps) {
    const candidate = sizeOf([...included, step]);
    if (candidate <= limit || !step.optional) {
      included.push(step);
      bytes = candidate;
    } else {
      deferred.push(step);
    }
  }
  return { included, deferred, bytes };
}

// ── 1. Amount chaining ───────────────────────────────────────────────────────

/// The `amount` field of an SPL or Token-2022 token account. Returns 0 for an account that does
/// not exist yet, which is the correct reading of "no account, no balance" — and is exactly the
/// state of an ATA the recipe itself is about to create.
export function decodeTokenAmount(data: Uint8Array | null | undefined): bigint {
  if (!data || data.length < TOKEN_AMOUNT_OFFSET + 8) return BigInt(0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(TOKEN_AMOUNT_OFFSET, true);
}

export type DryRun = {
  /// Balance of each requested account AFTER the instructions ran, keyed by base58 address.
  after: Map<string, bigint>;
  unitsConsumed?: number;
  /// Null when the simulation succeeded. The raw error otherwise — decode it with
  /// `explainTxError`, which this module deliberately does not import (it pulls in the IDL,
  /// and the engine stays testable under `node --test`).
  err: unknown | null;
  logs: string[];
};

/// Run instructions against the cluster without signing anything, and read the token balances
/// they leave behind.
///
/// ☢️ The transaction must still fit in the wire: the RPC refuses an oversized simulation the
/// same way the runtime refuses an oversized send. That is why sizing simulates the head of a
/// recipe that has already been fitted, never an unbounded list of candidate claims.
export async function dryRun(
  connection: Connection,
  feePayer: PublicKey,
  ixs: TransactionInstruction[],
  reads: PublicKey[] = [],
): Promise<DryRun> {
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: PLACEHOLDER_BLOCKHASH,
    instructions: ixs,
  }).compileToV0Message();

  const sim = await connection.simulateTransaction(new VersionedTransaction(message), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
    accounts: reads.length
      ? { encoding: "base64", addresses: reads.map((k) => k.toBase58()) }
      : undefined,
  });

  const after = new Map<string, bigint>();
  const accounts = sim.value.accounts ?? [];
  reads.forEach((key, i) => {
    const account = accounts[i];
    if (!account) return after.set(key.toBase58(), BigInt(0));
    const [b64] = account.data as [string, string];
    after.set(key.toBase58(), decodeTokenAmount(Buffer.from(b64, "base64")));
  });

  return {
    after,
    unitsConsumed: sim.value.unitsConsumed,
    err: sim.value.err ?? null,
    logs: sim.value.logs ?? [],
  };
}

/// Read the same balances the dry run will report, as they stand now.
///
/// The pair (before, after) is what lets a recipe act on WHAT IT PRODUCED rather than on
/// everything in the wallet. Compounding a claim should stake the claim, not quietly sweep a
/// SOLA balance the user was holding for something else.
export async function readBalances(
  connection: Connection,
  accounts: PublicKey[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (accounts.length === 0) return out;
  const infos = await connection.getMultipleAccountsInfo(accounts);
  accounts.forEach((key, i) => out.set(key.toBase58(), decodeTokenAmount(infos[i]?.data)));
  return out;
}

/// What a step produced, floored to base units, never negative.
///
/// Negative would mean the simulation spent from an account the recipe was supposed to fill —
/// a planning bug, not a user-visible condition — so it collapses to 0 and the recipe reports
/// nothing to work with rather than proposing a nonsensical amount.
export function produced(
  before: Map<string, bigint>,
  after: Map<string, bigint>,
  account: PublicKey,
): bigint {
  const key = account.toBase58();
  const delta = (after.get(key) ?? BigInt(0)) - (before.get(key) ?? BigInt(0));
  return delta > BigInt(0) ? delta : BigInt(0);
}

// ── 3. The dry run, as a plan gate ───────────────────────────────────────────

/// The compute budget a plan asks for, from what the dry run measured.
///
/// The margin covers the difference between a simulated slot and a landed one: account sizes
/// that grow, an `init_if_needed` that finds nothing the second time, a syscall that costs more
/// against a warmer cache. 20% over measured, floored at the 400k every single-instruction
/// screen already uses, capped at the 1.4M per-transaction maximum.
export function budgetFor(unitsConsumed: number | undefined): number {
  if (!unitsConsumed) return 400_000;
  return Math.min(1_400_000, Math.max(400_000, Math.ceil(unitsConsumed * 1.2)));
}
