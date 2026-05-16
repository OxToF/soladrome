// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  getProgram, statePda, solaM, hiSolaM, oSolaM,
  positionPda, userAta, toUi,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";

interface PortfolioData {
  solaBalance:   number;
  hiSolaBalance: number;
  oSolaBalance:  number;
  debt:          number;   // UserPosition.usdcBorrowed
  marketPrice:   number;   // virtualUsdc / virtualSola
}

export function Portfolio() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();

  const [data, setData] = useState<PortfolioData | null>(null);

  const load = useCallback(async () => {
    if (!wallet || !usdcMint) return;
    const provider = new AnchorProvider(connection, wallet, {});
    const program  = getProgram(provider);

    const [solaRes, hiSolaRes, oSolaRes, posRes, stateRes] = await Promise.allSettled([
      connection.getTokenAccountBalance(userAta(solaM,   wallet.publicKey)),
      connection.getTokenAccountBalance(userAta(hiSolaM, wallet.publicKey)),
      connection.getTokenAccountBalance(userAta(oSolaM,  wallet.publicKey)),
      (program.account as any).userPosition.fetch(positionPda(wallet.publicKey)),
      (program.account as any).protocolState.fetch(statePda),
    ]);

    const solaBalance   = solaRes.status   === "fulfilled" ? (solaRes.value.value.uiAmount   ?? 0) : 0;
    const hiSolaBalance = hiSolaRes.status === "fulfilled" ? (hiSolaRes.value.value.uiAmount ?? 0) : 0;
    const oSolaBalance  = oSolaRes.status  === "fulfilled" ? (oSolaRes.value.value.uiAmount  ?? 0) : 0;

    // UserPosition only has: owner, usdcBorrowed, feesDebt, bump
    let debt = 0;
    if (posRes.status === "fulfilled" && posRes.value?.usdcBorrowed) {
      debt = toUi(posRes.value.usdcBorrowed as BN);
    }

    let marketPrice = 1;
    if (stateRes.status === "fulfilled" && stateRes.value) {
      const s = stateRes.value as any;
      const vUsdc = s.virtualUsdc ? toUi(s.virtualUsdc as BN) : 0;
      const vSola = s.virtualSola ? toUi(s.virtualSola as BN) : 0;
      if (vSola > 0) marketPrice = vUsdc / vSola;
    }

    setData({ solaBalance, hiSolaBalance, oSolaBalance, debt, marketPrice });
  }, [connection, wallet, usdcMint]);

  useEffect(() => { load(); }, [load]);

  const totalValue = data
    ? (data.solaBalance + data.hiSolaBalance) * data.marketPrice
      + data.oSolaBalance       // oSOLA floor value ≈ $1
      - data.debt
    : null;

  return (
    <div className="card space-y-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <p className="text-base font-bold text-white">Portfolio</p>
        <p className="text-lg font-black text-brand-green">
          {totalValue !== null
            ? `$${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : "—"}
        </p>
      </div>

      {/* hiSOLA row */}
      <div className="flex items-start justify-between py-3 border-b border-brand-border/60">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-white">hiSOLA</p>
          <p className="text-xs text-gray-500">
            Voting Power{" "}
            <span className="text-gray-300">
              {data ? data.hiSolaBalance.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
            </span>
          </p>
          <p className="text-xs text-gray-500">
            Crédit dispo{" "}
            <span className="text-gray-300">
              {data
                ? `${Math.max(0, data.hiSolaBalance - data.debt).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`
                : "—"}
            </span>
          </p>
          {(data?.debt ?? 0) > 0 && (
            <p className="text-xs text-red-400">
              Debt {data!.debt.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="font-bold text-white text-sm">
            {data ? data.hiSolaBalance.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}
          </p>
          <p className="text-xs text-gray-600">
            ≈ ${data
              ? (data.hiSolaBalance * data.marketPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })
              : "0"}
          </p>
        </div>
      </div>

      {/* oSOLA row */}
      <div className="flex items-start justify-between py-3 border-b border-brand-border/60">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-white">oSOLA</p>
          <p className="text-xs text-gray-500">LP Rewards</p>
        </div>
        <div className="text-right">
          <p className="font-bold text-white text-sm">
            {data ? data.oSolaBalance.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}
          </p>
          <p className="text-xs text-gray-600">
            ≈ ${data ? data.oSolaBalance.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "0"}
          </p>
        </div>
      </div>

      {/* SOLA row */}
      <div className="flex items-start justify-between py-3 border-b border-brand-border/60">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-white">SOLA</p>
          <p className="text-xs text-gray-500">Wallet balance</p>
        </div>
        <div className="text-right">
          <p className="font-bold text-white text-sm">
            {data ? data.solaBalance.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}
          </p>
          <p className="text-xs text-gray-600">
            ≈ ${data
              ? (data.solaBalance * data.marketPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })
              : "0"}
          </p>
        </div>
      </div>

      {/* CTAs */}
      <div className="pt-4 space-y-3">
        <button
          className="btn-primary w-full text-sm"
          onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "claim" }))}
        >
          Claim Fees
        </button>
        <button
          className="btn-secondary w-full text-sm"
          onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "pools" }))}
        >
          Pools &amp; LP Rewards →
        </button>
      </div>
    </div>
  );
}
