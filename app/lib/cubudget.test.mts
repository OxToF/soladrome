// Run with: node --import ./scripts/json-loader.mjs --test lib/cubudget.test.mts
//
// The keeper requests what the simulation measured plus headroom, never less than it used and
// never more than the old fixed request. The priority fee is charged on the request, so this is
// the whole saving — and a request below what a round needs is a round that fails and still pays.
import test from "node:test";
import assert from "node:assert/strict";
import { CU_SIM_LIMIT, cuLimitFor, feeLamports } from "./cubudget.ts";

test("the request always covers what the simulation used, with headroom", () => {
  for (const used of [1, 300, 5_000, 44_982, 51_168, 91_393, 200_000, 480_000]) {
    const req = cuLimitFor(used);
    assert.ok(req >= used + Math.min(20_000, CU_SIM_LIMIT - used), `${used} → ${req}`);
    assert.ok(req >= Math.min(CU_SIM_LIMIT, Math.ceil(used * 1.2)), `${used} → ${req}`);
    assert.ok(req <= CU_SIM_LIMIT);
  }
});

test("a measurement the RPC did not return falls back to the full limit", () => {
  assert.equal(cuLimitFor(undefined), CU_SIM_LIMIT);
  assert.equal(cuLimitFor(null), CU_SIM_LIMIT);
  assert.equal(cuLimitFor(0), CU_SIM_LIMIT);
});

test("a measured vote round costs a third of what the fixed request did", () => {
  // 51 168 CU: the ESjB vote round on devnet, 2026-09-26.
  assert.equal(feeLamports(CU_SIM_LIMIT), 35_000);
  assert.ok(feeLamports(cuLimitFor(51_168)) < 35_000 / 3 + 1_000);
});
