"use client";
import { useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  getProgram, statePda, solaM, floorVault, marketVault,
  userAta, commonAccounts, fromUi, toUi,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";

type Tab = "buy" | "sell";

export function BuySell() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const [tab, setTab] = useState<Tab>("buy");
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
      const userSola = userAta(solaM, wallet.publicKey);
      const userUsdc = userAta(usdcMintPk, wallet.publicKey);

      if (tab === "buy") {
        const tx = await program.methods
          .buySola(fromUi(+amount), new BN(1))
          .accounts({
            user: wallet.publicKey,
            protocolState: statePda,
            solaMint: solaM,
            userUsdc,
            userSola,
            floorVault,
            marketVault,
            ...commonAccounts,
          } as any)
          .rpc();
        setStatus(`✅ Bought SOLA — tx: ${tx.slice(0, 16)}…`);
      } else {
        const tx = await program.methods
          .sellSola(fromUi(+amount))
          .accounts({
            user: wallet.publicKey,
            protocolState: statePda,
            solaMint: solaM,
            userSola,
            floorVault,
            userUsdc,
            tokenProgram: commonAccounts.tokenProgram,
          } as any)
          .rpc();
        setStatus(`✅ Sold SOLA — tx: ${tx.slice(0, 16)}…`);
      }
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card glow">
      <h2 className="text-lg font-bold mb-4 text-white">
        {tab === "buy" ? "Buy $SOLA" : "Sell $SOLA"}
      </h2>

      {/* Tabs */}
      <div className="flex gap-6 mb-6 border-b border-brand-border">
        {(["buy", "sell"] as Tab[]).map((t) => (
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
        {tab === "buy" ? "USDC amount" : "SOLA amount"}
      </label>
      <input
        className="input mb-4"
        type="number"
        min="0"
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />

      {tab === "buy" && (
        <p className="text-xs text-gray-500 mb-4">
          Floor price: 1 USDC / SOLA · Market price rises with demand
        </p>
      )}
      {tab === "sell" && (
        <p className="text-xs text-gray-500 mb-4">
          Redeem at floor — always receive 1 USDC per SOLA
        </p>
      )}

      <button
        className="btn-primary w-full"
        onClick={submit}
        disabled={loading || !wallet || !amount || !usdcMint}
      >
        {loading ? "Processing…" : tab === "buy" ? "Buy SOLA" : "Sell SOLA"}
      </button>

      {status && (
        <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>
      )}
    </div>
  );
}
