// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { getProgram, statePda, fromUi } from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";

// ── Epoch helpers ─────────────────────────────────────────────────────────────
const EPOCH_S = 7 * 24 * 60 * 60;
function currentEpoch() { return Math.floor(Date.now() / 1000 / EPOCH_S); }
function epochLabel(e: number) {
  const start = new Date(e * EPOCH_S * 1000);
  const end   = new Date((e + 1) * EPOCH_S * 1000);
  return `Epoch ${e} · ${start.toLocaleDateString()} – ${end.toLocaleDateString()}`;
}

// ── PDA helpers ───────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
function epochBuf(epoch: number) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(epoch >>> 0, 0);
  b.writeUInt32LE(Math.floor(epoch / 2 ** 32), 4);
  return b;
}
function bribeVaultPda(pool: PublicKey, mint: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bribe_vault"), pool.toBuffer(), mint.toBuffer(), epochBuf(epoch)], PROGRAM_ID)[0];
}
function bribeTokensPda(pool: PublicKey, mint: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bribe_tokens"), pool.toBuffer(), mint.toBuffer(), epochBuf(epoch)], PROGRAM_ID)[0];
}
function gaugePda(pool: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("gauge"), pool.toBuffer(), epochBuf(epoch)], PROGRAM_ID)[0];
}
function votePda(user: PublicKey, pool: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vote"), user.toBuffer(), pool.toBuffer(), epochBuf(epoch)], PROGRAM_ID)[0];
}
function claimPda(user: PublicKey, pool: PublicKey, mint: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bribe_claim"), user.toBuffer(), pool.toBuffer(), mint.toBuffer(), epochBuf(epoch)], PROGRAM_ID)[0];
}

type Tab = "deposit" | "claim";

// ── Component ─────────────────────────────────────────────────────────────────
export function Gauge() {
  const { connection } = useConnection();
  const wallet         = useAnchorWallet();
  const { usdcMint }   = useSoladrome();
  const epoch          = currentEpoch();

  const [tab,        setTab]        = useState<Tab>("deposit");
  const [poolId,     setPoolId]     = useState("");
  const [rewardMint, setRewardMint] = useState("");
  const [amount,     setAmount]     = useState("");
  const [claimEpoch, setClaimEpoch] = useState(String(epoch - 1));
  const [loading,    setLoading]    = useState(false);
  const [status,     setStatus]     = useState("");

  function parsePool(): PublicKey | null { try { return new PublicKey(poolId); } catch { return null; } }
  function parseMint(): PublicKey | null { try { return new PublicKey(rewardMint); } catch { return null; } }

  // ── Deposit bribe ────────────────────────────────────────────────────────────
  async function depositBribe() {
    if (!wallet || !amount) return;
    const pool = parsePool(); const mint = parseMint();
    if (!pool || !mint) { setStatus("❌ Adresse pool ou mint invalide"); return; }
    setLoading(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const depositorToken = getAssociatedTokenAddressSync(mint, wallet.publicKey);
      const bribeVault     = bribeVaultPda(pool, mint, epoch);
      const bribeTokenVault = bribeTokensPda(pool, mint, epoch);
      const tx = await program.methods
        .depositBribe(new BN(epoch), fromUi(+amount))
        .accounts({
          depositor: wallet.publicKey, poolId: pool, rewardMint: mint,
          depositorToken, bribeVault, bribeTokenVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any).rpc();
      setStatus(`✅ Bribe déposé — tx: ${tx.slice(0, 16)}…`);
      setAmount("");
    } catch (e: any) { setStatus(`❌ ${e?.message ?? e}`); }
    finally { setLoading(false); }
  }

  // ── Claim bribe ──────────────────────────────────────────────────────────────
  async function claimBribe() {
    if (!wallet) return;
    const pool = parsePool(); const mint = parseMint();
    if (!pool || !mint) { setStatus("❌ Adresse pool ou mint invalide"); return; }
    const ep = parseInt(claimEpoch, 10);
    if (isNaN(ep) || ep >= epoch) { setStatus("❌ Époque non terminée"); return; }
    setLoading(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const bribeVault      = bribeVaultPda(pool, mint, ep);
      const bribeTokenVault = bribeTokensPda(pool, mint, ep);
      const userRewardAta   = getAssociatedTokenAddressSync(mint, wallet.publicKey);
      const gaugeState      = gaugePda(pool, ep);
      const userVoteReceipt = votePda(wallet.publicKey, pool, ep);
      const userBribeClaim  = claimPda(wallet.publicKey, pool, mint, ep);
      const tx = await program.methods
        .claimBribe(new BN(ep))
        .accounts({
          user: wallet.publicKey, poolId: pool, rewardMint: mint,
          bribeVault, bribeTokenVault, userRewardAta,
          gaugeState, userVoteReceipt, userBribeClaim,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any).rpc();
      setStatus(`✅ Bribe réclamé — tx: ${tx.slice(0, 16)}…`);
    } catch (e: any) { setStatus(`❌ ${e?.message ?? e}`); }
    finally { setLoading(false); }
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-white">Bribes</h2>
        <span className="text-[10px] text-gray-500 border border-gray-700 rounded px-2 py-0.5 uppercase tracking-widest">
          {epochLabel(epoch)}
        </span>
      </div>

      <div className="flex gap-6 mb-6 border-b border-brand-border">
        {([
          { id: "deposit", label: "Déposer" },
          { id: "claim",   label: "Réclamer" },
        ] as { id: Tab; label: string }[]).map(({ id, label }) => (
          <button key={id} onClick={() => { setTab(id); setStatus(""); }}
            className={`pb-2 text-sm font-semibold uppercase tracking-wide transition-colors ${
              tab === id ? "tab-active" : "text-gray-500 hover:text-gray-300"}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Pool ID — common */}
      <label className="text-xs text-gray-400 mb-1 block">Pool / Gauge address</label>
      <input className="input mb-4" placeholder="Pubkey de la pool cible"
        value={poolId} onChange={(e) => setPoolId(e.target.value)} />

      <label className="text-xs text-gray-400 mb-1 block">Token de bribe (mint)</label>
      <input className="input mb-4"
        placeholder={usdcMint ? `Ex : ${usdcMint.toBase58().slice(0,8)}… (USDC, JUP…)` : "Mint address"}
        value={rewardMint} onChange={(e) => setRewardMint(e.target.value)} />

      {/* ── Deposit ── */}
      {tab === "deposit" && (
        <>
          <p className="text-xs text-gray-500 mb-4">
            Incitez les holders hiSOLA à voter pour votre pool. Les dépôts sont additifs.
          </p>
          <label className="text-xs text-gray-400 mb-1 block">Montant</label>
          <input className="input mb-4" type="number" min="0" placeholder="0.00"
            value={amount} onChange={(e) => setAmount(e.target.value)} />
          <button className="btn-primary w-full" onClick={depositBribe}
            disabled={loading || !wallet || !amount || !poolId || !rewardMint}>
            {loading ? "Dépôt…" : "Déposer la bribe"}
          </button>
        </>
      )}

      {/* ── Claim ── */}
      {tab === "claim" && (
        <>
          <label className="text-xs text-gray-400 mb-1 block">
            Numéro d'époque (courante : {epoch})
          </label>
          <input className="input mb-4" type="number" min="0"
            value={claimEpoch} onChange={(e) => setClaimEpoch(e.target.value)} />
          <p className="text-xs text-gray-500 mb-4">
            {claimEpoch && !isNaN(+claimEpoch)
              ? epochLabel(parseInt(claimEpoch, 10))
              : "Entrez un numéro d'époque passée"}
          </p>
          <button className="btn-primary w-full" onClick={claimBribe}
            disabled={loading || !wallet || !poolId || !rewardMint || !claimEpoch}>
            {loading ? "Claim…" : "Réclamer les bribes"}
          </button>
        </>
      )}

      {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
    </div>
  );
}