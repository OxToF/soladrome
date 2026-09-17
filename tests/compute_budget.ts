// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs
//
// # The test suites must run on the budget the APP asks for, not on the default
//
// Every transaction the frontend sends carries `setComputeUnitLimit({ units: 400_000 })`
// (`app/lib/program.ts`, in `sendTx`). No test asked for anything, so every test transaction
// ran on Solana's **200 000 CU default** — half of what any real user's transaction gets.
//
// That is not a harmless difference in a number. `add_liquidity` on a two-CPI pair consumes
// essentially the whole 200 000, so the suite was sitting exactly at the cliff:
//
//     Program TokenkegQfe... consumed 1850 of 1850 compute units
//     Program TokenkegQfe... failed: exceeded CUs meter at BPF instruction
//     Program DgD37Vjs...    consumed 200000 of 200000 compute units
//
// CI went red on 2026-09-17 with that error on `bankrun_continuous`, on a commit whose
// `programs/` tree was byte-identical to a green run two hours earlier — and a re-run of the
// SAME commit went green again. A test that flips on nothing is not testing the program, it is
// testing how close the current build happens to sit to a ceiling the app never touches. It
// would also have failed for the wrong reason forever: a genuine CU regression and a few
// hundred units of toolchain drift are indistinguishable at the cliff edge.
//
// So the budget is raised to the app's own figure — deliberately the same constant, because the
// point is to exercise what users execute. What this does NOT do is hide a real regression: at
// 400 000 the suite has the same headroom production has, so a change that genuinely doubles a
// handler's cost still fails here, and fails for a reason worth reading.
//
// ⚠️ If a future test ever wants to assert a compute-unit LIMIT (a deliberate exhaustion), it
// must add its own `setComputeUnitLimit` — this helper leaves any transaction that already
// carries a ComputeBudget instruction untouched, which is exactly that escape hatch.

import { ComputeBudgetProgram, Transaction } from "@solana/web3.js";

/** Mirrors `sendTx` in `app/lib/program.ts`. Keep the two equal. */
export const TEST_CU_LIMIT = 400_000;

function prependBudget(tx: unknown): void {
  // Versioned transactions carry an already-compiled message; none of the suites build one,
  // and rewriting a compiled message here would be a trap rather than a convenience.
  if (!(tx instanceof Transaction)) return;
  const alreadyBudgeted = tx.instructions.some((ix) =>
    ix.programId.equals(ComputeBudgetProgram.programId));
  if (alreadyBudgeted) return;
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: TEST_CU_LIMIT }));
}

/**
 * Give every transaction a provider sends the app's compute budget.
 *
 * Wraps the provider's own send path instead of touching call sites: there are 106 `.rpc()`
 * calls across the bankrun suites, and a per-call `.preInstructions([...])` would be 106
 * chances to forget one — including in whichever test is written next.
 *
 * Works for both `BankrunProvider` and Anchor's `AnchorProvider`: the three methods have the
 * same shape in each, and Anchor's `.rpc()` routes through `sendAndConfirm`.
 */
export function withComputeBudget<P extends object>(provider: P): P {
  const p = provider as any;

  for (const method of ["sendAndConfirm", "send"]) {
    const original = p[method]?.bind(p);
    if (!original) continue;
    p[method] = async (tx: unknown, signers?: unknown, opts?: unknown) => {
      prependBudget(tx);
      return original(tx, signers, opts);
    };
  }

  const sendAll = p.sendAll?.bind(p);
  if (sendAll) {
    p.sendAll = async (txWithSigners: { tx: unknown }[], opts?: unknown) => {
      txWithSigners.forEach((entry) => prependBudget(entry.tx));
      return sendAll(txWithSigners, opts);
    };
  }

  return provider;
}
