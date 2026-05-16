// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useEffect, useState, useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { getProgram, statePda, toUi, poolPda, solaM, oSolaM, sortMints } from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";

interface ProtocolStats {
  totalSola:       number;
  totalHiSola:     number;
  solaPrice:       number | null;  // from AMM USDC/SOLA pool
  osolaPrice:      number | null;  // from AMM oSOLA/USDC pool
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
      // ── Protocol state (supply + fees) ────────────────────────────────────
      const s = await (program.account as any).protocolState.fetch(statePda);

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

      // ── oSOLA price: from AMM oSOLA/USDC pool ─────────────────────────────
      let osolaPrice: number | null = null;
      if (usdcMint) {
        try {
          const poolAddr = poolPda(oSolaM, usdcMint);
          const pool     = await (program.account as any).ammPool.fetch(poolAddr);
          const mintA    = pool.tokenAMint.toString();
          const ra       = toUi(pool.reserveA as BN);
          const rb       = toUi(pool.reserveB as BN);
          osolaPrice = mintA === oSolaM.toString()
            ? (rb / ra)
            : (ra / rb);
        } catch {
          // Try oSOLA/SOLA pool and convert via SOLA price
          if (solaPrice !== null) {
            try {
              const poolAddr = poolPda(oSolaM, solaM);
              const pool     = await (program.account as any).ammPool.fetch(poolAddr);
              const mintA    = pool.tokenAMint.toString();
              const ra       = toUi(pool.reserveA as BN);
              const rb       = toUi(pool.reserveB as BN);
              const osolaPriceInSola = mintA === oSolaM.toString()
                ? (rb / ra)
                : (ra / rb);
              osolaPrice = osolaPriceInSola * solaPrice;
            } catch { osolaPrice = null; }
          }
        }
      }

      setStats({
        totalSola:       toUi(s.totalSola),
        totalHiSola:     toUi(s.totalHiSola),
        solaPrice,
        osolaPrice,
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

  const items = [
    { label: "SOLA Supply",   value: stats.totalSola.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
    { label: "hiSOLA Staked", value: stats.totalHiSola.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
    {
      label: "SOLA Price",
      value: stats.solaPrice !== null
        ? `${stats.solaPrice.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })} USDC`
        : "No pool",
    },
    {
      label: "oSOLA Price",
      value: stats.osolaPrice !== null
        ? `${stats.osolaPrice.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })} USDC`
        : "No pool",
    },
    { label: "Floor Price",   value: "1.0000 USDC" },
    { label: "Protocol Fees", value: `${stats.accumulatedFees.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC` },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
      {items.map((item) => (
        <div key={item.label} className="card text-center">
          <p className="text-xs text-gray-500 mb-1">{item.label}</p>
          <p className="font-bold text-brand-green">{item.value}</p>
        </div>
      ))}
    </div>
  );
}