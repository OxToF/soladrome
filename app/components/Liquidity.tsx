// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useEffect, useState } from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getProgram, statePda, floorVault, marketVault, solaVaultAddr, toUi, toUiDecimals } from "@/lib/program";
import { decimalsForMint } from "@/lib/tokens";

interface LiqStats {
  floorUsdc:   number;
  marketUsdc:  number;
  solaLocked:  number;
  virtualUsdc: number;
  virtualSola: number;
  totalSola:   number;
  ammTvl:      number;  // sum of AMM pool reserves valued in USDC
  ammPools:    number;  // number of active AMM pools
}

export function Liquidity() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [s, setS] = useState<LiqStats | null>(null);

  useEffect(() => {
    const provider = wallet
      ? new AnchorProvider(connection, wallet, {})
      : new AnchorProvider(
          connection,
          { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (ts) => ts },
          {}
        );
    const program = getProgram(provider);

    Promise.all([
      (program.account as any).protocolState.fetch(statePda),
      connection.getTokenAccountBalance(floorVault),
      connection.getTokenAccountBalance(marketVault),
      connection.getTokenAccountBalance(solaVaultAddr),
      (program.account as any).ammPool.all(),
    ]).then(([state, floor, market, solaVault, pools]) => {
      const usdcStr = state.usdcMint?.toString() ?? "";
      let ammTvl = 0;
      for (const p of pools) {
        const mintA = p.account.tokenAMint.toString();
        const mintB = p.account.tokenBMint.toString();
        const decA  = decimalsForMint(mintA, state.usdcMint ?? null);
        const decB  = decimalsForMint(mintB, state.usdcMint ?? null);
        const ra    = toUiDecimals(p.account.reserveA as BN, decA);
        const rb    = toUiDecimals(p.account.reserveB as BN, decB);
        // Value USDC-paired pools: TVL = 2 × USDC side
        if (mintA === usdcStr) ammTvl += ra * 2;
        else if (mintB === usdcStr) ammTvl += rb * 2;
        // For non-USDC pairs, use pool implied price if SOL/USDC ratio available
      }
      setS({
        floorUsdc:   (floor.value.uiAmount  ?? 0),
        marketUsdc:  (market.value.uiAmount ?? 0),
        solaLocked:  (solaVault.value.uiAmount ?? 0),
        virtualUsdc: toUi(state.virtualUsdc),
        virtualSola: toUi(state.virtualSola),
        totalSola:   toUi(state.totalSola),
        ammTvl,
        ammPools:    pools.length,
      });
    }).catch(() => {});
  }, [wallet, connection]);

  const bondingTvl = s ? s.floorUsdc + s.marketUsdc : 0;
  const tvl        = s ? bondingTvl + s.ammTvl : 0;
  const curvePrice = s && s.virtualSola > 0 ? s.virtualUsdc / s.virtualSola : 1;

  return (
    <div className="space-y-6">

      {/* TVL hero */}
      <div className="card glow text-center py-8">
        <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">Protocol TVL</p>
        <p className="text-5xl font-black text-brand-green">
          {s ? `$${tvl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
        </p>
        <div className="flex justify-center gap-6 mt-3 text-xs text-gray-500">
          <span>Bonding curve: <span className="text-gray-300">${bondingTvl.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></span>
          <span>AMM pools ({s?.ammPools ?? 0}): <span className="text-gray-300">${(s?.ammTvl ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></span>
        </div>
      </div>

      {/* Vault breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card text-center">
          <div className="text-2xl mb-2">🏦</div>
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-widest">Floor Vault</p>
          <p className="text-xl font-bold text-white">
            {s ? `${s.floorUsdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC` : "—"}
          </p>
          <p className="text-xs text-gray-500 mt-2">
            Garantit 1 USDC / SOLA à tout moment
          </p>
        </div>

        <div className="card text-center">
          <div className="text-2xl mb-2">📈</div>
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-widest">Market Vault</p>
          <p className="text-xl font-bold text-white">
            {s ? `${s.marketUsdc.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC` : "—"}
          </p>
          <p className="text-xs text-gray-500 mt-2">
            Prime de prix accumulée — partagée avec les stakers
          </p>
        </div>

        <div className="card text-center">
          <div className="text-2xl mb-2">🔒</div>
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-widest">SOLA Vault</p>
          <p className="text-xl font-bold text-white">
            {s ? `${s.solaLocked.toLocaleString(undefined, { maximumFractionDigits: 0 })} SOLA` : "—"}
          </p>
          <p className="text-xs text-gray-500 mt-2">
            SOLA verrouillé par les stakers (hiSOLA)
          </p>
        </div>
      </div>

      {/* Bonding curve */}
      <div className="card">
        <h2 className="text-base font-bold text-white mb-4">Bonding Curve — Réserves Virtuelles</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div>
            <p className="text-xs text-gray-500 mb-1">Virtual USDC</p>
            <p className="font-bold text-brand-green">
              {s ? s.virtualUsdc.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Virtual SOLA</p>
            <p className="font-bold text-brand-green">
              {s ? s.virtualSola.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Prix Marché</p>
            <p className="font-bold text-brand-green">
              {s ? `${curvePrice.toFixed(4)} USDC` : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">SOLA en circulation</p>
            <p className="font-bold text-brand-green">
              {s ? s.totalSola.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}
            </p>
          </div>
        </div>

        <div className="mt-6 p-4 rounded-xl bg-brand-dark border border-brand-border text-xs text-gray-400 leading-relaxed">
          <p className="font-semibold text-gray-300 mb-1">Modèle de liquidité Soladrome</p>
          La liquidité est <span className="text-brand-green">protocol-owned</span> — pas de LP externe.
          Chaque achat de SOLA dépose&nbsp;1 USDC dans le <em>floor vault</em> (garantie de rachat)
          et le surplus dans le <em>market vault</em> (revenus des stakers).
          La courbe de liaison x·y=k assure une profondeur de liquidité permanente sans risque d'impermanent loss.
        </div>
      </div>

      {/* CTA */}
      <div className="card flex items-center justify-between">
        <div>
          <p className="font-semibold text-white mb-1">Participer à la liquidité</p>
          <p className="text-xs text-gray-500">Achète SOLA pour renforcer le floor vault, stake pour gagner les fees.</p>
        </div>
        <div className="flex gap-3 shrink-0">
          <a href="#" onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "swap" }))}
            className="btn-secondary text-sm">
            Swap
          </a>
          <a href="#" onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "stake" }))}
            className="btn-primary text-sm">
            Staker
          </a>
        </div>
      </div>

    </div>
  );
}