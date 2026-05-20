// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { getProgram, statePda, hiSolaM, userAta, PROGRAM_ID as PROG_ID } from "@/lib/program";
import { symbolByMint } from "@/lib/tokens";
import { useSoladrome } from "@/lib/SoladromeContext";
import { currentEpoch, epochEnd, timeLeft } from "@/lib/epoch";

// ── PDA helpers ───────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
function lockPositionPda(user: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("velock"), user.toBuffer()], PROG_ID
  )[0];
}

const PCT = [25, 50, 75, 100] as const;

export function Vote() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const epoch = currentEpoch();
  const end   = epochEnd(epoch);

  const [poolId,     setPoolId]     = useState("");
  const [votes,      setVotes]      = useState("");
  const [balance,    setBalance]    = useState<number | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [status,     setStatus]     = useState("");
  const [ammPools,   setAmmPools]   = useState<{ label: string; addr: string }[]>([]);
  const [votedPools, setVotedPools] = useState<Set<string>>(new Set());

  const fetchBalance = useCallback(async () => {
    if (!wallet) { setBalance(null); return; }
    try {
      const ata  = userAta(hiSolaM, wallet.publicKey);
      const info = await connection.getTokenAccountBalance(ata);
      setBalance(Number(info.value.uiAmount ?? 0));
    } catch { setBalance(0); }
  }, [connection, wallet]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  // Fetch real AMM pools from chain
  useEffect(() => {
    const provider = new AnchorProvider(connection, wallet ?? ({} as any), {});
    const program  = getProgram(provider);
    (program.account as any).ammPool.all().then((all: any[]) => {
      setAmmPools(all.map((p: any) => {
        const sA = symbolByMint(p.account.tokenAMint.toString(), usdcMint);
        const sB = symbolByMint(p.account.tokenBMint.toString(), usdcMint);
        return { label: `${sA}/${sB}`, addr: p.publicKey.toString() };
      }));
    }).catch(() => {});
  }, [connection, wallet, usdcMint]);

  // Check which pools the wallet already voted for this epoch
  const checkVotedPools = useCallback(async () => {
    if (!wallet || ammPools.length === 0) return;
    const ep = currentEpoch();
    const eb = Buffer.alloc(8);
    eb.writeBigUInt64LE(BigInt(ep));
    const voted = new Set<string>();
    await Promise.all(ammPools.map(async (p) => {
      const pool = new PublicKey(p.addr);
      const [receiptPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote"), wallet.publicKey.toBuffer(), pool.toBuffer(), eb], PROG_ID
      );
      const info = await connection.getAccountInfo(receiptPda);
      if (info) voted.add(p.addr);
    }));
    setVotedPools(voted);
  }, [wallet, ammPools, connection]);

  useEffect(() => { checkVotedPools(); }, [checkVotedPools]);

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

      const ep = currentEpoch(); // recalculate just before tx
      const rawVotes   = new BN(Math.floor(amt * 1_000_000));
      const userHiSola = (await import("@solana/spl-token"))
        .getAssociatedTokenAddressSync(hiSolaM, wallet.publicKey);
      const lockPosition = lockPositionPda(wallet.publicKey);

      const epochBuf = Buffer.alloc(8);
      epochBuf.writeBigUInt64LE(BigInt(ep));

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
        .voteGauge(new BN(ep), rawVotes)
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
      setVotedPools(prev => new Set([...prev, poolId]));
      fetchBalance();
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.includes("already in use") || msg.includes("0x0")) {
        setStatus("✅ Vote déjà enregistré pour ce pool cette époque.");
        setVotedPools(prev => new Set([...prev, poolId]));
      } else if (msg.includes("VoteOverflow") || msg.includes("6011")) {
        setStatus("❌ You already voted for this epoch — no voting power left.");
      } else {
        setStatus(`❌ ${msg}`);
      }
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

        {/* AMM pools from chain */}
        <p className="text-xs text-gray-500 mb-2 uppercase tracking-widest">
          Pools disponibles {ammPools.length > 0 ? `(${ammPools.length})` : ""}
        </p>
        {ammPools.length > 0 ? (
          <div className="flex flex-wrap gap-2 mb-5">
            {ammPools.map((s) => {
              const voted = votedPools.has(s.addr);
              return (
                <button
                  key={s.addr}
                  onClick={() => setPoolId(s.addr)}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                    poolId === s.addr
                      ? "border-brand-green text-brand-green bg-brand-green/10"
                      : voted
                      ? "border-brand-green/40 text-brand-green/60"
                      : "border-brand-border text-gray-400 hover:border-gray-500"
                  }`}
                >
                  {voted && <span className="mr-1">✓</span>}
                  {s.label}
                  <span className="ml-1.5 text-gray-600 font-mono">
                    {s.addr.slice(0, 4)}…
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-gray-600 mb-5">Chargement des pools…</p>
        )}

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

        {votedPools.has(poolId) ? (
          <div className="w-full text-center py-2 text-sm text-brand-green border border-brand-green/30 rounded-xl">
            ✓ Vote déjà enregistré pour ce pool cette époque
          </div>
        ) : (
          <button
            className="btn-primary w-full"
            onClick={vote}
            disabled={loading || !wallet || !votes || !poolId}
          >
            {loading ? "Vote en cours…" : "Voter pour cette pool"}
          </button>
        )}

        {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
      </div>
    </div>
  );
}