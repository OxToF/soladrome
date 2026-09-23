// Run with: node --import ./scripts/json-loader.mjs --test lib/tokens.test.mts
//
// Every picker in the app is built from `getTokenList`. Two entries with the same symbol and
// different mints is a trap a human cannot see: on 2026-09-23 the swap offered two "jitoSOL",
// the first one mainnet's, and "No pool found" answered a pool that existed.
import test from "node:test";
import assert from "node:assert/strict";

test("on devnet, no symbol appears twice — a mock shadows the launch token it imitates", async () => {
  process.env.NEXT_PUBLIC_RPC_URL = "https://api.devnet.solana.com";
  const { getTokenList, DEVNET_MOCK_TOKENS } = await import("./tokens.ts");
  const symbols = getTokenList(null).map((t) => t.symbol.toLowerCase());
  const dupes = symbols.filter((s, i) => symbols.indexOf(s) !== i);
  assert.deepEqual(dupes, [], `duplicate symbols: ${dupes.join(", ")}`);
  // And the survivor is the mock, since it is the one with pools on devnet.
  for (const mock of DEVNET_MOCK_TOKENS) {
    const listed = getTokenList(null).find((t) => t.symbol.toLowerCase() === mock.symbol.toLowerCase());
    assert.equal(listed?.mint, mock.mint, `${mock.symbol} resolves to another mint`);
  }
});
