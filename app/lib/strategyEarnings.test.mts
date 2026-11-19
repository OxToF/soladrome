// Run with: node --import ./scripts/json-loader.mjs --test lib/strategyEarnings.test.mts
//
// The earnings dashboard and its USDC alert. The alert's one rule worth pinning: a round spends
// min(allowance, balance), and the two shortfalls call for different gestures — telling a holder
// with a dormant allowance to "raise the budget" would only enlarge what future USDC gets spent on.
import test from "node:test";
import assert from "node:assert/strict";
import { budgetAlert, lpPriceUsdc, strategyRoundFromTx, sumRounds } from "./strategyEarnings.ts";

const WSOL = "So11111111111111111111111111111111111111112";
const OWNER = "Owner1111111111111111111111111111111111111";
const M = { usdc: "Usdc", sola: "Sola", oSola: "OSola", lp: "Lp" };
const bal = (accountIndex: number, mint: string, uiAmount: number, owner?: string) => ({
  accountIndex, mint, owner, uiTokenAmount: { uiAmount },
});
const tx = (log: string, pre: any[], post: any[], err: unknown = null) => ({
  blockTime: 1_800_000_000,
  meta: { err, logMessages: [`Program log: Instruction: ${log}`], preTokenBalances: pre, postTokenBalances: post },
});

test("a voting round: USDC out of the owner's wallet, SOLA into the stake vault", () => {
  const r = strategyRoundFromTx(
    tx("CrankPoolStrategyVote",
      [bal(1, "Usdc", 100, OWNER), bal(2, "Sola", 5_000, "Vault")],
      [bal(1, "Usdc", 88, OWNER), bal(2, "Sola", 5_010, "Vault")]),
    "sig", OWNER, M)!;
  assert.equal(r.mode, "vote");
  assert.equal(r.usdcSpent, 12);
  assert.equal(r.hiSola, 10);
  assert.equal(r.lpMinted, 0);
});

test("a liquidity round: LP minted to the owner, overflow oSOLA to the wallet, no USDC", () => {
  const r = strategyRoundFromTx(
    tx("CrankPoolStrategyLp",
      [bal(1, "Lp", 3, OWNER), bal(2, "OSola", 0, OWNER), bal(3, "Usdc", 500, "Pool")],
      [bal(1, "Lp", 4.5, OWNER), bal(2, "OSola", 2, OWNER), bal(3, "Usdc", 480, "Pool")]),
    "sig", OWNER, M)!;
  assert.equal(r.mode, "liquidity");
  assert.equal(r.lpMinted, 1.5);
  assert.equal(r.oSolaToWallet, 2);
  assert.equal(r.usdcSpent, 0, "the pool's USDC is not the owner's");
});

test("an LP account that did not exist before the round counts from zero", () => {
  const r = strategyRoundFromTx(tx("CrankPoolStrategyLp", [], [bal(4, "Lp", 7, OWNER)]), "s", OWNER, M)!;
  assert.equal(r.lpMinted, 7);
});

test("failed rounds and other instructions are skipped", () => {
  assert.equal(strategyRoundFromTx(tx("SetPoolStrategy", [], []), "s", OWNER, M), null);
  assert.equal(strategyRoundFromTx(tx("CrankPoolStrategyVote", [], [], { Custom: 1 }), "s", OWNER, M), null);
  assert.equal(strategyRoundFromTx(null, "s", OWNER, M), null);
});

test("sumRounds adds every column", () => {
  const a = { signature: "a", time: 1, mode: "vote" as const, usdcSpent: 2, hiSola: 1, lpMinted: 0, oSolaToWallet: 0 };
  assert.deepEqual(sumRounds([a, a]), { usdcSpent: 4, hiSola: 2, lpMinted: 0, oSolaToWallet: 0 });
});

test("an LP is priced off a USDC side, or a SOL side at the SOL price, else not at all", () => {
  const usdcPool = { tokenAMint: "X", tokenBMint: "Usdc", reserveA: 1n, reserveB: 1_000_000_000n, totalLp: 100_000_000n };
  assert.equal(lpPriceUsdc(usdcPool, "Usdc", null, "Wsol"), 20, "1 000 USDC × 2 / 100 LP");
  const solPool = { tokenAMint: WSOL, tokenBMint: "Lst", reserveA: 10_000_000_000n, reserveB: 1n, totalLp: 50_000_000n };
  assert.equal(lpPriceUsdc(solPool, "Usdc", 150, WSOL), 1_500 * 2 / 50, "SOL has 9 decimals");
  assert.equal(lpPriceUsdc(solPool, "Usdc", null, WSOL), null);
  assert.equal(lpPriceUsdc({ ...usdcPool, totalLp: 0n }, "Usdc", null, "Wsol"), null);
});

const base = { allowance: 100, balance: 100, backlog: 0, perDay: 1, unitCost: 1.2, minHarvest: 1 };

test("enough budget: ok, with the runway in days", () => {
  const a = budgetAlert(base);
  assert.equal(a.level, "ok");
  assert.equal(Math.round(a.runwayDays!), 83); // 100 / 1.2
});

test("no budget at all: paused, and the rewards are not lost", () => {
  const a = budgetAlert({ ...base, allowance: 0 });
  assert.equal(a.level, "critical");
  assert.match(a.detail, /No USDC budget/);
  assert.match(a.detail, /nothing is lost/);
});

test("☢️ a dormant allowance asks for USDC in the wallet, never for a bigger budget", () => {
  const a = budgetAlert({ ...base, allowance: 500, balance: 0 });
  assert.equal(a.level, "critical");
  assert.match(a.detail, /add USDC to your wallet \(the budget you set already covers it\)/);
  assert.doesNotMatch(a.detail, /raise/);
});

test("USDC in the wallet but the allowance spent: raise the budget", () => {
  const a = budgetAlert({ ...base, allowance: 0.5, balance: 1_000 });
  assert.equal(a.level, "critical");
  assert.match(a.detail, /raise your voting budget/);
});

test("a backlog larger than the budget is a warning, not a pause", () => {
  const a = budgetAlert({ ...base, backlog: 200 });
  assert.equal(a.level, "warn");
  assert.match(a.title, /200 oSOLA are waiting/);
});

test("under a week of runway warns; the top-up covers the backlog and 30 days", () => {
  const a = budgetAlert({ ...base, allowance: 6, balance: 6 });
  assert.equal(a.level, "warn");
  assert.match(a.title, /About 5 days/);
  assert.equal(a.topUpUsdc, 30); // 1.2 × 30 − 6
});

test("nothing accruing: no runway figure, no alarm", () => {
  const a = budgetAlert({ ...base, perDay: 0 });
  assert.equal(a.level, "ok");
  assert.equal(a.runwayDays, null);
});

import { recentVoteRate } from "./strategyEarnings.ts";

test("recentVoteRate: oSOLA converted per day over the recent rounds, null on a single point", () => {
  const now = 1_800_000_000;
  const v = (daysAgo: number, hiSola: number) => ({
    signature: String(daysAgo), time: now - daysAgo * 86_400, mode: "vote" as const,
    usdcSpent: hiSola, hiSola, lpMinted: 0, oSolaToWallet: 0,
  });
  assert.equal(recentVoteRate([v(1, 10), v(4, 30)], now), 10, "40 over 4 days");
  assert.equal(recentVoteRate([v(1, 10), v(30, 999)], now), null, "the old round is out of the window");
  assert.equal(recentVoteRate([v(0.1, 5), v(0.2, 5)], now), 10, "a span under a day counts as one day");
});
