// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  getProgram, statePda, hiSolaM, marketVault,
  positionPda, userAta, toUi,
} from "@/lib/program";
import { TOKEN_PROGRAM_ID as SPL_TOKEN } from "@solana/spl-token";
import { useSoladrome } from "@/lib/SoladromeContext";

const PRECISION = BigInt("1000000000000"); // 1e12

function jsAdvanceAccumulator(acc: bigint, mktBal: bigint, lastBal: bigint, totalHi: bigint): bigint {
  if (mktBal <= lastBal || totalHi === 0n) return acc;
  return acc + (mktBal - lastBal) * PRECISION / totalHi;
}

function jsPendingFees(acc: bigint, debt: bigint, hiBal: bigint): bigint {
  const delta = acc > debt ? acc - debt : 0n;
  return delta * hiBal / PRECISION;
}

export function ClaimFees() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [claimable, setClaimable] = useState<number | null>(null);

  const computeClaimable = useCallback(async () => {
    if (!wallet || !usdcMint) { setClaimable(null); return; }
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const [stateRes, posRes, mktRes, hiRes] = await Promise.allSettled([
        (program.account as any).protocolState.fetch(statePda),
        (program.account as any).userPosition.fetch(positionPda(wallet.publicKey)),
        connection.getTokenAccountBalance(marketVault),
        connection.getTokenAccountBalance(userAta(hiSolaM, wallet.publicKey)),
      ]);

      if (stateRes.status !== "fulfilled" || posRes.status !== "fulfilled") { setClaimable(0); return; }
      const s      = stateRes.value as any;
      const pos    = posRes.value as any;
      const mktBal = mktRes.status === "fulfilled" ? BigInt(mktRes.value.value.amount) : 0n;
      const hiBal  = hiRes.status  === "fulfilled" ? BigInt(hiRes.value.value.amount)  : 0n;

      const acc  = jsAdvanceAccumulator(
        BigInt(s.feesPerHiSola.toString()),
        mktBal,
        BigInt(s.lastMarketVaultBalance.toString()),
        BigInt(s.totalHiSola.toString()),
      );
      const raw = jsPendingFees(acc, BigInt(pos.feesDebt.toString()), hiBal);
      setClaimable(Number(raw) / 1e6);
    } catch { setClaimable(0); }
  }, [connection, wallet, usdcMint]);

  useEffect(() => { computeClaimable(); }, [computeClaimable]);

  async function claim() {
    if (!wallet || !usdcMint) return;
    setLoading(true);
    setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program = getProgram(provider);
      const usdcMintPk = usdcMint;
      const userHiSola = userAta(hiSolaM, wallet.publicKey);
      const userUsdc   = userAta(usdcMintPk, wallet.publicKey);
      const position   = positionPda(wallet.publicKey);

      const tx = await program.methods
        .claimFees()
        .accounts({
          user: wallet.publicKey,
          protocolState: statePda,
          hiSolaMint: hiSolaM,
          userHiSola,
          marketVault,
          userUsdc,
          userPosition: position,
          tokenProgram: SPL_TOKEN,
        } as any)
        .rpc();
      setStatus(`✅ Fees claimed — tx: ${tx.slice(0, 16)}…`);
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2 className="text-lg font-bold mb-2 text-white">Claim Fees</h2>
      <p className="text-sm text-gray-400 mb-6">
        Your pro-rata share of protocol fees from the market vault.
        No admin required — the treasury PDA signs directly.
      </p>

      <div className="flex items-center gap-3 mb-6 p-4 rounded-xl bg-brand-dark border border-brand-border">
        <span className="text-2xl">🏦</span>
        <div className="flex-1">
          <p className="text-xs text-gray-500">Source</p>
          <p className="font-semibold text-brand-green">Market Vault (Treasury)</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500">Disponible</p>
          <p className={`text-lg font-black ${claimable && claimable > 0 ? "text-brand-green" : "text-gray-500"}`}>
            {claimable === null ? "…" : `${claimable.toLocaleString(undefined, { maximumFractionDigits: 4 })} USDC`}
          </p>
        </div>
      </div>

      {claimable !== null && claimable === 0 && (
        <p className="text-xs text-gray-500 text-center mb-4">
          Aucun fee à réclamer pour l'instant — les fees s'accumulent après votre dernier stake/claim.
        </p>
      )}

      <button
        className="btn-primary w-full"
        onClick={claim}
        disabled={loading || !wallet || !usdcMint || claimable === 0}
      >
        {loading ? "Claiming…" : claimable && claimable > 0 ? `Claim ${claimable.toLocaleString(undefined, { maximumFractionDigits: 4 })} USDC` : "Claim USDC Fees"}
      </button>

      {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
    </div>
  );
}