// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState } from "react";

// ── Data ──────────────────────────────────────────────────────────────────────

const PROTOCOLS = {
  soladrome: { id: "soladrome", label: "Soladrome", chain: "solana",   chainLabel: "Solana",   color: "#9945FF", url: "soladrome.finance"    },
  aerodrome: { id: "aerodrome", label: "Aerodrome", chain: "base",     chainLabel: "Base",     color: "#0052FF", url: "aerodrome.finance"    },
  velodrome: { id: "velodrome", label: "Velodrome", chain: "optimism", chainLabel: "Optimism", color: "#FF0420", url: "velodrome.finance"    },
} as const;
type ProtocolId = keyof typeof PROTOCOLS;

// Bribe tokens when target is Soladrome (EVM partners bridge their tokens in)
const EVM_BRIBE_TOKENS = [
  { id: "fbomb", label: "fBOMB", icon: "💣" },
  { id: "aero",  label: "AERO",  icon: "✈️"  },
  { id: "velo",  label: "VELO",  icon: "🌀"  },
  { id: "usdc",  label: "USDC",  icon: "💵"  },
  { id: "eth",   label: "ETH",   icon: "Ξ"   },
];

// Bribe tokens when target is Aerodrome/Velodrome (Soladrome exercises oSOLA → wSOLA)
const WSOLA_BRIBE_TOKENS = [
  { id: "wsola", label: "wSOLA", icon: "◎" },
  { id: "usdc",  label: "USDC",  icon: "💵" },
];

// LP pairs — each entry lists which protocols host this gauge
const LP_PAIRS = [
  {
    id: "sola-fbomb", label: "SOLA / fBOMB",
    tokenA: "SOLA", tokenB: "fBOMB",
    protocols: ["soladrome", "aerodrome"] as ProtocolId[],
  },
  {
    id: "sola-aero", label: "SOLA / AERO",
    tokenA: "SOLA", tokenB: "AERO",
    protocols: ["soladrome", "aerodrome"] as ProtocolId[],
  },
  {
    id: "sola-velo", label: "SOLA / VELO",
    tokenA: "SOLA", tokenB: "VELO",
    protocols: ["soladrome", "velodrome"] as ProtocolId[],
  },
  {
    id: "fbomb-aero", label: "fBOMB / AERO",
    tokenA: "fBOMB", tokenB: "AERO",
    protocols: ["soladrome", "aerodrome"] as ProtocolId[],
  },
  {
    id: "fbomb-velo", label: "fBOMB / VELO",
    tokenA: "fBOMB", tokenB: "VELO",
    protocols: ["soladrome", "velodrome"] as ProtocolId[],
  },
  {
    id: "sola-usdc", label: "SOLA / USDC",
    tokenA: "SOLA", tokenB: "USDC",
    protocols: ["soladrome"] as ProtocolId[],
  },
  {
    id: "sola-sol", label: "SOLA / SOL",
    tokenA: "SOLA", tokenB: "SOL",
    protocols: ["soladrome"] as ProtocolId[],
  },
  {
    id: "msol-usdc", label: "mSOL / USDC",
    tokenA: "mSOL", tokenB: "USDC",
    protocols: ["soladrome"] as ProtocolId[],
  },
] as const;
type LpId = typeof LP_PAIRS[number]["id"];

// ── Sub-components ────────────────────────────────────────────────────────────

function ChainDot({ color }: { color: string }) {
  return <span className="w-2 h-2 rounded-full shrink-0 inline-block" style={{ background: color }} />;
}

function ProtocolLogo({ chain }: { chain: string }) {
  if (chain === "solana") return (
    <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0" fill="none">
      <circle cx="12" cy="12" r="12" fill="#9945FF"/>
      <path fill="#fff" d="M7 15.5h8.5l1.5-1.5H8.5L7 15.5zm0-4h10l1.5-1.5H8.5L7 11.5zm2-4h8.5L16 6H9L7.5 7.5z"/>
    </svg>
  );
  if (chain === "base") return (
    <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0">
      <circle cx="12" cy="12" r="12" fill="#0052FF"/>
      <path fill="#fff" d="M12 5.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm0 11a4.5 4.5 0 110-9 4.5 4.5 0 010 9z"/>
    </svg>
  );
  if (chain === "optimism") return (
    <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0">
      <circle cx="12" cy="12" r="12" fill="#FF0420"/>
      <path fill="#fff" d="M8.5 9.5c0-.83.67-1.5 1.5-1.5h4c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5h-4c-.83 0-1.5-.67-1.5-1.5v-5z"/>
    </svg>
  );
  return (
    <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0">
      <circle cx="12" cy="12" r="12" fill="#627EEA"/>
      <path fill="rgba(255,255,255,.6)" d="M12 4v6.5l5.5 2.5L12 4z"/>
      <path fill="#fff" d="M12 4L6.5 13l5.5-2.5V4z"/>
    </svg>
  );
}

// Token pill
function TokenPill({ label, icon }: { label: string; icon: string }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-white/5 border border-brand-border text-xs font-semibold text-white">
      <span>{icon}</span>{label}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function Bridge() {
  const [lpId,       setLpId]       = useState<LpId>("sola-fbomb");
  const [protocolId, setProtocolId] = useState<ProtocolId>("soladrome");
  const [tokenId,    setTokenId]    = useState<string>("fbomb");
  const [amount,     setAmount]     = useState("");
  const [showTokens, setShowTokens] = useState(false);
  const [showModal,  setShowModal]  = useState(false);

  const lp       = LP_PAIRS.find(p => p.id === lpId)!;
  const protocol = PROTOCOLS[protocolId];

  // When LP changes, keep protocol if still valid, else reset to first available
  const handleLpChange = (id: LpId) => {
    const newLp = LP_PAIRS.find(p => p.id === id)!;
    const keepProtocol = (newLp.protocols as readonly string[]).includes(protocolId);
    const nextProtocol = keepProtocol ? protocolId : newLp.protocols[0];
    setLpId(id);
    setProtocolId(nextProtocol);
    const tokens = nextProtocol === "soladrome" ? EVM_BRIBE_TOKENS : WSOLA_BRIBE_TOKENS;
    setTokenId(tokens[0].id);
    setAmount("");
  };

  const handleProtocolChange = (pid: ProtocolId) => {
    setProtocolId(pid);
    const tokens = pid === "soladrome" ? EVM_BRIBE_TOKENS : WSOLA_BRIBE_TOKENS;
    setTokenId(tokens[0].id);
    setAmount("");
  };

  // Bribe tokens depend on direction
  const isEVM    = protocolId !== "soladrome";
  const tokens   = isEVM ? WSOLA_BRIBE_TOKENS : EVM_BRIBE_TOKENS;
  const token    = tokens.find(t => t.id === tokenId) ?? tokens[0];
  const hasAmt   = !!amount && parseFloat(amount) > 0;

  // Route description
  const route = isEVM
    ? `Solana → ${protocol.chainLabel} via LayerZero V2`
    : `${protocol.chainLabel} → Solana via LayerZero V2`;

  return (
    <div className="max-w-lg mx-auto flex flex-col gap-5">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight">Cross-Chain Bribe Bridge</h2>
          <p className="text-sm text-brand-muted mt-0.5">
            Bribe any LP gauge on Soladrome or EVM protocols
          </p>
        </div>
        <span className="badge-yellow shrink-0 mt-0.5">Mainnet soon</span>
      </div>

      <div className="flex items-center gap-2 text-xs text-brand-muted">
        <span>Powered by</span>
        <span className="badge-muted">LayerZero V2</span>
        <span className="badge-muted">⚡ Astralane</span>
      </div>

      <div className="card glow flex flex-col gap-6">

        {/* ── Step 1 : LP Pair ─────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-brand-green/15 text-brand-green text-xs font-bold flex items-center justify-center shrink-0">1</span>
            <span className="stat-label">Select LP Pair</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {LP_PAIRS.map(p => {
              const multi = p.protocols.length > 1;
              const active = lpId === p.id;
              return (
                <button key={p.id} onClick={() => handleLpChange(p.id)}
                  className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all duration-150 text-left ${
                    active ? "border-brand-green bg-brand-green/8 text-brand-green"
                           : "border-brand-border text-brand-muted hover:border-white/20 hover:text-white"
                  }`}
                >
                  <span className="truncate">{p.label}</span>
                  {multi && (
                    <span className={`text-[10px] font-bold shrink-0 ${active ? "text-brand-green/60" : "text-brand-muted/60"}`}>
                      ×{p.protocols.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>

        <div className="h-px bg-brand-border" />

        {/* ── Step 2 : Target Protocol ─────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-brand-green/15 text-brand-green text-xs font-bold flex items-center justify-center shrink-0">2</span>
            <span className="stat-label">Target Protocol — where to bribe</span>
          </div>
          <div className="flex flex-col gap-2">
            {(lp.protocols as readonly ProtocolId[]).map(pid => {
              const p      = PROTOCOLS[pid];
              const active = protocolId === pid;
              const evm    = pid !== "soladrome";
              return (
                <button key={pid} onClick={() => handleProtocolChange(pid)}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-all duration-150 ${
                    active ? "border-brand-green bg-brand-green/8"
                           : "border-brand-border hover:border-white/20"
                  }`}
                >
                  <ProtocolLogo chain={p.chain} />
                  <div className="flex flex-col items-start flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-semibold ${active ? "text-brand-green" : "text-white"}`}>
                        {p.label}
                      </span>
                      {/* LP pair on this protocol */}
                      <span className="text-xs text-brand-muted font-medium">
                        {lp.label} gauge
                      </span>
                    </div>
                    <span className="text-xs text-brand-muted flex items-center gap-1.5 mt-0.5">
                      <ChainDot color={p.color} />
                      {p.chainLabel}
                      {evm
                        ? <span className="text-yellow-500/70 ml-1">· Solana → {p.chainLabel}</span>
                        : <span className="text-purple-400/60 ml-1">· {p.chainLabel} → Solana</span>
                      }
                    </span>
                  </div>
                  {/* Bribe token hint */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {evm
                      ? <TokenPill label="wSOLA" icon="◎" />
                      : <span className="text-xs text-brand-muted">fBOMB / AERO…</span>
                    }
                  </div>
                  {active && <span className="text-brand-green text-base shrink-0">✓</span>}
                </button>
              );
            })}
          </div>

          {/* Direction + LP recap banner */}
          <div className={`rounded-xl px-4 py-3 flex items-center gap-3 text-xs ${
            isEVM
              ? "bg-yellow-500/5 border border-yellow-500/15"
              : "bg-purple-500/5 border border-purple-500/15"
          }`}>
            <span className="text-lg">{isEVM ? "⚡" : "🔗"}</span>
            <div className="flex flex-col gap-0.5">
              {isEVM ? (
                <>
                  <span className="text-white font-medium">
                    Bribing <span className="text-brand-green">{lp.label}</span> gauge on {protocol.label}
                  </span>
                  <span className="text-brand-muted">
                    Soladrome exercises oSOLA → bridges wSOLA (backed 1:1) · {protocol.chainLabel}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-white font-medium">
                    Bribing <span className="text-brand-green">{lp.label}</span> gauge on Soladrome
                  </span>
                  <span className="text-brand-muted">
                    Bridge your EVM tokens from {lp.protocols.filter(p => p !== "soladrome").map(p => PROTOCOLS[p].chainLabel).join("/")} · Solana
                  </span>
                </>
              )}
            </div>
          </div>
        </section>

        <div className="h-px bg-brand-border" />

        {/* ── Step 3 : Token + Amount ───────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-brand-green/15 text-brand-green text-xs font-bold flex items-center justify-center shrink-0">3</span>
            <span className="stat-label">Bribe Token & Amount</span>
          </div>

          {isEVM && (
            <p className="text-xs text-brand-muted bg-brand-dark/60 rounded-lg px-3 py-2 border border-brand-border">
              Soladrome treasury exercises oSOLA on-chain and bridges the resulting{" "}
              <span className="text-white font-medium">wSOLA (1:1 floor-backed)</span> to {protocol.label}.
              Select USDC to bribe directly instead.
            </p>
          )}

          <div className="flex gap-2">
            {/* Token selector */}
            <div className="relative">
              <button onClick={() => setShowTokens(!showTokens)}
                className="flex items-center gap-2 h-full px-3 py-2.5 rounded-xl border border-brand-border bg-brand-dark text-sm text-white hover:border-white/20 transition-all duration-150 shrink-0">
                <span>{token.icon}</span>
                <span className="font-medium">{token.label}</span>
                <svg className={`w-3 h-3 text-brand-muted transition-transform duration-150 ${showTokens ? "rotate-180" : ""}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7"/>
                </svg>
              </button>
              {showTokens && (
                <div className="absolute top-full left-0 mt-1 z-20 bg-brand-elevated border border-brand-border rounded-xl shadow-card-hover min-w-[150px] overflow-hidden">
                  {tokens.map(t => (
                    <button key={t.id}
                      onClick={() => { setTokenId(t.id); setShowTokens(false); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm transition-colors hover:bg-white/5 ${
                        tokenId === t.id ? "text-brand-green bg-brand-green/8" : "text-white"
                      }`}
                    >
                      <span>{t.icon}</span>
                      <span className="font-medium">{t.label}</span>
                      {t.id === "wsola" && (
                        <span className="ml-auto text-[10px] text-brand-muted">1:1 backed</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input type="number" min="0" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)}
              className="input flex-1" />
          </div>
        </section>

        {/* ── Summary ──────────────────────────────────────────────────── */}
        {hasAmt && (
          <div className="rounded-xl border border-brand-border bg-brand-dark/60 p-4 flex flex-col gap-2 text-sm">
            <div className="flex justify-between">
              <span className="text-brand-muted">LP gauge</span>
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
              <span className="text-yellow-400 text-xs">⚡ {route}</span>
            </div>
            {isEVM && (
              <div className="flex justify-between">
                <span className="text-brand-muted">Mechanism</span>
                <span className="text-brand-green text-xs">oSOLA exercised → wSOLA bridged</span>
              </div>
            )}
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
              <span className="text-brand-green">
                {parseFloat(amount).toLocaleString()} {token.label}
              </span>
            </div>
          </div>
        )}

        {/* CTA */}
        <button onClick={() => hasAmt && setShowModal(true)}
          className={`w-full py-3 rounded-xl font-semibold text-sm transition-all duration-200 ${
            hasAmt
              ? "btn-primary justify-center"
              : "bg-brand-green/10 text-brand-green/40 border border-brand-green/10 cursor-not-allowed"
          }`}
        >
          {isEVM ? "Bridge & Bribe →" : "Bribe →"}
        </button>
      </div>

      {/* Info */}
      <div className="card-flat flex gap-3 text-sm text-brand-muted">
        <span className="text-brand-green shrink-0 mt-0.5">ℹ</span>
        <p>
          LP pairs exist on <span className="text-white font-medium">Soladrome (Solana)</span> and
          their native EVM protocol. Bribe either gauge to direct emissions.
          Cross-chain wSOLA bribes are{" "}
          <span className="text-white font-medium">floor-backed 1:1</span> — Soladrome exercises
          oSOLA on-chain before bridging, preserving the floor price invariant.
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
              Bridge infrastructure deployed. Mainnet pending final audit + Astralane sign-off.
            </p>
            <div className="rounded-xl border border-brand-border bg-brand-dark/60 p-3 text-left text-sm flex flex-col gap-2">
              <div className="flex justify-between">
                <span className="text-brand-muted">LP gauge</span>
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
              {isEVM && (
                <div className="flex justify-between">
                  <span className="text-brand-muted">Backing</span>
                  <span className="text-brand-green text-xs">wSOLA · 1:1 floor-backed</span>
                </div>
              )}
            </div>
            <button onClick={() => setShowModal(false)} className="btn-secondary w-full justify-center">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
