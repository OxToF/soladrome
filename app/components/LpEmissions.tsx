// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getProgram, statePda, oSolaM, lpMintPda, poolPda,
  userAta, commonAccounts, PROGRAM_ID,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";
import { symbolByMint } from "@/lib/tokens";

const EPOCH_S = 7 * 24 * 60 * 60;
function currentEpoch() { return Math.floor(Date.now() / 1000 / EPOCH_S); }
function epochEnd(e: number) { return new Date((e + 1) * EPOCH_S * 1000); }
function timeLeft(d: Date) {
  const s = Math.max(0, Math.floor((d.getTime() - Date.now()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}
function epochBuf(e: number) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(e));
  return b;
}

interface PoolEmissionRow {
  poolAddress: string;
  symbolA: string;
  symbolB: string;
  lpBalance: number;
  weightedBalance: string;     // weighted balance from checkpoint (raw u128 as string)
  estimatedOsola: number | null;
  checkpointed: boolean;       // checkpointed for current epoch
  prevCheckpointed: boolean;   // checkpointed for previous epoch (eligible to claim)
  canClaim: boolean;
  finalized: boolean;
  allocatedOsola: number;
}

export function LpEmissions() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const epoch = currentEpoch();
  const end   = epochEnd(epoch);

  const [pools, setPools]   = useState<PoolEmissionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus]   = useState<Record<string, string>>({});

  const fetchPools = useCallback(async () => {
    if (!wallet || !usdcMint) return;
    const provider = new AnchorProvider(connection, wallet, {});
    const program  = getProgram(provider);

    // Fetch all AMM pools
    const allPools = await (program.account as any).ammPool.all().catch(() => []);
    const prevEpoch = epoch - 1;
    const prevEb    = epochBuf(prevEpoch); // epoch whose rewards can be claimed now

    const rows: PoolEmissionRow[] = [];
    for (const p of allPools) {
      const poolAddr = p.publicKey.toString();
      const poolPk   = p.publicKey as PublicKey;
      const lpMint   = lpMintPda(poolPk);
      const userLpAta = userAta(lpMint, wallet.publicKey);

      let lpBalance = 0;
      try {
        const info = await connection.getTokenAccountBalance(userLpAta);
        lpBalance = info.value.uiAmount ?? 0;
      } catch { lpBalance = 0; }

      // Fetch user checkpoint (single PDA, stores last epoch checkpointed)
      const [ckptPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_ckpt"), poolPk.toBuffer(), wallet.publicKey.toBuffer()], PROGRAM_ID
      );
      let weightedBalance = "0";
      let checkpointed    = false;   // checkpointed for current epoch (for badge)
      let prevCheckpointed = false;  // checkpointed for previous epoch (eligible to claim)
      let checkpointEpoch = 0;
      try {
        const ckpt = await (program.account as any).lpUserCheckpoint.fetch(ckptPda);
        weightedBalance  = (ckpt.weightedBalance as BN).toString();
        checkpointEpoch  = (ckpt.lastEpoch as BN).toNumber();
        checkpointed     = checkpointEpoch === epoch && weightedBalance !== "0";
        prevCheckpointed = checkpointEpoch === prevEpoch && weightedBalance !== "0";
      } catch {}

      // Fetch pool epoch accum for the PREVIOUS epoch (the one that can be finalized/claimed)
      const [accumPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_pool_epoch"), poolPk.toBuffer(), prevEb], PROGRAM_ID
      );
      let finalized      = false;
      let allocatedOsola = 0;
      let totalWeighted  = "0";
      try {
        const accum = await (program.account as any).lpPoolEpochAccum.fetch(accumPda);
        finalized      = accum.finalized as boolean;
        allocatedOsola = (accum.osolaAllocated as BN).toNumber() / 1e6;
        totalWeighted  = (accum.totalWeightedSupply as BN).toString();
      } catch {}

      // Estimate oSOLA earnings based on previous epoch checkpoint
      let estimatedOsola: number | null = null;
      if (prevCheckpointed && totalWeighted !== "0") {
        const share = Number(BigInt(weightedBalance) * BigInt(1_000_000) / BigInt(totalWeighted)) / 1_000_000;
        estimatedOsola = share * allocatedOsola;
      }

      // Check if already claimed for the previous epoch
      const [claimPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("lp_claim"), wallet.publicKey.toBuffer(), poolPk.toBuffer(), prevEb], PROGRAM_ID
      );
      let alreadyClaimed = false;
      try {
        await (program.account as any).lpEpochClaim.fetch(claimPda);
        alreadyClaimed = true;
      } catch {}

      const canClaim = finalized && prevCheckpointed && !alreadyClaimed;
      const mintA = p.account.tokenAMint.toString();
      const mintB = p.account.tokenBMint.toString();

      rows.push({
        poolAddress: poolAddr,
        symbolA: symbolByMint(mintA, usdcMint),
        symbolB: symbolByMint(mintB, usdcMint),
        lpBalance,
        weightedBalance,
        estimatedOsola,
        checkpointed,
        prevCheckpointed,
        canClaim,
        finalized,
        allocatedOsola,
      });
    }

    setPools(rows.filter((r) => r.lpBalance > 0 || r.checkpointed || r.canClaim));
  }, [connection, wallet, usdcMint, epoch]);

  useEffect(() => { fetchPools(); }, [fetchPools]);

  function setPoolStatus(poolAddr: string, msg: string) {
    setStatus((prev) => ({ ...prev, [poolAddr]: msg }));
  }

  async function checkpoint(poolAddr: string) {
    if (!wallet) return;
    setLoading(true);
    setPoolStatus(poolAddr, "Checkpoint en cours…");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const poolPk   = new PublicKey(poolAddr);
      const lpMint   = lpMintPda(poolPk);
      const userLpAta = userAta(lpMint, wallet.publicKey);

      const tx = await program.methods
        .checkpointLp(new BN(epoch))
        .accounts({
          user:              wallet.publicKey,
          pool:              poolPk,
          lpMint,
          userLp:            userLpAta,
          system_program:    (await import("@solana/web3.js")).SystemProgram.programId,
          rent:              (await import("@solana/web3.js")).SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
      setPoolStatus(poolAddr, `✅ Checkpoint — tx: ${tx.slice(0, 16)}…`);
      fetchPools();
    } catch (e: any) {
      setPoolStatus(poolAddr, `❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  async function emit(poolAddr: string) {
    if (!wallet) return;
    setLoading(true);
    setPoolStatus(poolAddr, "Emission en cours…");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const poolPk   = new PublicKey(poolAddr);
      const eb       = epochBuf(epoch - 1); // emit for previous epoch
      const prevEpoch = epoch - 1;

      const lpMint = lpMintPda(poolPk);
      const [gaugeState] = PublicKey.findProgramAddressSync(
        [Buffer.from("gauge"), poolPk.toBuffer(), eb], PROGRAM_ID
      );
      const [globalEpochVotes] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_votes"), eb], PROGRAM_ID
      );

      const tx = await program.methods
        .emitPoolRewards(new BN(prevEpoch))
        .accounts({
          caller:           wallet.publicKey,
          pool:             poolPk,
          lpMint,
          gaugeState,
          globalEpochVotes,
          system_program:   (await import("@solana/web3.js")).SystemProgram.programId,
          rent:             (await import("@solana/web3.js")).SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
      setPoolStatus(poolAddr, `✅ Rewards émis — tx: ${tx.slice(0, 16)}…`);
      fetchPools();
    } catch (e: any) {
      setPoolStatus(poolAddr, `❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  async function claim(poolAddr: string) {
    if (!wallet) return;
    setLoading(true);
    setPoolStatus(poolAddr, "Claim en cours…");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const poolPk   = new PublicKey(poolAddr);

      const userOSola = userAta(oSolaM, wallet.publicKey);

      const tx = await program.methods
        .claimLpEmissions(new BN(epoch - 1))
        .accounts({
          user:          wallet.publicKey,
          pool:          poolPk,
          protocolState: statePda,
          oSolaMint:     oSolaM,
          userOSola,
          ...commonAccounts,
        } as any)
        .rpc();
      setPoolStatus(poolAddr, `✅ oSOLA reçu — tx: ${tx.slice(0, 16)}…`);
      fetchPools();
    } catch (e: any) {
      setPoolStatus(poolAddr, `❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  const urgentCheckpoint = pools.some((p) => p.lpBalance > 0 && !p.checkpointed);

  return (
    <div className="space-y-6">
      {/* Epoch banner */}
      <div className="card flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-widest mb-1">Epoch courante</p>
          <p className="text-2xl font-black text-white">#{epoch}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500 uppercase tracking-widest mb-1">Deadline checkpoint</p>
          <p className={`text-2xl font-black ${urgentCheckpoint ? "text-yellow-400" : "text-brand-green"}`}>
            {timeLeft(end)}
          </p>
          <p className="text-xs text-gray-500">{end.toLocaleDateString()}</p>
        </div>
        <div className="text-right hidden md:block max-w-xs">
          <p className="text-xs text-gray-400 leading-relaxed">
            10 000 oSOLA/epoch distribués aux LPs <br />
            selon leur poids temps-pondéré de LP tokens. <br />
            <strong className="text-white">Checkpoint avant la fin de l'epoch.</strong>
          </p>
        </div>
      </div>

      {/* Alert */}
      {urgentCheckpoint && (
        <div className="rounded-xl border border-yellow-500/40 bg-yellow-500/10 p-4 text-sm text-yellow-300">
          ⚠️ Tu as des LP tokens sans checkpoint actif. Checkpointe avant la fin de l'epoch pour gagner des oSOLA.
        </div>
      )}

      {/* Pool list */}
      {pools.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-gray-500">Aucun pool avec LP tokens détecté.</p>
          <p className="text-xs text-gray-600 mt-2">Ajoute de la liquidité dans Pools pour participer aux émissions.</p>
          <button
            className="btn-secondary text-sm mt-4"
            onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "pools" }))}
          >
            Aller dans Pools →
          </button>
        </div>
      ) : (
        pools.map((row) => (
          <div key={row.poolAddress} className="card space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-bold text-white">{row.symbolA} / {row.symbolB}</p>
                <p className="text-xs text-gray-600 font-mono">{row.poolAddress.slice(0, 20)}…</p>
              </div>
              <div className="flex items-center gap-2">
                {row.checkpointed && (
                  <span className="text-xs text-brand-green border border-brand-green/30 rounded px-2 py-0.5">
                    ✓ Checkpointé
                  </span>
                )}
                {row.finalized && (
                  <span className="text-xs text-blue-400 border border-blue-400/30 rounded px-2 py-0.5">
                    Finalisé
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-xs text-gray-500 mb-1">LP Balance</p>
                <p className="font-bold text-white">
                  {row.lpBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">Pool alloué</p>
                <p className="font-bold text-brand-green">
                  {row.finalized ? `${row.allocatedOsola.toLocaleString(undefined, { maximumFractionDigits: 2 })} oSOLA` : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">Ta part estimée</p>
                <p className="font-bold text-brand-green">
                  {row.estimatedOsola !== null
                    ? `${row.estimatedOsola.toLocaleString(undefined, { maximumFractionDigits: 4 })} oSOLA`
                    : "—"}
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              {!row.checkpointed && row.lpBalance > 0 && (
                <button
                  className="btn-primary flex-1 text-sm"
                  disabled={loading}
                  onClick={() => checkpoint(row.poolAddress)}
                >
                  Checkpoint LP
                </button>
              )}
              {row.finalized && row.canClaim && (
                <button
                  className="btn-primary flex-1 text-sm"
                  disabled={loading}
                  onClick={() => claim(row.poolAddress)}
                >
                  Claim oSOLA
                </button>
              )}
              {!row.finalized && (
                <button
                  className="btn-secondary flex-1 text-sm"
                  disabled={loading}
                  onClick={() => emit(row.poolAddress)}
                  title="Finalise les rewards pour l'epoch précédente"
                >
                  Émettre rewards (epoch {epoch - 1})
                </button>
              )}
            </div>

            {status[row.poolAddress] && (
              <p className="text-xs text-gray-400 break-all">{status[row.poolAddress]}</p>
            )}
          </div>
        ))
      )}
    </div>
  );
}
