// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";

interface Row {
  wallet_address: string;
  points: number;
  quests: number;
  last_active: string;
}

const MEDAL = ["🥇", "🥈", "🥉"];
const PAGE_SIZE = 20;

function short(addr: string) {
  return addr.slice(0, 4) + "…" + addr.slice(-4);
}

export function Leaderboard() {
  const wallet = useAnchorWallet();
  const me = wallet?.publicKey.toBase58();
  const [rows, setRows]       = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage]       = useState(0);

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

  const total     = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const myIndex   = useMemo(() => (me ? rows.findIndex((r) => r.wallet_address === me) : -1), [rows, me]);
  const myRow     = myIndex >= 0 ? rows[myIndex] : null;
  const myPage    = myIndex >= 0 ? Math.floor(myIndex / PAGE_SIZE) : -1;

  // Clamp page if the dataset shrinks.
  useEffect(() => { if (page > pageCount - 1) setPage(pageCount - 1); }, [pageCount, page]);

  const start    = page * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-white">Leaderboard</h2>
        <span className="text-xs text-gray-500">{total} contributors</span>
      </div>

      {loading ? (
        <p className="text-xs text-gray-600">Loading…</p>
      ) : total === 0 ? (
        <p className="text-xs text-gray-500">
          No contributors yet — be the first. Complete a quest to appear here.
        </p>
      ) : (
        <>
          <ul className="space-y-1">
            {pageRows.map((r, i) => {
              const rank = start + i;
              const mine = r.wallet_address === me;
              return <RankRow key={r.wallet_address} r={r} rank={rank} mine={mine} />;
            })}
          </ul>

          {/* Pager */}
          {pageCount > 1 && (
            <div className="mt-4 flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setPage(0)}
                  disabled={page === 0}
                  aria-label="First page"
                  className="px-2 py-1 rounded-lg border border-brand-border text-gray-400 hover:text-brand-green hover:border-brand-green/50 transition-colors disabled:opacity-30"
                >
                  «
                </button>
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-2.5 py-1 rounded-lg border border-brand-border text-gray-400 hover:text-brand-green hover:border-brand-green/50 transition-colors disabled:opacity-30"
                >
                  ‹ Prev
                </button>
              </div>
              <span className="text-gray-500">
                Page <span className="text-gray-300 font-mono">{page + 1}</span> / {pageCount}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1}
                  className="px-2.5 py-1 rounded-lg border border-brand-border text-gray-400 hover:text-brand-green hover:border-brand-green/50 transition-colors disabled:opacity-30"
                >
                  Next ›
                </button>
                <button
                  onClick={() => setPage(pageCount - 1)}
                  disabled={page >= pageCount - 1}
                  aria-label="Last page"
                  className="px-2 py-1 rounded-lg border border-brand-border text-gray-400 hover:text-brand-green hover:border-brand-green/50 transition-colors disabled:opacity-30"
                >
                  »
                </button>
              </div>
            </div>
          )}

          {/* Pinned "your rank" — always visible when connected & ranked */}
          {myRow && (
            <div className="mt-4 pt-3 border-t border-brand-border">
              <div className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm bg-brand-green/10 border border-brand-green/30">
                <span className="w-7 shrink-0 text-center font-mono font-bold text-brand-green">
                  #{myIndex + 1}
                </span>
                <span className="font-mono flex-1 truncate text-brand-green">
                  {short(myRow.wallet_address)}
                  <span className="ml-2 text-[10px] text-brand-green/70">you</span>
                </span>
                <span className="text-xs text-gray-500 shrink-0">{myRow.quests}🎯</span>
                <span className="font-mono font-bold text-white shrink-0 w-14 text-right">{myRow.points}</span>
              </div>
              {myPage !== page && (
                <button
                  onClick={() => setPage(myPage)}
                  className="mt-2 w-full text-[11px] text-gray-400 hover:text-brand-green transition-colors"
                >
                  Jump to my position (page {myPage + 1}) →
                </button>
              )}
            </div>
          )}

          {me && !myRow && (
            <p className="mt-4 pt-3 border-t border-brand-border text-xs text-center text-gray-500">
              You're not on the board yet — complete a mission to appear.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function RankRow({ r, rank, mine }: { r: Row; rank: number; mine: boolean }) {
  return (
    <li
      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${
        mine ? "bg-brand-green/10 border border-brand-green/30" : "hover:bg-white/4"
      }`}
    >
      <span className="w-7 shrink-0 text-center font-mono text-gray-500">
        {rank < 3 ? MEDAL[rank] : rank + 1}
      </span>
      <span className={`font-mono flex-1 truncate ${mine ? "text-brand-green" : "text-gray-300"}`}>
        {short(r.wallet_address)}
        {mine && <span className="ml-2 text-[10px] text-brand-green/70">you</span>}
      </span>
      <span className="text-xs text-gray-500 shrink-0">{r.quests}🎯</span>
      <span className="font-mono font-bold text-white shrink-0 w-14 text-right">{r.points}</span>
    </li>
  );
}
