// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getProgram, poolPda, vaultAPda, vaultBPda, sortMints, userAta,
  statePda, marketVault, commonAccounts,
  fromUiDecimals, toUiDecimals,
  buildWrapInstructions, buildUnwrapInstruction, ensureAtaIx, sendTx,
  WSOL_MINT_STR,
} from "@/lib/program";
import { getTokenList, TokenInfo, WSOL_MINT, decimalsForMint } from "@/lib/tokens";
import { useSoladrome } from "@/lib/SoladromeContext";

const SLIPPAGE_OPTIONS = [0.1, 0.5, 1.0] as const;
const PCT_SHORTCUTS    = [25, 50, 75, 100] as const;

function xy_k_out(reserveIn: number, reserveOut: number, amountInNet: number): number {
  if (reserveIn <= 0 || reserveOut <= 0 || amountInNet <= 0) return 0;
  return (reserveOut * amountInNet) / (reserveIn + amountInNet);
}

export function AmmSwap({ embedded = false }: { embedded?: boolean }) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const tokens = getTokenList(usdcMint);

  const [idxIn,  setIdxIn]  = useState(1);
  const [idxOut, setIdxOut] = useState(2);
  const [amountIn,    setAmountIn]    = useState("");
  const [slippage,    setSlippage]    = useState<0.1 | 0.5 | 1.0>(0.5);
  const [estimatedOut, setEstimatedOut] = useState<number | null>(null);
  const [pool, setPool] = useState<{ reserveIn: number; reserveOut: number; feeRate: number } | null>(null);
  const [balanceIn, setBalanceIn] = useState<number | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [status,    setStatus]    = useState("");
  const [faucetLoading, setFaucetLoading] = useState(false);

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
      setStatus(`✅ ${data.amount} test USDC ajoutés à ton wallet !`);
      fetchBalance();
    } catch (e: any) {
      setStatus(`❌ Faucet: ${e?.message ?? e}`);
    } finally {
      setFaucetLoading(false);
    }
  }

  const tokIn:  TokenInfo | undefined = tokens[idxIn];
  const tokOut: TokenInfo | undefined = tokens[idxOut];

  // ── Wallet balance (native SOL for wSOL, ATA otherwise) ───────────────────
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
    } catch { setBalanceIn(0); }
  }, [connection, wallet, tokIn?.mint]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  // ── Pool reserves ─────────────────────────────────────────────────────────
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
      const acc      = await (program.account as any).ammPool.fetch(poolAddr);

      const [sortedA] = sortMints(mintInPk, mintOutPk);
      const aToB      = mintInPk.equals(sortedA);

      // Use each token's own decimals for correct UI amounts
      const decA = decimalsForMint(acc.tokenAMint.toString(), usdcMint);
      const decB = decimalsForMint(acc.tokenBMint.toString(), usdcMint);
      const ra   = toUiDecimals(acc.reserveA as BN, decA);
      const rb   = toUiDecimals(acc.reserveB as BN, decB);

      setPool({
        reserveIn:  aToB ? ra : rb,
        reserveOut: aToB ? rb : ra,
        feeRate:    acc.feeRate as number,
      });
    } catch { setPool(null); }
  }, [connection, tokIn?.mint, tokOut?.mint, wallet, usdcMint]);

  useEffect(() => { fetchPool(); }, [fetchPool]);

  // ── Output estimate ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!pool || !amountIn || isNaN(+amountIn)) { setEstimatedOut(null); return; }
    const feeRate = pool.feeRate / 10_000;
    const ainNet  = +amountIn * (1 - feeRate);
    setEstimatedOut(xy_k_out(pool.reserveIn, pool.reserveOut, ainNet));
  }, [pool, amountIn]);

  function applyPct(pct: number) {
    if (!balanceIn || balanceIn <= 0) return;
    const val = (balanceIn * pct) / 100;
    setAmountIn(val.toFixed(tokIn?.decimals ?? 6).replace(/\.?0+$/, ""));
  }

  function handleAmountChange(v: string) {
    if (v === "" || /^\d*\.?\d*$/.test(v)) setAmountIn(v);
  }

  // ── Swap (with transparent wrap/unwrap) ───────────────────────────────────
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

      const isWsolIn  = tokIn.mint  === WSOL_MINT;
      const isWsolOut = tokOut.mint === WSOL_MINT;

      const amountInBn = fromUiDecimals(+amountIn, tokIn.decimals);
      const minOutBn   = fromUiDecimals(estimatedOut * (1 - slippage / 100), tokOut.decimals);

      const preIxs  = [];
      const postIxs = [];

      // Wrap native SOL → wSOL ATA before swap
      if (isWsolIn) {
        const lamports = Math.floor(+amountIn * 1e9);
        preIxs.push(...await buildWrapInstructions(connection, wallet.publicKey, lamports));
        // Close after swap to reclaim any dust + recover native SOL
        postIxs.push(buildUnwrapInstruction(wallet.publicKey));
      }

      // Ensure output ATA exists; if wSOL output → unwrap after swap
      const outAtaIx = await ensureAtaIx(connection, wallet.publicKey, mintOutPk, wallet.publicKey);
      if (outAtaIx) preIxs.push(outAtaIx);
      if (isWsolOut) postIxs.push(buildUnwrapInstruction(wallet.publicKey));

      const swapIx = await program.methods
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
        .instruction();

      const sig = await sendTx(connection, wallet, [...preIxs, swapIx, ...postIxs]);

      setStatus(`✅ Swap — tx: ${sig.slice(0, 16)}…`);
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
    setIdxIn(idxOut); setIdxOut(idxIn);
    setAmountIn(""); setEstimatedOut(null);
  }

  // ── Derived display values ────────────────────────────────────────────────
  const priceImpact = (() => {
    if (!pool || !amountIn || !estimatedOut || +amountIn <= 0) return null;
    const spotPrice = pool.reserveIn / pool.reserveOut;
    const execPrice = +amountIn / estimatedOut;
    return ((execPrice - spotPrice) / spotPrice) * 100;
  })();

  const minReceived = estimatedOut !== null
    ? estimatedOut * (1 - slippage / 100)
    : null;

  const noPool  = !pool && tokIn && tokOut && tokIn.mint !== tokOut.mint;
  const canSwap = !!wallet && !!amountIn && +amountIn > 0 && !!estimatedOut && !!pool && !loading;

  if (tokens.length < 2) {
    return <div className={embedded ? "text-gray-400 text-sm text-center py-8" : "card glow text-gray-400 text-sm text-center py-8"}>Loading…</div>;
  }

  return (
    <div className={embedded ? "" : "card glow"}>
      {!embedded && <h2 className="text-lg font-bold mb-5 text-white">AMM Swap</h2>}

      {/* ── Token In ────────────────────────────────────────── */}
      <div className="rounded-xl bg-brand-dark border border-brand-border p-4 mb-2">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">You pay</span>
          {balanceIn !== null && (
            <span className="text-xs text-gray-500">
              Balance:{" "}
              <button className="text-gray-300 hover:text-brand-green transition-colors font-mono"
                onClick={() => applyPct(100)}>
                {balanceIn.toLocaleString(undefined, { maximumFractionDigits: 4 })} {tokIn?.symbol}
              </button>
            </span>
          )}
        </div>

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
            type="text" inputMode="decimal" placeholder="0"
            value={amountIn} onChange={(e) => handleAmountChange(e.target.value)}
          />
        </div>

        <div className="flex gap-2 mt-3">
          {PCT_SHORTCUTS.map((pct) => (
            <button key={pct} onClick={() => applyPct(pct)} disabled={!balanceIn}
              className="flex-1 text-xs py-1 rounded-md border border-brand-border text-gray-400
                         hover:border-brand-green hover:text-brand-green transition-colors
                         disabled:opacity-30 disabled:cursor-not-allowed">
              {pct === 100 ? "Max" : `${pct}%`}
            </button>
          ))}
        </div>
      </div>

      {/* ── Flip ────────────────────────────────────────────── */}
      <div className="flex justify-center my-1">
        <button onClick={flip}
          className="w-8 h-8 rounded-full border border-brand-border text-gray-400
                     hover:border-brand-green hover:text-brand-green transition-colors text-lg leading-none">
          ⇅
        </button>
      </div>

      {/* ── Token Out ───────────────────────────────────────── */}
      <div className="rounded-xl bg-brand-dark border border-brand-border p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">You receive (est.)</span>
          {tokOut?.mint === WSOL_MINT && (
            <span className="text-xs text-brand-green/70">→ unwrapped to SOL natif</span>
          )}
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

      {/* ── Error / price info ──────────────────────────────── */}
      {noPool && (
        <p className="text-xs text-yellow-500 mb-3">
          No pool found for {tokIn?.symbol}/{tokOut?.symbol}. Create one in the Pools tab.
        </p>
      )}

      {/* Spot price — always visible when pool exists */}
      {pool && (
        <div className="flex justify-between text-xs text-gray-500 mb-2 px-1">
          <span>Prix</span>
          <span className="font-mono text-gray-300">
            1 {tokIn?.symbol} = {(pool.reserveOut / pool.reserveIn).toLocaleString(undefined, { maximumFractionDigits: 6 })} {tokOut?.symbol}
          </span>
        </div>
      )}

      {pool && estimatedOut !== null && +amountIn > 0 && (
        <div className="rounded-xl border border-brand-border p-3 mb-3 space-y-1.5 text-xs">
          <div className="flex justify-between text-gray-400">
            <span>Minimum reçu</span>
            <span className="font-mono text-white">{minReceived?.toFixed(6)} {tokOut?.symbol}</span>
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

      {/* ── Slippage ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs text-gray-400">Slippage:</span>
        {SLIPPAGE_OPTIONS.map((s) => (
          <button key={s} onClick={() => setSlippage(s)}
            className={`text-xs px-2 py-1 rounded border transition-colors ${
              slippage === s
                ? "border-brand-green text-brand-green"
                : "border-brand-border text-gray-500 hover:text-gray-300"
            }`}>{s}%
          </button>
        ))}
      </div>

      <button className="btn-primary w-full" onClick={swap} disabled={!canSwap}>
        {loading ? "Processing…" : "Swap"}
      </button>

      {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}

      {/* Devnet faucet */}
      <div className="mt-4 pt-4 border-t border-brand-border flex items-center justify-between">
        <span className="text-xs text-gray-500">Besoin de USDC de test ?</span>
        <button
          className="btn-secondary text-xs px-4 py-2"
          onClick={claimFaucet}
          disabled={faucetLoading || !wallet}
        >
          {faucetLoading ? "Envoi…" : "Get 500 USDC"}
        </button>
      </div>
    </div>
  );
}
