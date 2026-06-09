// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState } from "react";

// ── All chains (EVM + Solana) ─────────────────────────────────────────────────
const EVM_CHAINS = [
  { id: "base",     label: "Base",     color: "#0052FF" },
  { id: "arbitrum", label: "Arbitrum", color: "#12AAFF" },
  { id: "ethereum", label: "Ethereum", color: "#627EEA" },
  { id: "optimism", label: "Optimism", color: "#FF0420" },
] as const;
type EvmChainId = typeof EVM_CHAINS[number]["id"];

// ── EVM tokens per chain ──────────────────────────────────────────────────────
const EVM_TOKENS: Record<EvmChainId, { id: string; label: string; icon: string }[]> = {
  base:     [
    { id: "usdc",  label: "USDC",  icon: "💵" },
    { id: "fbomb", label: "fBOMB", icon: "💣" },
    { id: "aero",  label: "AERO",  icon: "✈️" },
    { id: "eth",   label: "ETH",   icon: "⟠"  },
    { id: "cbeth", label: "cbETH", icon: "⟠"  },
    { id: "cbbtc", label: "cbBTC", icon: "₿"  },
  ],
  arbitrum: [
    { id: "usdc",  label: "USDC",  icon: "💵" },
    { id: "eth",   label: "ETH",   icon: "⟠"  },
  ],
  ethereum: [
    { id: "usdc",  label: "USDC",  icon: "💵" },
    { id: "eth",   label: "ETH",   icon: "⟠"  },
    { id: "cbeth", label: "cbETH", icon: "⟠"  },
    { id: "cbbtc", label: "cbBTC", icon: "₿"  },
  ],
  optimism: [
    { id: "usdc",  label: "USDC",  icon: "💵" },
    { id: "velo",  label: "VELO",  icon: "🚀" },
    { id: "eth",   label: "ETH",   icon: "⟠"  },
  ],
};

// ── Solana tokens (when bridging FROM Solana) ─────────────────────────────────
const SOLANA_TOKENS = [
  { id: "sola",   label: "SOLA",   icon: "◎" },
  { id: "sol",    label: "SOL",    icon: "◎" },
  { id: "msol",   label: "mSOL",   icon: "🌊" },
  { id: "hisola", label: "hiSOLA", icon: "🔒" },
  { id: "usdc",   label: "USDC",   icon: "💵" },
];

// ── Soladrome gauges ──────────────────────────────────────────────────────────
const GAUGES = [
  { id: "sola-usdc",  label: "SOLA / USDC"  },
  { id: "sola-sol",   label: "SOLA / SOL"   },
  { id: "sola-msol",  label: "SOLA / mSOL"  },
  { id: "sola-eth",   label: "SOLA / ETH"   },
  { id: "sola-btc",   label: "SOLA / cbBTC" },
  { id: "msol-usdc",  label: "mSOL / USDC"  },
];

// ── EVM protocols as bribe destinations ───────────────────────────────────────
const EVM_PROTOCOLS: Record<EvmChainId, { id: string; label: string }[]> = {
  base:     [{ id: "aerodrome",  label: "Aerodrome (Base)"    }],
  arbitrum: [{ id: "camelot",    label: "Camelot (Arbitrum)"  },
             { id: "ramses",     label: "Ramses (Arbitrum)"   }],
  ethereum: [{ id: "balancer",   label: "Balancer (Ethereum)" }],
  optimism: [{ id: "velodrome",  label: "Velodrome (Optimism)"}],
};

// ── Chain logo SVGs ───────────────────────────────────────────────────────────
function ChainLogo({ id }: { id: EvmChainId | "solana" }) {
  if (id === "solana") return (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
      <circle cx="12" cy="12" r="12" fill="#9945FF"/>
      <path fill="#fff" d="M7 15.5h8.5l1.5-1.5H8.5L7 15.5zm0-4h10l1.5-1.5H8.5L7 11.5zm2-4h8.5L16 6H9L7.5 7.5z"/>
    </svg>
  );
  if (id === "base") return (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#0052FF">
      <circle cx="12" cy="12" r="12"/>
      <path fill="#fff" d="M12 5.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm0 11a4.5 4.5 0 110-9 4.5 4.5 0 010 9z"/>
    </svg>
  );
  if (id === "arbitrum") return (
    <svg viewBox="0 0 24 24" className="w-5 h-5">
      <circle cx="12" cy="12" r="12" fill="#12AAFF"/>
      <path fill="#fff" d="M12 4L6 8v8l6 4 6-4V8l-6-4zm0 2.2l4.5 3-4.5 7.5L7.5 9.2l4.5-3z"/>
    </svg>
  );
  if (id === "ethereum") return (
    <svg viewBox="0 0 24 24" className="w-5 h-5">
      <circle cx="12" cy="12" r="12" fill="#627EEA"/>
      <path fill="rgba(255,255,255,.6)" d="M12 4v6.5l5.5 2.5L12 4z"/>
      <path fill="#fff" d="M12 4L6.5 13l5.5-2.5V4z"/>
      <path fill="rgba(255,255,255,.6)" d="M12 16.5v3.5l5.5-7.5L12 16.5z"/>
      <path fill="#fff" d="M12 20v-3.5l-5.5-4L12 20z"/>
    </svg>
  );
  return (
    <svg viewBox="0 0 24 24" className="w-5 h-5">
      <circle cx="12" cy="12" r="12" fill="#FF0420"/>
      <path fill="#fff" d="M8 9.5c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2v5c0 1.1-.9 2-2 2h-4c-1.1 0-2-.9-2-2v-5z"/>
    </svg>
  );
}

// ── Direction toggle ──────────────────────────────────────────────────────────
type Direction = "evm-to-sol" | "sol-to-evm";

export function Bridge() {
  const [direction,   setDirection]   = useState<Direction>("evm-to-sol");
  const [evmChain,    setEvmChain]    = useState<EvmChainId>("base");
  const [evmToken,    setEvmToken]    = useState("usdc");
  const [solToken,    setSolToken]    = useState("sola");
  const [gauge,       setGauge]       = useState(GAUGES[0].id);
  const [evmProtocol, setEvmProtocol] = useState("aerodrome");
  const [amount,      setAmount]      = useState("");
  const [showTokens,  setShowTokens]  = useState(false);
  const [showModal,   setShowModal]   = useState(false);

  const handleEvmChain = (id: EvmChainId) => {
    setEvmChain(id);
    setEvmToken(EVM_TOKENS[id][0].id);
    setEvmProtocol(EVM_PROTOCOLS[id][0].id);
  };

  const evmTokens        = EVM_TOKENS[evmChain];
  const selectedEvmToken = evmTokens.find(t => t.id === evmToken) ?? evmTokens[0];
  const selectedSolToken = SOLANA_TOKENS.find(t => t.id === solToken)!;
  const selectedGauge    = GAUGES.find(g => g.id === gauge)!;
  const protocols        = EVM_PROTOCOLS[evmChain];
  const selectedProtocol = protocols.find(p => p.id === evmProtocol) ?? protocols[0];

  const activeToken = direction === "evm-to-sol" ? selectedEvmToken : selectedSolToken;
  const hasAmount   = !!amount && parseFloat(amount) > 0;

  const sourceLabel = direction === "evm-to-sol"
    ? EVM_CHAINS.find(c => c.id === evmChain)!.label
    : "Solana";
  const destLabel = direction === "evm-to-sol"
    ? "Soladrome · " + selectedGauge.label
    : selectedProtocol.label;

  return (
    <div className="max-w-lg mx-auto flex flex-col gap-5">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight">Cross-Chain Bribe Bridge</h2>
          <p className="text-sm text-brand-muted mt-0.5">Bidirectional — EVM ↔ Solana</p>
        </div>
        <span className="badge-yellow shrink-0 mt-0.5">Mainnet soon</span>
      </div>

      {/* Powered by */}
      <div className="flex items-center gap-2 text-xs text-brand-muted">
        <span>Powered by</span>
        <span className="badge-muted">
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="10" fillOpacity="0.3"/>
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>
          </svg>
          LayerZero V2
        </span>
        <span className="badge-muted">⚡ Astralane</span>
      </div>

      {/* ── Direction toggle ────────────────────────────────────────────── */}
      <div className="flex rounded-xl border border-brand-border overflow-hidden">
        <button
          onClick={() => setDirection("evm-to-sol")}
          className={`flex-1 py-2.5 text-sm font-medium transition-all duration-150 ${
            direction === "evm-to-sol"
              ? "bg-brand-green/10 text-brand-green"
              : "text-brand-muted hover:text-white hover:bg-white/4"
          }`}
        >
          EVM → Soladrome
        </button>
        <div className="w-px bg-brand-border" />
        <button
          onClick={() => setDirection("sol-to-evm")}
          className={`flex-1 py-2.5 text-sm font-medium transition-all duration-150 ${
            direction === "sol-to-evm"
              ? "bg-brand-green/10 text-brand-green"
              : "text-brand-muted hover:text-white hover:bg-white/4"
          }`}
        >
          Solana → EVM
        </button>
      </div>

      {/* ── Card ─────────────────────────────────────────────────────────── */}
      <div className="card glow flex flex-col gap-5">

        {/* === EVM → Soladrome === */}
        {direction === "evm-to-sol" && (<>
          <div className="flex flex-col gap-2">
            <label className="stat-label">Source Chain</label>
            <div className="grid grid-cols-4 gap-2">
              {EVM_CHAINS.map((c) => (
                <button key={c.id} onClick={() => handleEvmChain(c.id)}
                  className={`flex flex-col items-center gap-1.5 py-3 rounded-xl border text-xs font-medium transition-all duration-150 ${
                    evmChain === c.id
                      ? "border-brand-green bg-brand-green/8 text-brand-green"
                      : "border-brand-border text-brand-muted hover:border-white/20 hover:text-white"
                  }`}>
                  <ChainLogo id={c.id} />
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-brand-border" />
            <span className="text-xs text-brand-muted flex items-center gap-1.5">
              <span className="text-brand-green">↓</span> Solana · Soladrome
            </span>
            <div className="flex-1 h-px bg-brand-border" />
          </div>

          <div className="flex flex-col gap-2">
            <label className="stat-label">Target Gauge</label>
            <select value={gauge} onChange={e => setGauge(e.target.value)} className="input">
              {GAUGES.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
            </select>
          </div>
        </>)}

        {/* === Solana → EVM === */}
        {direction === "sol-to-evm" && (<>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3 p-3 rounded-xl border border-brand-border bg-brand-dark/60">
              <ChainLogo id="solana" />
              <div>
                <p className="text-sm font-semibold text-white">Solana</p>
                <p className="text-xs text-brand-muted">Source chain</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-brand-border" />
            <span className="text-xs text-brand-muted flex items-center gap-1.5">
              <span className="text-brand-green">↓</span> EVM destination
            </span>
            <div className="flex-1 h-px bg-brand-border" />
          </div>

          <div className="flex flex-col gap-2">
            <label className="stat-label">Destination Chain</label>
            <div className="grid grid-cols-4 gap-2">
              {EVM_CHAINS.map((c) => (
                <button key={c.id} onClick={() => handleEvmChain(c.id)}
                  className={`flex flex-col items-center gap-1.5 py-3 rounded-xl border text-xs font-medium transition-all duration-150 ${
                    evmChain === c.id
                      ? "border-brand-green bg-brand-green/8 text-brand-green"
                      : "border-brand-border text-brand-muted hover:border-white/20 hover:text-white"
                  }`}>
                  <ChainLogo id={c.id} />
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label className="stat-label">Target Protocol</label>
            <select value={evmProtocol} onChange={e => setEvmProtocol(e.target.value)} className="input">
              {protocols.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
        </>)}

        {/* ── Token + Amount (shared) ─────────────────────────────────── */}
        <div className="flex flex-col gap-2">
          <label className="stat-label">Bribe Token & Amount</label>
          <div className="flex gap-2">
            <div className="relative">
              <button onClick={() => setShowTokens(!showTokens)}
                className="flex items-center gap-2 h-full px-3 py-2.5 rounded-xl border border-brand-border bg-brand-dark text-sm text-white hover:border-white/20 transition-all duration-150 shrink-0">
                <span>{activeToken.icon}</span>
                <span className="font-medium">{activeToken.label}</span>
                <svg className={`w-3 h-3 text-brand-muted transition-transform ${showTokens ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
                </svg>
              </button>
              {showTokens && (
                <div className="absolute top-full left-0 mt-1 z-20 bg-brand-elevated border border-brand-border rounded-xl shadow-card-hover min-w-[140px] overflow-hidden">
                  {(direction === "evm-to-sol" ? evmTokens : SOLANA_TOKENS).map(t => (
                    <button key={t.id}
                      onClick={() => {
                        direction === "evm-to-sol" ? setEvmToken(t.id) : setSolToken(t.id);
                        setShowTokens(false);
                      }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm transition-colors hover:bg-white/5 ${
                        activeToken.id === t.id ? "text-brand-green bg-brand-green/8" : "text-white"
                      }`}>
                      <span>{t.icon}</span>
                      <span className="font-medium">{t.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input type="number" min="0" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)} className="input flex-1" />
          </div>
        </div>

        {/* Summary */}
        {hasAmount && (
          <div className="rounded-xl border border-brand-border bg-brand-dark/60 p-4 flex flex-col gap-2.5 text-sm">
            <div className="flex justify-between">
              <span className="text-brand-muted">Route</span>
              <span className="text-white font-medium">{sourceLabel} → {destLabel}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-brand-muted">Token</span>
              <span className="text-white">{activeToken.icon} {activeToken.label}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-brand-muted">Bridge fee</span>
              <span className="text-white">~$0.10 (LayerZero)</span>
            </div>
            <div className="flex justify-between">
              <span className="text-brand-muted">Execution</span>
              <span className="text-brand-green font-medium">⚡ Sub-slot · Astralane</span>
            </div>
            <div className="h-px bg-brand-border" />
            <div className="flex justify-between font-semibold">
              <span className="text-brand-muted">Total bribe</span>
              <span className="text-brand-green">{parseFloat(amount).toLocaleString()} {activeToken.label}</span>
            </div>
          </div>
        )}

        {/* CTA */}
        <button
          onClick={() => hasAmount && setShowModal(true)}
          className={`w-full py-3 rounded-xl font-semibold text-sm transition-all duration-200 ${
            hasAmount
              ? "btn-primary justify-center"
              : "bg-brand-green/10 text-brand-green/40 border border-brand-green/10 cursor-not-allowed"
          }`}
        >
          Bridge Bribe →
        </button>
      </div>

      {/* Info */}
      <div className="card-flat flex gap-3 text-sm text-brand-muted">
        <span className="text-brand-green shrink-0 mt-0.5">ℹ</span>
        <p>
          {direction === "evm-to-sol"
            ? <>Bribes are locked into the selected Soladrome gauge for the current epoch. Voters receive rewards at epoch end. Execution via <span className="text-white font-medium">Astralane sub-slot middleware</span> for near-instant Solana settlement.</>
            : <>Bridge SOLA or SOL to EVM protocols to expand liquidity and visibility. Your tokens are wrapped via LayerZero and deposited as bribes on the destination protocol.</>
          }
        </p>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setShowModal(false)}>
          <div className="card max-w-sm w-full flex flex-col gap-4 text-center shadow-glow-lg"
            onClick={e => e.stopPropagation()}>
            <div className="text-3xl">🌉</div>
            <h3 className="text-lg font-bold text-white">Mainnet Launch Soon</h3>
            <p className="text-sm text-brand-muted leading-relaxed">
              The bridge is live on testnet. Mainnet activation pending final audit and Astralane integration sign-off.
            </p>
            <div className="rounded-xl border border-brand-border bg-brand-dark/60 p-3 text-left text-sm flex flex-col gap-1.5">
              <div className="flex justify-between">
                <span className="text-brand-muted">Bribe</span>
                <span className="text-white font-medium">{amount} {activeToken.label}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-brand-muted">Route</span>
                <span className="text-white">{sourceLabel} → {destLabel}</span>
              </div>
            </div>
            <button onClick={() => setShowModal(false)} className="btn-secondary w-full justify-center">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
