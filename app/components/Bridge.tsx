// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";

declare global {
  interface Window {
    __CONNECT_CONFIG?: unknown;
    __CONNECT_THEME?:  unknown;
  }
}

// ── Env ───────────────────────────────────────────────────────────────────────

const IS_TESTNET     = process.env.NEXT_PUBLIC_WH_NETWORK === "Testnet";
const WC_PROJECT_ID  = process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "";
const MOCK_AERO_ADDR = process.env.NEXT_PUBLIC_MOCK_AERO_ADDRESS ?? "";

// ── UI token cards ────────────────────────────────────────────────────────────
// Each card shows: native token sent → wrapped token received on destination.
// Wormhole handles wrapping automatically — we list only native tokens in the config.

// "attest" = deployed on Solana mainnet but not yet attested on EVM via Wormhole
const MAINNET_CARDS = [
  { id: "aero", label: "AERO",  recv: "wAERO", from: "Base",      fromColor: "#0052FF", to: "Solana", icon: "✈️", live: true,   attest: false },
  { id: "velo", label: "VELO",  recv: "wVELO", from: "Optimism",  fromColor: "#FF0420", to: "Solana", icon: "🌀", live: true,   attest: false },
  { id: "sola", label: "SOLA",  recv: "wSOLA", from: "Solana",    fromColor: "#14F195", to: "Base",   icon: "◈",  live: false,  attest: true  },
  { id: "sol",  label: "SOL",   recv: "wSOL",  from: "Solana",    fromColor: "#9945FF", to: "Base",   icon: "◎",  live: true,   attest: false },
  { id: "bero", label: "BERO",  recv: "wBERO", from: "Berachain", fromColor: "#F5A524", to: "Solana", icon: "🐻", live: false,  attest: false },
];

const TESTNET_CARDS = [
  { id: "mock-aero", label: "AERO", recv: "wAERO", from: "Base Sepolia", fromColor: "#0052FF", to: "Solana devnet", icon: "✈️", live: true, attest: false },
];

const CARDS = IS_TESTNET ? TESTNET_CARDS : MAINNET_CARDS;

// ── Wormhole Connect config ───────────────────────────────────────────────────
// List native tokens only. Wormhole creates wrapped versions automatically on
// attestation — no need to declare wAERO, wVELO, wSOLA, wSOL separately.

const WH_CONFIG_MAINNET = {
  network: "Mainnet" as const,
  chains:  ["Solana", "Base", "Optimism"] as const,
  tokens:  ["AERO", "VELO", "SOL", "ETH", "USDC"],
  rpcs: {
    Optimism: "https://mainnet.optimism.io",
    Base:     "https://mainnet.base.org",
    Solana:   "https://solana-rpc.publicnode.com",
  },
  tokensConfig: {
    AERO: {
      symbol:   "AERO",
      name:     "AERO",
      decimals: 18,
      icon:     "https://assets.coingecko.com/coins/images/31745/standard/token.png",
      tokenId:  { chain: "Base" as const, address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" },
    },
    VELO: {
      symbol:   "VELO",
      name:     "Velodrome",
      decimals: 18,
      icon:     "https://assets.coingecko.com/coins/images/25783/standard/velo.png",
      tokenId:  { chain: "Optimism" as const, address: "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db" },
    },
  },
  ui: {
    defaultInputs: {
      source:      { chain: "Base" as const, token: "AERO" },
      destination: { chain: "Solana" as const },
    },
    tokenNameOverrides: {
      // EVM-side names
      Base:     { "0x940181a94A35A4569E4529A3CDfB74e38FD98631": "AERO" },
      Optimism: { "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db": "VELO" },
      // Solana-side wrapped names (SPL mints derived from Wormhole Token Bridge PDA)
      Solana: {
        "AXYvFSKMPwt9adL1eBZhrDNCvT29HXnhNQuPxNwDZin": "wAERO",
        "GaLBL77CzH9XSzStkNPmCkWhuXwkDU38du2ainTGrEMN": "wVELO",
      },
    } as Record<string, Record<string, string>>,
    showFooter:  false,
    hideHistory: true,
    ...(WC_PROJECT_ID ? { walletConnectProjectId: WC_PROJECT_ID } : {}),
  },
};

const WH_CONFIG_TESTNET = {
  network: "Testnet" as const,
  chains:  ["Solana", "BaseSepolia"] as const,
  tokens:  MOCK_AERO_ADDR ? ["MOCK_AERO", "ETH"] : ["ETH"],
  tokensConfig: MOCK_AERO_ADDR ? {
    MOCK_AERO: {
      symbol:   "AERO",
      name:     "AERO",
      decimals: 18,
      icon:     "https://assets.coingecko.com/coins/images/31745/standard/token.png",
      tokenId:  { chain: "BaseSepolia" as const, address: MOCK_AERO_ADDR },
    },
  } : {},
  ui: {
    defaultInputs: {
      fromChain: "BaseSepolia" as const,
      toChain:   "Solana"      as const,
    },
    ...(MOCK_AERO_ADDR ? {
      tokenNameOverrides: { BaseSepolia: { [MOCK_AERO_ADDR]: "AERO" } } as Record<string, Record<string, string>>,
    } : {}),
    showFooter:  false,
    hideHistory: true,
    ...(WC_PROJECT_ID ? { walletConnectProjectId: WC_PROJECT_ID } : {}),
  },
};

const WH_CONFIG = IS_TESTNET ? WH_CONFIG_TESTNET : WH_CONFIG_MAINNET;

const WH_THEME = {
  mode:       "dark"  as const,
  primary:    "#14F195",
  secondary:  "#9945FF",
  background: "#0D0D0D",
  font:       "Inter, ui-sans-serif, sans-serif",
};

// ── Widget (local dist, zero webpack chunk) ───────────────────────────────────

const WH_JS  = "/wh/main.mjs";
const WH_CSS = "/wh/main.css";

function WormholeWidget({ config, theme }: { config: unknown; theme: unknown }) {
  const ref             = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!ref.current || ref.current.querySelector("#wormhole-connect")) return;

    if (!document.querySelector("link[data-wh-css]")) {
      const link         = document.createElement("link");
      link.rel           = "stylesheet";
      link.href          = WH_CSS;
      link.dataset.whCss = "1";
      document.head.appendChild(link);
    }

    // Clear stale WC sessions so the widget never auto-connects a wrong wallet.
    Object.keys(localStorage)
      .filter(k => k.startsWith("wormhole-connect") || k.startsWith("wc@") || k.startsWith("WALLETCONNECT"))
      .forEach(k => localStorage.removeItem(k));

    window.__CONNECT_CONFIG = config;
    window.__CONNECT_THEME  = theme;

    const div     = document.createElement("div");
    div.id        = "wormhole-connect";
    const script  = document.createElement("script");
    script.src    = WH_JS;
    script.type   = "module";
    script.onload = () => setReady(true);

    ref.current.appendChild(div);
    ref.current.appendChild(script);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={ref}>
      {!ready && (
        <div className="flex items-center justify-center h-48 rounded-2xl bg-brand-dark/40">
          <span className="text-brand-muted text-sm animate-pulse">Loading bridge…</span>
        </div>
      )}
    </div>
  );
}

// ── Bridge history ────────────────────────────────────────────────────────────

function ChainDot({ color }: { color: string }) {
  return <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />;
}

const WH_CHAIN_NAMES: Record<number, string> = { 1: "Solana", 24: "Optimism", 30: "Base" };
const WH_CHAIN_COLORS: Record<number, string> = { 1: "#14F195", 24: "#FF0420", 30: "#0052FF" };
// EVM addresses are lowercased hex; Solana addresses are base58 (case-sensitive — do NOT lowercase).
// Lookup tries lowercase first (EVM), then exact case (Solana), then falls back to API tokenSymbol.
const WH_TOKEN_NAMES: Record<string, string> = {
  // EVM (lowercase hex)
  "0x9560e827af36c94d2ac33a39bce1fe78631088db": "VELO",  // Optimism
  "0x940181a94a35a4569e4529a3cdfb74e38fd98631": "AERO",  // Base
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",  // Base
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85": "USDC",  // Optimism
  // Solana (exact base58 — no lowercasing)
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
  "So11111111111111111111111111111111111111112":   "SOL",
};

interface WHTx {
  id:        string;
  fromChain: number;
  toChain:   number;
  token:     string;
  amount:    string;
  status:    string;
  sourceTx?: string;
}

function parseTx(op: Record<string, unknown>): WHTx | null {
  try {
    const sp  = (op.content as Record<string, unknown>)?.standarizedProperties as Record<string, unknown>;
    const src = op.sourceChain as Record<string, unknown>;
    const tgt = op.targetChain as Record<string, unknown>;
    if (!sp) return null;

    const fromChain = sp.fromChain as number;
    const toChain   = sp.toChain   as number;
    if (!WH_CHAIN_NAMES[fromChain] || !WH_CHAIN_NAMES[toChain]) return null;

    // Try lowercase (EVM) then exact case (Solana base58), then API symbol, then "?"
    const rawAddr = sp.tokenAddress as string ?? "";
    const token   = WH_TOKEN_NAMES[rawAddr.toLowerCase()]
                 ?? WH_TOKEN_NAMES[rawAddr]
                 ?? (sp.tokenSymbol as string | undefined)
                 ?? "?";

    // Wormhole normalizes all amounts to 8 decimals in the VAA — divide by 1e8
    const amount   = (Number(sp.amount as string ?? "0") / 1e8).toFixed(4);
    const status   = (tgt as Record<string, unknown>)?.status as string ?? "pending";
    const sourceTx = ((src?.transaction as Record<string, unknown>)?.txHash as string) ?? undefined;

    return { id: op.id as string, fromChain, toChain, token, amount, status, sourceTx };
  } catch { return null; }
}

function BridgeHistory() {
  const wallet = useAnchorWallet();
  const [txs,     setTxs]     = useState<WHTx[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchHistory = useCallback(async (addr: string, signal: AbortSignal) => {
    setLoading(true);
    try {
      const url = `https://api.wormholescan.io/api/v1/operations?address=${addr}&pageSize=10&page=0`;
      const res = await fetch(url, { signal });
      if (!res.ok) return;
      const data = await res.json();
      const ops  = (data.operations ?? []) as Record<string, unknown>[];
      setTxs(ops.map(parseTx).filter(Boolean) as WHTx[]);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
    } finally {
      setLoading(false);
    }
  }, []);

  // Use .toBase58() string as dependency — object identity of publicKey is unstable
  const addrStr = wallet?.publicKey?.toBase58();

  useEffect(() => {
    if (!addrStr) return;
    const ctrl = new AbortController();
    fetchHistory(addrStr, ctrl.signal);
    return () => ctrl.abort();
  }, [addrStr, fetchHistory]);

  if (!wallet?.publicKey) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Bridge history</h3>
        <button
          onClick={() => { if (addrStr) { const c = new AbortController(); fetchHistory(addrStr, c.signal); } }}
          className="text-[11px] text-brand-muted hover:text-white transition-colors"
        >
          {loading ? "Loading…" : "↺ Refresh"}
        </button>
      </div>

      {loading && txs.length === 0 ? (
        <p className="text-xs text-brand-muted animate-pulse">Fetching transactions…</p>
      ) : txs.length === 0 ? (
        <p className="text-xs text-brand-muted">No bridge transactions found for this wallet.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {txs.map(tx => (
            <div
              key={tx.id}
              className="flex items-center justify-between p-2.5 rounded-xl border border-brand-border bg-brand-dark/40 text-xs"
            >
              {/* Route */}
              <div className="flex items-center gap-1.5 min-w-0">
                <ChainDot color={WH_CHAIN_COLORS[tx.fromChain] ?? "#888"} />
                <span className="text-brand-muted truncate">{WH_CHAIN_NAMES[tx.fromChain]}</span>
                <span className="text-brand-muted/50">→</span>
                <ChainDot color={WH_CHAIN_COLORS[tx.toChain] ?? "#888"} />
                <span className="text-brand-muted truncate">{WH_CHAIN_NAMES[tx.toChain]}</span>
              </div>

              {/* Amount + token */}
              <div className="flex items-center gap-2 shrink-0 ml-2">
                <span className="text-white font-medium">{tx.amount} {tx.token}</span>
                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase ${
                  tx.status === "completed" ? "bg-brand-green/20 text-brand-green" :
                  tx.status === "failed"    ? "bg-red-500/20 text-red-400" :
                                             "bg-yellow-500/20 text-yellow-400"
                }`}>
                  {tx.status}
                </span>
                {tx.sourceTx && (
                  <a
                    href={`https://wormholescan.io/#/tx/${tx.sourceTx}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-muted/50 hover:text-brand-green transition-colors"
                    title="View on Wormholescan"
                  >
                    ↗
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Bridge page ───────────────────────────────────────────────────────────────

export function Bridge() {
  return (
    <div className="max-w-lg mx-auto flex flex-col gap-5">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight">Token Bridge</h2>
          <p className="text-sm text-brand-muted mt-0.5">
            Bridge tokens between Solana, Base &amp; Optimism · both directions
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 mt-0.5">
          {IS_TESTNET && <span className="badge-yellow">Testnet</span>}
          <span className="badge-muted">Wormhole</span>
        </div>
      </div>

      {/* Token cards — send X, receive wX on destination */}
      <div className="grid grid-cols-5 gap-2">
        {CARDS.map(t => (
          <div
            key={t.id}
            className={`flex flex-col gap-1.5 p-2.5 rounded-xl border transition-all ${
              t.live
                ? "border-brand-border bg-brand-dark/40"
                : t.attest
                ? "border-brand-green/20 bg-brand-green/5"
                : "border-dashed border-brand-border/50 opacity-50"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-base">{t.icon}</span>
              {t.attest
                ? <span className="text-[8px] text-brand-green/70 font-semibold uppercase tracking-wide">Attest</span>
                : !t.live
                ? <span className="text-[8px] text-yellow-500/80 font-semibold uppercase tracking-wide">Soon</span>
                : null
              }
            </div>
            <div className="text-[11px] font-bold text-white leading-tight">{t.label}</div>
            <div className={`text-[10px] leading-tight ${t.attest ? "text-brand-green/50" : "text-brand-green/80"}`}>
              → {t.recv}
            </div>
            <span className="flex items-center gap-1 text-[9px] text-brand-muted/70 leading-tight">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: t.fromColor }} />
              {t.from}
            </span>
          </div>
        ))}
      </div>

      {/* SOLA attestation notice */}
      {!IS_TESTNET && (
        <div className="flex gap-2.5 p-3 rounded-xl border border-brand-green/20 bg-brand-green/5 text-xs text-brand-muted">
          <span className="shrink-0 text-brand-green mt-0.5">◈</span>
          <div className="flex flex-col gap-1">
            <span><span className="text-white font-medium">SOLA → wSOLA</span> requires a one-time Wormhole attestation on Base before the bridge route opens.</span>
            <span className="text-brand-muted/60">
              Steps: (1) attest SOLA mint on Base via Wormhole Token Bridge · (2) relay VAA → <code className="bg-brand-dark/60 px-1 rounded">createWrapped</code> on Base · (3) add wSOLA address here. Scheduled for mainnet launch.
            </span>
          </div>
        </div>
      )}

      {/* fBOMB notice */}
      {!IS_TESTNET && (
        <div className="flex gap-2.5 p-3 rounded-xl border border-yellow-500/20 bg-yellow-500/5 text-xs text-brand-muted">
          <span className="shrink-0 text-xl">💣</span>
          <div className="flex flex-col gap-1.5">
            <div>
              <span className="text-yellow-400 font-semibold">fBOMB cannot be bridged via Wormhole.</span>
              {" "}fBOMB is a <span className="text-white font-medium">LayerZero OFT</span> — burn/mint mechanics
              are baked in. Wormhole&apos;s lock-and-mint model is incompatible.
            </div>
            <div>
              Requires a native <span className="text-white font-medium">LZ OFT program on Solana</span> (EID 30168),{" "}
              <code className="text-brand-green/80 bg-brand-dark/60 px-1 rounded">setPeer</code> on each EVM contract,
              and DVN + executor config. Under negotiation with <span className="text-white font-medium">MLCB DAO</span>.
            </div>
          </div>
        </div>
      )}

      {/* Testnet helper */}
      {IS_TESTNET && (
        <div className="flex gap-2.5 p-3 rounded-xl border border-brand-green/20 bg-brand-green/5 text-xs text-brand-muted">
          <span className="text-brand-green shrink-0">⚗️</span>
          <div>
            <span className="text-brand-green font-semibold">Testnet mode.</span>
            {" "}Mint MockAERO:{" "}
            <code className="text-brand-green/80 bg-brand-dark/60 px-1 rounded">npm run deploy:mock-aero</code>
            {" "}in <code className="text-brand-green/80 bg-brand-dark/60 px-1 rounded">soladrome-bridge/evm</code>.
          </div>
        </div>
      )}

      {/* Wormhole widget */}
      <div className="rounded-2xl overflow-hidden border border-brand-border">
        <WormholeWidget config={WH_CONFIG} theme={WH_THEME} />
      </div>

      {/* Bridge history */}
      {!IS_TESTNET && (
        <div className="card-flat">
          <BridgeHistory />
        </div>
      )}

      {/* Footer */}
      <div className="card-flat flex gap-2.5 text-sm text-brand-muted">
        <span className="text-brand-green shrink-0 mt-0.5">ℹ</span>
        <p>
          Bridged tokens arrive as wrapped assets (wAERO, wVELO on Solana · wSOLA on Base/Optimism).
          Use them to{" "}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "pools" }))}
            className="text-brand-green hover:underline font-medium"
          >
            provide liquidity
          </button>{" "}
          or{" "}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "bribe" }))}
            className="text-brand-green hover:underline font-medium"
          >
            bribe gauges
          </button>{" "}
          on Soladrome.{" "}
          If your transaction gets stuck after source-chain confirmation, recover it at{" "}
          <a
            href="https://portalbridge.com/advanced-tools/#/redeem"
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-green hover:underline font-medium"
          >
            Portal Bridge recovery
          </a>.
        </p>
      </div>
    </div>
  );
}
