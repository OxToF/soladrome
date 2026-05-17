// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useEffect, useState, useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { getProgram, statePda, toUi, poolPda, solaM } from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";

interface ProtocolStats {
  totalSola:       number;
  totalHiSola:     number;
  curvePrice:      number;         // bonding curve: virtualUsdc / virtualSola
  solaPrice:       number | null;  // AMM USDC/SOLA pool spot price
  osolaIntrinsic:  number | null;  // max(0, solaPrice - 1) — exercise value
  floorPrice:      number;
  accumulatedFees: number;
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
      // ── Protocol state (supply + fees + virtual reserves) ────────────────
      const s = await (program.account as any).protocolState.fetch(statePda);
      const curvePrice = toUi(s.virtualUsdc as BN) / toUi(s.virtualSola as BN);

      // ── SOLA price: from AMM USDC/SOLA pool (reflects actual swaps) ───────
      let solaPrice: number | null = null;
      if (usdcMint) {
        try {
          const poolAddr = poolPda(solaM, usdcMint);
          const pool     = await (program.account as any).ammPool.fetch(poolAddr);
          const mintA    = pool.tokenAMint.toString();
          const ra       = toUi(pool.reserveA as BN);
          const rb       = toUi(pool.reserveB as BN);
          // price of SOLA in USDC
          solaPrice = mintA === solaM.toString()
            ? (rb / ra)   // token_a=SOLA, token_b=USDC → price = rb/ra
            : (ra / rb);  // token_a=USDC, token_b=SOLA → price = ra/rb
        } catch { solaPrice = null; }
      }

      // ── oSOLA intrinsic value: max(0, solaPrice - floor) ─────────────────
      // Exercise cost is always 1 USDC per oSOLA; profit = SOLA price - 1 USDC
      const osolaIntrinsic = solaPrice !== null ? Math.max(0, solaPrice - 1) : null;

      setStats({
        totalSola:       toUi(s.totalSola),
        totalHiSola:     toUi(s.totalHiSola),
        curvePrice,
        solaPrice,
        osolaIntrinsic,
        floorPrice:      1,
        accumulatedFees: toUi(s.accumulatedFees),
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
    <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-8">
      {Array.from({ length: 6 }).map((_, i) => (
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
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-8">
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
        <p className="text-xs text-gray-500 mb-1">Prix courbe</p>
        <p className="font-bold text-brand-green">{fmt4(stats.curvePrice)} USDC</p>
        <p className="text-[10px] text-gray-600 mt-0.5">émission primaire</p>
      </div>

      {/* AMM spot price + spread indicator */}
      <div className="card text-center">
        <p className="text-xs text-gray-500 mb-1">Prix AMM</p>
        <p className="font-bold text-brand-green">
          {stats.solaPrice !== null ? `${fmt4(stats.solaPrice)} USDC` : "No pool"}
        </p>
        {spreadPct !== null && (
          <p className={`text-[10px] mt-0.5 ${spreadPct > 0 ? "text-yellow-500" : "text-blue-400"}`}>
            {spreadPct > 0 ? "▲" : "▼"} {Math.abs(spreadPct).toFixed(2)}% vs courbe
          </p>
        )}
      </div>

      <div className="card text-center">
        <p className="text-xs text-gray-500 mb-1">oSOLA Valeur</p>
        <p className="font-bold text-brand-green">
          {stats.osolaIntrinsic !== null ? `${fmt4(stats.osolaIntrinsic)} USDC` : "—"}
        </p>
        <p className="text-[10px] text-gray-600 mt-0.5">1 oSOLA + 1 USDC → 1 SOLA</p>
      </div>

      <div className="card text-center">
        <p className="text-xs text-gray-500 mb-1">Floor Price</p>
        <p className="font-bold text-brand-green">1.0000 USDC</p>
        <p className="text-[10px] text-gray-600 mt-0.5">garanti</p>
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