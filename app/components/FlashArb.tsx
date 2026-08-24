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
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { getProgram, statePda, poolPda, solaM, oSolaM, toUi, fromUi, PROGRAM_ID, sendTx } from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";

const CALLER_SHARE = 0.10; // 10% to caller, flash-arb direction only
const FEE_RATE     = 30;   // 0.30% default pool fee
const FLOOR        = 1;    // sell_sola pays exactly 1 USDC per SOLA, unconditionally
// Below this gap the profit is dust and not worth a transaction fee.
const MIN_GAP      = 0.0005;

// ── Why this page has two directions ─────────────────────────────────────────
//
// `flash_arbitrage` handles ONE of them. It burns oSOLA, mints floor-backed SOLA and sells it
// into the pool, and its on-chain check is `require!(usdc_out > amount_osola)` — the pool must
// pay MORE than 1 USDC per SOLA. So it is the tool for a pool trading ABOVE the floor, and it
// routes 90% of the profit to hiSOLA stakers.
//
// When the pool falls BELOW the floor that instruction correctly refuses, and until 2026-08-24
// this page stopped there: it printed "AMM price too low — not profitable" and went quiet,
// while displaying every number needed to see that the OPPOSITE trade was profitable.
//
// That was the real defect, and it was worse than a missing feature. A user watching SOLA
// quoted at 0.95 on this very screen had no way to learn that the protocol would pay them
// 1.00 for it — and that user is exactly who the floor exists to reassure. The page you go to
// for arbitrage told you there was none.
//
// The downward correction needs no dedicated instruction: buy SOLA cheap on the AMM, redeem it
// at exactly 1.00 through `sell_sola`, which reads only `floor_vault` and never the pool. Both
// legs go in ONE transaction here, so there is no window between them.
//
// ⚠️ Worth stating, because it is a real asymmetry an auditor should see: the protocol captures
// 90% of the value when the pool is overpriced, and nothing at all when it is underpriced —
// the whole spread goes to whoever arbitrages, and the LP pays it. The deviation that damages
// the headline promise is the one the protocol is not instrumented for.

interface ArbState {
  solaAmmPrice:  number;
  osolaBalance:  number;
  usdcBalance:   number;
  reserveSola:   number;
  reserveUsdc:   number;
  solaIsA:       boolean;
  poolAddress:   string;
}

function estimateOutput(amountIn: number, reserveIn: number, reserveOut: number, feeRate: number): number {
  if (reserveIn <= 0 || reserveOut <= 0 || amountIn <= 0) return 0;
  const feeTotal  = amountIn * feeRate / 10_000;
  const amountNet = amountIn - feeTotal;
  return (amountNet * reserveOut) / (reserveIn + amountNet);
}

/// USDC that brings the pool back to exactly 1.000000.
///
/// With x·y = k, a price of 1 means both reserves equal sqrt(k). Spending more than this
/// overshoots and starts LOSING money, which is why the page offers it as the default rather
/// than letting someone type "Max".
function amountToRestoreFloor(reserveUsdc: number, reserveSola: number, feeRate: number): number {
  const k = reserveUsdc * reserveSola;
  const target = Math.sqrt(k);
  if (target <= reserveUsdc) return 0;
  return (target - reserveUsdc) / (1 - feeRate / 10_000);
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

      const pool      = await (program.account as any).ammPool.fetch(poolPda(solaM, usdcMint));
      const mintA     = pool.tokenAMint.toString();
      const solaIsA   = mintA === solaM.toString();
      const ra        = toUi(pool.reserveA as BN);
      const rb        = toUi(pool.reserveB as BN);
      const reserveSola = solaIsA ? ra : rb;
      const reserveUsdc = solaIsA ? rb : ra;
      const solaPrice   = reserveUsdc / reserveSola;

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

      setArb({
        solaAmmPrice: solaPrice, osolaBalance, usdcBalance,
        reserveSola, reserveUsdc, solaIsA,
        poolAddress: poolPda(solaM, usdcMint).toBase58(),
      });
    } catch { }
  }, [connection, wallet, usdcMint]);

  useEffect(() => {
    fetchState();
    const id = setInterval(fetchState, 8_000);
    return () => clearInterval(id);
  }, [fetchState]);

  // ── Which way is the market wrong? ───────────────────────────────────────
  const price     = arb?.solaAmmPrice ?? FLOOR;
  const direction: "above" | "below" | "aligned" =
    !arb                       ? "aligned"
    : price > FLOOR + MIN_GAP  ? "above"
    : price < FLOOR - MIN_GAP  ? "below"
    :                            "aligned";

  const amt = parseFloat(amount) || 0;

  // ── Direction ABOVE: burn oSOLA → mint SOLA → sell high (flash_arbitrage) ──
  const usdcOut     = arb ? estimateOutput(amt, arb.reserveSola, arb.reserveUsdc, FEE_RATE) : 0;
  const grossProfit = Math.max(0, usdcOut - amt);   // floor takes 1 USDC per oSOLA
  const callerShare = grossProfit * CALLER_SHARE;
  const protShare   = grossProfit * (1 - CALLER_SHARE);

  // ── Direction BELOW: buy SOLA cheap → redeem at the floor ────────────────
  const suggested   = arb ? amountToRestoreFloor(arb.reserveUsdc, arb.reserveSola, FEE_RATE) : 0;
  const solaBought  = arb ? estimateOutput(amt, arb.reserveUsdc, arb.reserveSola, FEE_RATE) : 0;
  const redeemValue = solaBought * FLOOR;
  const buyProfit   = redeemValue - amt;
  const priceAfter  = arb && amt > 0
    ? (arb.reserveUsdc + amt * (1 - FEE_RATE / 10_000)) / (arb.reserveSola - solaBought)
    : price;

  const isProfitable = direction === "above" ? grossProfit > 0 && amt > 0
                     : direction === "below" ? buyProfit   > 0 && amt > 0
                     : false;
  const enoughUsdc   = direction !== "below" || !arb || amt <= arb.usdcBalance;

  // ── The floor guard, mirrored ─────────────────────────────────────────────
  // `require_floor_respected` refuses any trade that LEAVES the SOLA/USDC pool under 1.00,
  // and `flash_arbitrage` sells SOLA into that pool, so an oversized burn is refused on
  // chain. Profitability does not imply it fits: `usdc_out > amount_osola` constrains the
  // average price paid, the guard constrains the final price. Without this the page would
  // show a green profit for a size that reverts — the same gap the guard closes on chain.
  //
  // The largest burn that fits is the one landing both reserves on sqrt(k), which is also
  // very nearly the profit-maximising size, so the ceiling costs the caller almost nothing.
  const maxBurn = arb && arb.reserveUsdc > arb.reserveSola
    ? (Math.sqrt(arb.reserveUsdc * arb.reserveSola) - arb.reserveSola) / (1 - FEE_RATE / 10_000)
    : 0;
  const overshootsFloor = direction === "above" && amt > maxBurn;

  // ── Execute: ABOVE ────────────────────────────────────────────────────────
  async function executeFlashArb() {
    if (!wallet || !arb || !usdcMint || amt <= 0) return;
    setLoading(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);

      const poolPk      = new PublicKey(arb.poolAddress);
      const pool        = await (program.account as any).ammPool.fetch(poolPk);
      const s           = await (program.account as any).protocolState.fetch(statePda);

      const callerOSola = getAssociatedTokenAddressSync(oSolaM, wallet.publicKey);
      const callerSola  = getAssociatedTokenAddressSync(solaM, wallet.publicKey);
      const callerUsdc  = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
      const minProfit   = fromUi(Math.max(0, grossProfit * 0.95));

      const ix = await program.methods
        .flashArbitrage(fromUi(amt), minProfit)
        .accounts({
          caller: wallet.publicKey, protocolState: statePda,
          oSolaMint: oSolaM, solaMint: solaM,
          callerOSola, callerSola, callerUsdc, usdcMint,
          pool: poolPk,
          tokenAVault: pool.tokenAVault as PublicKey,
          tokenBVault: pool.tokenBVault as PublicKey,
          floorVault: s.floorVault as PublicKey,
          marketVault: s.marketVault as PublicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any)
        .instruction();

      const tx = await sendTx(connection, wallet, [ix]);
      setStatus(`✅ Flash arb executed — +${callerShare.toFixed(4)} USDC — tx: ${tx.slice(0, 16)}…`);
      setAmount(""); fetchState();
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally { setLoading(false); }
  }

  // ── Execute: BELOW — both legs in ONE transaction ─────────────────────────
  //
  // Atomic on purpose. Split across two transactions, someone else can arbitrage between them
  // and leave the first leg holding SOLA bought above the floor. Packed together, the trade
  // either completes or never happened.
  //
  // `sell_sola` takes an exact amount, and the swap output is only known at execution time, so
  // we sell `minOut` — the slippage-guarded floor of the estimate, which is guaranteed to have
  // landed. Any dust above it stays in the wallet rather than risking the whole transaction.
  async function executeBuyAndRedeem() {
    if (!wallet || !arb || !usdcMint || amt <= 0) return;
    setLoading(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);

      const poolPk = new PublicKey(arb.poolAddress);
      const pool   = await (program.account as any).ammPool.fetch(poolPk);
      const s      = await (program.account as any).protocolState.fetch(statePda);

      const userUsdc = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
      const userSola = getAssociatedTokenAddressSync(solaM, wallet.publicKey);

      const minOutUi = solaBought * 0.995;              // 0.5% slippage guard
      const minOut   = fromUi(minOutUi);

      // a_to_b spends mint A. We are spending USDC, so it is true when USDC is mint A.
      const aToB = !arb.solaIsA;

      const swapIx = await program.methods
        .ammSwap(fromUi(amt), minOut, aToB)
        .accounts({
          user: wallet.publicKey, pool: poolPk,
          tokenAVault: pool.tokenAVault as PublicKey,
          tokenBVault: pool.tokenBVault as PublicKey,
          userTokenIn: userUsdc, userTokenOut: userSola,
          marketVault: s.marketVault as PublicKey,
          protocolState: statePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();

      const sellIx = await program.methods
        .sellSola(minOut)
        .accounts({
          user: wallet.publicKey, protocolState: statePda, solaMint: solaM,
          userSola, floorVault: s.floorVault as PublicKey, userUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();

      const ataIx = createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey, userSola, wallet.publicKey, solaM);

      const tx = await sendTx(connection, wallet, [ataIx, swapIx, sellIx]);
      setStatus(`✅ Floor restored — +${buyProfit.toFixed(4)} USDC — tx: ${tx.slice(0, 16)}…`);
      setAmount(""); fetchState();
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally { setLoading(false); }
  }

  const profitColor = isProfitable ? "text-brand-green" : "text-gray-600";
  const gapPct = arb ? ((price - FLOOR) / FLOOR) * 100 : 0;

  return (
    <div className="card space-y-5">
      {/* Header — reflects the direction the market is actually wrong in */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">
            {direction === "below" ? "Floor Arbitrage" : "Flash Arbitrage"}
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {direction === "below"
              ? "Buy SOLA below the floor on the AMM → redeem at 1.00 USDC. One transaction."
              : "Burn oSOLA → mint SOLA → sell on AMM → split profit. Zero USDC upfront."}
          </p>
        </div>
        {direction === "above" && (
          <div className="text-right text-xs text-gray-500 border border-brand-border rounded px-2 py-1 shrink-0">
            <span className="text-brand-green font-bold">{(CALLER_SHARE * 100).toFixed(0)}%</span> caller
            {" / "}
            <span className="text-purple-400 font-bold">{((1 - CALLER_SHARE) * 100).toFixed(0)}%</span> hiSOLA stakers
          </div>
        )}
        {direction === "below" && (
          <div className="text-right text-xs border border-yellow-500/40 bg-yellow-500/10 rounded px-2 py-1 shrink-0">
            <span className="text-yellow-300 font-bold">100%</span>
            <span className="text-yellow-400/70"> to you</span>
          </div>
        )}
      </div>

      {/* Live market state */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl bg-brand-dark border border-brand-border p-3 text-center">
          <p className="text-xs text-gray-500 mb-1">SOLA AMM price</p>
          <p className={`font-bold ${direction === "below" ? "text-yellow-400" : "text-brand-green"}`}>
            {arb ? `${arb.solaAmmPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })} USDC` : "—"}
          </p>
          {arb && direction !== "aligned" && (
            <p className={`text-[10px] mt-0.5 ${direction === "below" ? "text-yellow-500" : "text-brand-green"}`}>
              {gapPct > 0 ? "+" : ""}{gapPct.toFixed(2)}% vs floor
            </p>
          )}
        </div>
        <div className="rounded-xl bg-brand-dark border border-brand-border p-3 text-center">
          <p className="text-xs text-gray-500 mb-1">
            {direction === "below" ? "USDC balance" : "oSOLA balance"}
          </p>
          <p className="font-bold text-white">
            {arb
              ? (direction === "below" ? arb.usdcBalance : arb.osolaBalance)
                  .toLocaleString(undefined, { maximumFractionDigits: 4 })
              : "—"}
          </p>
        </div>
        <div className="rounded-xl bg-brand-dark border border-brand-border p-3 text-center">
          <p className="text-xs text-gray-500 mb-1">Floor price</p>
          <p className="font-bold text-gray-400">1.0000 USDC</p>
          <p className="text-[10px] text-gray-600 mt-0.5">guaranteed by sell_sola</p>
        </div>
      </div>

      {/* Nothing to do */}
      {direction === "aligned" && (
        <div className="rounded-xl border border-brand-border p-6 text-center space-y-1">
          <p className="text-sm text-gray-400">The AMM is trading at the floor.</p>
          <p className="text-xs text-gray-600">
            Arbitrage opens when the pool moves away from 1.0000 USDC in either direction.
            This page follows whichever way it goes.
          </p>
        </div>
      )}

      {direction !== "aligned" && (
        <>
          {/* Amount */}
          <div className="rounded-xl bg-brand-dark border border-brand-border p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-400">
                {direction === "below" ? "USDC to deploy" : "oSOLA to arbitrage"}
              </span>
              {direction === "below" ? (
                suggested > 0 && (
                  <button
                    className="text-xs text-yellow-400 hover:underline font-mono"
                    onClick={() => setAmount(suggested.toFixed(6))}>
                    Restore floor {suggested.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </button>
                )
              ) : (
                arb && arb.osolaBalance > 0 && (
                  <button
                    className="text-xs text-brand-green hover:underline font-mono"
                    onClick={() => setAmount(String(arb.osolaBalance))}>
                    Max {arb.osolaBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                  </button>
                )
              )}
            </div>
            <input
              className="w-full bg-transparent text-right text-3xl font-black text-white placeholder-gray-700 focus:outline-none"
              type="text" inputMode="decimal" placeholder="0"
              value={amount}
              onChange={e => { if (e.target.value === "" || /^\d*\.?\d*$/.test(e.target.value)) setAmount(e.target.value); }}
            />
            {direction === "below" && suggested > 0 && (
              <p className="text-[11px] text-gray-600 mt-2">
                Spending more than {suggested.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
                pushes the pool past the floor and starts losing money.
              </p>
            )}
          </div>

          {/* Breakdown — ABOVE */}
          {direction === "above" && amt > 0 && (
            <div className="rounded-xl border border-brand-border p-4 space-y-2 text-sm">
              <div className="flex justify-between text-gray-500">
                <span>SOLA sold on AMM</span>
                <span className="font-mono text-white">{usdcOut.toFixed(4)} USDC</span>
              </div>
              <div className="flex justify-between text-gray-500">
                <span>Floor vault (backing)</span>
                <span className="font-mono text-red-400">−{amt.toFixed(4)} USDC</span>
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
            </div>
          )}

          {/* Breakdown — BELOW */}
          {direction === "below" && amt > 0 && (
            <div className="rounded-xl border border-brand-border p-4 space-y-2 text-sm">
              <div className="flex justify-between text-gray-500">
                <span>1. Buy on AMM</span>
                <span className="font-mono text-white">
                  {amt.toFixed(4)} USDC → {solaBought.toFixed(4)} SOLA
                </span>
              </div>
              <div className="flex justify-between text-gray-500">
                <span>2. Redeem at the floor</span>
                <span className="font-mono text-white">
                  {solaBought.toFixed(4)} SOLA → {redeemValue.toFixed(4)} USDC
                </span>
              </div>
              <div className="h-px bg-brand-border" />
              <div className="flex justify-between font-semibold">
                <span className="text-gray-400">Your profit</span>
                <span className={`font-mono ${profitColor}`}>
                  {buyProfit >= 0 ? "+" : ""}{buyProfit.toFixed(4)} USDC
                  {amt > 0 && <span className="text-xs text-gray-600 ml-1">({((buyProfit / amt) * 100).toFixed(2)}%)</span>}
                </span>
              </div>
              <div className="flex justify-between text-xs text-gray-500">
                <span>Pool price after</span>
                <span className="font-mono">{priceAfter.toFixed(6)} USDC</span>
              </div>
              {!enoughUsdc && (
                <p className="text-xs text-red-400 text-center pt-1">
                  ⚠ Not enough USDC — you hold {arb?.usdcBalance.toFixed(2)}
                </p>
              )}
              {enoughUsdc && buyProfit <= 0 && (
                <p className="text-xs text-red-400 text-center pt-1">
                  ⚠ Past the floor — this amount overshoots and loses money
                </p>
              )}
            </div>
          )}

          <button
            className="btn-primary w-full py-3 text-base font-bold"
            onClick={direction === "below" ? executeBuyAndRedeem : executeFlashArb}
            disabled={loading || !wallet || !isProfitable || !enoughUsdc || overshootsFloor}>
            {loading ? "Executing…"
              : !wallet ? "Connect your wallet"
              : amt <= 0 ? "Enter an amount"
              : !enoughUsdc ? "Not enough USDC"
              : overshootsFloor ? `Too large — max ${maxBurn.toFixed(4)} oSOLA before the floor`
              : !isProfitable ? "Not profitable at this size"
              : direction === "below" ? `Buy & redeem — earn ${buyProfit.toFixed(4)} USDC`
              : `Execute — earn ${callerShare.toFixed(4)} USDC`}
          </button>
        </>
      )}

      {status && <p className="text-xs text-gray-400 break-all">{status}</p>}

      <p className="text-xs text-gray-600 text-center">
        {direction === "below"
          ? "Both legs in one transaction · The floor pays 1.00 USDC whatever the AMM says"
          : "Atomic · No USDC capital required · On-chain enforced · Double slippage protection"}
      </p>
    </div>
  );
}
