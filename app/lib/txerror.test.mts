// Run with: node --test lib/txerror.test.mts   (Node 22+, native type stripping —
// same convention as rpc.test.mts: .mts so the tsconfig `include` glob ignores it.)
import test from "node:test";
import assert from "node:assert/strict";
import {
  explainInstructionError, explainRpcRefusal, spendableSol, SOL_FEE_RESERVE,
  SYSTEM_PROGRAM_ID_STR, TOKEN_PROGRAM_ID_STR,
} from "./txerror.ts";

// The program's own errors come from the IDL, which the decoder takes as an argument.
const IDL_ERRORS = [{ code: 6037, name: "FeatureDisabled", msg: "This feature is disabled" }];

// The transaction a devnet tester reported on 2026-09-21, reduced to its shape.
// sendTx prepends two ComputeBudget instructions, so index 3 is the wrap transfer:
//   [0] setComputeUnitLimit  [1] setComputeUnitPrice  [2] create wSOL ATA
//   [3] SystemProgram.transfer   [4] syncNative   [5] create LP ATA   [6] addLiquidity
// The chain logged "Transfer: insufficient lamports 914337912, need 916511000" after the
// Max button filled 100% of a balance that also had to pay the fee and two ATA rents.
const INSUFFICIENT_LAMPORTS = { InstructionError: [3, { Custom: 1 }] };

const wrapTx = [
  SYSTEM_PROGRAM_ID_STR, SYSTEM_PROGRAM_ID_STR, TOKEN_PROGRAM_ID_STR,
  SYSTEM_PROGRAM_ID_STR, TOKEN_PROGRAM_ID_STR,  TOKEN_PROGRAM_ID_STR,
];

test("the reported failure explains itself instead of printing raw JSON", () => {
  const msg = explainInstructionError(INSUFFICIENT_LAMPORTS, wrapTx, IDL_ERRORS);
  assert.match(msg, /not enough SOL/i);
  assert.doesNotMatch(msg, /InstructionError/, "the raw runtime shape must not leak through");
});

// Custom code 1 is "result with negative lamports" in the System program and "insufficient
// funds" in SPL Token. Resolving it without looking at WHICH program failed would be a
// coin flip, so the same error against a token instruction must read differently.
test("the same code reads differently per program", () => {
  const token = explainInstructionError({ InstructionError: [4, { Custom: 1 }] }, wrapTx, IDL_ERRORS);
  assert.match(token, /insufficient token balance/i);
});

test("without the instruction list it degrades to the raw shape, never to a guess", () => {
  const msg = explainInstructionError(INSUFFICIENT_LAMPORTS);
  assert.match(msg, /InstructionError/);
});

// What the same tester hit four times before, on a pool holding a token they do not own.
test("Anchor framework errors are explained even though no IDL carries them", () => {
  const msg = explainInstructionError({ InstructionError: [3, { Custom: 3012 }] }, wrapTx, IDL_ERRORS);
  assert.match(msg, /does not exist yet/i);
});

test("the program's own errors still come from the IDL", () => {
  const msg = explainInstructionError({ InstructionError: [2, { Custom: 6037 }] }, wrapTx, IDL_ERRORS);
  assert.match(msg, /\(6037\)/);
});

test("the SOL reserve is withheld and never goes negative", () => {
  assert.equal(spendableSol(1), 1 - SOL_FEE_RESERVE);
  assert.equal(spendableSol(SOL_FEE_RESERVE / 2), 0, "a balance under the reserve is unspendable");
  assert.equal(spendableSol(0), 0);
});

// The exact numbers of the reported transaction. The reserve has to cover what that tx still
// owed AFTER the transfer: the 25 000-lamport fee plus rent for the three ATAs an
// add-liquidity can open (2 039 280 each) = 0.00614284 SOL. Asserting against that floor is
// what makes this test fail if the reserve is ever set back to zero.
test("the reserve covers what the failing transaction still owed after the transfer", () => {
  const FEE_AND_THREE_ATA_RENTS = 0.00614284;
  const balanceAtSend = 0.915851352;
  const max = spendableSol(balanceAtSend);
  assert.ok(
    max <= balanceAtSend - FEE_AND_THREE_ATA_RENTS,
    `Max (${max}) must leave at least ${FEE_AND_THREE_ATA_RENTS} SOL behind`,
  );
  assert.ok(max < 0.916511, "and must sit below the amount that actually failed on-chain");
  assert.ok(max > 0.89, "while not withholding an absurd share of the balance");
});

// ── RPC refusals ─────────────────────────────────────────────────────────────

// The exact string a tester saw under "Sign the recipe" on 2026-09-21, after a Compound plan
// had just spent a dozen reads: the send path's own pre-flight `getBalance` was refused.
const HELIUS_401 =
  '401 : {"jsonrpc":"2.0","error":{"code":-32401,"message":"Bad request, please try again later."}}';

test("a refused RPC says nothing was signed, instead of looking like a failed transaction", () => {
  const msg = explainRpcRefusal(new Error(HELIUS_401));
  assert.ok(msg, "the refusal must be recognised");
  assert.match(msg!, /nothing was sent/i);
  assert.doesNotMatch(msg!, /jsonrpc/, "the raw envelope must not leak through");
});

test("a rate limit is named as one, because the provider's own message hides it", () => {
  const msg = explainRpcRefusal(new Error("429 : Too Many Requests"));
  assert.match(msg!, /rate-limiting/i);
});

test("an on-chain revert is NOT an RPC refusal, and must fall through to the decoder", () => {
  assert.equal(explainRpcRefusal({ InstructionError: [2, { Custom: 6037 }] }), null);
  assert.equal(explainRpcRefusal(new Error("Transaction simulation failed")), null);
  // A pubkey that merely contains 401 must not be mistaken for a status code.
  assert.equal(explainRpcRefusal(new Error("account 401xyz not found")), null);
});
