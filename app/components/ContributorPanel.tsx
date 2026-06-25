// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getProgram, statePda, solaM, hiSolaM, oSolaM,
  solaVaultAddr, marketVault, floorVault,
  positionPda, userAta, commonAccounts, fromUi, PROGRAM_ID, sendTx,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";

// ── Vesting constants (devnet — must match state.rs) ─────────────────────────
// Mainnet: cliff = 1 month, duration = 12 months
const CONTRIBUTOR_CLIFF_SECS    = 1 * 3_600;   // 1 h devnet
const CONTRIBUTOR_DURATION_SECS = 12 * 3_600;  // 12 h devnet

const CONTRIBUTOR_SEED = Buffer.from("contributor");

export function contributorVestingPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [CONTRIBUTOR_SEED, wallet.toBuffer()],
    PROGRAM_ID
  )[0];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(raw: number, dec = 2) {
  return (raw / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: dec });
}

function ProgressBar({ pct, color = "bg-brand-green" }: { pct: number; color?: string }) {
  return (
    <div className="w-full bg-brand-border rounded-full h-2 mt-1">
      <div className={`${color} h-2 rounded-full transition-all`}
           style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

interface VestingData {
  hiSolaAmount:  number;
  oSolaAmount:   number;
  hiSolaClaimed: number;
  oSolaClaimed:  number;
  startTs:       number;
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ContributorPanel() {
  const { connection } = useConnection();
  const wallet         = useAnchorWallet();
  const { usdcMint }   = useSoladrome();

  const [vesting,   setVesting]   = useState<VestingData | null>(null);
  const [debt,      setDebt]      = useState(0);
  const [nowSecs,   setNowSecs]   = useState(Math.floor(Date.now() / 1000));
  const [notFound,  setNotFound]  = useState(false);

  const [loadingHi,  setLoadingHi]  = useState(false);
  const [loadingO,   setLoadingO]   = useState(false);
  const [loadingBor, setLoadingBor] = useState(false);
  const [borrowTab,  setBorrowTab]  = useState<"borrow" | "repay">("borrow");
  const [borrowAmt,  setBorrowAmt]  = useState("");
  const [status,     setStatus]     = useState("");

  // ── Fetch ───────────────────────────────────────────────────────────────────
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
        const d = v.value as any;
        setVesting({
          hiSolaAmount:  Number(d.hiSolaAmount.toString()),
          oSolaAmount:   Number(d.oSolaAmount.toString()),
          hiSolaClaimed: Number(d.hiSolaClaimed.toString()),
          oSolaClaimed:  Number(d.oSolaClaimed.toString()),
          startTs:       Number(d.startTs.toString()),
        });
        setNotFound(false);
      } else {
        setNotFound(true);
      }

      setDebt(pos.status === "fulfilled" && pos.value
        ? Number((pos.value as any).usdcBorrowed.toString()) : 0);

      if (slot.status === "fulfilled") {
        const bt = await connection.getBlockTime(slot.value);
        if (bt) setNowSecs(bt);
      }
    } catch (e) { console.error("ContributorPanel fetchData:", e); }
  }, [connection, wallet]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    const id = setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Derived values ──────────────────────────────────────────────────────────
  const elapsed    = vesting ? Math.max(0, nowSecs - vesting.startTs) : 0;
  const afterCliff = elapsed >= CONTRIBUTOR_CLIFF_SECS;
  const secsLeft   = vesting ? Math.max(0, CONTRIBUTOR_CLIFF_SECS - elapsed) : 0;

  function vestedRaw(total: number) {
    if (!afterCliff) return 0;
    return Math.floor(total * Math.min(elapsed, CONTRIBUTOR_DURATION_SECS) / CONTRIBUTOR_DURATION_SECS);
  }
  const hiVested    = vesting ? vestedRaw(vesting.hiSolaAmount) : 0;
  const oVested     = vesting ? vestedRaw(vesting.oSolaAmount)  : 0;
  const hiClaimable = vesting ? Math.max(0, hiVested - vesting.hiSolaClaimed) : 0;
  const oClaimable  = vesting ? Math.max(0, oVested  - vesting.oSolaClaimed)  : 0;

  // Borrow cap = 10% of monthly hiSOLA = hiSolaAmount / 120
  const monthlyHi  = vesting ? Math.floor(vesting.hiSolaAmount / 12) : 0;
  const borrowCap  = Math.floor(monthlyHi * 0.10);
  const borrowAvail = Math.max(0, borrowCap - debt) / 1_000_000;

  // ── Claim hiSOLA ────────────────────────────────────────────────────────────
  async function claimHiSola() {
    if (!wallet) return;
    setLoadingHi(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const pda      = contributorVestingPda(wallet.publicKey);
      const ix = await program.methods.claimContributorHiSola()
        .accounts({
          contributor:          wallet.publicKey,
          protocolState:        statePda,
          solaMint:             solaM,
          hiSolaMint:           hiSolaM,
          solaVault:            solaVaultAddr,
          marketVault,
          contributorHiSola:    userAta(hiSolaM, wallet.publicKey),
          contributorPosition:  positionPda(wallet.publicKey),
          contributorVesting:   pda,
          tokenProgram:         commonAccounts.tokenProgram,
          associatedTokenProgram: commonAccounts.associatedTokenProgram,
          systemProgram:        commonAccounts.systemProgram,
        } as any).instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setStatus(`✅ hiSOLA claimed — tx: ${tx.slice(0,16)}…`);
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      await fetchData();
    } catch (e: any) { setStatus(`❌ ${e?.message ?? e}`); }
    finally { setLoadingHi(false); }
  }

  // ── Claim oSOLA ─────────────────────────────────────────────────────────────
  async function claimOSola() {
    if (!wallet) return;
    setLoadingO(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const pda      = contributorVestingPda(wallet.publicKey);
      const ix = await program.methods.claimContributorVesting()
        .accounts({
          contributor:          wallet.publicKey,
          protocolState:        statePda,
          oSolaMint:            oSolaM,
          contributorVesting:   pda,
          contributorOSola:     userAta(oSolaM, wallet.publicKey),
          tokenProgram:         commonAccounts.tokenProgram,
          associatedTokenProgram: commonAccounts.associatedTokenProgram,
          systemProgram:        commonAccounts.systemProgram,
        } as any).instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setStatus(`✅ oSOLA claimed — tx: ${tx.slice(0,16)}…`);
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      await fetchData();
    } catch (e: any) { setStatus(`❌ ${e?.message ?? e}`); }
    finally { setLoadingO(false); }
  }

  // ── Borrow / Repay ──────────────────────────────────────────────────────────
  async function submitBorrow() {
    if (!wallet || !borrowAmt || !usdcMint) return;
    setLoadingBor(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const pda      = contributorVestingPda(wallet.publicKey);

      let tx: string;
      if (borrowTab === "borrow") {
        const ix = await program.methods.contributorBorrowUsdc(fromUi(+borrowAmt))
          .accounts({
            contributor:            wallet.publicKey,
            protocolState:          statePda,
            hiSolaMint:             hiSolaM,
            contributorHiSola:      userAta(hiSolaM, wallet.publicKey),
            floorVault,
            marketVault,
            usdcMint:               usdcMint,
            contributorUsdc:        userAta(usdcMint, wallet.publicKey),
            contributorPosition:    positionPda(wallet.publicKey),
            contributorVesting:     pda,
            tokenProgram:           commonAccounts.tokenProgram,
            associatedTokenProgram: commonAccounts.associatedTokenProgram,
            systemProgram:          commonAccounts.systemProgram,
          } as any).instruction();
        tx = await sendTx(connection, wallet, [ix]);
        setStatus(`✅ Borrowed ${borrowAmt} USDC — tx: ${tx.slice(0,16)}…`);
      } else {
        const ix = await program.methods.repayUsdc(fromUi(+borrowAmt))
          .accounts({
            user:          wallet.publicKey,
            protocolState: statePda,
            userPosition:  positionPda(wallet.publicKey),
            floorVault,
            userUsdc:      userAta(usdcMint, wallet.publicKey),
            tokenProgram:  commonAccounts.tokenProgram,
          } as any).instruction();
        tx = await sendTx(connection, wallet, [ix]);
        setStatus(`✅ Repaid ${borrowAmt} USDC — tx: ${tx.slice(0,16)}…`);
      }
      setBorrowAmt("");
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      await fetchData();
    } catch (e: any) { setStatus(`❌ ${e?.message ?? e}`); }
    finally { setLoadingBor(false); }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (!wallet) return (
    <div className="card text-center text-gray-500 py-12">Connect wallet to continue.</div>
  );

  if (notFound) return (
    <div className="card text-center py-12">
      <div className="text-4xl mb-4">🔍</div>
      <p className="text-gray-400 text-sm">No contributor allocation found for this wallet.</p>
      <p className="text-gray-600 text-xs mt-2">Contact the Soladrome team if you believe this is an error.</p>
    </div>
  );

  if (!vesting) return (
    <div className="card text-center py-12 text-gray-500 text-sm">Loading…</div>
  );

  const cliffInfo = !afterCliff && (
    <p className="text-xs text-yellow-400 mt-3">
      ⏳ Cliff in {Math.floor(secsLeft / 3600)}h {Math.floor((secsLeft % 3600) / 60)}m — tokens unlock progressively after cliff
    </p>
  );

  return (
    <div className="max-w-xl mx-auto flex flex-col gap-6">

      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-2xl">🤝</span>
          <h2 className="text-xl font-black text-white">Contributor Allocation</h2>
        </div>
        <p className="text-xs text-gray-500">
          On-chain vesting · transparent &amp; permissionless · verified on Solana
        </p>
      </div>

      {/* ── hiSOLA Vesting ──────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-white">
            hiSOLA Vesting
            <span className="ml-2 text-xs font-normal text-gray-500">(governance + borrow)</span>
          </h3>
          <span className="text-xs text-gray-400 font-mono">
            {fmt(vesting.hiSolaClaimed)} / {fmt(vesting.hiSolaAmount)}
          </span>
        </div>

        <div className="flex justify-between text-[10px] text-gray-500 mb-0.5">
          <span>Vested {vesting.hiSolaAmount > 0 ? ((hiVested / vesting.hiSolaAmount) * 100).toFixed(1) : "0"}%</span>
          <span>Claimed {vesting.hiSolaAmount > 0 ? ((vesting.hiSolaClaimed / vesting.hiSolaAmount) * 100).toFixed(1) : "0"}%</span>
        </div>
        <ProgressBar pct={vesting.hiSolaAmount > 0 ? (hiVested / vesting.hiSolaAmount) * 100 : 0} />

        <p className="text-xs text-gray-500 mt-2">
          hiSOLA gives you governance rights, fee share &amp; USDC borrow power. Monthly installment: <span className="text-white font-mono">{fmt(monthlyHi)} hiSOLA</span>.
        </p>

        {cliffInfo}
        {afterCliff && (
          <div className="flex items-center justify-between gap-3 mt-3">
            <span className="text-xs text-gray-400">
              Claimable: <span className="text-white font-mono font-semibold">{fmt(hiClaimable)} hiSOLA</span>
            </span>
            <button className="btn-primary px-4 py-1.5 text-sm"
              onClick={claimHiSola} disabled={loadingHi || hiClaimable === 0}>
              {loadingHi ? "…" : hiClaimable === 0 ? "Up to date" : "Claim hiSOLA"}
            </button>
          </div>
        )}
      </div>

      {/* ── oSOLA Vesting ───────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-white">
            oSOLA Vesting
            <span className="ml-2 text-xs font-normal text-gray-500">(liquid options)</span>
          </h3>
          <span className="text-xs text-gray-400 font-mono">
            {fmt(vesting.oSolaClaimed)} / {fmt(vesting.oSolaAmount)}
          </span>
        </div>

        <div className="flex justify-between text-[10px] text-gray-500 mb-0.5">
          <span>Vested {vesting.oSolaAmount > 0 ? ((oVested / vesting.oSolaAmount) * 100).toFixed(1) : "0"}%</span>
          <span>Claimed {vesting.oSolaAmount > 0 ? ((vesting.oSolaClaimed / vesting.oSolaAmount) * 100).toFixed(1) : "0"}%</span>
        </div>
        <ProgressBar pct={vesting.oSolaAmount > 0 ? (oVested / vesting.oSolaAmount) * 100 : 0} color="bg-blue-400" />

        <p className="text-xs text-gray-500 mt-2">
          Exercise oSOLA via the <span className="text-brand-green">Options</span> tab: pay 1 USDC → receive 1 SOLA at guaranteed floor price.
        </p>

        {cliffInfo}
        {afterCliff && (
          <div className="flex items-center justify-between gap-3 mt-3">
            <span className="text-xs text-gray-400">
              Claimable: <span className="text-white font-mono font-semibold">{fmt(oClaimable)} oSOLA</span>
            </span>
            <button className="btn-primary px-4 py-1.5 text-sm"
              onClick={claimOSola} disabled={loadingO || oClaimable === 0}>
              {loadingO ? "…" : oClaimable === 0 ? "Up to date" : "Claim oSOLA"}
            </button>
          </div>
        )}
      </div>

      {/* ── Borrow ──────────────────────────────────────────────── */}
      <div className="card">
        <h3 className="text-base font-bold text-white mb-1">
          Borrow USDC
          <span className="ml-2 text-xs font-normal text-gray-500">(10% of monthly hiSOLA)</span>
        </h3>

        <div className="flex items-start gap-2 text-xs text-gray-500 bg-brand-dark border border-brand-border rounded-lg px-3 py-2 mb-4">
          <span className="text-brand-green text-base leading-none shrink-0">ℹ</span>
          <span>
            Monthly installment: <span className="text-white font-mono">{fmt(monthlyHi)} hiSOLA</span> ·{" "}
            Cap: <span className="text-white font-mono font-semibold">{fmt(borrowCap)} USDC</span> ·{" "}
            Debt: <span className="text-yellow-400 font-mono">{fmt(debt)} USDC</span> ·{" "}
            Available: <span className="text-brand-green font-mono font-semibold">{borrowAvail.toFixed(4)} USDC</span>
          </span>
        </div>

        <div className="flex gap-6 mb-5 border-b border-brand-border">
          {(["borrow", "repay"] as const).map((t) => (
            <button key={t} onClick={() => setBorrowTab(t)}
              className={`pb-2 text-sm font-semibold uppercase tracking-wide transition-colors ${
                borrowTab === t ? "tab-active" : "text-gray-500 hover:text-gray-300"
              }`}>{t}</button>
          ))}
        </div>

        <div className="rounded-xl bg-brand-dark border border-brand-border p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-400">
              {borrowTab === "borrow" ? "USDC to borrow" : "USDC to repay"}
            </span>
            {borrowTab === "borrow" && borrowAvail > 0 && (
              <button className="text-xs text-gray-300 hover:text-brand-green transition-colors font-mono"
                onClick={() => setBorrowAmt(borrowAvail.toFixed(6).replace(/\.?0+$/, ""))}>
                Max {borrowAvail.toFixed(4)}
              </button>
            )}
            {borrowTab === "repay" && debt > 0 && (
              <button className="text-xs text-gray-300 hover:text-brand-green transition-colors font-mono"
                onClick={() => setBorrowAmt((debt / 1_000_000).toFixed(6).replace(/\.?0+$/, ""))}>
                Max {fmt(debt)}
              </button>
            )}
          </div>
          <input className="w-full bg-transparent text-right text-2xl font-bold text-white placeholder-gray-600 focus:outline-none"
            type="text" inputMode="decimal" placeholder="0.00" value={borrowAmt}
            onChange={(e) => { if (e.target.value === "" || /^\d*\.?\d*$/.test(e.target.value)) setBorrowAmt(e.target.value); }} />
        </div>

        <p className="text-xs text-gray-500 mb-4">
          {borrowTab === "borrow"
            ? "No interest · No liquidation · 2% origination fee to market_vault"
            : "Repaying frees up your borrow headroom"}
        </p>

        <button className="btn-primary w-full" onClick={submitBorrow}
          disabled={loadingBor || !borrowAmt || !usdcMint}>
          {loadingBor ? "Processing…" : borrowTab === "borrow" ? "Borrow" : "Repay"}
        </button>
      </div>

      {status && <p className="text-xs text-gray-400 break-all px-1">{status}</p>}
    </div>
  );
}
