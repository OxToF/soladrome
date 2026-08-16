// Run with: node --test lib/rpc.test.mts   (Node 22+, native type stripping —
// no runner to install, which is why this file is .mts and not .ts: the glob in
// tsconfig `include` deliberately does not pick it up.)
import test from "node:test";
import assert from "node:assert/strict";
import { resolveRpcUrl, isUsableRpcUrl, FALLBACK_RPC_URL } from "./rpc.ts";

// The shape read out of Vercel on 2026-08-16, with a placeholder key: leading
// `h` lost and the key truncated mid-way by a real U+2026. It killed the faucet
// in production for three days. (Never put a live key in a test — this repo is
// public, and a fixture is read by everyone who clones it.)
const BROKEN = "ttps://devnet.helius-rpc.com/?api-key=00000000…";
const GOOD   = "https://devnet.helius-rpc.com/?api-key=00000000-0000-0000-0000-000000000000";

test("the value that broke production is rejected", () => {
  assert.equal(isUsableRpcUrl(BROKEN), false);
  assert.equal(resolveRpcUrl(BROKEN), FALLBACK_RPC_URL);
});

// Both halves of that value are independently fatal, so both are asserted
// separately — a guard covering only one would still pass the test above.
test("each half of the breakage is caught on its own", () => {
  assert.equal(isUsableRpcUrl("ttps://devnet.helius-rpc.com/"), false, "protocol");
  assert.equal(isUsableRpcUrl("https://devnet.helius-rpc.com/?api-key=00000000…"), false, "truncation");
});

test("a valid endpoint is passed through untouched", () => {
  assert.equal(isUsableRpcUrl(GOOD), true);
  assert.equal(resolveRpcUrl(GOOD), GOOD);
  // Localnet is http, not https — the guard must not tighten to https only.
  assert.equal(resolveRpcUrl("http://127.0.0.1:8899"), "http://127.0.0.1:8899");
});

test("candidates are tried in order and a bad one never masks a good one", () => {
  assert.equal(resolveRpcUrl(undefined, GOOD), GOOD);
  assert.equal(resolveRpcUrl(BROKEN, GOOD), GOOD);
  assert.equal(resolveRpcUrl("", "   ", undefined), FALLBACK_RPC_URL);
});

test("a non-http scheme is not an RPC endpoint", () => {
  assert.equal(isUsableRpcUrl("ws://devnet.helius-rpc.com/"), false);
});
