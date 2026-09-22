// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs

// What a failed transaction costs the user, and what it is trying to say.
//
// Deliberately dependency-free: no web3.js, no IDL import. Program ids are compared as
// base58 strings and the IDL's error list is passed in by the caller. That keeps this file
// importable by `node --test` (see txerror.test.mts), which is where the regressions this
// module exists for are pinned.

/// Lamports a native-SOL input must leave untouched in the wallet.
///
/// Wrapping SOL is never the whole cost of the transaction that wraps it. After the
/// `SystemProgram.transfer` into the wSOL ATA, the SAME transaction still has to pay:
///   • the fee — 5 000 base + 20 000 priority (400 000 CU x 50 000 microlamports),
///   • rent for every ATA it opens — 2 039 280 lamports each, and an add-liquidity can
///     open three of them (wSOL, LP, and the dead-LP one on a pool's first deposit).
/// That floor is 6 142 840 lamports. We reserve 0.02 SOL instead, so that a "Max" click
/// also leaves enough for the NEXT transaction (the unwrap, a stake, a claim) rather than
/// stranding the wallet at a balance too thin to do anything with the LP it just got.
export const SOL_FEE_RESERVE = 0.02;

/// How much of a native-SOL balance a user can actually put into a transaction.
/// Returns 0 when the balance is already at or below the reserve, so the percentage
/// buttons go quiet instead of proposing an amount that cannot land.
export function spendableSol(balanceSol: number): number {
  return Math.max(0, balanceSol - SOL_FEE_RESERVE);
}

export const SYSTEM_PROGRAM_ID_STR   = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID_STR    = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_ID_STR       = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/// An entry of an Anchor IDL's `errors` array.
export interface IdlErrorEntry { code: number; name: string; msg?: string }

/// Turn a raw on-chain failure into something a human can act on.
///
/// `getSignatureStatus` returns the runtime's own structure, e.g.
///   {"InstructionError":[2,{"Custom":6037}]}
/// which we used to print verbatim. 6037 means FeatureDisabled, and the IDL already carries
/// that message — there is no reason to make anyone look it up.
///
/// `programIds` is the transaction's instruction list reduced to base58 program ids, in
/// order. It is what disambiguates the low error codes; without it those stay raw, which is
/// still better than a wrong guess.
export function explainInstructionError(
  err: unknown,
  programIds?: readonly string[],
  idlErrors?: readonly IdlErrorEntry[],
): string {
  const raw = JSON.stringify(err);
  const { index, code } = extractInstructionError(err);
  if (code === null) return `Transaction failed on-chain: ${raw}`;

  const entry = idlErrors?.find((e) => e.code === code);
  // The IDL message is written for a developer; prepend the name so a report is greppable,
  // and keep the code so it can be matched against the program source.
  if (entry) return `${entry.name} (${code}): ${entry.msg ?? "no message in the IDL"}`;

  // Anchor's own framework errors (2000-3999) never appear in an IDL — only the program's
  // `#[error_code]` enum does, from 6000 up. They still reach users: 3012 is what a deposit
  // into a pool whose other token the wallet has never held comes back as.
  const framework = ANCHOR_FRAMEWORK_ERRORS[code];
  if (framework) return `Transaction failed: ${framework}`;

  // Below 2000 the error is raised by a program we did not write, and the number alone is
  // ambiguous: System 1 is "result with negative lamports", SPL Token 1 is "insufficient
  // funds". It only resolves once the failing instruction names the program that raised it.
  const msg = nativeErrorTable(index, programIds)?.[code];
  if (msg) return `Transaction failed: ${msg}`;

  return `Transaction failed on-chain: ${raw}`;
}

/// Anchor framework errors a user can actually trigger from this UI.
const ANCHOR_FRAMEWORK_ERRORS: Record<number, string> = {
  2003: "an account constraint was not satisfied.",
  2006: "an account address was derived from the wrong seeds. The app may be running against "
      + "a stale IDL.",
  3007: "an account is owned by the wrong program.",
  3012: "one of the token accounts this transaction needs does not exist yet, which means the "
      + "wallet has never held that token. Pick a pool whose two tokens you already hold.",
  3014: "an account was expected to sign and did not.",
};

/// System-program errors that a dApp transaction can realistically hit.
const SYSTEM_PROGRAM_ERRORS: Record<number, string> = {
  0: "that account already exists.",
  1: "not enough SOL. The wallet has to cover the amount you entered PLUS the network fee and "
   + "the rent of the token accounts this transaction opens, so it cannot spend the balance "
   + `down to zero. Leave at least ${SOL_FEE_RESERVE} SOL and try again.`,
  2: "invalid program id.",
  3: "invalid account data length.",
};

/// SPL Token (and Token-2022, same numbering) errors reachable from the UI.
const TOKEN_PROGRAM_ERRORS: Record<number, string> = {
  0: "the token account is not rent-exempt.",
  1: "insufficient token balance for this transfer.",
  3: "that token account belongs to a different mint.",
  4: "that token account has a different owner.",
  17: "that token account is frozen.",
};

function nativeErrorTable(
  index: number | null,
  programIds?: readonly string[],
): Record<number, string> | null {
  if (index === null || !programIds?.[index]) return null;
  const program = programIds[index];
  if (program === SYSTEM_PROGRAM_ID_STR) return SYSTEM_PROGRAM_ERRORS;
  if (program === TOKEN_PROGRAM_ID_STR)  return TOKEN_PROGRAM_ERRORS;
  if (program === TOKEN_2022_ID_STR)     return TOKEN_PROGRAM_ERRORS;
  return null;
}

/// Split the runtime's `{"InstructionError":[index, {"Custom": code}]}` into its two halves.
/// Falls back to the recursive digger for the wrapped shapes wallet adapters produce, which
/// carry the code but not always the index.
function extractInstructionError(err: unknown): { index: number | null; code: number | null } {
  const pair = (err as { InstructionError?: unknown })?.InstructionError;
  if (Array.isArray(pair) && typeof pair[0] === "number") {
    const inner = pair[1] as { Custom?: unknown } | undefined;
    return {
      index: pair[0],
      code:  inner && typeof inner === "object" && typeof inner.Custom === "number"
        ? inner.Custom
        : null,
    };
  }
  return { index: null, code: extractCustomCode(err) };
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

// ── RPC refusals, which never reach the chain ────────────────────────────────

/// Recognise a transport-level refusal by the RPC provider, as opposed to a program failure.
///
/// These two get confused constantly, and the confusion is expensive: a rate-limited read
/// looks, to a user staring at a button, exactly like a broken transaction. It is not. Nothing
/// was signed, nothing was sent, nothing on chain changed — the provider declined to answer.
///
/// Helius meters by REQUESTS PER SECOND, not by credits, so a burst is what trips it: a recipe
/// plans with about ten reads and two simulations, and the send path then opens with two more
/// on a deliberately un-throttled connection. The provider answers `401` with
/// `{"code":-32401,"message":"Bad request, please try again later."}` — a message that says
/// nothing about rate limiting and reads like an auth failure, which is why it needs naming.
///
/// Returns null when the error is not one of these, so the caller can fall through to the
/// on-chain decoder rather than mislabelling a real revert.
export function explainRpcRefusal(err: unknown): string | null {
  const text =
    typeof err === "string"
      ? err
      : ((err as { message?: string })?.message ?? JSON.stringify(err ?? ""));

  // JSON-RPC codes a provider uses to decline: -32401 (Helius "bad request"), -32005 (node
  // behind / limit exceeded), -32429 and the plain HTTP statuses web3.js prefixes its message
  // with. `^\s*4\d\d\s` matches "401 : {...}" without matching a 401 that appears in a pubkey.
  const declined =
    /-32401|-32005|-32429/.test(text) ||
    /^\s*(401|403|429|502|503|504)\s*[:\s]/.test(text);
  if (!declined) return null;

  const tooMany = /429|-32005|-32429|rate|too many/i.test(text);
  return tooMany
    ? "The RPC provider is rate-limiting this wallet (requests per second, not credits). Nothing was signed and nothing was sent — wait a moment and try again."
    : "The RPC provider declined the request. Nothing was signed and nothing was sent — this is the endpoint, not your transaction. Wait a moment and try again.";
}
