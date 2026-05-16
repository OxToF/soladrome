// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getProgram, statePda, solaM, hiSolaM, solaVaultAddr,
  marketVault, positionPda, userAta, commonAccounts, fromUi,
} from "@/lib/program";

type Tab = "stake" | "unstake";
const PCT = [25, 50, 75, 100] as const;

export function Stake({ embedded = false }: { embedded?: boolean }) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [tab, setTab] = useState<Tab>("stake");
  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  const fetchBalance = useCallback(async () => {
    if (!wallet) { setBalance(null); return; }
    const mint = tab === "stake" ? solaM : hiSolaM;
    try {
      const ata  = userAta(mint, wallet.publicKey);
      const info = await connection.getTokenAccountBalance(ata);
      setBalance(Number(info.value.uiAmount ?? 0));
    } catch { setBalance(0); }
  }, [connection, wallet, tab]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  function applyPct(pct: number) {
    if (!balance || balance <= 0) return;
    setAmount(((balance * pct) / 100).toFixed(6).replace(/\.?0+$/, ""));
  }

  async function submit() {
    if (!wallet || !amount) return;
    setLoading(true);
    setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program = getProgram(provider);
      const userSola   = userAta(solaM,   wallet.publicKey);
      const userHiSola = userAta(hiSolaM, wallet.publicKey);
      const position   = positionPda(wallet.publicKey);

      if (tab === "stake") {
        const tx = await program.methods
          .stakeSola(fromUi(+amount))
          .accounts({
            user: wallet.publicKey,
            protocolState: statePda,
            solaMint: solaM,
            hiSolaMint: hiSolaM,
            userSola,
            userHiSola,
            solaVault: solaVaultAddr,
            marketVault,
            userPosition: position,
            ...commonAccounts,
          } as any)
          .rpc();
        setStatus(`✅ Staked → hiSOLA — tx: ${tx.slice(0, 16)}…`);
      } else {
        const tx = await program.methods
          .unstakeHiSola(fromUi(+amount))
          .accounts({
            user: wallet.publicKey,
            protocolState: statePda,
            solaMint: solaM,
            hiSolaMint: hiSolaM,
            userHiSola,
            userSola,
            solaVault: solaVaultAddr,
            userPosition: position,
            ...commonAccounts,
          } as any)
          .rpc();
        setStatus(`✅ Unstaked → SOLA — tx: ${tx.slice(0, 16)}…`);
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
        {tab === "stake" ? "Stake SOLA → hiSOLA" : "Unstake hiSOLA → SOLA"}
      </h2>

      <div className="flex gap-6 mb-6 border-b border-brand-border">
        {(["stake", "unstake"] as Tab[]).map((t) => (
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
            {tab === "stake" ? "SOLA to lock" : "hiSOLA to unlock"}
          </span>
          {balance !== null && (
            <span className="text-xs text-gray-500">
              Balance:{" "}
              <button
                className="text-gray-300 hover:text-brand-green transition-colors font-mono"
                onClick={() => applyPct(100)}
              >
                {balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} {tab === "stake" ? "SOLA" : "hiSOLA"}
              </button>
            </span>
          )}
        </div>
        <input
          className="w-full bg-transparent text-right text-2xl font-bold text-white placeholder-gray-600 focus:outline-none mb-3"
          type="text"
          inputMode="decimal"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <div className="flex gap-2">
          {PCT.map((pct) => (
            <button
              key={pct}
              onClick={() => applyPct(pct)}
              disabled={!balance}
              className="flex-1 text-xs py-1 rounded-md border border-brand-border text-gray-400
                         hover:border-brand-green hover:text-brand-green transition-colors
                         disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {pct === 100 ? "Max" : `${pct}%`}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-gray-500 mb-4">
        {tab === "stake"
          ? "hiSOLA gives governance rights, fee share & borrow power"
          : "Repay outstanding debt before unstaking"}
      </p>

      <button
        className="btn-primary w-full"
        onClick={submit}
        disabled={loading || !wallet || !amount}
      >
        {loading ? "Processing…" : tab === "stake" ? "Stake" : "Unstake"}
      </button>

      {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
    </div>
  );
}