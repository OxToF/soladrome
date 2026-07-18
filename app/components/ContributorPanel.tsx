// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getProgram, statePda, solaM, hiSolaM, oSolaM,
  solaVaultAddr, marketVault, floorVault,
  positionPda, userAta, commonAccounts, fromUi, PROGRAM_ID, sendTx,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";

// ── PDAs ────────────────────────────────────────────────────────────────────
const CONTRIBUTOR_SEED = Buffer.from("contributor");

export function contributorVestingPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([CONTRIBUTOR_SEED, wallet.toBuffer()], PROGRAM_ID)[0];
}
// Lifetime ve lock — claim_contributor_hi_sola mints here, never to the wallet.
function veLockPositionPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("velock"), owner.toBuffer()], PROGRAM_ID)[0];
}
function veLockVaultPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("ve_vault"), owner.toBuffer()], PROGRAM_ID)[0];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(raw: number, dec = 2) {
  return (raw / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: dec });
}

interface AllocData {
  hiSolaAmount:  number;
  oSolaAmount:   number;
  hiSolaClaimed: number;
  oSolaClaimed:  number;
}

// ── Main component ─────────────────────────────────────────────────────────────
export function ContributorPanel() {
  const { connection } = useConnection();
  const wallet         = useAnchorWallet();
  const { usdcMint }   = useSoladrome();

  const [alloc,     setAlloc]     = useState<AllocData | null>(null);
  const [locked,    setLocked]    = useState(0);   // hiSOLA in the ve lock (base units)
  const [debt,      setDebt]      = useState(0);
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

      const [v, lock, pos] = await Promise.allSettled([
        (program.account as any).contributorVesting.fetchNullable(pda),
        (program.account as any).veLockPosition.fetchNullable(veLockPositionPda(wallet.publicKey)),
        (program.account as any).userPosition.fetchNullable(positionPda(wallet.publicKey)),
      ]);

      if (v.status === "fulfilled" && v.value) {
        const d = v.value as any;
        setAlloc({
          hiSolaAmount:  Number(d.hiSolaAmount.toString()),
          oSolaAmount:   Number(d.oSolaAmount.toString()),
          hiSolaClaimed: Number(d.hiSolaClaimed.toString()),
          oSolaClaimed:  Number(d.oSolaClaimed.toString()),
        });
        setNotFound(false);
      } else {
        setNotFound(true);
      }

      setLocked(lock.status === "fulfilled" && lock.value
        ? Number((lock.value as any).amountLocked.toString()) : 0);
      setDebt(pos.status === "fulfilled" && pos.value
        ? Number((pos.value as any).usdcBorrowed.toString()) : 0);
    } catch (e) { console.error("ContributorPanel fetchData:", e); }
  }, [connection, wallet]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Derived values (no cliff, no vesting — claimed all at once) ───────────────
  const hiClaimable = alloc ? Math.max(0, alloc.hiSolaAmount - alloc.hiSolaClaimed) : 0;
  const oClaimable  = alloc ? Math.max(0, alloc.oSolaAmount  - alloc.oSolaClaimed)  : 0;

  // Borrow cap = 20% of the ve-locked hiSOLA (borrow_against_locked), minus current debt.
  const borrowCap   = Math.floor(locked * 0.20);
  const borrowAvail = Math.max(0, borrowCap - debt) / 1_000_000;

  // ── Claim hiSOLA (into a lifetime ve lock) ────────────────────────────────────
  async function claimHiSola() {
    if (!wallet) return;
    setLoadingHi(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const me       = wallet.publicKey;

      // Migrate a legacy 128-byte UserPosition if one exists (from prior staking).
      const ixs: any[] = [];
      const posInfo = await connection.getAccountInfo(positionPda(me));
      if (posInfo && posInfo.data.length < 136) {
        ixs.push(await program.methods.migrateUserPosition()
          .accounts({ user: me, userPosition: positionPda(me), systemProgram: SystemProgram.programId } as any)
          .instruction());
      }

      ixs.push(await program.methods.claimContributorHiSola()
        .accounts({
          contributor:          me,
          protocolState:        statePda,
          solaMint:             solaM,
          hiSolaMint:           hiSolaM,
          solaVault:            solaVaultAddr,
          marketVault,
          lockPosition:         veLockPositionPda(me),
          veLockVault:          veLockVaultPda(me),
          contributorPosition:  positionPda(me),
          contributorVesting:   contributorVestingPda(me),
          tokenProgram:         commonAccounts.tokenProgram,
          associatedTokenProgram: commonAccounts.associatedTokenProgram,
          systemProgram:        commonAccounts.systemProgram,
        } as any).instruction());

      const tx = await sendTx(connection, wallet, ixs);
      setStatus(`✅ hiSOLA bag claimed into your lifetime ve-lock (not your wallet — by design) — tx: ${tx.slice(0,16)}…`);
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      await fetchData();
    } catch (e: any) { setStatus(`❌ ${e?.message ?? e}`); }
    finally { setLoadingHi(false); }
  }

  // ── Claim oSOLA (to the wallet, exercisable) ──────────────────────────────────
  async function claimOSola() {
    if (!wallet) return;
    setLoadingO(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const me       = wallet.publicKey;
      const ix = await program.methods.claimContributorVesting()
        .accounts({
          contributor:          me,
          protocolState:        statePda,
          oSolaMint:            oSolaM,
          contributorVesting:   contributorVestingPda(me),
          contributorOSola:     userAta(oSolaM, me),
          tokenProgram:         commonAccounts.tokenProgram,
          associatedTokenProgram: commonAccounts.associatedTokenProgram,
          systemProgram:        commonAccounts.systemProgram,
        } as any).instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setStatus(`✅ oSOLA claimed to your wallet — exercise it in the Options tab — tx: ${tx.slice(0,16)}…`);
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      await fetchData();
    } catch (e: any) { setStatus(`❌ ${e?.message ?? e}`); }
    finally { setLoadingO(false); }
  }

  // ── Borrow / Repay (against the ve-locked bag, 20% cap) ───────────────────────
  async function submitBorrow() {
    if (!wallet || !borrowAmt || !usdcMint) return;
    setLoadingBor(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const me       = wallet.publicKey;

      let tx: string;
      if (borrowTab === "borrow") {
        const ix = await program.methods.borrowAgainstLocked(fromUi(+borrowAmt))
          .accounts({
            partner:                me,
            protocolState:          statePda,
            lockPosition:           veLockPositionPda(me),
            floorVault,
            marketVault,
            usdcMint,
            partnerUsdc:            userAta(usdcMint, me),
            partnerPosition:        positionPda(me),
            tokenProgram:           commonAccounts.tokenProgram,
            associatedTokenProgram: commonAccounts.associatedTokenProgram,
            systemProgram:          commonAccounts.systemProgram,
          } as any).instruction();
        tx = await sendTx(connection, wallet, [ix]);
        setStatus(`✅ Borrowed ${borrowAmt} USDC — tx: ${tx.slice(0,16)}…`);
      } else {
        const ix = await program.methods.repayUsdc(fromUi(+borrowAmt))
          .accounts({
            user:          me,
            protocolState: statePda,
            userPosition:  positionPda(me),
            floorVault,
            userUsdc:      userAta(usdcMint, me),
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

  if (!alloc) return (
    <div className="card text-center py-12 text-gray-500 text-sm">Loading…</div>
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
          Claimed at launch · hiSOLA locked for life (permanent voting power) + oSOLA · verified on Solana
        </p>
      </div>

      {/* ── hiSOLA bag ──────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-white">
            hiSOLA Bag
            <span className="ml-2 text-xs font-normal text-gray-500">(locked for life · votes · 20% borrow)</span>
          </h3>
          <span className="text-xs text-gray-400 font-mono">
            {fmt(alloc.hiSolaClaimed)} / {fmt(alloc.hiSolaAmount)}
          </span>
        </div>

        <p className="text-xs text-gray-500 mt-1">
          Minted straight into a lifetime ve-lock — your wallet never holds it. It votes (up to 4×) and
          borrows up to 20%, but can never be sold. Currently locked: <span className="text-white font-mono">{fmt(locked)} hiSOLA</span>.
        </p>

        <div className="flex items-center justify-between gap-3 mt-3">
          <span className="text-xs text-gray-400">
            Claimable: <span className="text-white font-mono font-semibold">{fmt(hiClaimable)} hiSOLA</span>
          </span>
          <button className="btn-primary px-4 py-1.5 text-sm"
            onClick={claimHiSola} disabled={loadingHi || hiClaimable === 0}>
            {loadingHi ? "…" : hiClaimable === 0 ? "Claimed" : "Claim hiSOLA"}
          </button>
        </div>
      </div>

      {/* ── oSOLA ───────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-bold text-white">
            oSOLA
            <span className="ml-2 text-xs font-normal text-gray-500">(upside, self-financing)</span>
          </h3>
          <span className="text-xs text-gray-400 font-mono">
            {fmt(alloc.oSolaClaimed)} / {fmt(alloc.oSolaAmount)}
          </span>
        </div>

        <p className="text-xs text-gray-500 mt-1">
          Claimed to your wallet, then exercise it in the <span className="text-brand-green">Options</span> tab:
          pay 1 USDC → receive 1 SOLA at the guaranteed floor price. Each exercise adds 1 USDC to the floor.
        </p>

        <div className="flex items-center justify-between gap-3 mt-3">
          <span className="text-xs text-gray-400">
            Claimable: <span className="text-white font-mono font-semibold">{fmt(oClaimable)} oSOLA</span>
          </span>
          <button className="btn-primary px-4 py-1.5 text-sm"
            onClick={claimOSola} disabled={loadingO || oClaimable === 0}>
            {loadingO ? "…" : oClaimable === 0 ? "Claimed" : "Claim oSOLA"}
          </button>
        </div>
      </div>

      {/* ── Borrow ──────────────────────────────────────────────── */}
      <div className="card">
        <h3 className="text-base font-bold text-white mb-1">
          Borrow USDC
          <span className="ml-2 text-xs font-normal text-gray-500">(20% of your locked bag)</span>
        </h3>

        <div className="flex items-start gap-2 text-xs text-gray-500 bg-brand-dark border border-brand-border rounded-lg px-3 py-2 mb-4">
          <span className="text-brand-green text-base leading-none shrink-0">ℹ</span>
          <span>
            Locked: <span className="text-white font-mono">{fmt(locked)} hiSOLA</span> ·{" "}
            Cap (20%): <span className="text-white font-mono font-semibold">{fmt(borrowCap)} USDC</span> ·{" "}
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
            ? "No interest · No liquidation · 2% origination fee to market_vault · bounded by the 75% floor buffer"
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
