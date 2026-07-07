// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { QUEST_GROUPS, groupPoints, claimableQuests, trackQuest, findQuest, type Quest, type QuestGroup, type QuestId } from "@/lib/quests";
import { StatusBanner } from "./ui/StatusBanner";

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
  const [discordNotice, setDiscordNotice] = useState<string | null>(null);

  // Land back here after the Discord OAuth round-trip (/api/discord/callback
  // redirects to /?discord_verified=1 or /?discord_error=<reason>) — show a
  // one-line result and strip the query param so a page refresh doesn't repeat it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const verified = params.get("discord_verified");
    const error    = params.get("discord_error");
    if (!verified && !error) return;
    setDiscordNotice(
      verified ? "✅ Discord verified — quest credited."
      : error === "not_a_member" ? "❌ You need to join the Soladrome Discord first."
      : "❌ Discord verification failed — try again."
    );
    window.history.replaceState({}, "", window.location.pathname);
    setTimeout(() => window.dispatchEvent(new CustomEvent("quests:refresh")), 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const missingGates = (group.gate ?? []).filter((id) => !done.has(id));
  const locked = missingGates.length > 0;
  // Which tab holds the first unmet prerequisite (Solana ID + TrueMRR both live in Ecosystem).
  const unlockTargetIndex = locked ? (findQuest(missingGates[0])?.groupIndex ?? -1) : -1;
  const unlockLabel = unlockTargetIndex >= 0 ? groups[unlockTargetIndex].title : undefined;

  // Two-step honor claim: QuestRow opens the external action (X follow/repost)
  // first, then calls this to credit. Splitting open from credit means a single
  // stray click no longer mints points — the user has to come back and claim,
  // which converts far more of them into real follows/reposts.
  //
  // NOTE: this honor-system path still applies to follow_x/repost/like_video/
  // repost_video — real X follow/like/repost verification needs the paid X API
  // tier, not budgeted yet. "discord" was reported exploited the same way and
  // has since moved to real OAuth + bot verification (see verifyDiscord below);
  // it no longer goes through this function.
  const claim = useCallback((q: Quest) => {
    const id = wallet?.publicKey.toBase58();
    if (id) trackQuest(id, q.id as QuestId);
  }, [wallet?.publicKey.toBase58()]);

  // Discord: full-page redirect into OAuth (not window.open — the callback has
  // to land back on our own domain to credit the quest), instead of a client-
  // side self-report claim.
  const verifyDiscord = useCallback(() => {
    const id = wallet?.publicKey.toBase58();
    if (!id) return;
    window.location.href = `/api/discord/authorize?wallet=${id}`;
  }, [wallet?.publicKey.toBase58()]);

  // Referral: copy this wallet's invite link (credited server-side when a
  // referred wallet becomes a verified on-chain Genesis Tester).
  const copyRef = useCallback(() => {
    const id = wallet?.publicKey.toBase58();
    if (!id) return false;
    try { navigator.clipboard?.writeText(`${window.location.origin}/?ref=${id}`); return true; }
    catch { return false; }
  }, [wallet?.publicKey.toBase58()]);

  return (
    <div className="card">
      {discordNotice && <StatusBanner message={discordNotice} />}

      {/* ── Campaign tabs ───────────────────────────────────────── */}
      <div className="flex items-center gap-1 mb-4 border-b border-brand-border overflow-x-auto">
        {groups.map((g, i) => (
          <button
            key={g.id}
            onClick={() => setPage(i)}
            aria-current={i === page ? "page" : undefined}
            className={`flex items-center gap-2 px-3 py-2 -mb-px border-b-2 text-sm font-bold whitespace-nowrap transition-colors ${
              i === page
                ? "text-white border-brand-green"
                : "text-gray-500 border-transparent hover:text-gray-300"
            }`}
          >
            {g.title}
            <TabStatus group={g} done={done} />
          </button>
        ))}
      </div>

      <GroupBody
        group={group}
        done={done}
        wallet={!!wallet}
        missingGates={missingGates}
        unlockLabel={unlockLabel}
        onUnlock={unlockTargetIndex >= 0 ? () => setPage(unlockTargetIndex) : undefined}
        onClaim={claim}
        onCopyRef={copyRef}
        onVerifyDiscord={verifyDiscord}
      />

      {!wallet && group.live && (
        <p className="mt-4 text-xs text-gray-500 text-center">
          Connect a wallet to start your missions.
        </p>
      )}
    </div>
  );
}

// ── Compact per-tab status: ★ when complete, "Soon" when not live, else points ──
function TabStatus({ group, done }: { group: QuestGroup; done: Set<string> }) {
  if (!group.live) {
    return <span className="text-[9px] uppercase tracking-wider text-yellow-500/70">Soon</span>;
  }
  if (group.gate && group.gate.some((id) => !done.has(id))) {
    return <span className="text-xs" aria-label="locked">🔒</span>;
  }
  const claimable = claimableQuests(group);
  const completed = claimable.every((q) => done.has(q.id));
  if (completed) return <span className="text-brand-green text-xs" aria-label="completed">★</span>;
  const earned = claimable.filter((q) => done.has(q.id)).reduce((s, q) => s + q.points, 0);
  return <span className="text-[10px] font-mono text-gray-600">{earned}/{groupPoints(group)}</span>;
}

// ── Group body: blurb + progress + quest rows + bonus ──────────────────────
function GroupBody({ group, done, wallet, missingGates, unlockLabel, onUnlock, onClaim, onCopyRef, onVerifyDiscord }: { group: QuestGroup; done: Set<string>; wallet: boolean; missingGates: QuestId[]; unlockLabel?: string; onUnlock?: () => void; onClaim: (q: Quest) => void; onCopyRef: () => boolean; onVerifyDiscord: () => void }) {
  const claimable = claimableQuests(group);
  const earned    = claimable.filter((q) => done.has(q.id)).reduce((s, q) => s + q.points, 0);
  const locked    = missingGates.length > 0;
  const pct       = group.live && !locked ? Math.round((earned / groupPoints(group)) * 100) : 0;
  const completed = group.live && !locked && claimable.every((q) => done.has(q.id));
  const active    = group.live && !locked;

  return (
    <>
      <p className="text-xs text-gray-500 mb-4">{group.blurb}</p>

      {locked ? (
        <div className="mb-5 rounded-xl border border-brand-green/20 bg-brand-green/5 px-4 py-2.5 text-center">
          <p className="text-xs text-brand-green/90 font-semibold">🔒 Complete these first to unlock</p>
          <ul className="text-[11px] text-gray-400 mt-1 space-y-0.5">
            {missingGates.map((id) => (
              <li key={id}>{findQuest(id)?.quest.label ?? id}</li>
            ))}
          </ul>
          {onUnlock && (
            <button onClick={onUnlock} className="mt-2 text-xs text-brand-green border border-brand-green/50 hover:bg-brand-green/10 rounded-lg px-2.5 py-1 transition-colors">
              Go to {unlockLabel ?? "Ecosystem Missions"} →
            </button>
          )}
        </div>
      ) : group.live ? (
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
          <QuestRow key={q.id} q={q} n={i + 1} done={done.has(q.id)} live={active} locked={locked} wallet={wallet} onClaim={onClaim} onCopyRef={onCopyRef} onVerifyDiscord={onVerifyDiscord} />
        ))}
      </ul>

      {group.bonus && group.bonus.length > 0 && (
        <>
          <p className="text-[11px] uppercase tracking-widest text-gray-600 mt-5 mb-2">Bonus</p>
          <ul className="space-y-2">
            {group.bonus.map((q) => (
              <QuestRow key={q.id} q={q} done={done.has(q.id)} live={active} locked={locked} wallet={wallet} onClaim={onClaim} onCopyRef={onCopyRef} onVerifyDiscord={onVerifyDiscord} />
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
function QuestRow({ q, n, done, live, locked, wallet, onClaim, onCopyRef, onVerifyDiscord }: { q: Quest; n?: number; done: boolean; live: boolean; locked?: boolean; wallet: boolean; onClaim: (q: Quest) => void; onCopyRef: () => boolean; onVerifyDiscord: () => void }) {
  const [copied, setCopied] = useState(false);
  // Two-step: first click opens the X action, second click claims. Resets on
  // unmount, which is fine — re-opening costs nothing.
  const [opened, setOpened] = useState(false);
  const dim = (!live || q.soon || locked) && !done;
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
      {q.copyRef ? (
        // Referral is repeatable — always show the copy button, even once
        // `done` (the label above already turns green to signal "earned at
        // least once"), so testers can keep sharing and earning +25 per
        // NEW successful referral instead of getting stuck after the first.
        <button
          onClick={() => { if (onCopyRef()) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}
          disabled={!wallet}
          className="text-xs text-gray-400 hover:text-brand-green border border-brand-border hover:border-brand-green/50 rounded-lg px-2.5 py-1 transition-colors shrink-0 disabled:opacity-30"
        >
          {copied ? "Copied ✓" : "Copy link"}
        </button>
      ) : done ? (
        <span className="text-brand-green text-sm shrink-0">✓</span>
      ) : locked ? (
        <span className="text-[10px] text-gray-600 shrink-0">🔒 Locked</span>
      ) : q.soon ? (
        <span className="text-[10px] text-gray-600 shrink-0">Soon</span>
      ) : !live ? (
        <span className="text-[10px] text-gray-600 shrink-0">{q.external ?? "Soon"}</span>
      ) : q.linkOnly && q.href ? (
        <a
          href={q.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-gray-400 hover:text-brand-green border border-brand-border hover:border-brand-green/50 rounded-lg px-2.5 py-1 transition-colors shrink-0"
        >
          {q.external ?? "Open"} →
        </a>
      ) : q.href ? (
        !opened ? (
          <button
            onClick={() => { window.open(q.href, "_blank", "noopener,noreferrer"); setOpened(true); }}
            disabled={!wallet}
            className="text-xs text-gray-400 hover:text-brand-green border border-brand-border hover:border-brand-green/50 rounded-lg px-2.5 py-1 transition-colors shrink-0 disabled:opacity-30"
          >
            {q.external ?? "Open"} →
          </button>
        ) : q.id === "discord" ? (
          // Real verification, not honor-system: hits Discord OAuth + a
          // bot-checked guild-membership lookup server-side (see
          // app/api/discord/authorize + /callback) instead of self-crediting.
          <button
            onClick={onVerifyDiscord}
            disabled={!wallet}
            className="text-xs text-brand-green border border-brand-green/50 hover:bg-brand-green/10 rounded-lg px-2.5 py-1 transition-colors shrink-0 disabled:opacity-30"
          >
            Verify Discord →
          </button>
        ) : (
          <button
            onClick={() => onClaim(q)}
            disabled={!wallet}
            className="text-xs text-brand-green border border-brand-green/50 hover:bg-brand-green/10 rounded-lg px-2.5 py-1 transition-colors shrink-0 disabled:opacity-30"
          >
            Claim +{q.points}
          </button>
        )
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
