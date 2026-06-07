// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getProgram, statePda, solaM, hiSolaM, oSolaM,
  solaVaultAddr, marketVault, floorVault,
  positionPda, userAta, commonAccounts, fromUi, toUi,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";
import { PROGRAM_ID } from "@/lib/program";

// ── Hardcoded founder wallet (must match FOUNDER_WALLET in lib.rs) ────────────
const FOUNDER_WALLET = "46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4";

// ── Vesting constants (devnet — must match state.rs) ─────────────────────────
// Mainnet: cliff = 180 days, duration = 720 days — flip these before launch
const VESTING_CLIFF_SECS    = 6 * 3_600;   // 6 h devnet
const VESTING_DURATION_SECS = 24 * 3_600;  // 24 h devnet

// ── PDAs ─────────────────────────────────────────────────────────────────────
const founderHiVestingPda = PublicKey.findProgramAddressSync(
  [Buffer.from("founder_hi_vesting")],
  PROGRAM_ID
)[0];

const founderVestingPda = PublicKey.findProgramAddressSync(
  [Buffer.from("founder_vesting")],
  PROGRAM_ID
)[0];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtSola(raw: number) {
  return (raw / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function pctBar(pct: number) {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <div className="w-full bg-brand-border rounded-full h-2 mt-1">
      <div
        className="bg-brand-green h-2 rounded-full transition-all"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function VestingCard({
  title,
  totalRaw,
  claimedRaw,
  startTs,
  cliffSecs,
  durationSecs,
  nowSecs,
  tokenSymbol,
  onClaim,
  loading,
}: {
  title: string;
  totalRaw: number;
  claimedRaw: number;
  startTs: number;
  cliffSecs: number;
  durationSecs: number;
  nowSecs: number;
  tokenSymbol: string;
  onClaim: () => void;
  loading: boolean;
}) {
  const elapsed      = Math.max(0, nowSecs - startTs);
  const afterCliff   = elapsed >= cliffSecs;
  const vestedRaw    = afterCliff
    ? Math.floor((totalRaw * Math.min(elapsed, durationSecs)) / durationSecs)
    : 0;
  const claimableRaw = Math.max(0, vestedRaw - claimedRaw);
  const vestPct      = (vestedRaw / totalRaw) * 100;
  const claimPct     = (claimedRaw / totalRaw) * 100;

  // Countdown to cliff
  const secsToCliff  = Math.max(0, cliffSecs - elapsed);
  const hToCliff     = Math.floor(secsToCliff / 3600);
  const mToCliff     = Math.floor((secsToCliff % 3600) / 60);

  return (
    <div className="rounded-xl bg-brand-dark border border-brand-border p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold text-white">{title}</span>
        <span className="text-xs text-gray-400 font-mono">
          {fmtSola(claimedRaw)} / {fmtSola(totalRaw)} {tokenSymbol}
        </span>
      </div>

      {/* Progress bars */}
      <div className="mb-1">
        <div className="flex justify-between text-[10px] text-gray-500 mb-0.5">
          <span>Vested {vestPct.toFixed(1)}%</span>
          <span>Claimed {claimPct.toFixed(1)}%</span>
        </div>
        {pctBar(vestPct)}
      </div>

      {!afterCliff ? (
        <p className="text-xs text-yellow-400 mt-2">
          ⏳ Cliff in {hToCliff}h {mToCliff}m
        </p>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-gray-400">
            Claimable:{" "}
            <span className="text-white font-mono font-semibold">
              {fmtSola(claimableRaw)} {tokenSymbol}
            </span>
          </span>
          <button
            className="btn-primary px-4 py-1.5 text-sm"
            onClick={onClaim}
            disabled={loading || claimableRaw === 0}
          >
            {loading ? "…" : claimableRaw === 0 ? "Nothing to claim" : "Claim"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function FounderPanel() {
  const { connection } = useConnection();
  const wallet         = useAnchorWallet();
  const { usdcMint }   = useSoladrome();

  const isFounder = wallet?.publicKey.toBase58() === FOUNDER_WALLET;

  // ── On-chain state ──────────────────────────────────────────────────────────
  const [hiVesting,       setHiVesting]       = useState<{ totalAmount: number; claimed: number; startTs: number } | null>(null);
  const [oVesting,        setOVesting]        = useState<{ totalAmount: number; claimed: number; startTs: number } | null>(null);
  const [founderPos,      setFounderPos]      = useState<{ usdcBorrowed: number } | null>(null);
  const [hiSolaBal,       setHiSolaBal]       = useState<number>(0);
  const [floorVaultBal,   setFloorVaultBal]   = useState<number>(0); // raw USDC
  const [nowSecs,         setNowSecs]         = useState<number>(Math.floor(Date.now() / 1000));

  // ── UI state ────────────────────────────────────────────────────────────────
  const [loadingHi,  setLoadingHi]  = useState(false);
  const [loadingO,   setLoadingO]   = useState(false);
  const [loadingBor, setLoadingBor] = useState(false);
  const [borrowTab,  setBorrowTab]  = useState<"borrow" | "repay">("borrow");
  const [borrowAmt,  setBorrowAmt]  = useState("");
  const [status,     setStatus]     = useState("");

  // ── Fetch all vesting + position data ───────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!wallet || !isFounder) return;
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);

      const [hiV, oV, pos, hiBal, floorBal, slot] = await Promise.allSettled([
        (program.account as any).founderHiSolaVesting.fetch(founderHiVestingPda),
        (program.account as any).founderVesting.fetch(founderVestingPda),
        (program.account as any).userPosition.fetchNullable(positionPda(wallet.publicKey)),
        connection.getTokenAccountBalance(userAta(hiSolaM, wallet.publicKey)),
        connection.getTokenAccountBalance(floorVault),
        connection.getSlot(),
      ]);

      if (hiV.status === "fulfilled") {
        const d = hiV.value;
        setHiVesting({
          totalAmount: Number(d.totalAmount.toString()),
          claimed:     Number(d.claimed.toString()),
          startTs:     Number(d.startTs.toString()),
        });
      }
      if (oV.status === "fulfilled") {
        const d = oV.value;
        setOVesting({
          totalAmount: Number(d.totalAmount.toString()),
          claimed:     Number(d.claimed.toString()),
          startTs:     Number(d.startTs.toString()),
        });
      }
      if (pos.status === "fulfilled" && pos.value) {
        setFounderPos({ usdcBorrowed: Number((pos.value as any).usdcBorrowed.toString()) });
      } else {
        setFounderPos({ usdcBorrowed: 0 });
      }
      if (hiBal.status === "fulfilled") {
        setHiSolaBal(Number(hiBal.value.value.uiAmount ?? 0));
      }
      if (floorBal.status === "fulfilled") {
        setFloorVaultBal(Number(floorBal.value.value.amount)); // raw
      }
      if (slot.status === "fulfilled") {
        const blockTime = await connection.getBlockTime(slot.value);
        if (blockTime) setNowSecs(blockTime);
      }
    } catch (e) {
      console.error("FounderPanel fetchData error:", e);
    }
  }, [connection, wallet, isFounder]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Refresh clock every 30s ──────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Claim hiSOLA vesting ─────────────────────────────────────────────────
  async function claimHiSola() {
    if (!wallet || !usdcMint) return;
    setLoadingHi(true);
    setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const founder  = wallet.publicKey;

      // Auto-migrate if UserPosition is on old 128-byte layout
      const posInfo = await connection.getAccountInfo(positionPda(founder));
      if (posInfo && posInfo.data.length < 136) {
        setStatus("⚙️ Migrating position account…");
        await program.methods.migrateUserPosition()
          .accounts({ user: founder, userPosition: positionPda(founder), systemProgram: SystemProgram.programId } as any)
          .rpc();
      }

      const tx = await program.methods
        .claimFounderHiSola()
        .accounts({
          founder,
          protocolState:       statePda,
          solaMint:            solaM,
          hiSolaMint:          hiSolaM,
          solaVault:           solaVaultAddr,
          marketVault:         marketVault,
          founderHiSola:       userAta(hiSolaM, founder),
          founderPosition:     positionPda(founder),
          founderHiVesting:    founderHiVestingPda,
          tokenProgram:        commonAccounts.tokenProgram,
          associatedTokenProgram: commonAccounts.associatedTokenProgram,
          systemProgram:       commonAccounts.systemProgram,
        } as any)
        .rpc();
      setStatus(`✅ hiSOLA claimed — tx: ${tx.slice(0, 16)}…`);
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      await fetchData();
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoadingHi(false);
    }
  }

  // ── Claim oSOLA vesting ──────────────────────────────────────────────────
  async function claimOSola() {
    if (!wallet) return;
    setLoadingO(true);
    setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const founder  = wallet.publicKey;
      const tx = await program.methods
        .claimFounderVesting()
        .accounts({
          founder,
          protocolState:          statePda,
          oSolaMint:              oSolaM,
          founderVesting:         founderVestingPda,
          founderOSola:           userAta(oSolaM, founder),
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
      setLoadingO(false);
    }
  }

  // ── Founder borrow / repay ────────────────────────────────────────────────
  const borrowCap      = hiVesting ? Math.floor(hiVesting.claimed * 0.10) : 0;
  const currentDebt    = founderPos?.usdcBorrowed ?? 0;
  const capHeadroom    = Math.max(0, borrowCap - currentDebt);          // raw
  // Actual borrowable = min(cap headroom, floor vault liquidity)
  const borrowAvailRaw = Math.min(capHeadroom, floorVaultBal);
  const borrowAvail    = borrowAvailRaw / 1_000_000;
  const limitedByFloor = floorVaultBal < capHeadroom && capHeadroom > 0;

  async function submitBorrow() {
    if (!wallet || !borrowAmt || !usdcMint) return;
    setLoadingBor(true);
    setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const founder  = wallet.publicKey;

      if (borrowTab === "borrow") {
        const tx = await program.methods
          .founderBorrowUsdc(fromUi(+borrowAmt))
          .accounts({
            founder,
            protocolState:          statePda,
            hiSolaMint:             hiSolaM,
            founderHiSola:          userAta(hiSolaM, founder),
            floorVault:             floorVault,
            marketVault:            marketVault,
            usdcMint:               usdcMint,
            founderUsdc:            userAta(usdcMint, founder),
            founderPosition:        positionPda(founder),
            founderHiVesting:       founderHiVestingPda,
            tokenProgram:           commonAccounts.tokenProgram,
            associatedTokenProgram: commonAccounts.associatedTokenProgram,
            systemProgram:          commonAccounts.systemProgram,
          } as any)
          .rpc();
        setStatus(`✅ Borrowed ${borrowAmt} USDC — tx: ${tx.slice(0, 16)}…`);
      } else {
        // Regular repay_usdc — same PDA, no special auth check
        const tx = await program.methods
          .repayUsdc(fromUi(+borrowAmt))
          .accounts({
            user:          founder,
            protocolState: statePda,
            userPosition:  positionPda(founder),
            floorVault:    floorVault,
            userUsdc:      userAta(usdcMint, founder),
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

  if (!isFounder) {
    return (
      <div className="card text-center py-12">
        <div className="text-4xl mb-4">🔒</div>
        <p className="text-gray-400 text-sm">Founder access only.</p>
      </div>
    );
  }

  const startTs = hiVesting?.startTs ?? 0;
  const vestingStarted = startTs > 0;

  return (
    <div className="max-w-xl mx-auto flex flex-col gap-6">

      {/* ── Header ─────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-2xl">👑</span>
          <h2 className="text-xl font-black text-white">Founder Panel</h2>
        </div>
        <p className="text-xs text-gray-500">
          Private — only visible to wallet <span className="font-mono text-gray-400">{FOUNDER_WALLET.slice(0, 8)}…</span>
        </p>
      </div>

      {!vestingStarted ? (
        <div className="card text-center py-8 text-gray-500 text-sm">
          Vesting not yet started — call <code className="text-brand-green">mint_founder_allocation</code> first.
        </div>
      ) : (
        <>
          {/* ── hiSOLA Vesting ──────────────────────────────── */}
          <div className="card">
            <h3 className="text-base font-bold text-white mb-1">
              hiSOLA Vesting
              <span className="ml-2 text-xs font-normal text-gray-500">(7 M governance tranche)</span>
            </h3>
            <p className="text-xs text-gray-500 mb-4">
              Mints SOLA → sola_vault + hiSOLA to your wallet. Linear, no cliff penalty.
              Current balance: <span className="text-white font-mono">{hiSolaBal.toLocaleString(undefined, {maximumFractionDigits: 2})} hiSOLA</span>.
            </p>

            {hiVesting && (
              <VestingCard
                title="7 000 000 hiSOLA"
                totalRaw={hiVesting.totalAmount}
                claimedRaw={hiVesting.claimed}
                startTs={hiVesting.startTs}
                cliffSecs={VESTING_CLIFF_SECS}
                durationSecs={VESTING_DURATION_SECS}
                nowSecs={nowSecs}
                tokenSymbol="hiSOLA"
                onClaim={claimHiSola}
                loading={loadingHi}
              />
            )}
          </div>

          {/* ── oSOLA Vesting ───────────────────────────────── */}
          <div className="card">
            <h3 className="text-base font-bold text-white mb-1">
              oSOLA Vesting
              <span className="ml-2 text-xs font-normal text-gray-500">(5 M liquid tranche)</span>
            </h3>
            <p className="text-xs text-gray-500 mb-4">
              Mints oSOLA to your wallet. Exercise via the <span className="text-brand-green">oSOLA</span> tab to convert at floor price.
            </p>

            {oVesting && (
              <VestingCard
                title="5 000 000 oSOLA"
                totalRaw={oVesting.totalAmount}
                claimedRaw={oVesting.claimed}
                startTs={oVesting.startTs}
                cliffSecs={VESTING_CLIFF_SECS}
                durationSecs={VESTING_DURATION_SECS}
                nowSecs={nowSecs}
                tokenSymbol="oSOLA"
                onClaim={claimOSola}
                loading={loadingO}
              />
            )}
          </div>

          {/* ── Founder Borrow ──────────────────────────────── */}
          <div className="card">
            <h3 className="text-base font-bold text-white mb-1">
              Founder Borrow
              <span className="ml-2 text-xs font-normal text-gray-500">(capped at 10% of claimed hiSOLA)</span>
            </h3>

            {/* Cap info banner */}
            <div className="flex items-start gap-2 text-xs text-gray-500 bg-brand-dark border border-brand-border rounded-lg px-3 py-2 mb-3">
              <span className="text-brand-green text-base leading-none shrink-0">ℹ</span>
              <span>
                Cap: <span className="text-white font-mono font-semibold">{fmtSola(borrowCap)} USDC</span>
                {" "}(10% × {fmtSola(hiVesting?.claimed ?? 0)} hiSOLA) ·{" "}
                Debt: <span className="text-yellow-400 font-mono">{fmtSola(currentDebt)} USDC</span> ·{" "}
                Available: <span className="text-brand-green font-mono font-semibold">{borrowAvail.toFixed(4)} USDC</span>
              </span>
            </div>
            {limitedByFloor && (
              <div className="flex items-start gap-2 text-xs bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 mb-3">
                <span className="text-yellow-400 text-base leading-none shrink-0">⚠</span>
                <span className="text-yellow-300">
                  Floor vault liquidity ({fmtSola(floorVaultBal)} USDC) is lower than your cap.
                  Available borrow is limited to floor vault balance.
                  More SOLA purchases will increase this limit.
                </span>
              </div>
            )}

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
                {borrowTab === "borrow" && (
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
                    Max {fmtSola(currentDebt)}
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
                ? "No interest · No liquidation · Repay anytime · 2% origination fee to market_vault"
                : "Repaying unlocks your borrow headroom for future draws"}
            </p>

            <button
              className="btn-primary w-full"
              onClick={submitBorrow}
              disabled={loadingBor || !borrowAmt || !usdcMint}
            >
              {loadingBor ? "Processing…" : borrowTab === "borrow" ? "Borrow" : "Repay"}
            </button>
          </div>
        </>
      )}

      {/* ── Status ──────────────────────────────────────────── */}
      {status && (
        <p className="text-xs text-gray-400 break-all px-1">{status}</p>
      )}
    </div>
  );
}
