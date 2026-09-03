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
import { useFloorHeadroom } from "@/lib/SoladromeContext";
import { PartnerStream } from "@/components/PartnerStream";

const PARTNER_SEED  = Buffer.from("partner");
const VELOCK_SEED   = Buffer.from("velock");

const EPOCH_DURATION = 604_800; // state.rs
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
  bribeMintKey:      PublicKey;
  lpMint:            PublicKey;
  lpThreshold:       bigint;
  retainerPerEpoch:  bigint;
  minBribePerEpoch:  bigint;
  lastCreditedEpoch: number;
  epochsQualified:   number;
  streamStartTs:     number;
  scheduleEpochs:    number;
  bribeMint:         string;
  baseHiSola:        bigint;
  bagClaimed:        boolean;
  claimed:           bigint;
  lockDurationSecs:  number;
  startTs:           number;
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
        // Field names track PartnerAllocation in state.rs, and a mismatch is not cosmetic —
        // a missing field throws in this callback and leaves the panel on "Loading…" forever.
        // It happened on 2026-08-25 (`hiSolaAmount`) and again here: `rateNum`, `rateDen`,
        // `capHiSola` and `totalBribedCredited` no longer exist at all.
        setAlloc({
          bribeMintKey:      d.bribeMint,
          lpMint:            d.lpMint,
          lpThreshold:       BigInt(d.lpThreshold.toString()),
          retainerPerEpoch:  BigInt(d.retainerPerEpoch.toString()),
          minBribePerEpoch:  BigInt(d.minBribePerEpoch.toString()),
          lastCreditedEpoch: Number(d.lastCreditedEpoch.toString()),
          epochsQualified:   Number(d.epochsQualified.toString()),
          streamStartTs:     Number(d.streamStartTs?.toString() ?? "0"),
          scheduleEpochs:    Number(d.scheduleEpochs?.toString() ?? "0"),
          bribeMint:         d.bribeMint.toBase58(),
          baseHiSola:        BigInt(d.baseHiSola.toString()),
          bagClaimed:        Boolean(d.bagClaimed),
          claimed:           BigInt(d.hiSolaClaimed.toString()),
          lockDurationSecs:  Number(d.lockDurationSecs.toString()),
          startTs:           Number(d.startTs.toString()),
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

  // ── The same test claim_partner_allocation runs ─────────────────────────────
  // A zero stamp means no schedule was ever escrowed, and nothing accrues at all — the bag is
  // the consideration for the schedule, so it cannot precede it.
  const claimable = alloc.streamStartTs !== 0 && !alloc.bagClaimed
    ? alloc.baseHiSola
    : BigInt(0);
  const currentEpoch = Math.floor(nowSecs / EPOCH_DURATION);

  const isLocked   = lock && lock.lockEndTs > nowSecs;
  const lockEndsIn = lock ? timeLeft(lock.lockEndTs, nowSecs) : null;
  const lockEndDate = lock ? new Date(lock.lockEndTs * 1000).toLocaleDateString(undefined, {
    day: "2-digit", month: "short", year: "numeric",
  }) : null;

  // 20% of the locked position, then the protocol's 75% floor buffer. `borrow_against_locked`
  // enforces both, and at low buy volume the buffer is the one that binds — publishing the cap
  // alone promises a partner USDC the chain would refuse.
  const capBorrowable = lock
    ? (lock.amountLocked * BigInt(PARTNER_BORROW_CAP_BPS)) / BigInt(10_000)
    : BigInt(0);
  const floorHeadroomRaw = useFloorHeadroom();
  const floorCap   = floorHeadroomRaw === null ? null : BigInt(Math.floor(floorHeadroomRaw));
  const floorBinds = floorCap !== null && floorCap < capBorrowable;
  const borrowable = floorBinds ? (floorCap as bigint) : capBorrowable;
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
          Vote-locked hiSOLA · a signature bag, then a retainer on your liquidity
        </p>
      </div>

      {/* ── The schedule that gates everything else, and this epoch's crank ── */}
      <PartnerStream
        alloc={{
          bribeMint:         alloc.bribeMintKey,
          lpMint:            alloc.lpMint,
          lpThreshold:       alloc.lpThreshold,
          retainerPerEpoch:  alloc.retainerPerEpoch,
          minBribePerEpoch:  alloc.minBribePerEpoch,
          baseHiSola:        alloc.baseHiSola,
          streamStartTs:     alloc.streamStartTs,
          scheduleEpochs:    alloc.scheduleEpochs,
          lastCreditedEpoch: alloc.lastCreditedEpoch,
          epochsQualified:   alloc.epochsQualified,
        }}
        bribeDec={bribeDec}
        onChanged={fetchData}
      />

      {/* ── The signature bag ── */}
      <div className="card">
        <div className="flex justify-between items-baseline mb-1">
          <h3 className="text-base font-bold text-white">Signature bag</h3>
          <span className="text-xs text-gray-400 font-mono">{fmt(alloc.baseHiSola)} hiSOLA</span>
        </div>
        <p className="text-[11px] text-gray-500 mb-4">
          Delivered whole, once, the moment your schedule is escrowed. It is the only
          unconditional part of the deal, which is why it is the smaller part.
        </p>

        {alloc.bagClaimed ? (
          <p className="text-xs text-brand-green">
            ✅ Claimed — permanent, voting for life, never unlockable or sellable.
          </p>
        ) : (
          <>
            <div className="flex items-start gap-2 text-xs text-gray-500 bg-brand-dark border border-brand-border rounded-lg px-3 py-2 mb-4">
              <span className="text-brand-green text-base leading-none shrink-0">ℹ</span>
              <span>
                Claiming mints straight into your vote-locked position — your wallet balance
                stays 0, and voting power is live immediately. It earns protocol fees for life,
                and you can draw{" "}
                <span className="text-white font-mono">20%</span> of it as USDC through
                borrow_against_locked, without interest or liquidation.
              </span>
            </div>
            <button
              className="btn-primary w-full"
              onClick={claimAllocation}
              disabled={loading || claimable === BigInt(0)}
            >
              {loading ? "Processing…"
                : claimable === BigInt(0)
                  ? "Escrow your bribe schedule first"
                  : `Claim & lock ${fmt(claimable)} hiSOLA`}
            </button>
          </>
        )}
      </div>

      {/* ── The retainer ── */}
      <div className="card">
        <div className="flex justify-between items-baseline mb-1">
          <h3 className="text-base font-bold text-white">Retainer</h3>
          <span className="text-xs text-gray-400 font-mono">
            {fmt(alloc.retainerPerEpoch)} hiSOLA / epoch
          </span>
        </div>
        <p className="text-[11px] text-gray-500 mb-3">
          Bought one epoch at a time against liquidity that is still there. No total, no cap and
          no end date: stay three years and it pays for three years.
        </p>
        <div className="flex flex-col gap-1 text-[11px]">
          <div className="flex justify-between">
            <span className="text-gray-500">Epochs earned</span>
            <span className="text-gray-300 font-mono">{alloc.epochsQualified}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Credited in total</span>
            <span className="text-gray-300 font-mono">{fmt(alloc.claimed)} hiSOLA</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Last epoch credited</span>
            <span className="text-gray-300 font-mono">
              {alloc.lastCreditedEpoch === 0 ? "—" : alloc.lastCreditedEpoch}
              {alloc.lastCreditedEpoch === currentEpoch && " (this one)"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Committed bribe mint</span>
            <span className="text-gray-300 font-mono">{alloc.bribeMint.slice(0, 8)}…</span>
          </div>
        </div>
        <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
          Every epoch credited is <span className="text-white">permanent</span> hiSOLA: it votes
          for life, earns protocol fees for life, and borrows at 20% — and it can never be
          unlocked or sold, because nobody bought it through the curve.
        </p>
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
              <span className="text-gray-500">
                Borrowable now {floorBinds ? "(floor buffer)" : "(20%)"}
              </span>
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
