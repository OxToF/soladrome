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
import { getTokenList, TokenInfo } from "@/lib/tokens";

const SLIPPAGE_OPTIONS = [0.1, 0.5, 1.0] as const;

function xy_k_out(reserveIn: number, reserveOut: number, amountInNet: number): number {
  if (reserveIn <= 0 || reserveOut <= 0 || amountInNet <= 0) return 0;
  return (reserveOut * amountInNet) / (reserveIn + amountInNet);
}

export function AmmSwap() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const tokens = getTokenList();
  const [idxIn,  setIdxIn]  = useState(1); // SOLA by default
  const [idxOut, setIdxOut] = useState(2); // USDC by default
  const [amountIn, setAmountIn] = useState("");
  const [slippage, setSlippage] = useState<0.1 | 0.5 | 1.0>(0.5);
  const [estimatedOut, setEstimatedOut] = useState<number | null>(null);
  const [pool, setPool] = useState<{ reserveA: number; reserveB: number; feeRate: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  const tokIn:  TokenInfo | undefined = tokens[idxIn];
  const tokOut: TokenInfo | undefined = tokens[idxOut];

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
      fetchPool();
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

  const noPool  = !pool && tokIn && tokOut && tokIn.mint !== tokOut.mint;
  const canSwap = !!wallet && !!amountIn && +amountIn > 0 && !!estimatedOut && !!pool && !loading;

  if (tokens.length < 2) {
    return (
      <div className="card glow text-gray-400 text-sm text-center py-8">
        Token addresses not configured. Set NEXT_PUBLIC_SOLA_MINT and NEXT_PUBLIC_USDC_MINT.
      </div>
    );
  }

  return (
    <div className="card glow">
      <h2 className="text-lg font-bold mb-4 text-white">AMM Swap</h2>

      {/* Token In */}
      <label className="text-xs text-gray-400 mb-1 block">You pay</label>
      <div className="flex gap-2 mb-3">
        <select
          className="input w-32 shrink-0"
          value={idxIn}
          onChange={(e) => { setIdxIn(+e.target.value); setAmountIn(""); setEstimatedOut(null); }}
        >
          {tokens.map((t, i) => (
            <option key={i} value={i} disabled={i === idxOut}>{t.symbol}</option>
          ))}
        </select>
        <input
          className="input flex-1 min-w-0"
          type="number"
          min="0"
          step="any"
          placeholder="0.00"
          value={amountIn}
          onChange={(e) => setAmountIn(e.target.value)}
        />
      </div>

      {/* Flip */}
      <div className="flex justify-center mb-3">
        <button
          onClick={flip}
          className="w-8 h-8 rounded-full border border-brand-border text-gray-400
                     hover:border-brand-green hover:text-brand-green transition-colors text-lg leading-none"
        >
          ⇅
        </button>
      </div>

      {/* Token Out */}
      <label className="text-xs text-gray-400 mb-1 block">You receive (est.)</label>
      <div className="flex gap-2 mb-4">
        <select
          className="input w-32 shrink-0"
          value={idxOut}
          onChange={(e) => { setIdxOut(+e.target.value); setAmountIn(""); setEstimatedOut(null); }}
        >
          {tokens.map((t, i) => (
            <option key={i} value={i} disabled={i === idxIn}>{t.symbol}</option>
          ))}
        </select>
        <div className="input flex-1 min-w-0 text-brand-green font-mono">
          {estimatedOut !== null ? estimatedOut.toFixed(6) : "—"}
        </div>
      </div>

      {/* Pool info */}
      {noPool && (
        <p className="text-xs text-yellow-500 mb-3">
          No pool found for {tokIn?.symbol}/{tokOut?.symbol}. Create one in the Pools tab.
        </p>
      )}
      {pool && (
        <p className="text-xs text-gray-500 mb-3">
          Pool reserves: {pool.reserveA.toFixed(4)} {tokIn?.symbol} / {pool.reserveB.toFixed(4)} {tokOut?.symbol}
          {" · "}Fee: {(pool.feeRate / 100).toFixed(2)}%
        </p>
      )}

      {/* Slippage */}
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
