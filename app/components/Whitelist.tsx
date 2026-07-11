// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Quests } from "./Quests";

// Cosmetic spot count for the FOMO gauge — not a hard cap enforced anywhere
// on-chain, just gives the gauge and copy a real number instead of a fake one.
const WHITELIST_CAP = 500;

interface Status {
  signedUp:    boolean;
  whitelisted: boolean;
  email:       string | null;
  completed:   string[];
}

export function Whitelist() {
  const { publicKey, connected, signMessage } = useWallet();
  const { setVisible } = useWalletModal();

  const [status, setStatus]   = useState<Status | null>(null);
  const [signing, setSigning] = useState(false);
  const [email, setEmail]     = useState("");
  const [savingEmail, setSavingEmail] = useState(false);
  const [count, setCount]     = useState<number | null>(null);
  const [error, setError]     = useState<string | null>(null);

  const wallet = publicKey?.toBase58();

  const refreshStatus = useCallback(async () => {
    if (!wallet) { setStatus(null); return; }
    try {
      const res  = await fetch(`/api/whitelist/status?wallet=${wallet}`);
      const data = await res.json();
      setStatus(data);
      setEmail(data.email ?? "");
    } catch { /* keep previous state */ }
  }, [wallet]);

  const refreshCount = useCallback(async () => {
    try {
      const res  = await fetch("/api/whitelist/count");
      const data = await res.json();
      setCount(data.count ?? 0);
    } catch { /* keep previous state */ }
  }, []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);
  useEffect(() => { refreshCount(); }, [refreshCount]); // once on mount — marketing counter, not real-time-critical

  // Also refresh once a tracked quest lands, so "whitelisted" flips as soon as
  // the on-chain-verified action (stake/borrow/vote) is credited.
  useEffect(() => {
    const h = () => setTimeout(() => { refreshStatus(); refreshCount(); }, 1200);
    window.addEventListener("quests:refresh", h);
    return () => window.removeEventListener("quests:refresh", h);
  }, [refreshStatus, refreshCount]);

  const handleSign = useCallback(async () => {
    if (!wallet || !signMessage) return;
    setSigning(true);
    setError(null);
    try {
      const message   = `Soladrome Whitelist — ${wallet} — ${Date.now()}`;
      const signature = await signMessage(new TextEncoder().encode(message));
      const bs58      = (await import("bs58")).default;
      // Include the email so step 2 ("Save") actually persists it — the previous
      // body omitted it, so every signup stored a null email.
      const res = await fetch("/api/whitelist/join", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ wallet, signature: bs58.encode(signature), message, email: email.trim() || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Signature verification failed");
      }
      await refreshStatus();
    } catch (e: any) {
      setError(e?.message ?? "Signing failed — try again.");
    } finally {
      setSigning(false);
    }
  }, [wallet, signMessage, refreshStatus, email]);

  const handleSaveEmail = useCallback(async () => {
    if (!wallet || !status?.signedUp) return;
    setSavingEmail(true);
    try {
      // Re-persist with the last signed message on file isn't available client-side,
      // so saving an email re-signs — keeps the same verified-ownership guarantee.
      await handleSign();
    } finally {
      setSavingEmail(false);
    }
  }, [wallet, status?.signedUp, handleSign]);

  const pct = count !== null ? Math.min(100, Math.round((count / WHITELIST_CAP) * 100)) : 0;

  return (
    <div className="space-y-6">
      <div className="card glow text-center py-10">
        <span className="badge-green mb-4 inline-block">Founding Contributor Whitelist</span>
        <p className="text-3xl md:text-4xl font-black text-white leading-tight">
          Guaranteed mainnet access + boosted emissions
        </p>
        <p className="text-xs text-gray-500 mt-4 max-w-xl mx-auto">
          Sign your wallet, complete real bonding-curve missions (stake, borrow,
          vote), and lock in early mainnet access before the public launch.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 card space-y-4">
          <StepRow
            n={1}
            title="Sign wallet"
            done={!!connected}
            active
          >
            {!connected ? (
              <button onClick={() => setVisible(true)} className="btn-primary">
                Select Wallet
              </button>
            ) : !status?.signedUp ? (
              <button onClick={handleSign} disabled={signing} className="btn-primary">
                {signing ? "Signing…" : "Sign to verify"}
              </button>
            ) : (
              <span className="text-brand-green text-sm font-semibold">Verified ✓</span>
            )}
          </StepRow>

          <StepRow n={2} title="Email (optional)" done={!!status?.email} active={!!status?.signedUp}>
            {status?.signedUp ? (
              <div className="flex gap-2 w-full max-w-sm">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="input flex-1"
                />
                <button onClick={handleSaveEmail} disabled={savingEmail} className="btn-secondary shrink-0">
                  Save
                </button>
              </div>
            ) : (
              <span className="text-xs text-gray-600">🔒 Sign your wallet first</span>
            )}
          </StepRow>

          <StepRow n={3} title="Mint contributor NFT" done={false} active={!!status?.whitelisted}>
            {status?.whitelisted ? (
              <span className="text-xs text-gray-500">On-chain minting ships in a follow-up update.</span>
            ) : (
              <span className="text-xs text-gray-600">🔒 Complete the missions below first</span>
            )}
          </StepRow>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="space-y-4">
          <div className="card text-center">
            <p className="stat-label mb-1">Whitelisted users</p>
            <p className="text-3xl font-black text-brand-green">
              {count !== null ? count.toLocaleString() : "—"}
            </p>
          </div>
          <div className="card">
            <p className="stat-label mb-2 text-center">Founding spots</p>
            <div className="h-2 rounded-full bg-brand-border overflow-hidden">
              <div
                className="h-full bg-brand-green transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-[11px] text-gray-500 mt-2 text-center">
              {count !== null ? `${Math.max(0, WHITELIST_CAP - count)} of ${WHITELIST_CAP} left` : "…"}
            </p>
          </div>
        </div>
      </div>

      <Quests />
    </div>
  );
}

function StepRow({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex items-center justify-between gap-4 rounded-xl border p-4 ${active ? "border-brand-border bg-brand-dark" : "border-brand-border/50 bg-brand-dark/40 opacity-60"}`}>
      <div className="flex items-center gap-3">
        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${done ? "bg-brand-green text-black" : "bg-brand-border text-gray-400"}`}>
          {done ? "✓" : n}
        </span>
        <span className="text-sm font-semibold text-white">{title}</span>
      </div>
      <div>{children}</div>
    </div>
  );
}
