// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import {
  getProgram, statePda, solaM, oSolaM, floorVault,
  userAta, poolPda, vaultAPda, vaultBPda,
  fromUi, toUi, commonAccounts, ensureAtaIx, sendTx,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";
import { trackQuest } from "@/lib/quests";
import { StatusBanner } from "./ui/StatusBanner";
import { EmptyState } from "./ui/EmptyState";

const PCT = [25, 50, 75, 100] as const;

export function Exercise({ embedded = false }: { embedded?: boolean }) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { sendTransaction } = useWallet();
  const { usdcMint } = useSoladrome();

  const [oSolaBal, setOSolaBal]   = useState<number | null>(null);
  const [usdcBal,  setUsdcBal]    = useState<number | null>(null);
  const [mktPrice, setMktPrice]   = useState<number | null>(null);
  const [poolPrice, setPoolPrice] = useState<number | null>(null);
  const [poolExists, setPoolExists] = useState<boolean | null>(null);
  const [amount, setAmount]       = useState("");
  const [loading, setLoading]     = useState(false);
  const [status,  setStatus]      = useState("");

  const fetchAll = useCallback(async () => {
    if (!wallet || !usdcMint) return;
    const provider = new AnchorProvider(connection, wallet, {});
    const program  = getProgram(provider);

    const [oSolaAta, usdcAta] = [
      userAta(oSolaM, wallet.publicKey),
      userAta(usdcMint, wallet.publicKey),
    ];

    const [oSolaInfo, usdcInfo, state] = await Promise.allSettled([
      connection.getTokenAccountBalance(oSolaAta),
      connection.getTokenAccountBalance(usdcAta),
      (program.account as any).protocolState.fetch(statePda),
    ]);

    if (oSolaInfo.status === "fulfilled") setOSolaBal(oSolaInfo.value.value.uiAmount ?? 0);
    else setOSolaBal(0);

    if (usdcInfo.status === "fulfilled") setUsdcBal(usdcInfo.value.value.uiAmount ?? 0);
    else setUsdcBal(0);

    if (state.status === "fulfilled") {
      const s = state.value as any;
      const vUsdc = toUi(s.virtualUsdc as BN);
      const vSola = toUi(s.virtualSola as BN);
      setMktPrice(vSola > 0 ? vUsdc / vSola : 1);
    }

    // Check if oSOLA/USDC pool exists and get its price
    try {
      const pool = poolPda(oSolaM, usdcMint);
      const poolData = await (program.account as any).ammPool.fetch(pool);
      const mintA = poolData.tokenAMint.toString();
      const ra = toUi(poolData.reserveA as BN);
      const rb = toUi(poolData.reserveB as BN);
      // price of oSOLA in USDC: if mintA = oSOLA → price = rb/ra, else ra/rb
      const price = mintA === oSolaM.toString() ? (rb / ra) : (ra / rb);
      setPoolPrice(price);
      setPoolExists(true);
    } catch {
      setPoolExists(false);
      setPoolPrice(null);
    }
  }, [connection, wallet, usdcMint]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  function applyPct(pct: number) {
    if (!oSolaBal || oSolaBal <= 0) return;
    setAmount(((oSolaBal * pct) / 100).toFixed(6).replace(/\.?0+$/, ""));
  }

  async function exercise() {
    if (!wallet || !usdcMint || !amount) return;
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { setStatus("❌ Invalid amount"); return; }

    setLoading(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);

      const userOSola = userAta(oSolaM, wallet.publicKey);
      const userSola  = userAta(solaM,  wallet.publicKey);
      const userUsdc  = userAta(usdcMint, wallet.publicKey);

      // Ensure SOLA ATA exists
      const solaAtaIx = await ensureAtaIx(connection, wallet.publicKey, solaM, wallet.publicKey);
      if (solaAtaIx) {
        await sendTx(connection, wallet, [solaAtaIx]);
      }

      const ix = await program.methods
        .exerciseOSola(fromUi(amt))
        .accounts({
          user:                  wallet.publicKey,
          protocolState:         statePda,
          solaMint:              solaM,
          oSolaMint:             oSolaM,
          userOSola,
          userSola,
          floorVault,
          userUsdc,
          ...commonAccounts,
        } as any)
        .instruction();
      const tx = await sendTx(connection, wallet, [ix]);

      setStatus(`✅ ${amt} oSOLA exercised → SOLA — tx: ${tx.slice(0, 16)}…`);
      trackQuest(wallet.publicKey.toBase58(), "exercise");
      setAmount("");
      fetchAll();
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  const intrinsicValue = mktPrice !== null ? Math.max(0, mktPrice - 1) : null;
  const usdcCost = amount ? parseFloat(amount) || 0 : 0;
  const canExercise = usdcBal !== null && usdcCost > 0 && usdcBal >= usdcCost;

  if (embedded) return (
    <div>
      {/* Inline stats strip */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <div className="rounded-lg bg-brand-dark border border-brand-border p-3 text-center">
          <p className="text-xs text-gray-500 mb-0.5">Balance oSOLA</p>
          <p className="font-bold text-white text-sm">
            {oSolaBal !== null ? oSolaBal.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}
          </p>
        </div>
        <div className="rounded-lg bg-brand-dark border border-brand-border p-3 text-center">
          <p className="text-xs text-gray-500 mb-0.5">Intrinsic value</p>
          <p className={`font-bold text-sm ${intrinsicValue && intrinsicValue > 0 ? "text-brand-green" : "text-gray-400"}`}>
            {intrinsicValue !== null ? `$${intrinsicValue.toFixed(4)}` : "—"}
          </p>
        </div>
      </div>

      <p className="text-xs text-gray-500 mb-4">
        Pay 1 USDC per oSOLA → burns oSOLA → receive 1 SOLA at floor price.
        Profit if market price &gt; $1.00.
      </p>

      {wallet && oSolaBal === 0 && (
        <EmptyState
          icon="📈"
          title="No oSOLA to exercise yet."
          hint="You receive oSOLA from LP emissions or bribe rewards."
        />
      )}

      <div className="rounded-xl bg-brand-dark border border-brand-border p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">oSOLA to exercise</span>
          {oSolaBal !== null && (
            <span className="text-xs text-gray-500">
              Balance:{" "}
              <button className="text-gray-300 hover:text-brand-green transition-colors font-mono"
                onClick={() => applyPct(100)}>
                {oSolaBal.toLocaleString(undefined, { maximumFractionDigits: 4 })} oSOLA
              </button>
            </span>
          )}
        </div>
        <input
          className="w-full bg-transparent text-right text-2xl font-bold text-white placeholder-gray-600 focus:outline-none mb-3"
          type="text" inputMode="decimal" placeholder="0"
          value={amount} onChange={(e) => setAmount(e.target.value)}
        />
        <div className="flex gap-2">
          {PCT.map((pct) => (
            <button key={pct} onClick={() => applyPct(pct)} disabled={!oSolaBal}
              className="flex-1 text-xs py-1 rounded-md border border-brand-border text-gray-400
                         hover:border-brand-green hover:text-brand-green transition-colors
                         disabled:opacity-30 disabled:cursor-not-allowed">
              {pct === 100 ? "Max" : `${pct}%`}
            </button>
          ))}
        </div>
      </div>

      {usdcCost > 0 && (
        <div className="rounded-xl bg-brand-dark border border-brand-border p-3 mb-4 text-xs space-y-1">
          <div className="flex justify-between text-gray-400">
            <span>USDC cost</span>
            <span className="text-white font-mono">{usdcCost.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC</span>
          </div>
          <div className="flex justify-between text-gray-400">
            <span>SOLA received</span>
            <span className="text-white font-mono">{usdcCost.toLocaleString(undefined, { maximumFractionDigits: 6 })} SOLA</span>
          </div>
          {intrinsicValue !== null && (
            <div className="flex justify-between border-t border-brand-border pt-1 mt-1">
              <span className="text-gray-400">Estimated profit</span>
              <span className={`font-mono font-bold ${intrinsicValue * usdcCost > 0 ? "text-brand-green" : "text-gray-500"}`}>
                ${(intrinsicValue * usdcCost).toFixed(4)}
              </span>
            </div>
          )}
          {usdcBal !== null && usdcCost > usdcBal && (
            <p className="text-red-400 pt-1">Insufficient USDC balance ({usdcBal.toFixed(2)} available)</p>
          )}
        </div>
      )}

      <button className="btn-primary w-full" onClick={exercise}
        disabled={loading || !wallet || !amount || !canExercise}>
        {loading ? "Exercising…" : "Exercise oSOLA → SOLA"}
      </button>
      <StatusBanner message={status} />
    </div>
  );

  return (
    <div className="space-y-6">

      {/* Header stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card text-center">
          <p className="text-xs text-gray-500 uppercase tracking-widest mb-1">Balance oSOLA</p>
          <p className="text-xl font-bold text-white">
            {oSolaBal !== null ? oSolaBal.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}
          </p>
        </div>
        <div className="card text-center">
          <p className="text-xs text-gray-500 uppercase tracking-widest mb-1">Prix Floor</p>
          <p className="text-xl font-bold text-white">$1.00</p>
          <p className="text-xs text-gray-500">Exercise cost / oSOLA</p>
        </div>
        <div className="card text-center">
          <p className="text-xs text-gray-500 uppercase tracking-widest mb-1">SOLA Market Price</p>
          <p className="text-xl font-bold text-brand-green">
            {mktPrice !== null ? `$${mktPrice.toFixed(4)}` : "—"}
          </p>
        </div>
        <div className="card text-center">
          <p className="text-xs text-gray-500 uppercase tracking-widest mb-1">Intrinsic Value</p>
          <p className={`text-xl font-bold ${intrinsicValue && intrinsicValue > 0 ? "text-brand-green" : "text-gray-400"}`}>
            {intrinsicValue !== null ? `$${intrinsicValue.toFixed(4)}` : "—"}
          </p>
          <p className="text-xs text-gray-500">per oSOLA exercised</p>
        </div>
      </div>

      {/* Exercise form */}
      <div className="card">
        <h2 className="text-lg font-bold text-white mb-1">Exercise oSOLA</h2>
        <p className="text-xs text-gray-500 mb-6">
          Pay 1 USDC per oSOLA → burns oSOLA → receive 1 SOLA at floor price.
          Profit if market price &gt; $1.00.
        </p>

        {wallet && oSolaBal === 0 && (
          <EmptyState
            icon="📈"
            title="No oSOLA to exercise yet."
            hint="You receive oSOLA from LP emissions or bribe rewards."
          />
        )}

        <div className="rounded-xl bg-brand-dark border border-brand-border p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-400">oSOLA to exercise</span>
            {oSolaBal !== null && (
              <span className="text-xs text-gray-500">
                Balance:{" "}
                <button
                  className="text-gray-300 hover:text-brand-green transition-colors font-mono"
                  onClick={() => applyPct(100)}
                >
                  {oSolaBal.toLocaleString(undefined, { maximumFractionDigits: 4 })} oSOLA
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
                disabled={!oSolaBal}
                className="flex-1 text-xs py-1 rounded-md border border-brand-border text-gray-400
                           hover:border-brand-green hover:text-brand-green transition-colors
                           disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {pct === 100 ? "Max" : `${pct}%`}
              </button>
            ))}
          </div>
        </div>

        {/* Cost summary */}
        {usdcCost > 0 && (
          <div className="rounded-xl bg-brand-dark border border-brand-border p-3 mb-4 text-xs space-y-1">
            <div className="flex justify-between text-gray-400">
              <span>USDC cost</span>
              <span className="text-white font-mono">{usdcCost.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC</span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>SOLA received</span>
              <span className="text-white font-mono">{usdcCost.toLocaleString(undefined, { maximumFractionDigits: 6 })} SOLA</span>
            </div>
            {intrinsicValue !== null && (
              <div className="flex justify-between border-t border-brand-border pt-1 mt-1">
                <span className="text-gray-400">Estimated profit</span>
                <span className={`font-mono font-bold ${intrinsicValue * usdcCost > 0 ? "text-brand-green" : "text-gray-500"}`}>
                  ${(intrinsicValue * usdcCost).toFixed(4)}
                </span>
              </div>
            )}
            {usdcBal !== null && usdcCost > usdcBal && (
              <p className="text-red-400 pt-1">Insufficient USDC balance ({usdcBal.toFixed(2)} USDC available)</p>
            )}
          </div>
        )}

        <button
          className="btn-primary w-full"
          onClick={exercise}
          disabled={loading || !wallet || !amount || !canExercise}
        >
          {loading ? "Exercising…" : "Exercise oSOLA → SOLA"}
        </button>

        <StatusBanner message={status} />
      </div>

      {/* oSOLA/USDC Pool card */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-base font-bold text-white">Pool oSOLA / USDC</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Arbitrageurs exercise when pool price &gt; $1.00
            </p>
          </div>
          {poolExists === true && (
            <span className="text-xs text-brand-green border border-brand-green/30 rounded px-2 py-0.5">Active</span>
          )}
          {poolExists === false && (
            <span className="text-xs text-gray-500 border border-brand-border rounded px-2 py-0.5">No pool</span>
          )}
        </div>

        {poolExists === true && poolPrice !== null && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center mb-4">
            <div>
              <p className="text-xs text-gray-500 mb-1">Pool price</p>
              <p className="font-bold text-brand-green">${poolPrice.toFixed(4)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Spread / Floor</p>
              <p className={`font-bold ${poolPrice > 1 ? "text-brand-green" : "text-gray-400"}`}>
                {poolPrice > 1 ? `+${((poolPrice - 1) * 100).toFixed(2)}%` : `${((poolPrice - 1) * 100).toFixed(2)}%`}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Arbitrage</p>
              <p className={`font-bold text-xs ${poolPrice > 1 ? "text-brand-green" : "text-gray-500"}`}>
                {poolPrice > 1 ? "✓ Profitable" : "Price ≤ floor"}
              </p>
            </div>
          </div>
        )}

        {poolExists === false && (
          <p className="text-xs text-gray-400 mb-4">
            No one has created this pool yet. Be the first LPer and capture arbitrage fees.
          </p>
        )}

        <button
          className="btn-secondary w-full text-sm"
          onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: poolExists ? "pools" : "pools" }))}
        >
          {poolExists ? "Manage liquidity →" : "Create oSOLA/USDC pool →"}
        </button>
      </div>

    </div>
  );
}
