// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { getProgram, statePda, poolPda, solaM, oSolaM, toUi, fromUi, PROGRAM_ID, sendTx } from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";

const CALLER_SHARE = 0.10; // 10% to caller
const FEE_RATE     = 30;   // 0.30% default pool fee

interface ArbState {
  solaAmmPrice:  number;
  osolaBalance:  number;
  usdcBalance:   number;
  poolReserveIn: number;
  poolReserveOut: number;
  solaIsA:       boolean;
  poolAddress:   string;
}

function estimateOutput(amountIn: number, reserveIn: number, reserveOut: number, feeRate: number): number {
  if (reserveIn <= 0 || reserveOut <= 0 || amountIn <= 0) return 0;
  const feeTotal  = amountIn * feeRate / 10_000;
  const amountNet = amountIn - feeTotal;
  return (amountNet * reserveOut) / (reserveIn + amountNet);
}

export function FlashArb() {
  const { connection } = useConnection();
  const wallet         = useAnchorWallet();
  const { usdcMint }   = useSoladrome();

  const [arb,     setArb]     = useState<ArbState | null>(null);
  const [amount,  setAmount]  = useState("");
  const [loading, setLoading] = useState(false);
  const [status,  setStatus]  = useState("");

  const fetchState = useCallback(async () => {
    if (!usdcMint) return;
    try {
      const provider = new AnchorProvider(connection, wallet ?? ({} as any), {});
      const program  = getProgram(provider);

      // Pool SOLA/USDC
      const pool      = await (program.account as any).ammPool.fetch(poolPda(solaM, usdcMint));
      const mintA     = pool.tokenAMint.toString();
      const solaIsA   = mintA === solaM.toString();
      const ra        = toUi(pool.reserveA as BN);
      const rb        = toUi(pool.reserveB as BN);
      const solaPrice = solaIsA ? rb / ra : ra / rb;

      const [reserveIn, reserveOut] = solaIsA ? [ra, rb] : [rb, ra];

      const poolAddr  = poolPda(solaM, usdcMint).toBase58();

      // Wallet balances
      let osolaBalance = 0;
      let usdcBalance  = 0;
      if (wallet) {
        try {
          const ataOsola = getAssociatedTokenAddressSync(oSolaM, wallet.publicKey);
          osolaBalance   = (await connection.getTokenAccountBalance(ataOsola)).value.uiAmount ?? 0;
        } catch { }
        try {
          const ataUsdc = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
          usdcBalance   = (await connection.getTokenAccountBalance(ataUsdc)).value.uiAmount ?? 0;
        } catch { }
      }

      setArb({ solaAmmPrice: solaPrice, osolaBalance, usdcBalance, poolReserveIn: reserveIn, poolReserveOut: reserveOut, solaIsA, poolAddress: poolAddr });
    } catch { }
  }, [connection, wallet, usdcMint]);

  useEffect(() => {
    fetchState();
    const id = setInterval(fetchState, 8_000);
    return () => clearInterval(id);
  }, [fetchState]);

  // ── Estimated output for given amount ────────────────────────────────────
  const amt         = parseFloat(amount) || 0;
  const usdcOut     = arb ? estimateOutput(amt, arb.poolReserveIn, arb.poolReserveOut, FEE_RATE) : 0;
  const floorCost   = amt;                       // 1 USDC per oSOLA exercised
  const grossProfit = Math.max(0, usdcOut - floorCost);
  const callerShare = grossProfit * CALLER_SHARE;
  const protShare   = grossProfit * (1 - CALLER_SHARE);
  const isProfitable = grossProfit > 0 && amt > 0;

  async function executeFlashArb() {
    if (!wallet || !arb || !usdcMint || amt <= 0) return;
    setLoading(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);

      const poolPk        = new PublicKey(arb.poolAddress);
      const pool          = await (program.account as any).ammPool.fetch(poolPk);
      const mintA         = pool.tokenAMint as PublicKey;
      const mintB         = pool.tokenBMint as PublicKey;
      const tokenAVault   = pool.tokenAVault as PublicKey;
      const tokenBVault   = pool.tokenBVault as PublicKey;

      const [statePdaAcc] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
      const s             = await (program.account as any).protocolState.fetch(statePdaAcc);
      const floorVault    = s.floorVault as PublicKey;
      const marketVault   = s.marketVault as PublicKey;

      const callerOSola = getAssociatedTokenAddressSync(oSolaM, wallet.publicKey);
      const callerSola  = getAssociatedTokenAddressSync(solaM, wallet.publicKey);
      const callerUsdc  = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);

      const minProfit = fromUi(Math.max(0, grossProfit * 0.95)); // 5% slippage tolerance

      const ix = await program.methods
        .flashArbitrage(fromUi(amt), minProfit)
        .accounts({
          caller:                 wallet.publicKey,
          protocolState:          statePdaAcc,
          oSolaMint:              oSolaM,
          solaMint:               solaM,
          callerOSola,
          callerSola,
          callerUsdc,
          usdcMint,
          pool:                   poolPk,
          tokenAVault,
          tokenBVault,
          floorVault,
          marketVault,
          tokenProgram:           TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram:          SystemProgram.programId,
          rent:                   SYSVAR_RENT_PUBKEY,
        } as any)
        .instruction();
      const tx = await sendTx(connection, wallet, [ix]);

      setStatus(`✅ Flash arb executed — +${callerShare.toFixed(4)} USDC — tx: ${tx.slice(0, 16)}…`);
      setAmount("");
      fetchState();
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  const profitColor = isProfitable ? "text-brand-green" : "text-gray-600";

  return (
    <div className="card space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">Flash Arbitrage</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Burn oSOLA → mint SOLA → sell on AMM → split profit. Zero USDC upfront.
          </p>
        </div>
        <div className="text-right text-xs text-gray-500 border border-brand-border rounded px-2 py-1">
          <span className="text-brand-green font-bold">{(CALLER_SHARE * 100).toFixed(0)}%</span> caller
          {" / "}
          <span className="text-purple-400 font-bold">{((1 - CALLER_SHARE) * 100).toFixed(0)}%</span> hiSOLA stakers
        </div>
      </div>

      {/* Live market state */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl bg-brand-dark border border-brand-border p-3 text-center">
          <p className="text-xs text-gray-500 mb-1">SOLA AMM price</p>
          <p className="font-bold text-brand-green">
            {arb ? `${arb.solaAmmPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })} USDC` : "—"}
          </p>
        </div>
        <div className="rounded-xl bg-brand-dark border border-brand-border p-3 text-center">
          <p className="text-xs text-gray-500 mb-1">oSOLA balance</p>
          <p className="font-bold text-white">
            {arb ? arb.osolaBalance.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}
          </p>
        </div>
        <div className="rounded-xl bg-brand-dark border border-brand-border p-3 text-center">
          <p className="text-xs text-gray-500 mb-1">Floor price</p>
          <p className="font-bold text-gray-400">1.0000 USDC</p>
        </div>
      </div>

      {/* Amount input */}
      <div className="rounded-xl bg-brand-dark border border-brand-border p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-gray-400">oSOLA to arbitrage</span>
          {arb && arb.osolaBalance > 0 && (
            <button
              className="text-xs text-brand-green hover:underline font-mono"
              onClick={() => setAmount(String(arb.osolaBalance))}>
              Max {arb.osolaBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </button>
          )}
        </div>
        <input
          className="w-full bg-transparent text-right text-3xl font-black text-white placeholder-gray-700 focus:outline-none"
          type="text" inputMode="decimal" placeholder="0"
          value={amount}
          onChange={e => { if (e.target.value === "" || /^\d*\.?\d*$/.test(e.target.value)) setAmount(e.target.value); }}
        />
        <div className="flex gap-2 mt-3">
          {[25, 50, 75, 100].map(pct => (
            <button key={pct}
              disabled={!arb || arb.osolaBalance <= 0}
              onClick={() => arb && setAmount(((arb.osolaBalance * pct) / 100).toFixed(6).replace(/\.?0+$/, ""))}
              className="flex-1 text-xs py-1 rounded-md border border-brand-border text-gray-500
                         hover:border-brand-green hover:text-brand-green transition-colors
                         disabled:opacity-30 disabled:cursor-not-allowed">
              {pct === 100 ? "Max" : `${pct}%`}
            </button>
          ))}
        </div>
      </div>

      {/* Profit breakdown */}
      {amt > 0 && (
        <div className="rounded-xl border border-brand-border p-4 space-y-2 text-sm">
          <div className="flex justify-between text-gray-500">
            <span>SOLA received (AMM)</span>
            <span className="font-mono text-white">{usdcOut.toFixed(4)} USDC</span>
          </div>
          <div className="flex justify-between text-gray-500">
            <span>Floor vault (backing)</span>
            <span className="font-mono text-red-400">−{floorCost.toFixed(4)} USDC</span>
          </div>
          <div className="h-px bg-brand-border" />
          <div className="flex justify-between font-semibold">
            <span className="text-gray-400">Gross profit</span>
            <span className={`font-mono ${profitColor}`}>{grossProfit.toFixed(4)} USDC</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-brand-green">Your share (10%)</span>
            <span className="font-mono text-brand-green">+{callerShare.toFixed(4)} USDC</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-purple-400">hiSOLA stakers (90%)</span>
            <span className="font-mono text-purple-400">+{protShare.toFixed(4)} USDC</span>
          </div>
          {!isProfitable && amt > 0 && (
            <p className="text-xs text-red-400 text-center pt-1">
              ⚠ AMM price too low — not profitable after floor replenishment
            </p>
          )}
        </div>
      )}

      <button
        className="btn-primary w-full py-3 text-base font-bold"
        onClick={executeFlashArb}
        disabled={loading || !wallet || !isProfitable}>
        {loading ? "Executing…"
          : !wallet ? "Connect your wallet"
          : !isProfitable && amt > 0 ? "Not profitable"
          : amt > 0 ? `Execute — earn ${callerShare.toFixed(4)} USDC`
          : "Enter an amount"}
      </button>

      {status && <p className="text-xs text-gray-400 break-all">{status}</p>}

      <p className="text-xs text-gray-600 text-center">
        Atomic · No USDC capital required · On-chain enforced · Double slippage protection
      </p>
    </div>
  );
}
