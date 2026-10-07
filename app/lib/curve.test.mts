// Run with: node --import ./scripts/json-loader.mjs --test lib/curve.test.mts
//
// `quoteBuy` / `quoteSell` are the client's copy of `math.rs::curve_buy` / `curve_sell`. A drift
// is not a state bug but it is a number on screen the chain will not honour, and on a sale it
// is the `min_usdc_out` the transaction carries — quoted 1 % high, every sale would be refused.
// The cases mirror the Rust ones in `programs/soladrome/src/math.rs`.
import test from "node:test";
import assert from "node:assert/strict";
import { quoteBuy, quoteSell, marginalSellPrice, INIT_VIRTUAL_SOLA, type CurveReserves } from "./curve.ts";

const N = INIT_VIRTUAL_SOLA;
const start: CurveReserves = { virtualUsdc: N, virtualSola: N, k: N * N };
const after = (r: CurveReserves, usdcIn: bigint): CurveReserves => {
  const fee = (usdcIn * 100n) / 10_000n;
  const vu = r.virtualUsdc + usdcIn - fee;
  return { virtualUsdc: vu, virtualSola: r.k / vu, k: r.k };
};

test("a buy pays the 1 % fee before the curve prices anything", () => {
  const q = quoteBuy(start, 100_000_000_000n)!;
  assert.equal(q.fee, 1_000_000_000n);
  assert.equal(q.fee + q.solaOut + q.premium, 100_000_000_000n);
});

test("a SOLA bought high sells high, and a round trip costs the two fees", () => {
  // The bug this replaces: the old quote was the identity, 1 USDC per SOLA.
  const usdcIn = 500_000_000_000n;
  const b = quoteBuy(start, usdcIn)!;
  const s = quoteSell(after(start, usdcIn), b.solaOut)!;
  assert.equal(s.onCurve, b.solaOut);
  const back = Number(s.usdcOut) / Number(usdcIn);
  assert.ok(back > 0.979 && back < 0.981, `≈ 0.99², got ${back}`);
  assert.ok(s.usdcOut > (b.solaOut * 14n) / 10n, "far above the floor");
});

test("at the bottom of the curve a sale pays exactly the floor, no fee", () => {
  const s = quoteSell(start, 1_000_000n)!;
  assert.deepEqual([s.usdcOut, s.fee, s.onCurve], [1_000_000n, 0n, 0n]);
});

test("the fee never takes a sale below the floor", () => {
  const r = after(start, 1_000_000n);
  const b = quoteBuy(start, 1_000_000n)!;
  const s = quoteSell(r, b.solaOut)!;
  assert.ok(s.usdcOut >= b.solaOut);
});

test("the marginal sell price is the curve's less 1 %, floored at 1", () => {
  assert.equal(marginalSellPrice(start), 1);
  const r = after(start, 1_000_000_000_000n); // price ≈ 3.96
  const spot = Number(r.virtualUsdc) / Number(r.virtualSola);
  assert.ok(Math.abs(marginalSellPrice(r) - spot * 0.99) < 1e-9);
});
