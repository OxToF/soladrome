// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  getProgram, statePda, hiSolaM, floorVault,
  positionPda, userAta, commonAccounts, fromUi,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";

type Tab = "borrow" | "repay";

export function Borrow() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const [tab, setTab] = useState<Tab>("borrow");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  async function submit() {
    if (!wallet || !amount || !usdcMint) return;
    setLoading(true);
    setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program = getProgram(provider);
      const usdcMintPk = usdcMint;
      const userHiSola = userAta(hiSolaM, wallet.publicKey);
      const userUsdc   = userAta(usdcMintPk, wallet.publicKey);
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
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
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

      <label className="text-xs text-gray-400 mb-1 block">USDC amount</label>
      <input
        className="input mb-4"
        type="number"
        min="0"
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />

      <p className="text-xs text-gray-500 mb-4">
        {tab === "borrow"
          ? "Max = your hiSOLA balance · No liquidation risk"
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