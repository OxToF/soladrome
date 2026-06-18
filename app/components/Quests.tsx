// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { QUESTS, BONUS_QUESTS, TOTAL_POINTS, type Quest } from "@/lib/quests";

// Jump to where a mission is performed (page + optional inner ActionPanel tab).
function go(q: Quest) {
  if (!q.page) return;
  window.dispatchEvent(new CustomEvent("nav", { detail: q.page }));
  if (q.tab) {
    // ActionPanel listens for this to switch its inner tab once home is shown.
    setTimeout(() => window.dispatchEvent(new CustomEvent("action:tab", { detail: q.tab })), 50);
  }
}

export function Quests() {
  const wallet = useAnchorWallet();
  const [done, setDone] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!wallet) { setDone(new Set()); return; }
    try {
      const res  = await fetch(`/api/track-quest?wallet=${wallet.publicKey.toBase58()}`);
      const data = await res.json();
      setDone(new Set<string>(data.completed ?? []));
    } catch { /* keep previous state */ }
  }, [wallet?.publicKey.toBase58()]);

  useEffect(() => { refresh(); }, [refresh]);

  // Refresh shortly after any quest is tracked (DB write lags the tx slightly).
  useEffect(() => {
    const h = () => setTimeout(refresh, 1200);
    window.addEventListener("quests:refresh", h);
    return () => window.removeEventListener("quests:refresh", h);
  }, [refresh]);

  const earned    = QUESTS.filter((q) => done.has(q.id)).reduce((s, q) => s + q.points, 0);
  const pct       = Math.round((earned / TOTAL_POINTS) * 100);
  const completed = QUESTS.every((q) => done.has(q.id));

  function row(q: Quest, n?: number) {
    const isDone = done.has(q.id);
    return (
      <li
        key={q.id}
        className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
          isDone ? "border-brand-green/40 bg-brand-green/5" : "border-brand-border hover:border-gray-600"
        }`}
      >
        {n !== undefined && (
          <span className="w-5 shrink-0 text-center text-xs font-mono text-gray-600">{n}</span>
        )}
        <span className="text-lg shrink-0">{q.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-semibold ${isDone ? "text-brand-green" : "text-gray-200"}`}>
              {q.label}
            </span>
            <span className="text-[10px] font-mono text-gray-500">+{q.points}</span>
            {q.bonus && (
              <span className="text-[10px] text-yellow-500/80 border border-yellow-500/30 rounded px-1">bonus</span>
            )}
          </div>
          <p className="text-xs text-gray-500 truncate">{q.desc}</p>
        </div>
        {isDone ? (
          <span className="text-brand-green text-sm shrink-0">✓</span>
        ) : q.bonus ? (
          <span className="text-[10px] text-gray-600 shrink-0">Discord</span>
        ) : (
          <button
            onClick={() => go(q)}
            disabled={!wallet}
            className="text-xs text-gray-400 hover:text-brand-green border border-brand-border hover:border-brand-green/50 rounded-lg px-2.5 py-1 transition-colors shrink-0 disabled:opacity-30"
          >
            Go →
          </button>
        )}
      </li>
    );
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-bold text-white">Missions</h2>
        {completed ? (
          <span className="badge-green">★ Genesis Tester</span>
        ) : (
          <span className="badge-green">{earned} / {TOTAL_POINTS} pts</span>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Complete all 8 missions to become a <span className="text-brand-green">Genesis Tester</span> and
        qualify for the airdrop. Each mission counts once — no farming.
      </p>

      {/* Progress bar */}
      <div className="h-2 rounded-full bg-brand-dark border border-brand-border overflow-hidden mb-5">
        <div className="h-full bg-brand-green transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>

      <ul className="space-y-2">
        {QUESTS.map((q, i) => row(q, i + 1))}
      </ul>

      {/* Bonus */}
      <p className="text-[11px] uppercase tracking-widest text-gray-600 mt-5 mb-2">Bonus</p>
      <ul className="space-y-2">
        {BONUS_QUESTS.map((q) => row(q))}
      </ul>

      {completed && (
        <div className="mt-5 rounded-xl border border-brand-green/30 bg-brand-green/5 px-4 py-3 text-center">
          <p className="text-sm font-bold text-brand-green">★ You're a Genesis Tester</p>
          <p className="text-xs text-gray-400 mt-1">
            You qualify for the airdrop. Find bugs to climb the leaderboard.
          </p>
        </div>
      )}

      {!wallet && (
        <p className="mt-4 text-xs text-gray-500 text-center">
          Connect a wallet to start your missions.
        </p>
      )}
    </div>
  );
}
