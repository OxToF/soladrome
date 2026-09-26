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
