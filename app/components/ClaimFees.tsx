// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import {
  getProgram, statePda, hiSolaM, marketVault,
  positionPda, userAta, sendTx,
} from "@/lib/program";
import { TOKEN_PROGRAM_ID as SPL_TOKEN } from "@solana/spl-token";
import { useSoladrome } from "@/lib/SoladromeContext";
import { computeClaimableFees } from "@/lib/claims";
import { StatusBanner } from "./ui/StatusBanner";

export function ClaimFees() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [claimable, setClaimable] = useState<number | null>(null);

  const computeClaimable = useCallback(async () => {
    if (!wallet || !usdcMint) { setClaimable(null); return; }
    setClaimable(await computeClaimableFees(connection, wallet, usdcMint));
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

      // Auto-migrate UserPosition if on old 128-byte layout
      const posInfo = await connection.getAccountInfo(position);
      if (posInfo && posInfo.data.length === 128) {
        setStatus("Migrating account layout…");
        const migIx = await program.methods.migrateUserPosition()
          .accounts({ user: wallet.publicKey, userPosition: position, systemProgram: SystemProgram.programId } as any)
          .instruction();
        await sendTx(connection, wallet, [migIx]);
      }

      const ix = await program.methods
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
        .instruction();
      const tx = await sendTx(connection, wallet, [ix]);
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
          <p className="text-xs text-gray-500">Available</p>
          <p className={`text-lg font-black ${claimable && claimable > 0 ? "text-brand-green" : "text-gray-500"}`}>
            {claimable === null ? "…" : `${claimable.toLocaleString(undefined, { maximumFractionDigits: 4 })} USDC`}
          </p>
        </div>
      </div>

      {claimable !== null && claimable === 0 && (
        <p className="text-xs text-gray-500 text-center mb-4">
          No fees to claim yet — fees accrue after your last stake/claim.
        </p>
      )}

      <button
        className="btn-primary w-full"
        onClick={claim}
        disabled={loading || !wallet || !usdcMint || claimable === 0}
      >
        {loading ? "Claiming…" : claimable && claimable > 0 ? `Claim ${claimable.toLocaleString(undefined, { maximumFractionDigits: 4 })} USDC` : "Claim USDC Fees"}
      </button>

      <StatusBanner message={status} />
    </div>
  );
}