// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useEffect, useState, useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { getProgram, statePda, floorVault, marketVault, toUi, solaM, oSolaM } from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";
import { unpackAccount } from "@solana/spl-token";

interface ProtocolStats {
  totalSola:        number;
  totalHiSola:      number;
  curvePrice:       number;
  solaPrice:        number | null;
  osolaIntrinsic:   number | null;
  osolaMktPrice:    number | null;
  floorPrice:       number;
  accumulatedFees:  number;
  tvl:              number;
  pendingPerHiSola: number;  // USDC claimable per hiSOLA right now
}

export function Stats() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const [stats, setStats] = useState<ProtocolStats | null>(null);

  const fetchStats = useCallback(async () => {
    const provider = new AnchorProvider(connection, wallet ?? ({} as any), {});
    const program  = getProgram(provider);

    try {
      // ── Protocol state + vault balances + ALL AMM pools in 3 RPC calls ─────
      // Vault balances batch into one getMultipleAccountsInfo; ammPool.all() is
      // fetched once and reused for both price derivation AND TVL below (the old
      // code re-fetched the SOLA/USDC and oSOLA/USDC pools separately — 2 extra
      // round-trips that all() already returns). USDC vaults use 6 decimals.
      const [s, vaultInfos, ammPools] = await Promise.all([
        (program.account as any).protocolState.fetch(statePda),
        connection.getMultipleAccountsInfo([floorVault, marketVault]),
        (program.account as any).ammPool.all(),
      ]);
      const floorUsdc  = vaultInfos[0] ? Number(unpackAccount(floorVault,  vaultInfos[0]).amount) / 1e6 : 0;
      const marketUsdc = vaultInfos[1] ? Number(unpackAccount(marketVault, vaultInfos[1]).amount) / 1e6 : 0;
      const curvePrice = toUi(s.virtualUsdc as BN) / toUi(s.virtualSola as BN);

      const usdcStr = s.usdcMint?.toString() ?? "";

      // Price of `mintStr` in USDC, derived from its USDC AMM pool (if any).
      const priceVsUsdc = (mintStr: string): number | null => {
        const p = ammPools.find((p: any) => {
          const a = p.account.tokenAMint.toString();
          const b = p.account.tokenBMint.toString();
          return (a === mintStr && b === usdcStr) || (a === usdcStr && b === mintStr);
        });
        if (!p) return null;
        const a  = p.account.tokenAMint.toString();
        const ra = toUi(p.account.reserveA as BN);
        const rb = toUi(p.account.reserveB as BN);
        if (ra === 0 || rb === 0) return null;
        return a === mintStr ? rb / ra : ra / rb;
      };

      // ── SOLA price: from AMM USDC/SOLA pool (reflects actual swaps) ───────
      const solaPrice = priceVsUsdc(solaM.toString());
      // ── oSOLA intrinsic value: max(0, solaPrice - floor) ─────────────────
      const osolaIntrinsic = solaPrice !== null ? Math.max(0, solaPrice - 1) : null;
      // ── oSOLA market price: from AMM oSOLA/USDC pool ──────────────────────
      const osolaMktPrice = priceVsUsdc(oSolaM.toString());

      // ── TVL from the already-fetched pool set ─────────────────────────────
      let ammTvl = 0;
      for (const p of ammPools) {
        const mA = p.account.tokenAMint.toString();
        const mB = p.account.tokenBMint.toString();
        const ra = toUi(p.account.reserveA as BN);
        const rb = toUi(p.account.reserveB as BN);
        if (mA === usdcStr) ammTvl += ra * 2;
        else if (mB === usdcStr) ammTvl += rb * 2;
      }

      const tvl = floorUsdc + marketUsdc + ammTvl;
      const totalHiSola = toUi(s.totalHiSola);
      const pendingPerHiSola = totalHiSola > 0 ? marketUsdc / totalHiSola : 0;

      setStats({
        totalSola:        toUi(s.totalSola),
        totalHiSola,
        curvePrice,
        solaPrice,
        osolaIntrinsic,
        osolaMktPrice,
        floorPrice:       1,
        accumulatedFees:  toUi(s.accumulatedFees),
        tvl,
        pendingPerHiSola,
      });
    } catch { }
  }, [connection, wallet, usdcMint]);

  // Fetch on mount + every 10 seconds
  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, 10_000);
    return () => clearInterval(id);
  }, [fetchStats]);

  if (!stats) return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-9 gap-4 mb-8">
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="card text-center animate-pulse">
          <div className="h-3 bg-brand-border rounded mb-2 mx-auto w-2/3" />
          <div className="h-5 bg-brand-border rounded mx-auto w-1/2" />
        </div>
      ))}
    </div>
  );

  const fmt4 = (v: number) =>
    v.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });

  // Spread: positive = AMM premium over curve (buy on curve), negative = AMM discount (buy on AMM)
  const spread = stats.solaPrice !== null ? stats.solaPrice - stats.curvePrice : null;
  const spreadPct = spread !== null && stats.curvePrice > 0
    ? (spread / stats.curvePrice) * 100
    : null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-9 gap-4 mb-8">

      {/* TVL — first, most prominent */}
      <div className="card text-center">
        <p className="text-xs text-gray-500 mb-1">Protocol TVL</p>
        <p className="font-bold text-brand-green">
          ${stats.tvl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </p>
      </div>

      {/* hiSOLA claimable yield */}
      <div className="card text-center">
        <p className="text-xs text-gray-500 mb-1">hiSOLA Yield</p>
        <p className="font-bold text-brand-green">
          {stats.pendingPerHiSola > 0
            ? `${stats.pendingPerHiSola.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })} USDC`
            : "—"}
        </p>
        <p className="text-[10px] text-gray-600 mt-0.5">per hiSOLA · claimable</p>
      </div>

      <div className="card text-center">
        <p className="text-xs text-gray-500 mb-1">SOLA Supply</p>
        <p className="font-bold text-brand-green">
          {stats.totalSola.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </p>
      </div>

      <div className="card text-center">
        <p className="text-xs text-gray-500 mb-1">hiSOLA Staked</p>
        <p className="font-bold text-brand-green">
          {stats.totalHiSola.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </p>
      </div>

      {/* Bonding curve price */}
      <div className="card text-center">
        <p className="text-xs text-gray-500 mb-1">Curve price</p>
        <p className="font-bold text-brand-green">{fmt4(stats.curvePrice)} USDC</p>
        <p className="text-[10px] text-gray-600 mt-0.5">primary issuance</p>
      </div>

      {/* AMM spot price + spread indicator */}
      <div className="card text-center">
        <p className="text-xs text-gray-500 mb-1">AMM price</p>
        <p className="font-bold text-brand-green">
          {stats.solaPrice !== null ? `${fmt4(stats.solaPrice)} USDC` : "No pool"}
        </p>
        {spreadPct !== null && (
          <p className={`text-[10px] mt-0.5 ${spreadPct > 0 ? "text-yellow-500" : "text-blue-400"}`}>
            {spreadPct > 0 ? "▲" : "▼"} {Math.abs(spreadPct).toFixed(2)}% vs curve
          </p>
        )}
      </div>

      <div className="card text-center">
        <p className="text-xs text-gray-500 mb-1">oSOLA</p>
        <p className="font-bold text-brand-green">
          {stats.osolaMktPrice !== null ? `${fmt4(stats.osolaMktPrice)} USDC` : "—"}
        </p>
        <p className="text-[10px] text-gray-600 mt-0.5">market price</p>
        {stats.osolaIntrinsic !== null && (
          <p className="text-[10px] text-yellow-500 mt-1">
            exercice: {fmt4(stats.osolaIntrinsic)} USDC
          </p>
        )}
      </div>

      <div className="card text-center">
        <p className="text-xs text-gray-500 mb-1">Floor Price</p>
        <p className="font-bold text-brand-green">1.0000 USDC</p>
        <p className="text-[10px] text-gray-600 mt-0.5">guaranteed</p>
      </div>

      <div className="card text-center">
        <p className="text-xs text-gray-500 mb-1">Protocol Fees</p>
        <p className="font-bold text-brand-green">
          {stats.accumulatedFees.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
        </p>
      </div>
    </div>
  );
}