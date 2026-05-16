// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  getProgram, statePda, hiSolaM, floorVault,
  positionPda, userAta, commonAccounts, fromUi, toUi,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";
import { BN } from "@coral-xyz/anchor";

type Tab = "borrow" | "repay";
const PCT = [25, 50, 75, 100] as const;

export function Borrow({ embedded = false }: { embedded?: boolean }) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const [tab, setTab] = useState<Tab>("borrow");
  const [amount, setAmount] = useState("");
  const [hiSolaBal, setHiSolaBal] = useState<number | null>(null);
  const [borrowed, setBorrowed] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  const available = hiSolaBal !== null ? Math.max(0, hiSolaBal - borrowed) : null;

  const fetchBalance = useCallback(async () => {
    if (!wallet) { setHiSolaBal(null); setBorrowed(0); return; }
    try {
      const provider = new (await import("@coral-xyz/anchor")).AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const [ataInfo, posResult] = await Promise.allSettled([
        connection.getTokenAccountBalance(userAta(hiSolaM, wallet.publicKey)),
        (program.account as any).userPosition.fetch(positionPda(wallet.publicKey)),
      ]);
      setHiSolaBal(ataInfo.status === "fulfilled" ? (ataInfo.value.value.uiAmount ?? 0) : 0);
      setBorrowed(posResult.status === "fulfilled" ? toUi(posResult.value.usdcBorrowed as BN) : 0);
    } catch { setHiSolaBal(0); setBorrowed(0); }
  }, [connection, wallet]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  function applyPct(pct: number) {
    if (!available || available <= 0) return;
    setAmount(((available * pct) / 100).toFixed(6).replace(/\.?0+$/, ""));
  }

  async function submit() {
    if (!wallet || !amount || !usdcMint) return;
    setLoading(true);
    setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program = getProgram(provider);
      const userHiSola = userAta(hiSolaM, wallet.publicKey);
      const userUsdc   = userAta(usdcMint, wallet.publicKey);
      const position   = positionPda(wallet.publicKey);

      if (tab === "borrow") {
        const tx = await program.methods
          .borrowUsdc(fromUi(+amount))
          .accounts({
            user: wallet.publicKey,
            protocolState: statePda,
            hiSolaMint: hiSolaM,
            userHiSola,
            floorVault,
            userUsdc,
            userPosition: position,
            tokenProgram: commonAccounts.tokenProgram,
            systemProgram: commonAccounts.systemProgram,
          } as any)
          .rpc();
        setStatus(`✅ Borrowed ${amount} USDC — tx: ${tx.slice(0, 16)}…`);
      } else {
        const tx = await program.methods
          .repayUsdc(fromUi(+amount))
          .accounts({
            user: wallet.publicKey,
            protocolState: statePda,
            userPosition: position,
            floorVault,
            userUsdc,
            tokenProgram: commonAccounts.tokenProgram,
          } as any)
          .rpc();
        setStatus(`✅ Repaid ${amount} USDC — tx: ${tx.slice(0, 16)}…`);
      }
      setAmount("");
      fetchBalance();
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={embedded ? "" : "card"}>
      <h2 className="text-lg font-bold mb-4 text-white">
        {tab === "borrow" ? "Borrow USDC" : "Repay USDC"}
      </h2>

      <div className="flex gap-6 mb-6 border-b border-brand-border">
        {(["borrow", "repay"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pb-2 text-sm font-semibold uppercase tracking-wide transition-colors ${
              tab === t ? "tab-active" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="rounded-xl bg-brand-dark border border-brand-border p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">
            {tab === "borrow" ? "USDC to borrow" : "USDC to repay"}
          </span>
          {available !== null && tab === "borrow" && (
            <span className="text-xs text-gray-500">
              Dispo:{" "}
              <button
                className="text-gray-300 hover:text-brand-green transition-colors font-mono"
                onClick={() => applyPct(100)}
              >
                {available.toLocaleString(undefined, { maximumFractionDigits: 4 })} USDC
              </button>
            </span>
          )}
        </div>
        <input
          className="w-full bg-transparent text-right text-2xl font-bold text-white placeholder-gray-600 focus:outline-none mb-3"
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => { if (e.target.value === "" || /^\d*\.?\d*$/.test(e.target.value)) setAmount(e.target.value); }}
        />
        {tab === "borrow" && (
          <div className="flex gap-2">
            {PCT.map((pct) => (
              <button
                key={pct}
                onClick={() => applyPct(pct)}
                disabled={!available || available <= 0}
                className="flex-1 text-xs py-1 rounded-md border border-brand-border text-gray-400
                           hover:border-brand-green hover:text-brand-green transition-colors
                           disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {pct === 100 ? "Max" : `${pct}%`}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-gray-500 mb-4">
        {tab === "borrow"
          ? `Max = hiSOLA − déjà emprunté (${borrowed > 0 ? borrowed.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " USDC en cours" : "rien emprunté"}) · Pas de liquidation`
          : "Repay to unlock your hiSOLA collateral"}
      </p>

      <button
        className="btn-primary w-full"
        onClick={submit}
        disabled={loading || !wallet || !amount || !usdcMint}
      >
        {loading ? "Processing…" : tab === "borrow" ? "Borrow" : "Repay"}
      </button>

      {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
    </div>
  );
}
