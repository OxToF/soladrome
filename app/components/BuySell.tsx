// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  getProgram, statePda, solaM, floorVault, marketVault,
  userAta, commonAccounts, fromUi, toUi, sendTx,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";
import { trackQuest } from "@/lib/quests";

type Tab = "buy" | "sell";

const PCT_SHORTCUTS = [25, 50, 75, 100] as const;

export function BuySell() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const [tab, setTab] = useState<Tab>("buy");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);

  // The side you spend from: USDC when buying, SOLA when selling.
  const spendMint   = tab === "buy" ? usdcMint : solaM;
  const spendSymbol = tab === "buy" ? "USDC"   : "SOLA";

  const fetchBalance = useCallback(async () => {
    if (!wallet || !spendMint) { setBalance(null); return; }
    try {
      const info = await connection.getTokenAccountBalance(userAta(spendMint, wallet.publicKey));
      setBalance(Number(info.value.uiAmount ?? 0));
    } catch {
      // No ATA yet — a brand-new wallet before its first faucet claim. Zero, not unknown.
      setBalance(0);
    }
  }, [connection, wallet, spendMint]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  // Buy/sell/faucet all dispatch this, and Portfolio and Stats already listen to it, so the
  // card refreshes itself instead of showing a balance the last trade already invalidated.
  useEffect(() => {
    const h = () => { fetchBalance(); };
    window.addEventListener("soladrome:refresh", h);
    return () => window.removeEventListener("soladrome:refresh", h);
  }, [fetchBalance]);

  const insufficient =
    balance !== null && amount !== "" && Number(amount) > balance;

  function applyPct(pct: number) {
    if (balance === null || balance <= 0) return;
    // Floor to 6 decimals — the token precision. Anything finer is dust the input would
    // round anyway, and `Max` must never produce more than the wallet actually holds.
    const v = Math.floor(balance * (pct / 100) * 1e6) / 1e6;
    setAmount(v > 0 ? String(v) : "");
  }

  async function claimFaucet() {
    if (!wallet) return;
    setFaucetLoading(true);
    setStatus("");
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: wallet.publicKey.toBase58() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStatus(`✅ Got ${data.amount} test USDC!`);
      trackQuest(wallet.publicKey.toBase58(), "faucet");
      // Without this the card still reads 0 right after a successful claim, which looks
      // exactly like a failed faucet — the first impression every new tester gets.
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
    } catch (e: any) {
      setStatus(`❌ Faucet: ${e?.message ?? e}`);
    } finally {
      setFaucetLoading(false);
    }
  }

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
        const ix = await program.methods
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
          .instruction();
        const tx = await sendTx(connection, wallet, [ix]);
        setStatus(`✅ Bought SOLA — tx: ${tx.slice(0, 16)}…`);
        trackQuest(wallet.publicKey.toBase58(), "swap");
        window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      } else {
        const ix = await program.methods
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
          .instruction();
        const tx = await sendTx(connection, wallet, [ix]);
        setStatus(`✅ Sold SOLA — tx: ${tx.slice(0, 16)}…`);
        window.dispatchEvent(new CustomEvent("soladrome:refresh"));
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

      <div className="flex items-center justify-between mb-1">
        <label className="text-xs text-gray-400">
          {tab === "buy" ? "USDC amount" : "SOLA amount"}
        </label>
        {balance !== null && (
          <span className="text-xs text-gray-500">
            Balance:{" "}
            <button
              type="button"
              className="text-gray-300 hover:text-brand-green transition-colors font-mono"
              onClick={() => applyPct(100)}
            >
              {balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} {spendSymbol}
            </button>
          </span>
        )}
      </div>
      <input
        className="input"
        type="number"
        min="0"
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />

      <div className="flex gap-2 mt-3 mb-4">
        {PCT_SHORTCUTS.map((pct) => (
          <button
            key={pct}
            type="button"
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

      {/* Refuse a trade the wallet cannot fund rather than letting the chain reject it —
          an on-chain failure costs the user a signature and reads as a broken app. */}
      {insufficient && (
        <p className="text-xs text-yellow-500 mb-2">
          Not enough {spendSymbol} — you hold{" "}
          {(balance ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })}.
        </p>
      )}

      <button
        className="btn-primary w-full"
        onClick={submit}
        disabled={loading || !wallet || !amount || !usdcMint || insufficient}
      >
        {loading ? "Processing…" : tab === "buy" ? "Buy SOLA" : "Sell SOLA"}
      </button>

      {status && (
        <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>
      )}

      {/* Devnet faucet */}
      <div className="mt-4 pt-4 border-t border-brand-border">
        <p className="text-xs text-gray-500 mb-2">New wallet? Get test USDC</p>
        <button
          className="btn-secondary w-full text-xs"
          onClick={claimFaucet}
          disabled={faucetLoading || !wallet}
        >
          {faucetLoading ? "Sending…" : "Get 500 Test USDC"}
        </button>
        {/* SOL comes from the official faucet — the in-app one only mints our
            custom test USDC (fee SOL via devnet airdrop was rate-limited anyway). */}
        <p className="text-[10px] text-gray-600 mt-2">
          Need SOL for transaction fees?{" "}
          <a
            href="https://faucet.solana.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-400"
          >
            Get devnet SOL at faucet.solana.com
          </a>
        </p>
      </div>
    </div>
  );
}