// Run with: node --test lib/recipe.test.mts   (Node 22+, native type stripping —
// same convention as txerror.test.mts: .mts so the tsconfig `include` glob ignores it.)
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  WIRE_LIMIT, measureIxs, budgetPreamble, fitSteps,
  decodeTokenAmount, produced, budgetFor, type Step,
} from "./recipe.ts";

const PAYER = Keypair.generate().publicKey;
const PROGRAM = Keypair.generate().publicKey;

/// An instruction shaped like `claim_lp_rewards`: 12 accounts, an 8-byte discriminator.
/// `shared` are accounts every claim names (the program state, the mints, the user), which is
/// what makes the marginal cost of the second claim smaller than the first.
function claimIx(shared: PublicKey[], own = 5): TransactionInstruction {
  const keys = [
    ...shared.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ...Array.from({ length: own }, () => ({
      pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true,
    })),
  ];
  return new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.alloc(8) });
}

function step(id: string, ixs: TransactionInstruction[], optional = false): Step {
  return { id, label: id, ixs, optional };
}

// ── measurement ──────────────────────────────────────────────────────────────

test("the measured size is the size the runtime will see", () => {
  const ixs = [claimIx([], 6), claimIx([], 6)];
  const measured = measureIxs(ixs, PAYER);

  // Serialize the same transaction the way web3.js does when it has a signature, and compare.
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = "11111111111111111111111111111111";
  tx.feePayer = PAYER;
  const real = tx.serialize({ verifySignatures: false, requireAllSignatures: false }).length;

  assert.equal(measured, real, "a measurement that is not the wire size is a guess");
});

test("an account named twice is paid for once", () => {
  const shared = Array.from({ length: 7 }, () => Keypair.generate().publicKey);
  const first  = measureIxs([claimIx(shared)], PAYER);
  const second = measureIxs([claimIx(shared), claimIx(shared)], PAYER);
  const lone   = measureIxs([claimIx([], 12)], PAYER);

  assert.ok(
    second - first < lone,
    "the marginal claim must cost less than a standalone one, or the packer under-fills the wire",
  );
});

test("the compute-budget preamble occupies wire space and must be measured with the rest", () => {
  const ixs = [claimIx([], 8)];
  const bare = measureIxs(ixs, PAYER);
  const sent = measureIxs([...budgetPreamble(400_000), ...ixs], PAYER);
  assert.ok(sent > bare + 40, "sendTx prepends two instructions; ignoring them under-counts");
});

// ── fitting ──────────────────────────────────────────────────────────────────

test("claims that do not fit are deferred to a second round, never dropped in silence", () => {
  const shared = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
  const claims = Array.from({ length: 40 }, (_, i) => step(`claim-${i}`, [claimIx(shared)], true));

  const { included, deferred, bytes } = fitSteps(claims, PAYER);

  assert.ok(included.length > 0, "something must fit");
  assert.ok(deferred.length > 0, "forty claims cannot fit in 1232 bytes");
  assert.equal(included.length + deferred.length, 40, "no step may vanish");
  assert.ok(bytes <= WIRE_LIMIT, `fitted to ${bytes} bytes, over the wire`);
  // Order is the plan's order: a deferred claim is a LATER one, never an arbitrary one.
  assert.equal(included[0]!.id, "claim-0");
});

test("the tail travels with every candidate, so its room is never taken by a claim", () => {
  const shared = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
  const claims = Array.from({ length: 40 }, (_, i) => step(`claim-${i}`, [claimIx(shared)], true));
  const tail = [claimIx(shared, 7), claimIx(shared, 6)]; // an exercise and a stake, in shape

  const free    = fitSteps(claims, PAYER).included.length;
  const withEnd = fitSteps(claims, PAYER, { tail });

  assert.ok(withEnd.included.length < free, "the tail must cost at least one claim slot");
  const real = measureIxs(
    [...withEnd.included.flatMap((s) => s.ixs), ...tail], PAYER,
  );
  assert.equal(withEnd.bytes, real, "the reported size must be the assembled size");
  assert.ok(real <= WIRE_LIMIT, `assembled to ${real} bytes, over the wire`);
});

test("a tail that shares the head's accounts is not charged for them twice", () => {
  const shared = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
  const claims = Array.from({ length: 40 }, (_, i) => step(`claim-${i}`, [claimIx(shared)], true));
  const tail = [claimIx(shared, 7), claimIx(shared, 6)];

  const measured = fitSteps(claims, PAYER, { tail }).included.length;
  // The bug this replaces: reserving `measureIxs(tail)` in isolation pays the ~130 bytes of
  // fixed overhead a second time, plus every shared account, and deferred four claims that fit.
  const naive = fitSteps(claims, PAYER, {
    tail: [], limit: WIRE_LIMIT - measureIxs(tail, PAYER),
  }).included.length;

  assert.ok(
    measured > naive,
    `measuring the tail in place must admit more claims (${measured}) than reserving it (${naive})`,
  );
});

test("a required step is never deferred, and the caller can see the plan does not fit", () => {
  const big = Array.from({ length: 40 }, (_, i) => step(`must-${i}`, [claimIx([], 8)], false));
  const { included, deferred, bytes } = fitSteps(big, PAYER);

  assert.equal(deferred.length, 0, "a required step must never be silently dropped");
  assert.equal(included.length, 40);
  assert.ok(bytes > WIRE_LIMIT, "instead the plan reports a size the caller must refuse");
});

// ── amount chaining ──────────────────────────────────────────────────────────

test("a token balance is read at offset 64, and a missing account reads as zero", () => {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(BigInt(12_401_337), 64);

  assert.equal(decodeTokenAmount(data), BigInt(12_401_337));
  assert.equal(decodeTokenAmount(null), BigInt(0), "an ATA the recipe is about to create");
  assert.equal(decodeTokenAmount(Buffer.alloc(40)), BigInt(0), "a truncated read is not a balance");
});

test("a recipe acts on what it produced, not on what the wallet already held", () => {
  const ata = Keypair.generate().publicKey;
  const key = ata.toBase58();

  // The wallet was already holding 100 oSOLA; the claims added 12.4.
  const before = new Map([[key, BigInt(100_000_000)]]);
  const after  = new Map([[key, BigInt(112_401_337)]]);
  assert.equal(produced(before, after, ata), BigInt(12_401_337));
});

test("a balance that went down is nothing produced, not a negative amount", () => {
  const ata = Keypair.generate().publicKey;
  const key = ata.toBase58();
  const before = new Map([[key, BigInt(100)]]);
  const after  = new Map([[key, BigInt(40)]]);
  assert.equal(produced(before, after, ata), BigInt(0));
});

// ── compute budget ───────────────────────────────────────────────────────────

test("the budget comes from the dry run, with a floor and a ceiling", () => {
  assert.equal(budgetFor(undefined), 400_000, "no measurement falls back to the shipped default");
  assert.equal(budgetFor(50_000), 400_000, "a cheap recipe still gets the default floor");
  assert.equal(budgetFor(600_000), 720_000, "20% over measured");
  assert.equal(budgetFor(1_300_000), 1_400_000, "capped at the per-transaction maximum");
});
