// Run with: node --import ./scripts/json-loader.mjs --test lib/strategies.test.mts
//
// `canCompound` is the client's copy of the program's rule in `set_pool_strategy`: a position in
// the sale pool, or in the SOL hop when its destination needs the hop, cannot compound through it
// (the same pool would be two accounts in one instruction). The strategy controls only offer what
// this accepts, so a drift from the program is a button the chain refuses.
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { canCompound } from "./strategies.ts";
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
