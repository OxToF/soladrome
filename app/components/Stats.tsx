// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useMemo } from "react";
import { BN } from "@coral-xyz/anchor";
import { toUi, solaM, oSolaM, floorVault, marketVault } from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";
import { ammPriceVsUsdc } from "@/lib/prices";
import { unpackAccount } from "@solana/spl-token";

export function Stats() {
  const { protocolState: s, ammPools, vaultInfos, usdcMint, loading } = useSoladrome();

  const stats = useMemo(() => {
    if (!s || !usdcMint) return null;
    const usdcStr   = usdcMint.toString();
    const floorUsdc  = vaultInfos[0] ? Number(unpackAccount(floorVault,  vaultInfos[0]).amount) / 1e6 : 0;
    const marketUsdc = vaultInfos[1] ? Number(unpackAccount(marketVault, vaultInfos[1]).amount) / 1e6 : 0;
    const curvePrice = toUi(s.virtualUsdc as BN) / toUi(s.virtualSola as BN);

    const priceVsUsdc = (mintStr: string): number | null =>
      ammPriceVsUsdc(ammPools, mintStr, usdcStr);

    const solaPrice      = priceVsUsdc(solaM.toString());
    const osolaIntrinsic = solaPrice !== null ? Math.max(0, solaPrice - 1) : null;
    const osolaMktPrice  = priceVsUsdc(oSolaM.toString());

    let ammTvl = 0;
    for (const p of ammPools) {
      const mA = p.account.tokenAMint.toString();
      const mB = p.account.tokenBMint.toString();
      const ra = toUi(p.account.reserveA as BN);
      const rb = toUi(p.account.reserveB as BN);
      if (mA === usdcStr) ammTvl += ra * 2;
      else if (mB === usdcStr) ammTvl += rb * 2;
    }

    const tvl          = floorUsdc + marketUsdc + ammTvl;
    const totalHiSola  = toUi(s.totalHiSola);
    return {
      totalSola:        toUi(s.totalSola),
      totalHiSola,
      curvePrice,
      solaPrice,
      osolaIntrinsic,
      osolaMktPrice,
      floorPrice:       1,
      accumulatedFees:  toUi(s.accumulatedFees),
      tvl,
      pendingPerHiSola: totalHiSola > 0 ? marketUsdc / totalHiSola : 0,
    };
  }, [s, ammPools, vaultInfos, usdcMint]);

  if (loading || !stats) return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 sm:gap-4 mb-6 sm:mb-8">
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="card text-center animate-pulse">
          <div className="h-3 bg-brand-border rounded mb-2 mx-auto w-2/3" />
          <div className="h-5 bg-brand-border rounded mx-auto w-1/2" />
        </div>
      ))}
    </div>
  );

  // Full precision always available via the `title` tooltip. Values >= 10,000
  // switch to compact notation (13495061.8672 -> "13.5M") so the primary
  // display never wraps inside a narrow card; smaller values keep 4 decimals.
  const fmt4 = (v: number) =>
    Math.abs(v) >= 10_000
      ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(v)
      : v.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });

  const fmtInt = (v: number) =>
    Math.abs(v) >= 10_000
      ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(v)
      : v.toLocaleString(undefined, { maximumFractionDigits: 0 });

  const spread    = stats.solaPrice !== null ? stats.solaPrice - stats.curvePrice : null;
  const spreadPct = spread !== null && stats.curvePrice > 0
    ? (spread / stats.curvePrice) * 100
    : null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 sm:gap-4 mb-6 sm:mb-8">
      <div className="card p-3 sm:p-5 text-center">
        <p className="text-xs text-gray-500 mb-1">Protocol TVL</p>
        <p
          className="font-bold text-brand-green text-base sm:text-lg leading-tight truncate"
          title={`$${stats.tvl.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
        >
          ${fmtInt(stats.tvl)}
        </p>
      </div>
      <div className="card p-3 sm:p-5 text-center">
        <p className="text-xs text-gray-500 mb-1">hiSOLA Yield</p>
        <p className="font-bold text-brand-green text-base sm:text-lg leading-tight truncate">
          {stats.pendingPerHiSola > 0 ? `${fmt4(stats.pendingPerHiSola)} USDC` : "—"}
        </p>
        <p className="text-[10px] text-gray-600 mt-0.5">per hiSOLA · claimable</p>
      </div>
      <div className="card p-3 sm:p-5 text-center">
        <p className="text-xs text-gray-500 mb-1">SOLA Supply</p>
        <p
          className="font-bold text-brand-green text-base sm:text-lg leading-tight truncate"
          title={stats.totalSola.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        >
          {fmtInt(stats.totalSola)}
        </p>
      </div>
      <div className="card p-3 sm:p-5 text-center">
        <p className="text-xs text-gray-500 mb-1">hiSOLA Staked</p>
        <p
          className="font-bold text-brand-green text-base sm:text-lg leading-tight truncate"
          title={stats.totalHiSola.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        >
          {fmtInt(stats.totalHiSola)}
        </p>
      </div>
      <div className="card p-3 sm:p-5 text-center">
        <p className="text-xs text-gray-500 mb-1">Curve price</p>
        <p
          className="font-bold text-brand-green text-base sm:text-lg leading-tight truncate"
          title={`${stats.curvePrice.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })} USDC`}
        >
          {fmt4(stats.curvePrice)} USDC
        </p>
        <p className="text-[10px] text-gray-600 mt-0.5">primary issuance</p>
      </div>
      <div className="card p-3 sm:p-5 text-center">
        <p className="text-xs text-gray-500 mb-1">AMM price</p>
        <p className="font-bold text-brand-green text-base sm:text-lg leading-tight truncate">
          {stats.solaPrice !== null ? `${fmt4(stats.solaPrice)} USDC` : "No pool"}
        </p>
        {spreadPct !== null && (
          <p className={`text-[10px] mt-0.5 ${spreadPct > 0 ? "text-yellow-500" : "text-blue-400"}`}>
            {spreadPct > 0 ? "▲" : "▼"} {Math.abs(spreadPct).toFixed(2)}% vs curve
          </p>
        )}
      </div>
      <div className="card p-3 sm:p-5 text-center">
        <p className="text-xs text-gray-500 mb-1">oSOLA</p>
        <p className="font-bold text-brand-green text-base sm:text-lg leading-tight truncate">
          {stats.osolaMktPrice !== null ? `${fmt4(stats.osolaMktPrice)} USDC` : "—"}
        </p>
        <p className="text-[10px] text-gray-600 mt-0.5">market price</p>
        {stats.osolaIntrinsic !== null && (
          <p className="text-[10px] text-yellow-500 mt-1 truncate">
            exercice: {fmt4(stats.osolaIntrinsic)} USDC
          </p>
        )}
      </div>
      <div className="card p-3 sm:p-5 text-center">
        <p className="text-xs text-gray-500 mb-1">Floor Price</p>
        <p className="font-bold text-brand-green text-base sm:text-lg leading-tight truncate">1.0000 USDC</p>
        <p className="text-[10px] text-gray-600 mt-0.5">guaranteed</p>
      </div>
      <div className="card p-3 sm:p-5 text-center">
        <p className="text-xs text-gray-500 mb-1">Protocol Fees</p>
        <p
          className="font-bold text-brand-green text-base sm:text-lg leading-tight truncate"
          title={`${stats.accumulatedFees.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`}
        >
          {fmt4(stats.accumulatedFees)} USDC
        </p>
      </div>
    </div>
  );
}
