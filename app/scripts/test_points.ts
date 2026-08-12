// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// Unit tests for the pure phase-2 points logic (app/lib/points.ts).
// Run:  npx tsx app/scripts/test_points.ts   (from app/)
//   or: npx ts-node --compiler-options '{"module":"commonjs"}' app/scripts/test_points.ts
// No chain, no DB — every function here is a deterministic number-in/number-out.
import {
  nonNeg, poolTvlUsd, lpTokenPriceUsd, sybilBasisLpUi, multiplierFactor,
  cappedValueUsd, accruePoints, valuePool, computePositionAccrual, resolvePricesUsd,
  reconcilePrices,
} from "../lib/points";

let passed = 0, failed = 0;
const EPS = 1e-9;

function eq(name: string, got: number, want: number) {
  if (Math.abs(got - want) <= EPS + Math.abs(want) * 1e-9) { ok(name, `${got}`); }
  else fail(name, `got ${got}, want ${want}`);
}
function is(name: string, got: any, want: any) {
  if (got === want) ok(name, `${got}`); else fail(name, `got ${got}, want ${want}`);
}
function ok(name: string, detail: string) { passed++; console.log(`  ✓ ${name}  (${detail})`); }
function fail(name: string, detail: string) { failed++; console.log(`  ✗ ${name}  — ${detail}`); }

console.log("nonNeg");
eq("positive passes", nonNeg(5), 5);
eq("negative → 0", nonNeg(-3), 0);
eq("NaN → 0", nonNeg(NaN), 0);
eq("Infinity → 0", nonNeg(Infinity), 0);
eq("zero → 0", nonNeg(0), 0);

console.log("poolTvlUsd");
eq("both sides", poolTvlUsd(10000, 100, 1, 100), 20000);      // 10000*1 + 100*100
eq("NaN price side ignored", poolTvlUsd(10000, 100, 1, NaN), 10000);
eq("negative reserve clamped", poolTvlUsd(-5, 100, 1, 100), 10000);

console.log("lpTokenPriceUsd");
eq("tvl/supply", lpTokenPriceUsd(20000, 1_000_000_000), 20000 / 1e9);
eq("zero supply → 0", lpTokenPriceUsd(20000, 0), 0);
eq("nan tvl → 0", lpTokenPriceUsd(NaN, 1000), 0);

console.log("sybilBasisLpUi (the §3.1 rule)");
eq("deposit > balance → balance (partial transfer out)", sybilBasisLpUi(500, 400), 400);
eq("balance > deposit → deposit (received extra LP)", sybilBasisLpUi(300, 900), 300);
eq("dusted balance, no deposit → 0", sybilBasisLpUi(0, 1000), 0);
eq("transferred away: deposit>0, balance 0 → 0", sybilBasisLpUi(700, 0), 0);
eq("negatives clamped → 0", sybilBasisLpUi(-5, 400), 0);

console.log("multiplierFactor");
eq("10000 bps → 1.0", multiplierFactor(10000), 1);
eq("25000 bps → 2.5", multiplierFactor(25000), 2.5);
eq("0 bps → 0", multiplierFactor(0), 0);
eq("negative → 0", multiplierFactor(-100), 0);

console.log("cappedValueUsd");
eq("under cap unchanged", cappedValueUsd(3000, 5000), 3000);
eq("over cap clamped", cappedValueUsd(8000, 5000), 5000);
eq("cap 0 = uncapped", cappedValueUsd(8000, 0), 8000);

console.log("accruePoints");
eq("value×hours×factor×rate", accruePoints({ valueUsd: 8000, elapsedSeconds: 3600, multiplierBps: 15000, ratePointsPerUsdHour: 1 }), 12000);
eq("half hour", accruePoints({ valueUsd: 1000, elapsedSeconds: 1800, multiplierBps: 10000, ratePointsPerUsdHour: 1 }), 500);
eq("elapsed 0 → 0 (first sighting)", accruePoints({ valueUsd: 8000, elapsedSeconds: 0, multiplierBps: 10000, ratePointsPerUsdHour: 1 }), 0);
eq("negative elapsed → 0 (clock skew)", accruePoints({ valueUsd: 8000, elapsedSeconds: -100, multiplierBps: 10000, ratePointsPerUsdHour: 1 }), 0);
eq("rate 2 doubles", accruePoints({ valueUsd: 100, elapsedSeconds: 3600, multiplierBps: 10000, ratePointsPerUsdHour: 2 }), 200);

console.log("valuePool");
{
  const v = valuePool({ reserveAUi: 10000, reserveBUi: 100, totalLpUi: 1_000_000_000, priceAUsd: 1, priceBUsd: 100, multiplierBps: 15000 }, 500);
  eq("tvl", v.tvlUsd, 20000);
  eq("lpPrice", v.lpPriceUsd, 20000 / 1e9);
  is("eligible (priceable + above floor)", v.eligible, true);
  is("multiplier carried", v.multiplierBps, 15000);
}
{
  const v = valuePool({ reserveAUi: 10000, reserveBUi: 100, totalLpUi: 1e9, priceAUsd: null, priceBUsd: 100 }, 500);
  is("no price → not eligible", v.eligible, false);
  eq("no price → tvl 0", v.tvlUsd, 0);
  is("default multiplier when omitted", v.multiplierBps, 10000);
}
{
  const v = valuePool({ reserveAUi: 100, reserveBUi: 1, totalLpUi: 1e9, priceAUsd: 1, priceBUsd: 100 }, 500);
  is("below TVL floor → not eligible", v.eligible, false); // tvl = 200 < 500
}

console.log("computePositionAccrual (end-to-end)");
{
  const pool = valuePool({ reserveAUi: 10000, reserveBUi: 100, totalLpUi: 1_000_000_000, priceAUsd: 1, priceBUsd: 100, multiplierBps: 15000 }, 500);
  // basis = min(500M, 400M) = 400M raw LP; lpPrice = 2e-5 USD/raw → value = 8000 USD
  const a = computePositionAccrual(pool, { depositedLpUi: 500_000_000, walletLpBalanceUi: 400_000_000, elapsedSeconds: 3600 }, { ratePointsPerUsdHour: 1, maxPositionUsd: 0 });
  eq("basis = min", a.basisLpUi, 400_000_000);
  eq("valueUsd", a.valueUsd, 8000);
  eq("uncapped cappedUsd", a.cappedUsd, 8000);
  eq("points = value × 1h × 1.5×", a.points, 12000);

  // Same, but cap value at 5000 → points = 5000 × 1.5 = 7500
  const b = computePositionAccrual(pool, { depositedLpUi: 500_000_000, walletLpBalanceUi: 400_000_000, elapsedSeconds: 3600 }, { ratePointsPerUsdHour: 1, maxPositionUsd: 5000 });
  eq("capped value", b.cappedUsd, 5000);
  eq("capped points", b.points, 7500);

  // Transferred-away LP: balance 0 → basis 0 → 0 points despite a big deposit
  const c = computePositionAccrual(pool, { depositedLpUi: 900_000_000, walletLpBalanceUi: 0, elapsedSeconds: 3600 }, { ratePointsPerUsdHour: 1, maxPositionUsd: 0 });
  eq("transferred-away earns 0", c.points, 0);
}

console.log("resolvePricesUsd (multi-hop BFS)");
{
  const USDC = "USDC", SOL = "SOL", JITO = "JITO", BTC = "BTC", SPY = "SPY", FOO = "FOO", BAR = "BAR";
  const pools = [
    // SOL/USDC: reserveSOL=10, reserveUSDC=1000 → SOL = $100
    { mintA: SOL,  mintB: USDC, reserveAUi: 10,  reserveBUi: 1000 },
    // JITO/SOL: reserveJITO=100, reserveSOL=110 → JITO = 1.1 SOL = $110 (one hop)
    { mintA: JITO, mintB: SOL,  reserveAUi: 100, reserveBUi: 110 },
    // BTC/USDC: reserveBTC=1, reserveUSDC=60000 → BTC = $60000
    { mintA: BTC,  mintB: USDC, reserveAUi: 1,   reserveBUi: 60000 },
    // SPY/BTC: reserveSPY=100, reserveBTC=1 → SPY = $600 (two hops via BTC)
    { mintA: SPY,  mintB: BTC,  reserveAUi: 100, reserveBUi: 1 },
    // FOO/BAR: no path to USDC → both unpriceable
    { mintA: FOO,  mintB: BAR,  reserveAUi: 50,  reserveBUi: 50 },
  ];
  const px = resolvePricesUsd(pools, USDC);
  eq("USDC anchor = 1", px[USDC], 1);
  eq("direct: SOL = $100", px[SOL], 100);
  eq("one hop: JITO = $110", px[JITO], 110);
  eq("direct: BTC = $60000", px[BTC], 60000);
  eq("two hops: SPY = $600", px[SPY], 600);
  is("isolated FOO unpriced", px[FOO], undefined);
  is("isolated BAR unpriced", px[BAR], undefined);
}

console.log("reconcilePrices (Jupiter primary × Pyth cross-check)");
{
  // ETH: Jupiter 1858 vs Pyth 1857 → 0.05% dev, within 3% → accepted at Jupiter's.
  const r1 = reconcilePrices({ ETH: 1858, USDT: 0.999 }, { ETH: 1857 }, 3);
  eq("within-tolerance accepted at primary", r1.prices.ETH, 1858);
  eq("no cross-check accepted as-is", r1.prices.USDT, 0.999);
  is("nothing disputed", r1.disputed.length, 0);
}
{
  // BTC: Jupiter says 90000 but Pyth says 64000 → 40% dev → DROPPED.
  const r2 = reconcilePrices({ BTC: 90000, SOL: 73 }, { BTC: 64000, SOL: 73.7 }, 3);
  is("poisoned BTC disputed", r2.disputed.includes("BTC"), true);
  is("disputed BTC excluded from prices", r2.prices.BTC, undefined);
  eq("SOL within tolerance kept", r2.prices.SOL, 73);
}
{
  // Non-positive / missing primary prices are ignored.
  const r3 = reconcilePrices({ A: 0, B: -5, C: 12 }, {}, 3);
  is("zero price ignored", r3.prices.A, undefined);
  is("negative price ignored", r3.prices.B, undefined);
  eq("valid price kept", r3.prices.C, 12);
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
