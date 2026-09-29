// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
import dynamic from "next/dynamic";

// The SDK is ~3 MB of chunks (it carries clients for every SODAX chain); it loads when this page
// opens and never before. See lib/sodax.ts.
const SodaxBridge = dynamic(() => import("./SodaxBridge"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-48 rounded-2xl bg-brand-dark/40">
      <span className="text-brand-muted text-sm animate-pulse">Loading bridge…</span>
    </div>
  ),
});

export function Bridge() {
  return (
    <div className="max-w-lg mx-auto flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-white tracking-tight">Bridge</h2>
          <p className="text-sm text-brand-muted mt-0.5">
            Move USDC, USDT and SODA between Solana and Robinhood Chain, Base, Arbitrum, Ethereum &amp; more
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 mt-0.5">
          <span className="badge text-red-400">Mainnet</span>
          <span className="badge-muted">SODAX</span>
        </div>
      </div>

      <SodaxBridge />

      {/* Footer */}
      <div className="card-flat flex gap-2.5 text-sm text-brand-muted">
        <span className="text-brand-green shrink-0 mt-0.5">ℹ</span>
        <p>
          Transfers are relayed by{" "}
          <a href="https://sodax.com" target="_blank" rel="noopener noreferrer" className="text-brand-green hover:underline font-medium">
            SODAX
          </a>{" "}
          through its Sonic hub and delivered to your address on the destination chain. Soladrome takes no fee and never holds
          your funds. When Soladrome is live on mainnet, bridged USDC can go straight into{" "}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "pools" }))}
            className="text-brand-green hover:underline font-medium"
          >
            liquidity
          </button>{" "}
          or{" "}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "bribe" }))}
            className="text-brand-green hover:underline font-medium"
          >
            bribes
          </button>
          , as a second, separate transaction.
        </p>
      </div>
    </div>
  );
}
