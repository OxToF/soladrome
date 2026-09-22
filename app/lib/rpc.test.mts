// Run with: node --test lib/rpc.test.mts   (Node 22+, native type stripping —
// no runner to install, which is why this file is .mts and not .ts: the glob in
// tsconfig `include` deliberately does not pick it up.)
import test from "node:test";
import assert from "node:assert/strict";
import { resolveRpcUrl, isUsableRpcUrl, FALLBACK_RPC_URL, declinedByProvider, fetchWithFallback, serverRpcUrl } from "./rpc.ts";

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

// ── The fallback that could never fire ───────────────────────────────────────

test("a Helius throttle is a decline, even though it wears a 401", () => {
  // The status the app tested for, and the three it did not.
  assert.equal(declinedByProvider(429), true);
  assert.equal(declinedByProvider(401), true, "Helius throttles with 401 — the whole bug");
  assert.equal(declinedByProvider(403), true);
  assert.equal(declinedByProvider(503), true);
});

test("a chain answering is never a decline", () => {
  // A 200 carrying an on-chain revert must reach the caller: retrying it on another RPC
  // answers exactly the same thing, one round trip later.
  assert.equal(declinedByProvider(200), false);
  assert.equal(declinedByProvider(404), false);
  assert.equal(declinedByProvider(500), false);
});

test("a declined request is cloned to the public RPC, once", async () => {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    seen.push(url);
    // The primary declines the way Helius does; the fallback answers.
    return url.includes("helius")
      ? new Response('{"error":{"code":-32401}}', { status: 401 })
      : new Response('{"result":"ok"}', { status: 200 });
  }) as typeof fetch;

  try {
    const f = fetchWithFallback("https://devnet.helius-rpc.com/?api-key=k");
    const res = await f("https://devnet.helius-rpc.com/?api-key=k", { method: "POST" });
    assert.equal(res.status, 200, "the caller must get the fallback's answer, not the 401");
    assert.equal(seen.length, 2, "exactly one retry");
    assert.match(seen[1]!, /api\.devnet\.solana\.com/);
  } finally {
    globalThis.fetch = real;
  }
});

test("without a distinct fallback it returns the decline rather than looping", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: 401 });
  }) as typeof fetch;

  try {
    const f = fetchWithFallback("https://api.devnet.solana.com");
    const res = await f("https://api.devnet.solana.com", { method: "POST" });
    assert.equal(res.status, 401);
    assert.equal(calls, 1, "the fallback IS the endpoint: there is nowhere to fall back to");
  } finally {
    globalThis.fetch = real;
  }
});

// ── serverRpcUrl: the browser key is public, so server code must not share it ────────────────
//
// ☢️ Verified on 2026-09-22 by fetching two chunks of www.soladrome.finance and reading the key
// out of them — no authentication, two `curl` calls. `NEXT_PUBLIC_*` is inlined into the client
// bundle at compile time, so that is a property of Next, not a mistake to fix.

test("the server key wins over the browser key", () => {
  process.env.RPC_URL = GOOD;
  process.env.NEXT_PUBLIC_RPC_URL = "https://public.example.com";
  assert.equal(serverRpcUrl(), GOOD);
});

// ⚠️ THE FALLBACK IS THE MIGRATION. Until a second key exists everything runs on the single one
// it uses today, so the split lands without an outage and becomes a config change afterwards.
// A test that let this regress would turn "restrict the browser key" into a silent outage of the
// keeper and every authority script.
test("without a server key, the browser key still works", () => {
  delete process.env.RPC_URL;
  process.env.NEXT_PUBLIC_RPC_URL = GOOD;
  assert.equal(serverRpcUrl(), GOOD);
});

test("a malformed server key is skipped, not handed to Connection", () => {
  process.env.RPC_URL = BROKEN;
  process.env.NEXT_PUBLIC_RPC_URL = GOOD;
  assert.equal(serverRpcUrl(), GOOD, "the August shape must not disarm the good value behind it");
});

test("with neither, it is the public endpoint and never a throw", () => {
  delete process.env.RPC_URL;
  delete process.env.NEXT_PUBLIC_RPC_URL;
  assert.equal(serverRpcUrl(), FALLBACK_RPC_URL);
});
