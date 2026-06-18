// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";

interface Row {
  wallet_address: string;
  points: number;
  quests: number;
  last_active: string;
}

const MEDAL = ["🥇", "🥈", "🥉"];

function short(addr: string) {
  return addr.slice(0, 4) + "…" + addr.slice(-4);
}

export function Leaderboard() {
  const wallet = useAnchorWallet();
  const me = wallet?.publicKey.toBase58();
  const [rows, setRows]       = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res  = await fetch("/api/leaderboard");
      const data = await res.json();
      setRows(data.rows ?? []);
    } catch { /* keep previous */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Refresh shortly after a quest is tracked.
  useEffect(() => {
    const h = () => setTimeout(refresh, 1500);
    window.addEventListener("quests:refresh", h);
    return () => window.removeEventListener("quests:refresh", h);
  }, [refresh]);

  const myRank = me ? rows.findIndex((r) => r.wallet_address === me) : -1;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-white">Leaderboard</h2>
        <span className="text-xs text-gray-500">{rows.length} contributors</span>
      </div>

      {loading ? (
        <p className="text-xs text-gray-600">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-gray-500">
          No contributors yet — be the first. Complete a quest to appear here.
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r, i) => {
            const mine = r.wallet_address === me;
            return (
              <li
                key={r.wallet_address}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${
                  mine ? "bg-brand-green/10 border border-brand-green/30" : "hover:bg-white/4"
                }`}
              >
                <span className="w-7 shrink-0 text-center font-mono text-gray-500">
                  {i < 3 ? MEDAL[i] : i + 1}
                </span>
                <span className={`font-mono flex-1 truncate ${mine ? "text-brand-green" : "text-gray-300"}`}>
                  {short(r.wallet_address)}{mine && <span className="ml-2 text-[10px] text-brand-green/70">you</span>}
                </span>
                <span className="text-xs text-gray-500 shrink-0">{r.quests}🎯</span>
                <span className="font-mono font-bold text-white shrink-0 w-14 text-right">{r.points}</span>
              </li>
            );
          })}
        </ul>
      )}

      {me && myRank >= 10 && (
        <p className="mt-4 pt-3 border-t border-brand-border text-xs text-center text-gray-500">
          Your rank: <span className="text-brand-green font-bold">#{myRank + 1}</span>
        </p>
      )}
    </div>
  );
}
