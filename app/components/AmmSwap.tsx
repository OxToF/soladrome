// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getProgram, poolPda, vaultAPda, vaultBPda,
  sortMints, userAta, statePda, marketVault, commonAccounts, fromUi, toUi,
} from "@/lib/program";
import { getTokenList, TokenInfo, WSOL_MINT } from "@/lib/tokens";
import { useSoladrome } from "@/lib/SoladromeContext";

const SLIPPAGE_OPTIONS = [0.1, 0.5, 1.0] as const;
const PCT_SHORTCUTS = [25, 50, 75, 100] as const;

function xy_k_out(reserveIn: number, reserveOut: number, amountInNet: number): number {
  if (reserveIn <= 0 || reserveOut <= 0 || amountInNet <= 0) return 0;
  return (reserveOut * amountInNet) / (reserveIn + amountInNet);
}

export function AmmSwap() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const { usdcMint } = useSoladrome();
  const tokens = getTokenList(usdcMint);
  const [idxIn,  setIdxIn]  = useState(1);
  const [idxOut, setIdxOut] = useState(2);
  const [amountIn, setAmountIn] = useState("");
  const [slippage, setSlippage] = useState<0.1 | 0.5 | 1.0>(0.5);
  const [estimatedOut, setEstimatedOut] = useState<number | null>(null);
  const [pool, setPool] = useState<{ reserveA: number; reserveB: number; feeRate: number } | null>(null);
  const [balanceIn, setBalanceIn] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  const tokIn:  TokenInfo | undefined = tokens[idxIn];
  const tokOut: TokenInfo | undefined = tokens[idxOut];

  // Fetch wallet balance — native SOL for wSOL, ATA otherwise
  const fetchBalance = useCallback(async () => {
    if (!wallet || !tokIn) { setBalanceIn(null); return; }
    try {
      if (tokIn.mint === WSOL_MINT) {
        const lamports = await connection.getBalance(wallet.publicKey);
        setBalanceIn(lamports / 1e9);
      } else {
        const ata  = userAta(new PublicKey(tokIn.mint), wallet.publicKey);
        const info = await connection.getTokenAccountBalance(ata);
        setBalanceIn(Number(info.value.uiAmount ?? 0));
      }
    } catch {
      setBalanceIn(0);
    }
  }, [connection, wallet, tokIn?.mint]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  // Fetch pool reserves when pair changes
  const fetchPool = useCallback(async () => {
    if (!tokIn || !tokOut || tokIn.mint === tokOut.mint) { setPool(null); return; }
    try {
      const mintInPk  = new PublicKey(tokIn.mint);
      const mintOutPk = new PublicKey(tokOut.mint);
      const poolAddr  = poolPda(mintInPk, mintOutPk);
      const info      = await connection.getAccountInfo(poolAddr);
      if (!info) { setPool(null); return; }

      const provider = new AnchorProvider(connection, wallet ?? ({} as any), {});
      const program  = getProgram(provider);
      const poolAcc  = await (program.account as any).ammPool.fetch(poolAddr);

      const [sortedA] = sortMints(mintInPk, mintOutPk);
      const aToB = mintInPk.equals(sortedA);
      const ra   = toUi(poolAcc.reserveA as BN);
      const rb   = toUi(poolAcc.reserveB as BN);
      setPool({
        reserveA: aToB ? ra : rb,
        reserveB: aToB ? rb : ra,
        feeRate:  poolAcc.feeRate as number,
      });
    } catch {
      setPool(null);
    }
  }, [connection, tokIn?.mint, tokOut?.mint, wallet]);

  useEffect(() => { fetchPool(); }, [fetchPool]);

  // Estimate output
  useEffect(() => {
    if (!pool || !amountIn || isNaN(+amountIn)) { setEstimatedOut(null); return; }
    const ainRaw = +amountIn;
    const feeRate = pool.feeRate / 10_000;
    const ainNet  = ainRaw * (1 - feeRate);
    setEstimatedOut(xy_k_out(pool.reserveA, pool.reserveB, ainNet));
  }, [pool, amountIn]);

  function applyPct(pct: number) {
    if (balanceIn === null || balanceIn <= 0) return;
    const val = (balanceIn * pct) / 100;
    setAmountIn(val.toFixed(6).replace(/\.?0+$/, ""));
  }

  function handleAmountChange(v: string) {
    // Allow only valid numeric input
    if (v === "" || /^\d*\.?\d*$/.test(v)) setAmountIn(v);
  }

  async function swap() {
    if (!wallet || !amountIn || !estimatedOut || !tokIn || !tokOut) return;
    setLoading(true); setStatus("");
    try {
      const provider  = new AnchorProvider(connection, wallet, {});
      const program   = getProgram(provider);
      const mintInPk  = new PublicKey(tokIn.mint);
      const mintOutPk = new PublicKey(tokOut.mint);
      const [sortedA] = sortMints(mintInPk, mintOutPk);
      const aToB      = mintInPk.equals(sortedA);
      const poolAddr  = poolPda(mintInPk, mintOutPk);

      const amountInBn = fromUi(+amountIn);
      const minOutBn   = fromUi(estimatedOut * (1 - slippage / 100));

      const tx = await program.methods
        .ammSwap(amountInBn, minOutBn, aToB)
        .accounts({
          user:          wallet.publicKey,
          pool:          poolAddr,
          tokenAVault:   vaultAPda(poolAddr),
          tokenBVault:   vaultBPda(poolAddr),
          userTokenIn:   userAta(mintInPk, wallet.publicKey),
          userTokenOut:  userAta(mintOutPk, wallet.publicKey),
          marketVault,
          protocolState: statePda,
          tokenProgram:  commonAccounts.tokenProgram,
        } as any)
        .rpc();

      setStatus(`✅ Swap done — tx: ${tx.slice(0, 16)}…`);
      setAmountIn("");
      fetchPool();
      fetchBalance();
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  function flip() {
    setIdxIn(idxOut);
    setIdxOut(idxIn);
    setAmountIn("");
    setEstimatedOut(null);
  }

  const priceImpact = (() => {
    if (!pool || !amountIn || !estimatedOut || +amountIn <= 0) return null;
    const spotPrice = pool.reserveA / pool.reserveB; // token_in per token_out at current ratio
    const execPrice = +amountIn / estimatedOut;
    return ((execPrice - spotPrice) / spotPrice) * 100;
  })();

  const minReceived = estimatedOut !== null ? estimatedOut * (1 - slippage / 100) : null;

  const noPool  = !pool && tokIn && tokOut && tokIn.mint !== tokOut.mint;
  const canSwap = !!wallet && !!amountIn && +amountIn > 0 && !!estimatedOut && !!pool && !loading;

  if (tokens.length < 2) {
    return (
      <div className="card glow text-gray-400 text-sm text-center py-8">
        Loading token information…
      </div>
    );
  }

  return (
    <div className="card glow">
      <h2 className="text-lg font-bold mb-5 text-white">AMM Swap</h2>

      {/* ── Token In ─────────────────────────────────────── */}
      <div className="rounded-xl bg-brand-dark border border-brand-border p-4 mb-2">
        {/* Header: label + balance */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">You pay</span>
          {balanceIn !== null && (
            <span className="text-xs text-gray-500">
              Balance:{" "}
              <button
                className="text-gray-300 hover:text-brand-green transition-colors font-mono"
                onClick={() => applyPct(100)}
              >
                {balanceIn.toLocaleString(undefined, { maximumFractionDigits: 4 })} {tokIn?.symbol}
              </button>
            </span>
          )}
        </div>

        {/* Token selector + amount input */}
        <div className="flex items-center gap-3">
          <select
            className="bg-transparent border border-brand-border rounded-lg px-3 py-2 text-sm text-white
                       focus:outline-none focus:border-brand-green shrink-0 cursor-pointer"
            value={idxIn}
            onChange={(e) => { setIdxIn(+e.target.value); setAmountIn(""); setEstimatedOut(null); }}
          >
            {tokens.map((t, i) => (
              <option key={i} value={i} disabled={i === idxOut} className="bg-gray-900">{t.symbol}</option>
            ))}
          </select>

          <input
            className="flex-1 min-w-0 bg-transparent text-right text-2xl font-bold text-white
                       placeholder-gray-600 focus:outline-none"
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={amountIn}
            onChange={(e) => handleAmountChange(e.target.value)}
          />
        </div>

        {/* Percentage shortcuts */}
        <div className="flex gap-2 mt-3">
          {PCT_SHORTCUTS.map((pct) => (
            <button
              key={pct}
              onClick={() => applyPct(pct)}
              disabled={!balanceIn}
              className="flex-1 text-xs py-1 rounded-md border border-brand-border text-gray-400
                         hover:border-brand-green hover:text-brand-green transition-colors
                         disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {pct === 100 ? "Max" : `${pct}%`}
            </button>
          ))}
        </div>
      </div>

      {/* ── Flip button ───────────────────────────────────── */}
      <div className="flex justify-center my-1">
        <button
          onClick={flip}
          className="w-8 h-8 rounded-full border border-brand-border text-gray-400
                     hover:border-brand-green hover:text-brand-green transition-colors text-lg leading-none"
        >
          ⇅
        </button>
      </div>

      {/* ── Token Out ────────────────────────────────────── */}
      <div className="rounded-xl bg-brand-dark border border-brand-border p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">You receive (est.)</span>
        </div>
        <div className="flex items-center gap-3">
          <select
            className="bg-transparent border border-brand-border rounded-lg px-3 py-2 text-sm text-white
                       focus:outline-none focus:border-brand-green shrink-0 cursor-pointer"
            value={idxOut}
            onChange={(e) => { setIdxOut(+e.target.value); setAmountIn(""); setEstimatedOut(null); }}
          >
            {tokens.map((t, i) => (
              <option key={i} value={i} disabled={i === idxIn} className="bg-gray-900">{t.symbol}</option>
            ))}
          </select>

          <div className="flex-1 text-right text-2xl font-bold text-brand-green font-mono">
            {estimatedOut !== null ? estimatedOut.toFixed(6) : "0"}
          </div>
        </div>
      </div>

      {/* ── Pool / error info ─────────────────────────────── */}
      {noPool && (
        <p className="text-xs text-yellow-500 mb-3">
          No pool found for {tokIn?.symbol}/{tokOut?.symbol}. Create one in the Pools tab.
        </p>
      )}

      {/* ── Price info ────────────────────────────────────── */}
      {pool && estimatedOut !== null && +amountIn > 0 && (
        <div className="rounded-xl border border-brand-border p-3 mb-3 space-y-1.5 text-xs">
          <div className="flex justify-between text-gray-400">
            <span>Minimum reçu</span>
            <span className="font-mono text-white">
              {minReceived?.toFixed(6)} {tokOut?.symbol}
            </span>
          </div>
          <div className="flex justify-between text-gray-400">
            <span>Price impact</span>
            <span className={`font-mono font-bold ${
              priceImpact === null ? "text-gray-400"
              : priceImpact < 1   ? "text-brand-green"
              : priceImpact < 3   ? "text-yellow-400"
              : "text-red-400"
            }`}>
              {priceImpact !== null ? `${priceImpact.toFixed(2)}%` : "—"}
            </span>
          </div>
          <div className="flex justify-between text-gray-400">
            <span>Fee du pool</span>
            <span className="font-mono">{(pool.feeRate / 100).toFixed(2)}%</span>
          </div>
        </div>
      )}

      {/* ── Slippage ─────────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs text-gray-400">Slippage:</span>
        {SLIPPAGE_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => setSlippage(s)}
            className={`text-xs px-2 py-1 rounded border transition-colors ${
              slippage === s
                ? "border-brand-green text-brand-green"
                : "border-brand-border text-gray-500 hover:text-gray-300"
            }`}
          >
            {s}%
          </button>
        ))}
      </div>

      <button className="btn-primary w-full" onClick={swap} disabled={!canSwap}>
        {loading ? "Processing…" : "Swap"}
      </button>

      {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
    </div>
  );
}
