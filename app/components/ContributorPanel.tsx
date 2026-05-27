// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getProgram, statePda, oSolaM, floorVault, marketVault,
  positionPda, userAta, commonAccounts, fromUi, PROGRAM_ID,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";

// ── Vesting constants (devnet — must match state.rs) ─────────────────────────
// Mainnet: cliff = 1 month, duration = 12 months — flip before launch
const CONTRIBUTOR_CLIFF_SECS    = 1 * 3_600;  // 1 h devnet
const CONTRIBUTOR_DURATION_SECS = 12 * 3_600; // 12 h devnet

const CONTRIBUTOR_SEED = Buffer.from("contributor");

export function contributorVestingPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [CONTRIBUTOR_SEED, wallet.toBuffer()],
    PROGRAM_ID
  )[0];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(raw: number, decimals = 2) {
  return (raw / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function ProgressBar({ pct }: { pct: number }) {
  const c = Math.min(100, Math.max(0, pct));
  return (
    <div className="w-full bg-brand-border rounded-full h-2 mt-1">
      <div className="bg-brand-green h-2 rounded-full transition-all" style={{ width: `${c}%` }} />
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ContributorPanel() {
  const { connection } = useConnection();
  const wallet         = useAnchorWallet();
  const { usdcMint }   = useSoladrome();

  // ── On-chain state ──────────────────────────────────────────────────────────
  const [vesting,  setVesting]  = useState<{
    totalAmount: number; claimed: number; startTs: number;
  } | null>(null);
  const [position, setPosition] = useState<{ usdcBorrowed: number } | null>(null);
  const [nowSecs,  setNowSecs]  = useState(Math.floor(Date.now() / 1000));
  const [notFound, setNotFound] = useState(false);

  // ── UI state ────────────────────────────────────────────────────────────────
  const [loadingClaim, setLoadingClaim] = useState(false);
  const [loadingBor,   setLoadingBor]   = useState(false);
  const [borrowTab,    setBorrowTab]    = useState<"borrow" | "repay">("borrow");
  const [borrowAmt,    setBorrowAmt]    = useState("");
  const [status,       setStatus]       = useState("");

  // ── Fetch vesting PDA ───────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!wallet) return;
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const pda      = contributorVestingPda(wallet.publicKey);

      const [v, pos, slot] = await Promise.allSettled([
        (program.account as any).contributorVesting.fetchNullable(pda),
        (program.account as any).userPosition.fetchNullable(positionPda(wallet.publicKey)),
        connection.getSlot(),
      ]);

      if (v.status === "fulfilled" && v.value) {
        const d = v.value;
        setVesting({
          totalAmount: Number(d.totalAmount.toString()),
          claimed:     Number(d.claimed.toString()),
          startTs:     Number(d.startTs.toString()),
        });
        setNotFound(false);
      } else {
        setNotFound(true);
      }

      if (pos.status === "fulfilled" && pos.value) {
        setPosition({ usdcBorrowed: Number((pos.value as any).usdcBorrowed.toString()) });
      } else {
        setPosition({ usdcBorrowed: 0 });
      }

      if (slot.status === "fulfilled") {
        const bt = await connection.getBlockTime(slot.value);
        if (bt) setNowSecs(bt);
      }
    } catch (e) {
      console.error("ContributorPanel fetchData error:", e);
    }
  }, [connection, wallet]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    const id = setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Derived vesting values ──────────────────────────────────────────────────
  const elapsed    = vesting ? Math.max(0, nowSecs - vesting.startTs) : 0;
  const afterCliff = elapsed >= CONTRIBUTOR_CLIFF_SECS;
  const vestedRaw  = vesting && afterCliff
    ? Math.floor((vesting.totalAmount * Math.min(elapsed, CONTRIBUTOR_DURATION_SECS)) / CONTRIBUTOR_DURATION_SECS)
    : 0;
  const claimableRaw = vesting ? Math.max(0, vestedRaw - vesting.claimed) : 0;
  const vestPct      = vesting ? (vestedRaw / vesting.totalAmount) * 100 : 0;
  const claimPct     = vesting ? (vesting.claimed / vesting.totalAmount) * 100 : 0;
  const secsToCliff  = vesting ? Math.max(0, CONTRIBUTOR_CLIFF_SECS - elapsed) : 0;
  const hToCliff     = Math.floor(secsToCliff / 3600);
  const mToCliff     = Math.floor((secsToCliff % 3600) / 60);

  // Borrow cap = 10% of claimed
  const borrowCap   = vesting ? Math.floor(vesting.claimed * 0.10) : 0;
  const currentDebt = position?.usdcBorrowed ?? 0;
  const borrowAvail = Math.max(0, borrowCap - currentDebt) / 1_000_000;

  // ── Claim oSOLA ─────────────────────────────────────────────────────────────
  async function claimVesting() {
    if (!wallet) return;
    setLoadingClaim(true);
    setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const pda      = contributorVestingPda(wallet.publicKey);
      const tx = await program.methods
        .claimContributorVesting()
        .accounts({
          contributor:            wallet.publicKey,
          protocolState:          statePda,
          oSolaMint:              oSolaM,
          contributorVesting:     pda,
          contributorOSola:       userAta(oSolaM, wallet.publicKey),
          tokenProgram:           commonAccounts.tokenProgram,
          associatedTokenProgram: commonAccounts.associatedTokenProgram,
          systemProgram:          commonAccounts.systemProgram,
        } as any)
        .rpc();
      setStatus(`✅ oSOLA claimed — tx: ${tx.slice(0, 16)}…`);
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      await fetchData();
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoadingClaim(false);
    }
  }

  // ── Borrow / Repay ──────────────────────────────────────────────────────────
  async function submitBorrow() {
    if (!wallet || !borrowAmt || !usdcMint) return;
    setLoadingBor(true);
    setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const pda      = contributorVestingPda(wallet.publicKey);

      if (borrowTab === "borrow") {
        const tx = await program.methods
          .contributorBorrowUsdc(fromUi(+borrowAmt))
          .accounts({
            contributor:         wallet.publicKey,
            protocolState:       statePda,
            floorVault:          floorVault,
            marketVault:         marketVault,
            contributorUsdc:     userAta(usdcMint, wallet.publicKey),
            contributorPosition: positionPda(wallet.publicKey),
            contributorVesting:  pda,
            tokenProgram:        commonAccounts.tokenProgram,
            systemProgram:       commonAccounts.systemProgram,
          } as any)
          .rpc();
        setStatus(`✅ Borrowed ${borrowAmt} USDC — tx: ${tx.slice(0, 16)}…`);
      } else {
        const tx = await program.methods
          .repayUsdc(fromUi(+borrowAmt))
          .accounts({
            user:          wallet.publicKey,
            protocolState: statePda,
            userPosition:  positionPda(wallet.publicKey),
            floorVault:    floorVault,
            userUsdc:      userAta(usdcMint, wallet.publicKey),
            tokenProgram:  commonAccounts.tokenProgram,
          } as any)
          .rpc();
        setStatus(`✅ Repaid ${borrowAmt} USDC — tx: ${tx.slice(0, 16)}…`);
      }
      setBorrowAmt("");
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      await fetchData();
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoadingBor(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (!wallet) {
    return (
      <div className="card text-center text-gray-500 py-12">
        Connect wallet to continue.
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="card text-center py-12">
        <div className="text-4xl mb-4">🔍</div>
        <p className="text-gray-400 text-sm">
          No contributor allocation found for this wallet.
        </p>
        <p className="text-gray-600 text-xs mt-2">
          Contact the Soladrome team if you believe this is an error.
        </p>
      </div>
    );
  }

  if (!vesting) {
    return (
      <div className="card text-center py-12 text-gray-500 text-sm">
        Loading…
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto flex flex-col gap-6">

      {/* ── Header ───────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-2xl">🤝</span>
          <h2 className="text-xl font-black text-white">Contributor Allocation</h2>
        </div>
        <p className="text-xs text-gray-500">
          Your on-chain oSOLA vesting schedule · transparent &amp; permissionless
        </p>
      </div>

      {/* ── oSOLA Vesting ──────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-white">oSOLA Vesting</h3>
          <span className="text-xs text-gray-400 font-mono">
            {fmt(vesting.claimed)} / {fmt(vesting.totalAmount)} oSOLA
          </span>
        </div>

        {/* Progress bars */}
        <div className="mb-1">
          <div className="flex justify-between text-[10px] text-gray-500 mb-0.5">
            <span>Vested {vestPct.toFixed(1)}%</span>
            <span>Claimed {claimPct.toFixed(1)}%</span>
          </div>
          <ProgressBar pct={vestPct} />
        </div>

        <div className="flex items-start gap-2 text-xs text-gray-500 bg-brand-dark border border-brand-border rounded-lg px-3 py-2 mt-3 mb-3">
          <span className="text-brand-green text-base leading-none shrink-0">ℹ</span>
          <span>
            oSOLA is exercisable 1:1 for SOLA at floor price (pay 1 USDC → receive 1 SOLA).
            Each exercise strengthens the protocol floor reserve.
          </span>
        </div>

        {!afterCliff ? (
          <p className="text-xs text-yellow-400 mt-2">
            ⏳ Cliff in {hToCliff}h {mToCliff}m — tokens unlock progressively after cliff
          </p>
        ) : (
          <div className="flex items-center justify-between gap-3 mt-3">
            <span className="text-xs text-gray-400">
              Claimable:{" "}
              <span className="text-white font-mono font-semibold">
                {fmt(claimableRaw)} oSOLA
              </span>
            </span>
            <button
              className="btn-primary px-4 py-1.5 text-sm"
              onClick={claimVesting}
              disabled={loadingClaim || claimableRaw === 0}
            >
              {loadingClaim ? "…" : claimableRaw === 0 ? "Up to date" : "Claim oSOLA"}
            </button>
          </div>
        )}
      </div>

      {/* ── Contributor Borrow ───────────────────────────────────── */}
      <div className="card">
        <h3 className="text-base font-bold text-white mb-1">
          Borrow USDC
          <span className="ml-2 text-xs font-normal text-gray-500">(10% of claimed oSOLA)</span>
        </h3>

        <div className="flex items-start gap-2 text-xs text-gray-500 bg-brand-dark border border-brand-border rounded-lg px-3 py-2 mb-4">
          <span className="text-brand-green text-base leading-none shrink-0">ℹ</span>
          <span>
            Cap: <span className="text-white font-mono font-semibold">{fmt(borrowCap)} USDC</span>
            {" "}(10% × {fmt(vesting.claimed)} oSOLA claimed) ·{" "}
            Debt: <span className="text-yellow-400 font-mono">{fmt(currentDebt)} USDC</span> ·{" "}
            Available: <span className="text-brand-green font-mono font-semibold">{borrowAvail.toFixed(4)} USDC</span>
          </span>
        </div>

        {/* Tabs */}
        <div className="flex gap-6 mb-5 border-b border-brand-border">
          {(["borrow", "repay"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setBorrowTab(t)}
              className={`pb-2 text-sm font-semibold uppercase tracking-wide transition-colors ${
                borrowTab === t ? "tab-active" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Input */}
        <div className="rounded-xl bg-brand-dark border border-brand-border p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-400">
              {borrowTab === "borrow" ? "USDC to borrow" : "USDC to repay"}
            </span>
            {borrowTab === "borrow" && borrowAvail > 0 && (
              <button
                className="text-xs text-gray-300 hover:text-brand-green transition-colors font-mono"
                onClick={() => setBorrowAmt(borrowAvail.toFixed(6).replace(/\.?0+$/, ""))}
              >
                Max {borrowAvail.toFixed(4)}
              </button>
            )}
            {borrowTab === "repay" && currentDebt > 0 && (
              <button
                className="text-xs text-gray-300 hover:text-brand-green transition-colors font-mono"
                onClick={() => setBorrowAmt((currentDebt / 1_000_000).toFixed(6).replace(/\.?0+$/, ""))}
              >
                Max {fmt(currentDebt)}
              </button>
            )}
          </div>
          <input
            className="w-full bg-transparent text-right text-2xl font-bold text-white placeholder-gray-600 focus:outline-none"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={borrowAmt}
            onChange={(e) => {
              if (e.target.value === "" || /^\d*\.?\d*$/.test(e.target.value))
                setBorrowAmt(e.target.value);
            }}
          />
        </div>

        <p className="text-xs text-gray-500 mb-4">
          {borrowTab === "borrow"
            ? "No interest · No liquidation · 2% origination fee to market_vault"
            : "Repaying increases your available borrow headroom"}
        </p>

        <button
          className="btn-primary w-full"
          onClick={submitBorrow}
          disabled={loadingBor || !borrowAmt || !usdcMint}
        >
          {loadingBor ? "Processing…" : borrowTab === "borrow" ? "Borrow" : "Repay"}
        </button>
      </div>

      {/* ── Status ──────────────────────────────────────────────── */}
      {status && (
        <p className="text-xs text-gray-400 break-all px-1">{status}</p>
      )}
    </div>
  );
}
