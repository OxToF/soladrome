// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { CAMPAIGN } from "@/lib/quests";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Quests } from "./Quests";
import { Leaderboard } from "./Leaderboard";

function fmt(n: number) {
  return n.toLocaleString("en-US");
}

export function Airdrop() {
  const wallet = useAnchorWallet();
  const { setVisible } = useWalletModal();

  return (
    <div className="space-y-6">
      {/* ── Hero ─────────────────────────────────────────────── */}
      <div className="card glow text-center py-10">
        <span className="badge-green mb-4 inline-block">{CAMPAIGN.name}</span>
        <p className="text-5xl md:text-6xl font-black text-brand-green leading-tight">
          {fmt(CAMPAIGN.totalSola)} <span className="text-white">$SOLA</span>
        </p>
        <p className="text-gray-400 mt-3 text-lg">for early beta testers</p>
        <p className="text-xs text-gray-500 mt-4 max-w-xl mx-auto">
          Soladrome is live on devnet. Test the protocol, complete the missions,
          help us break it before mainnet — and earn a share of the genesis pool.
        </p>
        {!wallet && (
          <button
            onClick={() => setVisible(true)}
            className="btn-primary mt-6 px-8 py-3"
          >
            Connect wallet to start →
          </button>
        )}
      </div>

      {/* ── Campaign terms ───────────────────────────────────── */}
      <div className="card">
        <h2 className="text-lg font-bold text-white mb-4">How the airdrop works</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
          {CAMPAIGN.pools.map((p) => (
            <div key={p.label} className="rounded-xl border border-brand-border bg-brand-dark p-4">
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-sm font-semibold text-white">{p.label}</span>
                <span className="font-mono text-brand-green font-bold">
                  {fmt(Math.round((CAMPAIGN.totalSola * p.pct) / 100))} $SOLA
                </span>
              </div>
              <p className="text-[11px] text-gray-500 mb-2">{p.pct}% of the pool</p>
              <p className="text-xs text-gray-400 leading-relaxed">{p.desc}</p>
            </div>
          ))}
        </div>

        <ul className="space-y-2 text-xs text-gray-400">
          <li className="flex gap-2">
            <span className="text-brand-green shrink-0">●</span>
            <span><span className="text-gray-200 font-semibold">Eligibility:</span> complete the 8 missions below on devnet to become a <span className="text-brand-green">Genesis Tester</span>.</span>
          </li>
          <li className="flex gap-2">
            <span className="text-brand-green shrink-0">●</span>
            <span><span className="text-gray-200 font-semibold">Window:</span> {CAMPAIGN.window}</span>
          </li>
          <li className="flex gap-2">
            <span className="text-brand-green shrink-0">●</span>
            <span><span className="text-gray-200 font-semibold">Payout:</span> {CAMPAIGN.claim}</span>
          </li>
          <li className="flex gap-2">
            <span className="text-brand-green shrink-0">●</span>
            <span><span className="text-gray-200 font-semibold">Anti-sybil:</span> each mission counts once per wallet. Obvious sybil clusters are excluded — quality testers, not farms.</span>
          </li>
        </ul>

        <p className="text-[10px] text-gray-600 mt-5 leading-relaxed border-t border-brand-border pt-3">
          Devnet tokens have no monetary value. Airdrop allocations are denominated in mainnet $SOLA,
          distributed at TGE, and remain subject to the final published campaign terms and anti-sybil review.
          Nothing here is a financial promise or investment advice.
        </p>
      </div>

      {/* ── Missions + Leaderboard ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <Quests />
        <Leaderboard />
      </div>
    </div>
  );
}
