// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState } from "react";

// ── LP Pairs — exist on multiple protocols ────────────────────────────────────
const LP_PAIRS = [
  {
    id: "sola-fbomb", label: "SOLA / fBOMB", icon: "◎💣",
    bribeTokens: [
      { id: "fbomb", label: "fBOMB", icon: "💣" },
      { id: "sola",  label: "SOLA",  icon: "◎"  },
      { id: "usdc",  label: "USDC",  icon: "💵" },
    ],
    protocols: [
      { id: "soladrome", label: "Soladrome", chain: "solana",   chainLabel: "Solana",   color: "#9945FF" },
      { id: "aerodrome", label: "Aerodrome", chain: "base",     chainLabel: "Base",     color: "#0052FF" },
    ],
  },
  {
    id: "sola-aero", label: "SOLA / AERO", icon: "◎✈️",
    bribeTokens: [
      { id: "aero", label: "AERO", icon: "✈️" },
      { id: "sola", label: "SOLA", icon: "◎"  },
      { id: "usdc", label: "USDC", icon: "💵" },
    ],
    protocols: [
      { id: "soladrome", label: "Soladrome", chain: "solana", chainLabel: "Solana", color: "#9945FF" },
      { id: "aerodrome", label: "Aerodrome", chain: "base",   chainLabel: "Base",   color: "#0052FF" },
    ],
  },
  {
    id: "sola-velo", label: "SOLA / VELO", icon: "◎🚀",
    bribeTokens: [
      { id: "velo", label: "VELO", icon: "🚀" },
      { id: "sola", label: "SOLA", icon: "◎"  },
      { id: "usdc", label: "USDC", icon: "💵" },
    ],
    protocols: [
      { id: "soladrome", label: "Soladrome", chain: "solana",   chainLabel: "Solana",   color: "#9945FF" },
      { id: "velodrome", label: "Velodrome", chain: "optimism", chainLabel: "Optimism", color: "#FF0420" },
    ],
  },
  {
    id: "fbomb-aero", label: "fBOMB / AERO", icon: "💣✈️",
    bribeTokens: [
      { id: "fbomb", label: "fBOMB", icon: "💣" },
      { id: "aero",  label: "AERO",  icon: "✈️" },
      { id: "usdc",  label: "USDC",  icon: "💵" },
    ],
    protocols: [
      { id: "soladrome", label: "Soladrome", chain: "solana", chainLabel: "Solana", color: "#9945FF" },
      { id: "aerodrome", label: "Aerodrome", chain: "base",   chainLabel: "Base",   color: "#0052FF" },
    ],
  },
  {
    id: "fbomb-velo", label: "fBOMB / VELO", icon: "💣🚀",
    bribeTokens: [
      { id: "fbomb", label: "fBOMB", icon: "💣" },
      { id: "velo",  label: "VELO",  icon: "🚀" },
      { id: "usdc",  label: "USDC",  icon: "💵" },
    ],
    protocols: [
      { id: "soladrome", label: "Soladrome", chain: "solana",   chainLabel: "Solana",   color: "#9945FF" },
      { id: "velodrome", label: "Velodrome", chain: "optimism", chainLabel: "Optimism", color: "#FF0420" },
    ],
  },
  // Soladrome native
  {
    id: "sola-usdc", label: "SOLA / USDC", icon: "◎💵",
    bribeTokens: [
      { id: "usdc", label: "USDC", icon: "💵" },
      { id: "sola", label: "SOLA", icon: "◎"  },
    ],
    protocols: [
      { id: "soladrome", label: "Soladrome", chain: "solana", chainLabel: "Solana", color: "#9945FF" },
    ],
  },
  {
    id: "sola-sol", label: "SOLA / SOL", icon: "◎◎",
    bribeTokens: [
      { id: "usdc", label: "USDC", icon: "💵" },
      { id: "sola", label: "SOLA", icon: "◎"  },
    ],
    protocols: [
      { id: "soladrome", label: "Soladrome", chain: "solana", chainLabel: "Solana", color: "#9945FF" },
    ],
  },
  {
    id: "msol-usdc", label: "mSOL / USDC", icon: "🌊💵",
    bribeTokens: [
      { id: "usdc", label: "USDC", icon: "💵" },
      { id: "msol", label: "mSOL", icon: "🌊" },
    ],
    protocols: [
      { id: "soladrome", label: "Soladrome", chain: "solana", chainLabel: "Solana", color: "#9945FF" },
    ],
  },
] as const;

type LpId       = typeof LP_PAIRS[number]["id"];
type BribeToken = { id: string; label: string; icon: string };
type Protocol   = { id: string; label: string; chain: string; chainLabel: string; color: string };

// ── Chain logo ────────────────────────────────────────────────────────────────
function ChainDot({ color }: { color: string }) {
  return <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />;
}

function ProtocolLogo({ chain }: { chain: string }) {
  if (chain === "solana") return (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
      <circle cx="12" cy="12" r="12" fill="#9945FF"/>
      <path fill="#fff" d="M7 15.5h8.5l1.5-1.5H8.5L7 15.5zm0-4h10l1.5-1.5H8.5L7 11.5zm2-4h8.5L16 6H9L7.5 7.5z"/>
    </svg>
  );
  if (chain === "base") return (
    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#0052FF">
      <circle cx="12" cy="12" r="12"/>
      <path fill="#fff" d="M12 5.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm0 11a4.5 4.5 0 110-9 4.5 4.5 0 010 9z"/>
    </svg>
  );
  if (chain === "optimism") return (
    <svg viewBox="0 0 24 24" className="w-5 h-5">
      <circle cx="12" cy="12" r="12" fill="#FF0420"/>
      <path fill="#fff" d="M8 9.5c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2v5c0 1.1-.9 2-2 2h-4c-1.1 0-2-.9-2-2v-5z"/>
    </svg>
  );
  return (
    <svg viewBox="0 0 24 24" className="w-5 h-5">
      <circle cx="12" cy="12" r="12" fill="#627EEA"/>
      <path fill="rgba(255,255,255,.6)" d="M12 4v6.5l5.5 2.5L12 4z"/>
      <path fill="#fff" d="M12 4L6.5 13l5.5-2.5V4z"/>
    </svg>
  );
}

// ── Bridge route label ────────────────────────────────────────────────────────
function routeLabel(srcChain: string, dstChain: string): string {
  if (srcChain === dstChain) return "On-chain (no bridge needed)";
  return `${srcChain.charAt(0).toUpperCase() + srcChain.slice(1)} → ${dstChain.charAt(0).toUpperCase() + dstChain.slice(1)} via LayerZero V2`;
}

// ─────────────────────────────────────────────────────────────────────────────
export function Bridge() {
  const [lpId,       setLpId]       = useState<LpId>("sola-fbomb");
  const [protocolId, setProtocolId] = useState<string>("soladrome");
  const [tokenId,    setTokenId]    = useState<string>("fbomb");
  const [amount,     setAmount]     = useState("");
  const [showTokens, setShowTokens] = useState(false);
  const [showModal,  setShowModal]  = useState(false);

  const lp         = LP_PAIRS.find(p => p.id === lpId)!;
  const protocol   = (lp.protocols as readonly Protocol[]).find(p => p.id === protocolId)
                     ?? lp.protocols[0];
  const token      = (lp.bribeTokens as readonly BribeToken[]).find(t => t.id === tokenId)
                     ?? lp.bribeTokens[0];
  const hasAmount  = !!amount && parseFloat(amount) > 0;

  // When LP changes, reset protocol + token
  const handleLpChange = (id: LpId) => {
    const newLp = LP_PAIRS.find(p => p.id === id)!;
    setLpId(id);
    setProtocolId(newLp.protocols[0].id);
    setTokenId(newLp.bribeTokens[0].id);
  };

  // Determine bridge route: user is "on Solana" by default
  // If destination is EVM → bridge needed. If Soladrome → no bridge.
  const needsBridge   = protocol.chain !== "solana";
  const userChain     = needsBridge ? "solana" : protocol.chain;
  const route         = routeLabel(userChain, protocol.chain);

  return (
    <div className="max-w-lg mx-auto flex flex-col gap-5">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight">Cross-Chain Bribe Bridge</h2>
          <p className="text-sm text-brand-muted mt-0.5">
            Bribe any LP on Soladrome or EVM protocols — bidirectional
          </p>
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

      <div className="card glow flex flex-col gap-6">

        {/* ── Step 1 : LP Pair ──────────────────────────────────────────── */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-brand-green/15 text-brand-green text-xs font-bold flex items-center justify-center shrink-0">1</span>
            <label className="stat-label">Select LP Pair</label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {LP_PAIRS.map(p => (
              <button
                key={p.id}
                onClick={() => handleLpChange(p.id)}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all duration-150 text-left ${
                  lpId === p.id
                    ? "border-brand-green bg-brand-green/8 text-brand-green"
                    : "border-brand-border text-brand-muted hover:border-white/20 hover:text-white"
                }`}
              >
                <span className="text-base shrink-0">{p.icon.slice(0, 2)}</span>
                <span className="truncate">{p.label}</span>
                {(p.protocols as readonly Protocol[]).length > 1 && (
                  <span className="ml-auto text-[10px] font-bold text-brand-muted shrink-0">×{p.protocols.length}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="h-px bg-brand-border" />

        {/* ── Step 2 : Protocol ────────────────────────────────────────── */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-brand-green/15 text-brand-green text-xs font-bold flex items-center justify-center shrink-0">2</span>
            <label className="stat-label">Target Protocol</label>
          </div>
          <div className="flex flex-col gap-2">
            {(lp.protocols as readonly Protocol[]).map(p => (
              <button
                key={p.id}
                onClick={() => setProtocolId(p.id)}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-all duration-150 ${
                  protocolId === p.id
                    ? "border-brand-green bg-brand-green/8"
                    : "border-brand-border hover:border-white/20"
                }`}
              >
                <ProtocolLogo chain={p.chain} />
                <div className="flex flex-col items-start">
                  <span className={`text-sm font-semibold ${protocolId === p.id ? "text-brand-green" : "text-white"}`}>
                    {p.label}
                  </span>
                  <span className="text-xs text-brand-muted flex items-center gap-1.5">
                    <ChainDot color={p.color} />
                    {p.chainLabel}
                    {p.chain !== "solana" && (
                      <span className="text-yellow-500/70 ml-1">· bridge required</span>
                    )}
                  </span>
                </div>
                {protocolId === p.id && (
                  <span className="ml-auto text-brand-green text-lg">✓</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="h-px bg-brand-border" />

        {/* ── Step 3 : Token + Amount ───────────────────────────────────── */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-brand-green/15 text-brand-green text-xs font-bold flex items-center justify-center shrink-0">3</span>
            <label className="stat-label">Bribe Token & Amount</label>
          </div>
          <div className="flex gap-2">
            <div className="relative">
              <button
                onClick={() => setShowTokens(!showTokens)}
                className="flex items-center gap-2 h-full px-3 py-2.5 rounded-xl border border-brand-border bg-brand-dark text-sm text-white hover:border-white/20 transition-all duration-150 shrink-0"
              >
                <span>{token.icon}</span>
                <span className="font-medium">{token.label}</span>
                <svg className={`w-3 h-3 text-brand-muted transition-transform duration-150 ${showTokens ? "rotate-180" : ""}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
                </svg>
              </button>
              {showTokens && (
                <div className="absolute top-full left-0 mt-1 z-20 bg-brand-elevated border border-brand-border rounded-xl shadow-card-hover min-w-[140px] overflow-hidden">
                  {(lp.bribeTokens as readonly BribeToken[]).map(t => (
                    <button key={t.id}
                      onClick={() => { setTokenId(t.id); setShowTokens(false); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm transition-colors hover:bg-white/5 ${
                        tokenId === t.id ? "text-brand-green bg-brand-green/8" : "text-white"
                      }`}
                    >
                      <span>{t.icon}</span>
                      <span className="font-medium">{t.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input
              type="number" min="0" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)}
              className="input flex-1"
            />
          </div>
        </div>

        {/* ── Summary ──────────────────────────────────────────────────── */}
        {hasAmount && (
          <div className="rounded-xl border border-brand-border bg-brand-dark/60 p-4 flex flex-col gap-2.5 text-sm">
            <div className="flex justify-between">
              <span className="text-brand-muted">LP</span>
              <span className="text-white font-medium">{lp.label}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-brand-muted">Protocol</span>
              <span className="text-white flex items-center gap-1.5">
                <ChainDot color={protocol.color} />
                {protocol.label} · {protocol.chainLabel}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-brand-muted">Route</span>
              <span className={needsBridge ? "text-yellow-400" : "text-brand-green"}>
                {needsBridge ? "⚡ " + route : "✓ " + route}
              </span>
            </div>
            {needsBridge && (
              <div className="flex justify-between">
                <span className="text-brand-muted">Bridge fee</span>
                <span className="text-white">~$0.10 (LayerZero)</span>
              </div>
            )}
            {needsBridge && (
              <div className="flex justify-between">
                <span className="text-brand-muted">Execution</span>
                <span className="text-brand-green font-medium">⚡ Sub-slot · Astralane</span>
              </div>
            )}
            <div className="h-px bg-brand-border" />
            <div className="flex justify-between font-semibold">
              <span className="text-brand-muted">Total bribe</span>
              <span className="text-brand-green">
                {parseFloat(amount).toLocaleString()} {token.label}
              </span>
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
          {needsBridge ? "Bridge & Bribe →" : "Bribe →"}
        </button>
      </div>

      {/* Info */}
      <div className="card-flat flex gap-3 text-sm text-brand-muted">
        <span className="text-brand-green shrink-0 mt-0.5">ℹ</span>
        <p>
          Each LP pair exists on <span className="text-white font-medium">Soladrome (Solana)</span> and
          its native EVM protocol. Bribe either side — voters on that protocol direct emissions
          to the pair. Cross-chain bribes route via{" "}
          <span className="text-white font-medium">LayerZero V2 + Astralane</span>.
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
              Bridge deployed on testnet. Mainnet pending final audit + Astralane sign-off.
            </p>
            <div className="rounded-xl border border-brand-border bg-brand-dark/60 p-3 text-left text-sm flex flex-col gap-2">
              <div className="flex justify-between">
                <span className="text-brand-muted">LP</span>
                <span className="text-white font-medium">{lp.label}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-brand-muted">Protocol</span>
                <span className="text-white">{protocol.label} · {protocol.chainLabel}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-brand-muted">Bribe</span>
                <span className="text-brand-green font-semibold">{amount} {token.label}</span>
              </div>
            </div>
            <button onClick={() => setShowModal(false)} className="btn-secondary w-full justify-center">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
