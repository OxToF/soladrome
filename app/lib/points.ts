// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// Phase-2 points — PURE accrual logic (no I/O, no chain, no DB).
//
// Everything here is a deterministic function of numbers already converted to
// human ("UI") units and USD, so it can be unit-tested in isolation
// (app/scripts/test_points.ts). The snapshot route (app/app/api/points/
// snapshot/route.ts) does the chain reads + DB writes and calls into here for
// the maths. Keeping the two apart is the whole point: the risky part (§3.1 of
// POINTS_PHASE2_DESIGN.md, sybil-resistant valuation) is a handful of small pure
// functions you can prove correct, not tangled into RPC/DB plumbing.
//
// Model recap: a wallet earns points proportional to the USD value of the
// liquidity it provides, integrated over time, scaled by a per-pool multiplier:
//
//     Δpoints = value_usd × (elapsed_seconds / 3600) × (multiplier_bps/10000) × RATE
//
// where RATE is points per USD per hour. The snapshot job samples value_usd at
// intervals and accrues each interval, so a missed run just widens `elapsed`
// (no points lost) and a duplicated run is rejected upstream (no double credit).

/** Points minted per 1 USD of liquidity held for 1 hour at multiplier 1.0×.
 *  Sizing note: total distributable ≈ RATE × Σ(value_usd × hours). Pick RATE
 *  from the phase-2 budget and the window length (see §5/§8 of the design doc).
 *  Default is a placeholder — 1 point per $1·hour — override via env in the route. */
export const DEFAULT_RATE_POINTS_PER_USD_HOUR = 1;

/** Pools with TVL below this (USD) accrue nothing — a pool nobody funds is not a
 *  signal (mirrors Gigadex weighting by real pool activity). */
export const DEFAULT_MIN_POOL_TVL_USD = 500;

/** Per-(wallet,pool) cap on the USD value that counts, damping whale / self-LP
 *  dominance. 0 = uncapped. */
export const DEFAULT_MAX_POSITION_USD = 0;

/** Multiplier for a pool with no explicit row: 1.00×. */
export const DEFAULT_MULTIPLIER_BPS = 10_000;

const SECONDS_PER_HOUR = 3600;

/** Coerce anything non-finite/negative to 0. Guards against NaN prices, negative
 *  clock skew, and bad DB rows silently poisoning an accrual. */
export function nonNeg(x: number): number {
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/** USD TVL of a two-sided pool from its reserves (UI units) and per-token USD
 *  prices. Returns 0 if any input is unusable. */
export function poolTvlUsd(
  reserveAUi: number,
  reserveBUi: number,
  priceAUsd: number,
  priceBUsd: number,
): number {
  return nonNeg(reserveAUi) * nonNeg(priceAUsd) + nonNeg(reserveBUi) * nonNeg(priceBUsd);
}

/** USD value of one LP token = pool TVL / LP supply (both UI units).
 *  Returns 0 when supply is 0 (a pool with no LP has no per-LP value). */
export function lpTokenPriceUsd(tvlUsd: number, totalLpUi: number): number {
  const supply = nonNeg(totalLpUi);
  if (supply === 0) return 0;
  return nonNeg(tvlUsd) / supply;
}

/** Sybil-resistant LP basis (§3.1): the min of what the wallet DEPOSITED through
 *  the program (LpUserInfo.lp_amount) and what it CURRENTLY HOLDS (wallet LP-token
 *  balance) — the exact rule the on-chain reward code uses. Transferred-away LP
 *  earns on neither wallet; dusted-in LP (balance without a deposit) yields 0. */
export function sybilBasisLpUi(depositedLpUi: number, walletLpBalanceUi: number): number {
  return Math.min(nonNeg(depositedLpUi), nonNeg(walletLpBalanceUi));
}

/** Fraction to scale by, from a multiplier in basis points. 10000 → 1.0. */
export function multiplierFactor(multiplierBps: number): number {
  return nonNeg(multiplierBps) / 10_000;
}

/** Apply the optional per-position USD cap (0 = uncapped). */
export function cappedValueUsd(valueUsd: number, maxPositionUsd: number): number {
  const v = nonNeg(valueUsd);
  const cap = nonNeg(maxPositionUsd);
  return cap > 0 ? Math.min(v, cap) : v;
}

/** Core accrual: points for holding `valueUsd` of value for `elapsedSeconds`
 *  at `multiplierBps`, given the global RATE. Never negative. */
export function accruePoints(args: {
  valueUsd: number;
  elapsedSeconds: number;
  multiplierBps: number;
  ratePointsPerUsdHour: number;
}): number {
  const value = nonNeg(args.valueUsd);
  const hours = nonNeg(args.elapsedSeconds) / SECONDS_PER_HOUR;
  const factor = multiplierFactor(args.multiplierBps);
  const rate = nonNeg(args.ratePointsPerUsdHour);
  return value * hours * factor * rate;
}

/** Reconcile a primary USD price map (Jupiter) against a cross-check map (Pyth
 *  majors, keyed by the same mint). A mint whose primary price deviates from its
 *  cross-check by more than `tolerancePct` is DROPPED (returned in `disputed`) so
 *  a poisoned feed can't mint points; a mint with no cross-check is accepted as
 *  is. Non-positive primary prices are ignored. Pure — no I/O. */
export function reconcilePrices(
  primary: Record<string, number>,
  crossCheck: Record<string, number>,
  tolerancePct: number,
): { prices: Record<string, number>; disputed: string[] } {
  const prices: Record<string, number> = {};
  const disputed: string[] = [];
  const tol = nonNeg(tolerancePct);
  for (const [mint, px] of Object.entries(primary)) {
    if (!(px > 0)) continue;
    const ref = crossCheck[mint];
    if (ref !== undefined && ref > 0) {
      const devPct = Math.abs(px - ref) / ref * 100;
      if (devPct > tol) { disputed.push(mint); continue; }
    }
    prices[mint] = px;
  }
  return { prices, disputed };
}

export interface PricePoolEdge {
  mintA: string;
  mintB: string;
  reserveAUi: number;
  reserveBUi: number;
}

/** Resolve USD prices for every mint reachable from USDC through the pool graph.
 *  At AMM balance `reserveA·priceA = reserveB·priceB`, so each pool relates its
 *  two mints' prices; BFS from USDC = 1 propagates across hops (jitoSOL→SOL→USDC,
 *  X→cbBTC→USDC) with no hardcoded intermediaries. Each mint is priced ONCE (the
 *  first connecting pool wins — no cycles, terminates); a mint with no priced
 *  path is simply absent from the result, so the caller skips its pool. */
export function resolvePricesUsd(pools: PricePoolEdge[], usdcMint: string): Record<string, number> {
  const price: Record<string, number> = { [usdcMint]: 1 };
  for (let iter = 0; iter <= pools.length + 1; iter++) {
    let changed = false;
    for (const p of pools) {
      if (!(p.reserveAUi > 0) || !(p.reserveBUi > 0)) continue;
      const pA = price[p.mintA], pB = price[p.mintB];
      if (pA !== undefined && pB === undefined) {
        price[p.mintB] = pA * p.reserveAUi / p.reserveBUi; changed = true;
      } else if (pB !== undefined && pA === undefined) {
        price[p.mintA] = pB * p.reserveBUi / p.reserveAUi; changed = true;
      }
    }
    if (!changed) break;
  }
  return price;
}

export interface PoolSnapshotInput {
  /** UI-unit reserves and LP supply, read from AmmPool. */
  reserveAUi: number;
  reserveBUi: number;
  totalLpUi: number;
  /** Per-token USD prices; null/unknown means the pool cannot be valued. */
  priceAUsd: number | null;
  priceBUsd: number | null;
  /** Pool multiplier in bps (default 10000). */
  multiplierBps?: number;
}

export interface PoolValuation {
  tvlUsd: number;
  lpPriceUsd: number;
  multiplierBps: number;
  /** True when the pool is priceable AND above the TVL floor — else skip it. */
  eligible: boolean;
}

/** Value a pool once per snapshot. `eligible=false` (missing price or below the
 *  TVL floor) means no wallet in this pool accrues this round. */
export function valuePool(input: PoolSnapshotInput, minPoolTvlUsd: number): PoolValuation {
  const priceable = input.priceAUsd != null && input.priceBUsd != null;
  const tvlUsd = priceable
    ? poolTvlUsd(input.reserveAUi, input.reserveBUi, input.priceAUsd as number, input.priceBUsd as number)
    : 0;
  const lpPriceUsd = lpTokenPriceUsd(tvlUsd, input.totalLpUi);
  const multiplierBps = input.multiplierBps ?? DEFAULT_MULTIPLIER_BPS;
  const eligible = priceable && tvlUsd >= nonNeg(minPoolTvlUsd) && lpPriceUsd > 0;
  return { tvlUsd, lpPriceUsd, multiplierBps, eligible };
}

export interface PositionInput {
  /** LpUserInfo.lp_amount in UI units. */
  depositedLpUi: number;
  /** Wallet's current LP-token balance in UI units. */
  walletLpBalanceUi: number;
  /** Seconds since this (wallet,pool)'s last snapshot. */
  elapsedSeconds: number;
}

export interface PositionAccrual {
  basisLpUi: number;
  valueUsd: number;
  cappedUsd: number;
  points: number;
}

/** Full per-(wallet,pool) accrual for one snapshot: sybil basis → USD value →
 *  cap → points. `pool.eligible` must be true (caller skips ineligible pools). */
export function computePositionAccrual(
  pool: PoolValuation,
  pos: PositionInput,
  cfg: { ratePointsPerUsdHour: number; maxPositionUsd: number },
): PositionAccrual {
  const basisLpUi = sybilBasisLpUi(pos.depositedLpUi, pos.walletLpBalanceUi);
  const valueUsd = basisLpUi * nonNeg(pool.lpPriceUsd);
  const cappedUsd = cappedValueUsd(valueUsd, cfg.maxPositionUsd);
  const points = accruePoints({
    valueUsd: cappedUsd,
    elapsedSeconds: pos.elapsedSeconds,
    multiplierBps: pool.multiplierBps,
    ratePointsPerUsdHour: cfg.ratePointsPerUsdHour,
  });
  return { basisLpUi, valueUsd, cappedUsd, points };
}
