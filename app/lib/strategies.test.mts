// Run with: node --import ./scripts/json-loader.mjs --test lib/strategies.test.mts
//
// `canCompound` is the client's copy of the program's rule in `set_pool_strategy`: a position in
// the sale pool, or in the SOL hop when its destination needs the hop, cannot compound through it
// (the same pool would be two accounts in one instruction). The strategy controls only offer what
// this accepts, so a drift from the program is a button the chain refuses.
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { canCompound, maxExercisable } from "./strategies.ts";
import { oSolaM, poolPda, WSOL_MINT_STR } from "./program.ts";

const USDC = Keypair.generate().publicKey;
const WSOL = new PublicKey(WSOL_MINT_STR);
const LST = Keypair.generate().publicKey;
const TKN = Keypair.generate().publicKey;
const pool = (a: PublicKey, b: PublicKey) => ({ key: poolPda(a, b), mintA: a, mintB: b });

const sale = pool(oSolaM, USDC);
const hop = pool(WSOL, USDC);
const lst = pool(LST, WSOL);
const tkn = pool(TKN, USDC);

test("an ordinary position compounds into itself or into another pool", () => {
  assert.equal(canCompound(tkn, tkn, USDC), true);
  assert.equal(canCompound(tkn, lst, USDC), true);
  assert.equal(canCompound(lst, lst, USDC), true);
});

test("a position in the sale pool cannot compound at all — every route sells through it", () => {
  assert.equal(canCompound(sale, tkn, USDC), false);
  assert.equal(canCompound(sale, lst, USDC), false);
});

test("a position in the SOL hop cannot compound into a SOL pair, but may into a USDC one", () => {
  assert.equal(canCompound(hop, lst, USDC), false, "the route would pass through the source");
  assert.equal(canCompound(hop, tkn, USDC), true, "no hop, no conflict");
  assert.equal(canCompound(hop, hop, USDC), true, "SOL/USDC into itself deposits USDC, no hop");
});

test("a destination must still pair USDC or SOL and hold no oSOLA", () => {
  assert.equal(canCompound(tkn, sale, USDC), false);
  assert.equal(canCompound(tkn, pool(LST, TKN), USDC), false);
});

// `maxExercisable` is the client's copy of `curve::max_exercisable`: the round a voting strategy
// runs on its budget. It must never announce a round the budget cannot pay, and should leave at
// most dust unspent. `fee` below is `curve::exercise_fee`, floors included.
test("a voting round never costs more than its budget, and leaves only dust unspent", () => {
  const fee = (st: any, x: bigint) => {
    const vu = BigInt(st.virtualUsdc), vs = BigInt(st.virtualSola);
    if (vu <= vs) return BigInt(0);
    return ((x * (vu - vs)) / vs * BigInt(st.exerciseFeeBps)) / BigInt(10_000);
  };
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let i = 0; i < 2_000; i++) {
    const vs = BigInt(1 + rnd(2_000_000_000)) * BigInt(1_000);
    const st = {
      virtualSola: vs.toString(),
      virtualUsdc: (vs + BigInt(rnd(3_000_000_000)) * BigInt(1_000)).toString(),
      exerciseFeeBps: rnd(3_000),
    };
    const budget = BigInt(rnd(2_000_000_000));
    const x = maxExercisable(st, budget);
    assert.ok(x + fee(st, x) <= budget, `overspent: ${x} + ${fee(st, x)} > ${budget}`);
    assert.ok(x + BigInt(3) + fee(st, x + BigInt(3)) > budget || x + BigInt(3) > budget, "left more than dust unspent");
  }
});

test("with no gain on the curve, one USDC exercises one oSOLA", () => {
  const st = { virtualSola: "1000000000000", virtualUsdc: "1000000000000", exerciseFeeBps: 1_000 };
  assert.equal(maxExercisable(st, BigInt(123_456)), BigInt(123_456));
});

// ── What the strategy screen tells the owner (2026-10-07) ────────────────────
import { costPerOSola, strategyConflicts, voteRoundFromTx, type PoolStrategy } from "./strategies.ts";

const state = (vu: number, vs: number, bps: number) => ({ virtualUsdc: vu, virtualSola: vs, exerciseFeeBps: bps });

test("costPerOSola is the inverse of maxExercisable", () => {
  const s = state(3_000_000, 1_000_000, 1_000); // price 3, gain 2, 10 % of it
  assert.equal(costPerOSola(s), 1.2);
  const budget = BigInt(1_200_000_000);
  assert.equal(Number(maxExercisable(s, budget)) * costPerOSola(s), Number(budget));
  assert.equal(costPerOSola(state(1_000_000, 1_000_000, 1_000)), 1, "no gain, no fee: the strike alone");
  assert.equal(costPerOSola(state(3_000_000, 1_000_000, 0)), 1);
});

const strat = (source: PublicKey, mode: PoolStrategy["mode"], target: PublicKey | null): PoolStrategy => ({
  address: Keypair.generate().publicKey, owner: USDC, sourcePool: source, targetPool: target, mode,
  minHarvest: 1, minInterval: 3_600, lastTs: 0, rounds: 0, harvested: 0, minIntrinsicBps: 7_000, maxFeeBps: 2_000,
});

test("a deposit into a pool that has its own strategy is reported — the devnet case", () => {
  // 2Bhw, 2026-10-06: USDC/GLDx compounds into jitoSOL/SOL, whose own rewards were meant to vote.
  const m = new Map([
    [tkn.key.toBase58(), strat(tkn.key, "liquidity", lst.key)],
    [lst.key.toBase58(), strat(lst.key, "vote", null)],
  ]);
  assert.deepEqual(strategyConflicts(m), [{ source: tkn.key.toBase58(), target: lst.key.toBase58(), targetMode: "vote" }]);
});

test("compounding into itself, into a pool without a strategy, or voting is no conflict", () => {
  const m = new Map([
    [tkn.key.toBase58(), strat(tkn.key, "liquidity", tkn.key)],
    [lst.key.toBase58(), strat(lst.key, "liquidity", hop.key)],
    [hop.key.toBase58(), strat(hop.key, "vote", null)],
  ]);
  // lst → hop IS one: hop has its own (voting) strategy.
  assert.deepEqual(strategyConflicts(m).map((c) => c.source), [lst.key.toBase58()]);
  m.delete(hop.key.toBase58());
  assert.deepEqual(strategyConflicts(m), []);
});

// The balances of a real round: 4tst…, 2026-10-06 22:12:06, signature 3uceGydh….
const OWNER = "4tstWLNxrL6mWH3Cw852STTpU2AP6CFJyD2mxq62BJGp";
const VAULTS = "9MP8MbbC9BNWd7pUqXnzw5kHMknTeVtd8h5ToEVcxX1M";
const U = "3N8EKeBPF8Gp9ayQ3WJzcxmDcWAMYKjwnuZXWC71FLtd";
const S = "CaGHeRis6ioEKJpP1kpJKXQmJKyszmsDTQHvrfqxcXwQ";
const bal = (accountIndex: number, mint: string, owner: string, uiAmount: number) => ({ accountIndex, mint, owner, uiTokenAmount: { uiAmount } });
const round = (logs: string[], err: unknown = null) => ({
  blockTime: 1_791_324_726,
  meta: {
    err,
    logMessages: logs,
    preTokenBalances: [bal(1, U, OWNER, 633.0), bal(2, S, VAULTS, 10_000), bal(3, U, VAULTS, 50_000), bal(4, U, VAULTS, 100)],
    postTokenBalances: [bal(1, U, OWNER, 2.0077), bal(2, S, VAULTS, 10_628.2748), bal(3, U, VAULTS, 50_628.2748), bal(4, U, VAULTS, 102.7175)],
  },
});
const VOTE_LOG = "Program log: Instruction: CrankPoolStrategyVote";

test("a voting round reads as USDC out of the wallet and hiSOLA onto the position", () => {
  const r = voteRoundFromTx(round([VOTE_LOG]), "sig", OWNER, U, S)!;
  assert.equal(r.usdcSpent.toFixed(4), "630.9923");
  assert.equal(r.hiSola.toFixed(4), "628.2748");
  assert.equal(r.time, 1_791_324_726);
});

test("anything that is not a successful voting round is skipped", () => {
  assert.equal(voteRoundFromTx(round(["Program log: Instruction: CrankAutoCompound"]), "s", OWNER, U, S), null);
  assert.equal(voteRoundFromTx(round([VOTE_LOG], { InstructionError: [2, { Custom: 6058 }] }), "s", OWNER, U, S), null);
  assert.equal(voteRoundFromTx(null, "s", OWNER, U, S), null);
});
