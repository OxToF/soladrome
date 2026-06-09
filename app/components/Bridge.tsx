// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState } from "react";

// ── Source chains supported by the bribe bridge ──────────────────────────────
const CHAINS = [
  { id: "base",      label: "Base",      logo: "🔵", color: "#0052FF" },
  { id: "arbitrum",  label: "Arbitrum",  logo: "🔵", color: "#12AAFF" },
  { id: "ethereum",  label: "Ethereum",  logo: "⟠",  color: "#627EEA" },
  { id: "optimism",  label: "Optimism",  logo: "🔴", color: "#FF0420" },
];

// ── Placeholder gauges (replaced by on-chain data once live) ─────────────────
const GAUGES = [
  { id: "sola-usdc", label: "SOLA / USDC",  apy: "—" },
  { id: "sola-sol",  label: "SOLA / SOL",   apy: "—" },
  { id: "msol-usdc", label: "mSOL / USDC",  apy: "—" },
];

type BridgeStep = "form" | "confirm" | "pending" | "done";

export function Bridge() {
  const [sourceChain, setSourceChain] = useState(CHAINS[0].id);
  const [gauge,       setGauge]       = useState(GAUGES[0].id);
  const [amount,      setAmount]      = useState("");
  const [step,        setStep]        = useState<BridgeStep>("form");

  const chain = CHAINS.find((c) => c.id === sourceChain)!;
  const selectedGauge = GAUGES.find((g) => g.id === gauge)!;

  return (
    <div className="max-w-lg mx-auto flex flex-col gap-6">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">Cross-Chain Bribe Bridge</h2>
          <p className="text-sm text-gray-400 mt-0.5">
            Inject bribes from any EVM chain directly into Soladrome gauges
          </p>
        </div>
        {/* Coming soon badge */}
        <span className="text-[10px] font-bold uppercase tracking-widest border border-yellow-500/40 text-yellow-400 rounded px-2 py-1">
          Testnet soon
        </span>
      </div>

      {/* ── Powered by ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 text-xs text-gray-500">
        <span>Powered by</span>
        <span className="flex items-center gap-1 border border-brand-border rounded px-2 py-1 text-gray-400">
          {/* LayerZero logo placeholder */}
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="10" fillOpacity="0.2"/>
            <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 18c-4.418 0-8-3.582-8-8s3.582-8 8-8 8 3.582 8 8-3.582 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/>
          </svg>
          LayerZero V2
        </span>
        <span className="flex items-center gap-1 border border-brand-border rounded px-2 py-1 text-gray-400">
          ⚡ Astralane
        </span>
      </div>

      {/* ── Main card ──────────────────────────────────────────────────── */}
      <div className="bg-brand-card border border-brand-border rounded-2xl p-5 flex flex-col gap-5">

        {/* Source chain */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Source Chain
          </label>
          <div className="grid grid-cols-4 gap-2">
            {CHAINS.map((c) => (
              <button
                key={c.id}
                onClick={() => setSourceChain(c.id)}
                className={`flex flex-col items-center gap-1 py-3 rounded-xl border text-xs font-medium transition-all ${
                  sourceChain === c.id
                    ? "border-brand-green bg-brand-green/10 text-brand-green"
                    : "border-brand-border text-gray-400 hover:border-gray-500 hover:text-white"
                }`}
              >
                <span className="text-lg">{c.logo}</span>
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* Arrow */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-brand-border" />
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className="text-brand-green">↓</span>
            Solana · Soladrome
          </div>
          <div className="flex-1 h-px bg-brand-border" />
        </div>

        {/* Target gauge */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Target Gauge
          </label>
          <select
            value={gauge}
            onChange={(e) => setGauge(e.target.value)}
            className="w-full bg-brand-dark border border-brand-border rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-brand-green transition-colors"
          >
            {GAUGES.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </div>

        {/* Bribe token + amount */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Bribe Amount
          </label>
          <div className="flex gap-2">
            <div className="flex items-center gap-2 bg-brand-dark border border-brand-border rounded-xl px-3 py-3 text-sm text-gray-400 shrink-0">
              <span>USDC</span>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
            <input
              type="number"
              min="0"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="flex-1 bg-brand-dark border border-brand-border rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-brand-green transition-colors placeholder-gray-600"
            />
          </div>
        </div>

        {/* Summary */}
        {amount && parseFloat(amount) > 0 && (
          <div className="bg-brand-dark rounded-xl p-4 flex flex-col gap-2 text-sm border border-brand-border">
            <div className="flex justify-between text-gray-400">
              <span>From</span>
              <span className="text-white font-medium">{chain.label} → {selectedGauge.label}</span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>Bridge fee</span>
              <span className="text-white">~$0.10 (LayerZero)</span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>Execution</span>
              <span className="text-brand-green font-medium">⚡ Sub-slot · Astralane</span>
            </div>
            <div className="h-px bg-brand-border" />
            <div className="flex justify-between font-semibold">
              <span className="text-gray-400">Total bribe</span>
              <span className="text-brand-green">{parseFloat(amount).toLocaleString()} USDC</span>
            </div>
          </div>
        )}

        {/* CTA */}
        <button
          disabled
          className="w-full py-3 rounded-xl font-bold text-sm bg-brand-green/20 text-brand-green/50 border border-brand-green/20 cursor-not-allowed transition-all"
          title="Integration coming soon — pending Astralane API"
        >
          Bridge Bribe →
          <span className="ml-2 text-xs font-normal opacity-60">(Integration in progress)</span>
        </button>
      </div>

      {/* ── Info box ───────────────────────────────────────────────────── */}
      <div className="bg-brand-card border border-brand-border rounded-xl p-4 flex gap-3 text-sm text-gray-400">
        <span className="text-brand-green mt-0.5 shrink-0">ℹ</span>
        <p>
          Bribes sent via this bridge are locked into the selected gauge for the current epoch.
          Voters receive rewards at epoch end. Execution is handled by{" "}
          <span className="text-white">Astralane sub-slot middleware</span> for near-instant
          settlement on Solana.
        </p>
      </div>

    </div>
  );
}
