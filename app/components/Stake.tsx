"use client";
import { useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  getProgram, statePda, solaM, hiSolaM, solaVaultAddr,
  marketVault, positionPda, userAta, commonAccounts, fromUi,
} from "@/lib/program";

type Tab = "stake" | "unstake";

export function Stake() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [tab, setTab] = useState<Tab>("stake");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

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
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
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

      <label className="text-xs text-gray-400 mb-1 block">
        {tab === "stake" ? "SOLA to lock" : "hiSOLA to unlock"}
      </label>
      <input
        className="input mb-4"
        type="number"
        min="0"
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />

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
