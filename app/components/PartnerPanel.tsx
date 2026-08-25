// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  getProgram, statePda, solaM,
  solaVaultAddr, marketVault, positionPda, PROGRAM_ID, sendTx,
} from "@/lib/program";

const PARTNER_SEED  = Buffer.from("partner");
const VELOCK_SEED   = Buffer.from("velock");

// state.rs — the welcome bag streams over 6 months from registration.
const BASE_BAG_VEST_SECS = 180 * 24 * 3_600;
// lib.rs — borrow_against_locked, PARTNER_BORROW_CAP_BPS. This panel used to publish 10%
// "after the lock expires", which was wrong twice over: the cap is 20%, and the valve is
// open DURING the lock — it exists precisely because locked hiSOLA cannot reach a wallet.
const PARTNER_BORROW_CAP_BPS = 2_000;

export function partnerAllocationPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PARTNER_SEED, wallet.toBuffer()],
    PROGRAM_ID
  )[0];
}

function velockPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VELOCK_SEED, wallet.toBuffer()], PROGRAM_ID)[0];
}

// ── Exact display, no floats ─────────────────────────────────────────────────
// These are the terms of an immutable agreement, so they are read back with the same
// precision they were written. A whole amount renders whole: never "1,000,000.000000".
function fmt(v: bigint, decimals = 6): string {
  const d = BigInt(10) ** BigInt(decimals);
  const whole = (v / d).toLocaleString("en-US");
  const frac = v % d;
  if (frac === BigInt(0)) return whole;
  return `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

function pct(part: bigint, whole: bigint): number {
  if (whole === BigInt(0)) return 0;
  return Number((part * BigInt(10_000)) / whole) / 100;
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
  bribeMint:        string;
  rateNum:          bigint;
  rateDen:          bigint;
  capHiSola:        bigint;
  baseHiSola:       bigint;
  totalBribed:      bigint;
  claimed:          bigint;
  lockDurationSecs: number;
  startTs:          number;
}

interface LockData {
  amountLocked:    bigint;
  permanentAmount: bigint;
  lockEndTs:       number;
}

export function PartnerPanel() {
  const { connection } = useConnection();
  const wallet         = useAnchorWallet();

  const [alloc,    setAlloc]    = useState<AllocData | null>(null);
  const [lock,     setLock]     = useState<LockData | null>(null);
  const [bribeDec, setBribeDec] = useState<number | null>(null);
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
        // Field names track PartnerAllocation in state.rs. This panel read `hiSolaAmount`
        // and `claimed` until 2026-08-25 — neither has existed since the allocation became
        // a streaming bag plus a bribe-earned tranche, so the read threw and the panel sat
        // on "Loading…" forever. Anything added here must exist in the IDL.
        setAlloc({
          bribeMint:        d.bribeMint.toBase58(),
          rateNum:          BigInt(d.rateNum.toString()),
          rateDen:          BigInt(d.rateDen.toString()),
          capHiSola:        BigInt(d.capHiSola.toString()),
          baseHiSola:       BigInt(d.baseHiSola.toString()),
          totalBribed:      BigInt(d.totalBribedCredited.toString()),
          claimed:          BigInt(d.hiSolaClaimed.toString()),
          lockDurationSecs: Number(d.lockDurationSecs.toString()),
          startTs:          Number(d.startTs.toString()),
        });
        setNotFound(false);

        connection.getParsedAccountInfo(d.bribeMint)
          .then((res) => {
            const dec = (res.value?.data as any)?.parsed?.info?.decimals;
            setBribeDec(typeof dec === "number" ? dec : null);
          })
          .catch(() => setBribeDec(null));
      } else {
        setNotFound(true);
      }

      if (l.status === "fulfilled" && l.value) {
        const d = l.value as any;
        setLock({
          amountLocked:    BigInt(d.amountLocked.toString()),
          permanentAmount: BigInt(d.permanentAmount?.toString() ?? "0"),
          lockEndTs:       Number(d.lockEndTs.toString()),
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
        const migIx = await program.methods.migrateUserPosition()
          .accounts({
            user:         wallet.publicKey,
            userPosition: positionPda(wallet.publicKey),
            systemProgram: SystemProgram.programId,
          } as any).instruction();
        await sendTx(connection, wallet, [migIx]);
      }

      const ix = await program.methods.claimPartnerAllocation()
        .accounts({
          partner:          wallet.publicKey,
          protocolState:    statePda,
          solaMint:         solaM,
          solaVault:        solaVaultAddr,
          marketVault,
          partnerAllocation: partnerAllocationPda(wallet.publicKey),
          lockPosition:     velockPda(wallet.publicKey),
          partnerPosition:  positionPda(wallet.publicKey),
          tokenProgram:     TOKEN_PROGRAM_ID,
          systemProgram:    SystemProgram.programId,
        } as any).instruction();
      const tx = await sendTx(connection, wallet, [ix]);

      setStatus(`✅ Claimed — tx: ${tx.slice(0, 16)}…`);
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

  // ── The same arithmetic claim_partner_allocation runs, so the figure on the button is
  //    the figure the instruction will mint. Integer division throughout, as on-chain.
  const elapsed = Math.max(0, nowSecs - alloc.startTs);
  const baseVested = elapsed >= BASE_BAG_VEST_SECS
    ? alloc.baseHiSola
    : (alloc.baseHiSola * BigInt(elapsed)) / BigInt(BASE_BAG_VEST_SECS);
  const bribeEarnedRaw = alloc.rateDen > BigInt(0)
    ? (alloc.totalBribed * alloc.rateNum) / alloc.rateDen
    : BigInt(0);
  const bribeEarned = bribeEarnedRaw < alloc.capHiSola ? bribeEarnedRaw : alloc.capHiSola;
  const entitled  = baseVested + bribeEarned;
  const claimable = entitled > alloc.claimed ? entitled - alloc.claimed : BigInt(0);

  const bagDoneIn = alloc.startTs + BASE_BAG_VEST_SECS;
  const bagStreaming = nowSecs < bagDoneIn;

  const isLocked   = lock && lock.lockEndTs > nowSecs;
  const lockEndsIn = lock ? timeLeft(lock.lockEndTs, nowSecs) : null;
  const lockEndDate = lock ? new Date(lock.lockEndTs * 1000).toLocaleDateString(undefined, {
    day: "2-digit", month: "short", year: "numeric",
  }) : null;

  const borrowable = lock
    ? (lock.amountLocked * BigInt(PARTNER_BORROW_CAP_BPS)) / BigInt(10_000)
    : BigInt(0);
  const releasable = lock && lock.amountLocked > lock.permanentAmount
    ? lock.amountLocked - lock.permanentAmount
    : BigInt(0);

  return (
    <div className="max-w-xl mx-auto flex flex-col gap-6">

      {/* ── Header ── */}
      <div className="card">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-2xl">🤝</span>
          <h2 className="text-xl font-black text-white">Partner Allocation</h2>
        </div>
        <p className="text-xs text-gray-500">
          Vote-locked hiSOLA · a streaming welcome bag plus what your bribes earn
        </p>
      </div>

      {/* ── Claimable now ── */}
      <div className="card">
        <h3 className="text-base font-bold text-white mb-4">Available to claim</h3>

        <div className="bg-brand-dark border border-brand-border rounded-xl p-4 mb-4">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Claimable now</p>
          <p className="text-2xl font-black text-white font-mono">{fmt(claimable)}</p>
          <p className="text-[10px] text-gray-500">hiSOLA</p>
        </div>

        <div className="flex items-start gap-2 text-xs text-gray-500 bg-brand-dark border border-brand-border rounded-lg px-3 py-2 mb-4">
          <span className="text-brand-green text-base leading-none shrink-0">ℹ</span>
          <span>
            Claiming mints straight into your vote-locked position — your wallet balance stays 0,
            and voting power is live immediately. While locked you can draw up to{" "}
            <span className="text-white font-mono">
              {fmt(borrowable)} USDC
            </span>{" "}
            against it (20%), without interest or liquidation.
          </span>
        </div>

        <button
          className="btn-primary w-full"
          onClick={claimAllocation}
          disabled={loading || claimable === BigInt(0)}
        >
          {loading ? "Processing…"
            : claimable === BigInt(0) ? "Nothing to claim yet"
            : `Claim & lock ${fmt(claimable)} hiSOLA`}
        </button>
      </div>

      {/* ── Welcome bag ── */}
      <div className="card">
        <div className="flex justify-between items-baseline mb-1">
          <h3 className="text-base font-bold text-white">Welcome bag</h3>
          <span className="text-xs text-gray-400 font-mono">
            {fmt(baseVested)} / {fmt(alloc.baseHiSola)}
          </span>
        </div>
        <p className="text-[11px] text-gray-500 mb-3">
          Streams over 6 months from registration, whether you bribe or not.
        </p>
        <div className="w-full bg-brand-border rounded-full h-2 mb-2">
          <div
            className="bg-brand-green h-2 rounded-full transition-all"
            style={{ width: `${Math.min(100, pct(baseVested, alloc.baseHiSola))}%` }}
          />
        </div>
        <p className="text-[11px] text-gray-500">
          {bagStreaming
            ? <>Fully streamed in <span className="font-mono text-gray-400">{timeLeft(bagDoneIn, nowSecs)}</span>.</>
            : <>Fully streamed.</>}
          {" "}This portion is <span className="text-white">permanent</span> — it keeps its voting
          power for life and can never be unlocked or sold.
        </p>
      </div>

      {/* ── Bribe-earned tranche ── */}
      <div className="card">
        <div className="flex justify-between items-baseline mb-1">
          <h3 className="text-base font-bold text-white">Earned by bribing</h3>
          <span className="text-xs text-gray-400 font-mono">
            {fmt(bribeEarned)} / {fmt(alloc.capHiSola)}
          </span>
        </div>
        <p className="text-[11px] text-gray-500 mb-3">
          Credited as you deposit bribes in the committed mint. Unlike the bag, this tranche is
          releasable once the lock expires.
        </p>
        <div className="w-full bg-brand-border rounded-full h-2 mb-3">
          <div
            className="bg-brand-green h-2 rounded-full transition-all"
            style={{ width: `${Math.min(100, pct(bribeEarned, alloc.capHiSola))}%` }}
          />
        </div>
        <div className="flex flex-col gap-1 text-[11px]">
          <div className="flex justify-between">
            <span className="text-gray-500">Bribes deposited so far</span>
            <span className="text-gray-300 font-mono">
              {bribeDec !== null ? fmt(alloc.totalBribed, bribeDec) : alloc.totalBribed.toString()}
              {bribeDec === null ? " base units" : ""}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Committed bribe mint</span>
            <span className="text-gray-300 font-mono">{alloc.bribeMint.slice(0, 8)}…</span>
          </div>
          {bribeEarned >= alloc.capHiSola && (
            <p className="text-brand-green mt-1">
              ✅ Cap reached — further bribes still pay voters, but earn no more hiSOLA.
            </p>
          )}
        </div>
      </div>

      {/* ── Locked position ── */}
      {lock && lock.amountLocked > BigInt(0) && (
        <div className="card">
          <h3 className="text-base font-bold text-white mb-3">Your locked position</h3>
          <div className="flex flex-col gap-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-gray-500">Total locked</span>
              <span className="text-white font-mono font-semibold">{fmt(lock.amountLocked)} hiSOLA</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Permanent (never releasable)</span>
              <span className="text-gray-300 font-mono">{fmt(lock.permanentAmount)} hiSOLA</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Releasable at expiry</span>
              <span className="text-gray-300 font-mono">{fmt(releasable)} hiSOLA</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Borrowable now (20%)</span>
              <span className="text-gray-300 font-mono">{fmt(borrowable)} USDC</span>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-brand-border">
            {isLocked ? (
              <p className="text-xs text-yellow-400">
                🔒 Unlocks in <span className="font-mono font-semibold">{lockEndsIn}</span>
                {" "}({lockEndDate})
              </p>
            ) : releasable > BigInt(0) ? (
              <p className="text-xs text-brand-green">
                ✅ Lock expired — <span className="font-mono">unlock_hi_sola</span> releases{" "}
                {fmt(releasable)} hiSOLA to your position. The permanent bag stays locked.
              </p>
            ) : (
              <p className="text-xs text-gray-500">
                Lock expired, and the whole position is the permanent bag — nothing to release,
                and it keeps voting forever.
              </p>
            )}
          </div>

          <p className="text-xs text-gray-500 mt-3">
            Direct your voting power in the{" "}
            <span className="text-brand-green cursor-pointer"
              onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "vote" }))}>
              Vote
            </span>{" "}tab to steer emissions and collect bribes.
          </p>
        </div>
      )}

      {status && <p className="text-xs text-gray-400 break-all px-1">{status}</p>}
    </div>
  );
}
