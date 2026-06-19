// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { QUEST_GROUPS, groupPoints, claimableQuests, trackQuest, type Quest, type QuestGroup, type QuestId } from "@/lib/quests";

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
  const [page, setPage] = useState(0); // which campaign group is shown

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

  const groups = QUEST_GROUPS;
  const group  = groups[page];
  const total  = groups.length;

  // Honor-system claim: open the external action (X follow/repost) and credit it.
  const claim = useCallback((q: Quest) => {
    if (q.href) window.open(q.href, "_blank", "noopener,noreferrer");
    const id = wallet?.publicKey.toBase58();
    if (id) trackQuest(id, q.id as QuestId);
  }, [wallet?.publicKey.toBase58()]);

  return (
    <div className="card">
      {/* ── Campaign header + pager ─────────────────────────────── */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => setPage((p) => (p - 1 + total) % total)}
            disabled={total < 2}
            aria-label="Previous campaign"
            className="text-gray-500 hover:text-brand-green disabled:opacity-0 disabled:cursor-default px-1 shrink-0"
          >
            ‹
          </button>
          <h2 className="text-lg font-bold text-white truncate">{group.title}</h2>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <GroupBadge group={group} done={done} />
          <button
            onClick={() => setPage((p) => (p + 1) % total)}
            disabled={total < 2}
            aria-label="Next campaign"
            className="text-gray-500 hover:text-brand-green disabled:opacity-0 disabled:cursor-default px-1"
          >
            ›
          </button>
        </div>
      </div>

      {/* Dots */}
      {total > 1 && (
        <div className="flex justify-center gap-1.5 mb-3">
          {groups.map((g, i) => (
            <button
              key={g.id}
              onClick={() => setPage(i)}
              aria-label={`Go to ${g.title}`}
              className={`h-1.5 rounded-full transition-all ${
                i === page ? "w-5 bg-brand-green" : "w-1.5 bg-gray-600 hover:bg-gray-500"
              }`}
            />
          ))}
        </div>
      )}

      <GroupBody group={group} done={done} wallet={!!wallet} onClaim={claim} />

      {!wallet && group.live && (
        <p className="mt-4 text-xs text-gray-500 text-center">
          Connect a wallet to start your missions.
        </p>
      )}
    </div>
  );
}

// ── Per-group badge (progress or completion) ───────────────────────────────
function GroupBadge({ group, done }: { group: QuestGroup; done: Set<string> }) {
  if (!group.live) {
    return <span className="text-[10px] uppercase tracking-widest text-yellow-500/80 border border-yellow-500/30 rounded px-2 py-0.5">Soon</span>;
  }
  const claimable = claimableQuests(group);
  const earned    = claimable.filter((q) => done.has(q.id)).reduce((s, q) => s + q.points, 0);
  const completed = claimable.every((q) => done.has(q.id));
  return completed && group.badge
    ? <span className="badge-green">★ {group.badge}</span>
    : <span className="badge-green">{earned} / {groupPoints(group)} pts</span>;
}

// ── Group body: blurb + progress + quest rows + bonus ──────────────────────
function GroupBody({ group, done, wallet, onClaim }: { group: QuestGroup; done: Set<string>; wallet: boolean; onClaim: (q: Quest) => void }) {
  const claimable = claimableQuests(group);
  const earned    = claimable.filter((q) => done.has(q.id)).reduce((s, q) => s + q.points, 0);
  const pct       = group.live ? Math.round((earned / groupPoints(group)) * 100) : 0;
  const completed = group.live && claimable.every((q) => done.has(q.id));

  return (
    <>
      <p className="text-xs text-gray-500 mb-4">{group.blurb}</p>

      {group.live ? (
        <div className="h-2 rounded-full bg-brand-dark border border-brand-border overflow-hidden mb-5">
          <div className="h-full bg-brand-green transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      ) : (
        <div className="mb-5 rounded-xl border border-yellow-500/20 bg-yellow-500/5 px-4 py-2.5 text-center">
          <p className="text-xs text-yellow-500/90 font-semibold">Coming soon</p>
          <p className="text-[11px] text-gray-500 mt-0.5">These missions aren't live yet — check back shortly.</p>
        </div>
      )}

      <ul className="space-y-2">
        {group.quests.map((q, i) => (
          <QuestRow key={q.id} q={q} n={i + 1} done={done.has(q.id)} live={group.live} wallet={wallet} onClaim={onClaim} />
        ))}
      </ul>

      {group.bonus && group.bonus.length > 0 && (
        <>
          <p className="text-[11px] uppercase tracking-widest text-gray-600 mt-5 mb-2">Bonus</p>
          <ul className="space-y-2">
            {group.bonus.map((q) => (
              <QuestRow key={q.id} q={q} done={done.has(q.id)} live={group.live} wallet={wallet} onClaim={onClaim} />
            ))}
          </ul>
        </>
      )}

      {completed && (
        <div className="mt-5 rounded-xl border border-brand-green/30 bg-brand-green/5 px-4 py-3 text-center">
          <p className="text-sm font-bold text-brand-green">★ You're a {group.badge}</p>
          <p className="text-xs text-gray-400 mt-1">
            You qualify for the airdrop. Find bugs to climb the leaderboard.
          </p>
        </div>
      )}
    </>
  );
}

// ── A single quest row ─────────────────────────────────────────────────────
function QuestRow({ q, n, done, live, wallet, onClaim }: { q: Quest; n?: number; done: boolean; live: boolean; wallet: boolean; onClaim: (q: Quest) => void }) {
  const dim = (!live || q.soon) && !done;
  return (
    <li
      className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
        done
          ? "border-brand-green/40 bg-brand-green/5"
          : dim
          ? "border-brand-border/50 opacity-60"
          : "border-brand-border hover:border-gray-600"
      }`}
    >
      {n !== undefined && (
        <span className="w-5 shrink-0 text-center text-xs font-mono text-gray-600">{n}</span>
      )}
      <span className="text-lg shrink-0">{q.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-semibold ${done ? "text-brand-green" : "text-gray-200"}`}>
            {q.label}
          </span>
          <span className="text-[10px] font-mono text-gray-500">+{q.points}</span>
          {q.bonus && (
            <span className="text-[10px] text-yellow-500/80 border border-yellow-500/30 rounded px-1">bonus</span>
          )}
        </div>
        <p className="text-xs text-gray-500 truncate">{q.desc}</p>
      </div>
      {done ? (
        <span className="text-brand-green text-sm shrink-0">✓</span>
      ) : q.soon ? (
        <span className="text-[10px] text-gray-600 shrink-0">Soon</span>
      ) : !live ? (
        <span className="text-[10px] text-gray-600 shrink-0">{q.external ?? "Soon"}</span>
      ) : q.href ? (
        <button
          onClick={() => onClaim(q)}
          disabled={!wallet}
          className="text-xs text-gray-400 hover:text-brand-green border border-brand-border hover:border-brand-green/50 rounded-lg px-2.5 py-1 transition-colors shrink-0 disabled:opacity-30"
        >
          {q.external ?? "Open"} →
        </button>
      ) : q.external ? (
        <span className="text-[10px] text-gray-600 shrink-0">{q.external}</span>
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
