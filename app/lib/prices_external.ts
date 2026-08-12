// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// External USD price sources for the off-chain points engine.
//
// WHY external: valuing a wallet's LP from Soladrome's OWN pool reserves is
// circular and manipulable — at launch the pools are thin, so skewing a reserve
// (a swap, a lopsided deposit) would inflate the USD value of one's own LP and
// farm points. Points value must come from a market-wide price the depositor
// cannot move: Jupiter's aggregate price (primary), cross-checked against Pyth
// on the majors. Because the snapshot job is off-chain, no on-chain oracle CPI
// is needed — plain server-side HTTP is enough.
//
// Shapes verified live 2026-07-24:
//   Jupiter v3:  GET lite-api.jup.ag/price/v3?ids=<mints>
//                → { "<mint>": { usdPrice:number, liquidity:number, decimals } }
//   Pyth Hermes: GET hermes.pyth.network/v2/updates/price/latest?ids[]=<feed>
//                → { parsed: [ { id, price:{ price, expo, conf } } ] }

/** Canonical Pyth mainnet price-feed IDs (no 0x prefix, as Hermes returns them). */
export const PYTH_FEED_IDS: Record<string, string> = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

/** USD price per mint from Jupiter's aggregate (all Solana liquidity, not
 *  Soladrome's). Drops entries below `minLiquidityUsd` — a thin token's quoted
 *  price is unreliable and manipulable. Chunks ids to stay within API limits.
 *  Returns {} on total failure so the caller degrades to "no accrual this round"
 *  rather than crashing (a missed snapshot only widens the next interval). */
export async function fetchJupiterUsdPrices(
  mints: string[],
  minLiquidityUsd = 0,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    try {
      const r = await fetch("https://lite-api.jup.ag/price/v3?ids=" + chunk.join(","));
      if (!r.ok) continue;
      const j: any = await r.json();
      for (const m of chunk) {
        const e = j?.[m];
        if (!e || typeof e.usdPrice !== "number" || !(e.usdPrice > 0)) continue;
        if (minLiquidityUsd > 0 && !(Number(e.liquidity) >= minLiquidityUsd)) continue;
        out[m] = e.usdPrice;
      }
    } catch { /* skip this chunk, keep whatever resolved */ }
  }
  return out;
}

/** Pyth majors (SOL, BTC, ETH) in USD, keyed by symbol, for cross-checking the
 *  Jupiter price of the corresponding mints. {} on failure (cross-check skipped,
 *  Jupiter still used). */
export async function fetchPythMajorsUsd(): Promise<Record<string, number>> {
  try {
    const q = Object.values(PYTH_FEED_IDS).map((id) => "ids[]=" + id).join("&");
    const r = await fetch("https://hermes.pyth.network/v2/updates/price/latest?" + q);
    if (!r.ok) return {};
    const j: any = await r.json();
    const idToSym = Object.fromEntries(Object.entries(PYTH_FEED_IDS).map(([s, id]) => [id, s]));
    const bySymbol: Record<string, number> = {};
    for (const p of j?.parsed ?? []) {
      const sym = idToSym[p.id];
      if (!sym) continue;
      const px = Number(p.price.price) * Math.pow(10, p.price.expo);
      if (px > 0) bySymbol[sym] = px;
    }
    return bySymbol;
  } catch {
    return {};
  }
}
