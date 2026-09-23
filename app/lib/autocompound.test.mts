// Run with: node --import ./scripts/json-loader.mjs --test lib/autocompound.test.mts
//
// `lpDestinationSide` is the client's copy of `lp_deposit_side` in the program. The Rewards card
// and the deposit checkbox only offer pools it accepts, so if the two ever disagree the screen
// offers a destination the chain refuses (a dead button), or hides one it would accept.
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { lpDestinationSide } from "./autocompound.ts";
import { oSolaM, WSOL_MINT_STR } from "./program.ts";

const USDC = Keypair.generate().publicKey;
const WSOL = new PublicKey(WSOL_MINT_STR);
const LST = Keypair.generate().publicKey;
const XSTOCK = Keypair.generate().publicKey;

test("a USDC pair is deposited on its USDC side, with no hop, whichever side USDC sorts to", () => {
  for (const [a, b] of [[USDC, XSTOCK], [XSTOCK, USDC]]) {
    const side = lpDestinationSide(a, b, USDC);
    assert.ok(side?.deposit.equals(USDC));
    assert.equal(side?.needsHop, false);
  }
});

test("a SOL pair — the LST pools the feature exists for — goes through the SOL/USDC hop", () => {
  const side = lpDestinationSide(LST, WSOL, USDC);
  assert.ok(side?.deposit.equals(WSOL));
  assert.equal(side?.needsHop, true);
});

test("USDC wins over SOL when a pool holds both: no hop is cheaper than one", () => {
  const side = lpDestinationSide(WSOL, USDC, USDC);
  assert.ok(side?.deposit.equals(USDC));
  assert.equal(side?.needsHop, false);
});

test("a pool holding oSOLA is never a destination, even paired with USDC", () => {
  assert.equal(lpDestinationSide(oSolaM, USDC, USDC), null);
  assert.equal(lpDestinationSide(oSolaM, WSOL, USDC), null);
});

test("a pair with neither USDC nor SOL is refused — v1 has no route to it", () => {
  assert.equal(lpDestinationSide(LST, XSTOCK, USDC), null);
});
