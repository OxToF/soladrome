// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useEffect, useState } from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getProgram, statePda, floorVault, marketVault, solaVaultAddr, toUi } from "@/lib/program";

interface LiqStats {
  floorUsdc:   number;  // backing floor vault
  marketUsdc:  number;  // fee vault (market premium)
  solaLocked:  number;  // SOLA locked in staking vault
  virtualUsdc: number;  // bonding curve virtual reserve
  virtualSola: number;
  totalSola:   number;
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
    ]).then(([state, floor, market, solaVault]) => {
      setS({
        floorUsdc:   (floor.value.uiAmount  ?? 0),
        marketUsdc:  (market.value.uiAmount ?? 0),
        solaLocked:  (solaVault.value.uiAmount ?? 0),
        virtualUsdc: toUi(state.virtualUsdc),
        virtualSola: toUi(state.virtualSola),
        totalSola:   toUi(state.totalSola),
      });
    }).catch(() => {});
  }, [wallet, connection]);

  const tvl = s ? s.floorUsdc + s.marketUsdc : 0;
  const curvePrice = s && s.virtualSola > 0 ? s.virtualUsdc / s.virtualSola : 1;

  return (
    <div className="space-y-6">

      {/* TVL hero */}
      <div className="card glow text-center py-8">
        <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">Protocol TVL</p>
        <p className="text-5xl font-black text-brand-green">
          {s ? `$${tvl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
        </p>
        <p className="text-xs text-gray-500 mt-2">Floor vault + Market vault</p>
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