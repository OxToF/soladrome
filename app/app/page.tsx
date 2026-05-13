// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useAnchorWallet } from "@solana/wallet-adapter-react";

// ssr: false évite la hydration mismatch liée à l'icône <i> du wallet adapter
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);
import { BuySell }    from "@/components/BuySell";
import { Stake }      from "@/components/Stake";
import { Borrow }     from "@/components/Borrow";
import { Vote }       from "@/components/Vote";
import { Gauge }      from "@/components/Gauge";
import { ClaimFees }  from "@/components/ClaimFees";
import { Liquidity }  from "@/components/Liquidity";
import { Stats }      from "@/components/Stats";
import { AmmSwap }    from "@/components/AmmSwap";
import { Pools }      from "@/components/Pools";

// USDC mint is read on-chain from protocolState.usdcMint via SoladromeContext

type Page = "trade" | "swap" | "pools" | "stake" | "borrow" | "vote" | "bribe" | "claim" | "liquidity";

const NAV: { id: Page; label: string }[] = [
  { id: "trade",     label: "Trade"     },
  { id: "swap",      label: "Swap"      },
  { id: "pools",     label: "Pools"     },
  { id: "stake",     label: "Stake"     },
  { id: "borrow",    label: "Borrow"    },
  { id: "liquidity", label: "Liquidity" },
  { id: "vote",      label: "Vote"      },
  { id: "bribe",     label: "Bribe"     },
  { id: "claim",     label: "Claim"     },
];

const DOCS_URL = "https://soladrome.finance";

export default function Home() {
  const wallet = useAnchorWallet();
  const [page, setPage] = useState<Page>("trade");

  // Allow Liquidity CTA buttons to navigate via custom event
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail as Page;
      if (NAV.some((n) => n.id === detail)) setPage(detail);
    };
    window.addEventListener("nav", handler);
    return () => window.removeEventListener("nav", handler);
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-brand-border bg-brand-dark/90 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
          {/* Logo */}
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-2xl font-black tracking-tight">
              <span className="text-white">SOLA</span>
              <span className="text-brand-green">DROME</span>
            </span>
            <span className="text-[10px] text-brand-green border border-brand-green/40 rounded px-1.5 py-0.5 uppercase tracking-widest">
              Devnet ✓
            </span>
          </div>

          {/* Nav */}
          <nav className="hidden md:flex items-center gap-1">
            {NAV.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setPage(id)}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  page === id
                    ? "bg-brand-green/10 text-brand-green"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
            {/* Docs — external link */}
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-white transition-colors flex items-center gap-1"
            >
              Docs
              <svg className="w-3 h-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </nav>

          <WalletMultiButton className="!bg-brand-green !text-black !rounded-xl !font-bold !text-sm shrink-0" />
        </div>
      </header>

      {/* ── Hero (not connected) ───────────────────────────────── */}
      {!wallet && (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-24">
          <h1 className="text-5xl md:text-7xl font-black mb-4 leading-tight">
            <span className="text-white">The Eternal</span>
            <br />
            <span className="text-brand-green">Liquidity Engine</span>
          </h1>
          <p className="text-gray-400 max-w-xl mb-10 text-lg">
            Bonding curve · Floor price · No liquidation<br />
            Powered by ve(3,3) tokenomics on Solana.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <WalletMultiButton className="!bg-brand-green !text-black !rounded-xl !font-bold !px-8 !py-3" />
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="btn-secondary"
            >
              Lire la Docs
            </a>
          </div>
        </div>
      )}

      {/* ── App (connected) ───────────────────────────────────── */}
      {wallet && (
        <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-8">
          <Stats />

          {/* Mobile nav */}
          <div className="flex md:hidden gap-2 mb-6 overflow-x-auto pb-1">
            {NAV.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setPage(id)}
                className={`shrink-0 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  page === id
                    ? "bg-brand-green/10 text-brand-green border border-brand-green/30"
                    : "text-gray-400 border border-brand-border"
                }`}
              >
                {label}
              </button>
            ))}
            <a href={DOCS_URL} target="_blank" rel="noreferrer"
              className="shrink-0 px-3 py-2 rounded-lg text-sm font-medium text-gray-400 border border-brand-border">
              Docs ↗
            </a>
          </div>

          {/* Panels */}
          <div className={page === "liquidity" || page === "pools" ? "w-full" : "max-w-xl mx-auto"}>
            {page === "trade"     && <BuySell />}
            {page === "swap"      && <AmmSwap />}
            {page === "pools"     && <Pools />}
            {page === "stake"     && <Stake />}
            {page === "borrow"    && <Borrow />}
            {page === "vote"      && <Vote />}
            {page === "bribe"     && <Gauge />}
            {page === "claim"     && <ClaimFees />}
            {page === "liquidity" && <Liquidity />}
          </div>
        </main>
      )}

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer className="border-t border-brand-border mt-auto py-6 text-center text-xs text-gray-600">
        Soladrome · ve(3,3) on Solana ·{" "}
        <a href={DOCS_URL} target="_blank" rel="noreferrer"
          className="hover:text-brand-green transition-colors">Docs</a>
        {" · "}
        <a href="https://github.com" className="hover:text-brand-green transition-colors">GitHub</a>
      </footer>
    </div>
  );
}
