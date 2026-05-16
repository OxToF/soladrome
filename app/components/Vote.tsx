// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { getProgram, statePda, hiSolaM, userAta, PROGRAM_ID as PROG_ID } from "@/lib/program";

// ── Epoch helpers ─────────────────────────────────────────────────────────────
const EPOCH_S = 7 * 24 * 60 * 60;
function currentEpoch() { return Math.floor(Date.now() / 1000 / EPOCH_S); }
function epochEnd(e: number) { return new Date((e + 1) * EPOCH_S * 1000); }
function timeLeft(d: Date) {
  const s = Math.max(0, Math.floor((d.getTime() - Date.now()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

// ── PDA helpers ───────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
function lockPositionPda(user: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("velock"), user.toBuffer()], PROG_ID
  )[0];
}

// ── Popular pools (labels only — devnet/localnet use any pubkey) ──────────────
const PCT = [25, 50, 75, 100] as const;

const SUGGESTED = [
  { label: "SOL/USDC · Raydium",  addr: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWaS3AFKBxQaP" },
  { label: "SOL/USDC · Orca",     addr: "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ" },
  { label: "SOLA/USDC · Serum",   addr: "So11111111111111111111111111111111111111112"   },
];

export function Vote() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const epoch = currentEpoch();
  const end   = epochEnd(epoch);

  const [poolId,   setPoolId]  = useState("");
  const [votes,    setVotes]   = useState("");
  const [balance,  setBalance] = useState<number | null>(null);
  const [loading,  setLoading] = useState(false);
  const [status,   setStatus]  = useState("");

  const fetchBalance = useCallback(async () => {
    if (!wallet) { setBalance(null); return; }
    try {
      const ata  = userAta(hiSolaM, wallet.publicKey);
      const info = await connection.getTokenAccountBalance(ata);
      setBalance(Number(info.value.uiAmount ?? 0));
    } catch { setBalance(0); }
  }, [connection, wallet]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  function applyPct(pct: number) {
    if (!balance || balance <= 0) return;
    setVotes(((balance * pct) / 100).toFixed(6).replace(/\.?0+$/, ""));
  }

  function tryPool(): PublicKey | null {
    try { return new PublicKey(poolId); } catch { return null; }
  }

  async function vote() {
    if (!wallet || !votes || !poolId) return;
    const pool = tryPool();
    if (!pool) { setStatus("❌ Adresse de pool invalide"); return; }

    const amt = parseFloat(votes);
    if (isNaN(amt) || amt <= 0) { setStatus("❌ Montant invalide"); return; }

    setLoading(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);

      const rawVotes   = new BN(Math.floor(amt * 1_000_000));
      const userHiSola = (await import("@solana/spl-token"))
        .getAssociatedTokenAddressSync(hiSolaM, wallet.publicKey);
      const lockPosition = lockPositionPda(wallet.publicKey);

      // Encode epoch as u64 little-endian (8 bytes) — matches Rust's epoch.to_le_bytes()
      const epochBuf = Buffer.alloc(8);
      epochBuf.writeBigUInt64LE(BigInt(epoch));

      const [gaugeState] = PublicKey.findProgramAddressSync(
        [Buffer.from("gauge"), pool.toBuffer(), epochBuf], PROG_ID
      );
      const [userVoteReceipt] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote"), wallet.publicKey.toBuffer(), pool.toBuffer(), epochBuf], PROG_ID
      );
      const [userEpochVotes] = PublicKey.findProgramAddressSync(
        [Buffer.from("uev"), wallet.publicKey.toBuffer(), epochBuf], PROG_ID
      );
      const [globalEpochVotes] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_votes"), epochBuf], PROG_ID
      );

      const tx = await program.methods
        .voteGauge(new BN(epoch), rawVotes)
        .accounts({
          user:             wallet.publicKey,
          poolId:           pool,
          protocolState:    statePda,
          hiSolaMint:       hiSolaM,
          userHiSola,
          lockPosition,
          gaugeState,
          userVoteReceipt,
          userEpochVotes,
          globalEpochVotes,
          systemProgram:   SystemProgram.programId,
          rent:            SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
      setStatus(`✅ Vote enregistré — tx: ${tx.slice(0, 16)}…`);
      setVotes("");
      fetchBalance();
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-6">
      {/* Epoch banner */}
      <div className="card flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-widest">Époque courante</p>
          <p className="text-2xl font-black text-white">#{epoch}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-widest">Se termine dans</p>
          <p className="text-2xl font-black text-brand-green">{timeLeft(end)}</p>
          <p className="text-xs text-gray-500">{end.toLocaleDateString()}</p>
        </div>
        <div className="text-right hidden md:block">
          <p className="text-xs text-gray-500 mb-2">Mécanisme</p>
          <p className="text-xs text-gray-400 max-w-xs">
            Vos hiSOLA votent pour les pools. <br />
            Les bribers rémunèrent les votants de <br />
            la pool qu'ils soutiennent.
          </p>
        </div>
      </div>

      {/* Vote form */}
      <div className="card">
        <h2 className="text-lg font-bold text-white mb-1">Voter pour une pool</h2>
        <p className="text-xs text-gray-500 mb-6">
          Poids de vote = hiSOLA alloué · Plafond = solde hiSOLA par époque · 1 vote par pool
        </p>

        {/* Suggested pools */}
        <p className="text-xs text-gray-500 mb-2 uppercase tracking-widest">Pools suggérées</p>
        <div className="flex flex-wrap gap-2 mb-5">
          {SUGGESTED.map((s) => (
            <button
              key={s.addr}
              onClick={() => setPoolId(s.addr)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                poolId === s.addr
                  ? "border-brand-green text-brand-green bg-brand-green/10"
                  : "border-brand-border text-gray-400 hover:border-gray-500"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <label className="text-xs text-gray-400 mb-1 block">Adresse de la pool (Pubkey)</label>
        <input
          className="input mb-4"
          placeholder="Colle l'adresse ou sélectionne ci-dessus"
          value={poolId}
          onChange={(e) => setPoolId(e.target.value)}
        />

        <div className="rounded-xl bg-brand-dark border border-brand-border p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-400">hiSOLA à allouer</span>
            {balance !== null && (
              <span className="text-xs text-gray-500">
                Balance:{" "}
                <button
                  className="text-gray-300 hover:text-brand-green transition-colors font-mono"
                  onClick={() => applyPct(100)}
                >
                  {balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} hiSOLA
                </button>
              </span>
            )}
          </div>
          <input
            className="w-full bg-transparent text-right text-2xl font-bold text-white placeholder-gray-600 focus:outline-none mb-3"
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={votes}
            onChange={(e) => setVotes(e.target.value)}
          />
          <div className="flex gap-2">
            {PCT.map((pct) => (
              <button
                key={pct}
                onClick={() => applyPct(pct)}
                disabled={!balance}
                className="flex-1 text-xs py-1 rounded-md border border-brand-border text-gray-400
                           hover:border-brand-green hover:text-brand-green transition-colors
                           disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {pct === 100 ? "Max" : `${pct}%`}
              </button>
            ))}
          </div>
        </div>

        <button
          className="btn-primary w-full"
          onClick={vote}
          disabled={loading || !wallet || !votes || !poolId}
        >
          {loading ? "Vote en cours…" : "Voter pour cette pool"}
        </button>

        {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
      </div>
    </div>
  );
}