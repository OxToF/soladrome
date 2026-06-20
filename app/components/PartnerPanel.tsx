// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  getProgram, statePda, solaM, hiSolaM,
  solaVaultAddr, marketVault, positionPda, PROGRAM_ID,
} from "@/lib/program";

const PARTNER_SEED  = Buffer.from("partner");
const VELOCK_SEED   = Buffer.from("velock");
const VE_VAULT_SEED = Buffer.from("ve_vault");

export function partnerAllocationPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PARTNER_SEED, wallet.toBuffer()],
    PROGRAM_ID
  )[0];
}

function velockPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VELOCK_SEED, wallet.toBuffer()], PROGRAM_ID)[0];
}

function veVaultPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VE_VAULT_SEED, wallet.toBuffer()], PROGRAM_ID)[0];
}

function fmt(raw: number, dec = 2) {
  return (raw / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: dec });
}

function timeLeft(endTs: number, nowSecs: number): string {
  const s = Math.max(0, endTs - nowSecs);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

interface AllocData {
  hiSolaAmount:    number;
  lockDurationSecs: number;
  claimed:         boolean;
  startTs:         number;
}

interface LockData {
  amountLocked: number;
  lockEndTs:    number;
}

export function PartnerPanel() {
  const { connection } = useConnection();
  const wallet         = useAnchorWallet();

  const [alloc,    setAlloc]    = useState<AllocData | null>(null);
  const [lock,     setLock]     = useState<LockData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [nowSecs,  setNowSecs]  = useState(Math.floor(Date.now() / 1000));
  const [loading,  setLoading]  = useState(false);
  const [status,   setStatus]   = useState("");

  const fetchData = useCallback(async () => {
    if (!wallet) return;
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const pda      = partnerAllocationPda(wallet.publicKey);

      const [a, l, slot] = await Promise.allSettled([
        (program.account as any).partnerAllocation.fetchNullable(pda),
        (program.account as any).veLockPosition.fetchNullable(velockPda(wallet.publicKey)),
        connection.getSlot(),
      ]);

      if (a.status === "fulfilled" && a.value) {
        const d = a.value as any;
        setAlloc({
          hiSolaAmount:     Number(d.hiSolaAmount.toString()),
          lockDurationSecs: Number(d.lockDurationSecs.toString()),
          claimed:          d.claimed,
          startTs:          Number(d.startTs.toString()),
        });
        setNotFound(false);
      } else {
        setNotFound(true);
      }

      if (l.status === "fulfilled" && l.value) {
        const d = l.value as any;
        setLock({
          amountLocked: Number(d.amountLocked.toString()),
          lockEndTs:    Number(d.lockEndTs.toString()),
        });
      }

      if (slot.status === "fulfilled") {
        const bt = await connection.getBlockTime(slot.value);
        if (bt) setNowSecs(bt);
      }
    } catch (e) { console.error("PartnerPanel fetchData:", e); }
  }, [connection, wallet]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    const id = setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  async function claimAllocation() {
    if (!wallet || !alloc) return;
    setLoading(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);

      // Auto-migrate UserPosition if it was created with the old 128-byte layout
      // (before last_borrow_slot was added — ConstraintSpace: Left 136, Right 128)
      const posInfo = await connection.getAccountInfo(positionPda(wallet.publicKey));
      if (posInfo && posInfo.data.length < 136) {
        setStatus("⚙️ Migrating position account…");
        await program.methods.migrateUserPosition()
          .accounts({
            user:         wallet.publicKey,
            userPosition: positionPda(wallet.publicKey),
            systemProgram: SystemProgram.programId,
          } as any).rpc();
      }

      const tx = await program.methods.claimPartnerAllocation()
        .accounts({
          partner:          wallet.publicKey,
          protocolState:    statePda,
          solaMint:         solaM,
          hiSolaMint:       hiSolaM,
          solaVault:        solaVaultAddr,
          marketVault,
          partnerAllocation: partnerAllocationPda(wallet.publicKey),
          lockPosition:     velockPda(wallet.publicKey),
          veLockVault:      veVaultPda(wallet.publicKey),
          partnerPosition:  positionPda(wallet.publicKey),
          tokenProgram:     TOKEN_PROGRAM_ID,
          systemProgram:    SystemProgram.programId,
        } as any).rpc();

      setStatus(`✅ Allocation claimed — tx: ${tx.slice(0, 16)}…`);
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      await fetchData();
    } catch (e: any) { setStatus(`❌ ${e?.message ?? e}`); }
    finally { setLoading(false); }
  }

  if (!wallet) return (
    <div className="card text-center text-gray-500 py-12">Connect wallet to continue.</div>
  );
  if (notFound) return (
    <div className="card text-center py-12">
      <div className="text-4xl mb-4">🔍</div>
      <p className="text-gray-400 text-sm">No partner allocation found for this wallet.</p>
      <p className="text-gray-600 text-xs mt-2">Contact the Soladrome team if you believe this is an error.</p>
    </div>
  );
  if (!alloc) return (
    <div className="card text-center py-12 text-gray-500 text-sm">Loading…</div>
  );

  const isLocked   = lock && lock.lockEndTs > nowSecs;
  const lockEndsIn = lock ? timeLeft(lock.lockEndTs, nowSecs) : null;
  const lockEndDate = lock ? new Date(lock.lockEndTs * 1000).toLocaleDateString(undefined, {
    day: "2-digit", month: "short", year: "numeric",
  }) : null;

  return (
    <div className="max-w-xl mx-auto flex flex-col gap-6">

      {/* ── Header ── */}
      <div className="card">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-2xl">🤝</span>
          <h2 className="text-xl font-black text-white">Partner Allocation</h2>
        </div>
        <p className="text-xs text-gray-500">
          One-time hiSOLA allocation · locked into governance vault · transparent on Solana
        </p>
      </div>

      {/* ── Allocation summary ── */}
      <div className="card">
        <h3 className="text-base font-bold text-white mb-4">hiSOLA Allocation</h3>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="bg-brand-dark border border-brand-border rounded-xl p-3">
            <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Total allocated</p>
            <p className="text-lg font-black text-white font-mono">{fmt(alloc.hiSolaAmount)}</p>
            <p className="text-[10px] text-gray-500">hiSOLA</p>
          </div>
          <div className="bg-brand-dark border border-brand-border rounded-xl p-3">
            <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Lock duration</p>
            <p className="text-lg font-black text-white font-mono">
              {(alloc.lockDurationSecs / 86400).toFixed(1)}
            </p>
            <p className="text-[10px] text-gray-500">days</p>
          </div>
        </div>

        <div className="flex items-start gap-2 text-xs text-gray-500 bg-brand-dark border border-brand-border rounded-lg px-3 py-2 mb-4">
          <span className="text-brand-green text-base leading-none shrink-0">ℹ</span>
          <span>
            hiSOLA is minted directly to your governance vault — your wallet balance stays 0.
            Borrow power unlocks after the lock expires.
            Max borrow after unlock: <span className="text-white font-mono">{fmt(alloc.hiSolaAmount * 0.1)} USDC</span> (10%).
          </span>
        </div>

        {/* Not yet claimed */}
        {!alloc.claimed && (
          <>
            <p className="text-xs text-yellow-400 mb-3">
              ⚡ Ready to claim — hiSOLA will be locked immediately for {(alloc.lockDurationSecs / 86400).toFixed(1)} days.
            </p>
            <button
              className="btn-primary w-full"
              onClick={claimAllocation}
              disabled={loading}
            >
              {loading ? "Processing…" : `Lock ${fmt(alloc.hiSolaAmount)} hiSOLA`}
            </button>
          </>
        )}

        {/* Already claimed */}
        {alloc.claimed && lock && (
          <div className="mt-2">
            <div className="flex justify-between text-xs text-gray-400 mb-1">
              <span>Locked</span>
              <span className="text-white font-mono font-semibold">{fmt(lock.amountLocked)} hiSOLA</span>
            </div>
            <div className="w-full bg-brand-border rounded-full h-2 mb-3">
              <div
                className="bg-brand-green h-2 rounded-full transition-all"
                style={{ width: isLocked
                  ? `${Math.max(5, 100 - ((lock.lockEndTs - nowSecs) / alloc.lockDurationSecs) * 100)}%`
                  : "100%" }}
              />
            </div>

            {isLocked ? (
              <p className="text-xs text-yellow-400">
                🔒 Locked — unlocks in <span className="font-mono font-semibold">{lockEndsIn}</span>
                {" "}({lockEndDate})
              </p>
            ) : (
              <p className="text-xs text-brand-green">
                ✅ Lock expired — call <span className="font-mono">unlock_hi_sola</span> to move hiSOLA to your wallet.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Voting power info ── */}
      {alloc.claimed && lock && isLocked && (
        <div className="card">
          <h3 className="text-base font-bold text-white mb-3">Governance</h3>
          <p className="text-xs text-gray-500 mb-2">
            Your locked hiSOLA carries voting power in the gauge system.
            Vote on pools in the <span className="text-brand-green cursor-pointer"
              onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "vote" }))}>
              Vote
            </span> tab to direct SOLA emissions and earn bribes.
          </p>
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-500">ve_lock_vault balance</span>
            <span className="text-white font-mono font-semibold">{fmt(lock.amountLocked)} hiSOLA</span>
          </div>
        </div>
      )}

      {status && <p className="text-xs text-gray-400 break-all px-1">{status}</p>}
    </div>
  );
}
