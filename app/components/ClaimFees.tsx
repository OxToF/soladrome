"use client";
import { useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  getProgram, statePda, hiSolaM, marketVault,
  positionPda, userAta,
} from "@/lib/program";
import { TOKEN_PROGRAM_ID as SPL_TOKEN } from "@solana/spl-token";
import { useSoladrome } from "@/lib/SoladromeContext";

export function ClaimFees() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

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
        <div>
          <p className="text-xs text-gray-500">Source</p>
          <p className="font-semibold text-brand-green">Market Vault (Treasury)</p>
        </div>
      </div>

      <button
        className="btn-primary w-full"
        onClick={claim}
        disabled={loading || !wallet || !usdcMint}
      >
        {loading ? "Claiming…" : "Claim USDC Fees"}
      </button>

      {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
    </div>
  );
}
