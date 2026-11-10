// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  getProgram, solaM, oSolaM,
  positionPda, userAta, toUi, PROGRAM_ID,
  marketVault,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";
import { ammPriceVsUsdc, FLOOR_PRICE } from "@/lib/prices";
import { marginalSellPrice, quoteSell } from "@/lib/curve";
import { currentEpoch } from "@/lib/epoch";
import { PublicKey } from "@solana/web3.js";
import { unpackAccount } from "@solana/spl-token";
import { jsAdvanceAccumulator, jsPendingFees, computeClaimableBribesSummary, type ClaimableBribesSummary } from "@/lib/claims";

interface PortfolioData {
  solaBalance:   number;
  hiSolaBalance: number;
  oSolaBalance:  number;
  oSolaBonus:    number;   // extra voting power from burning oSOLA this epoch
  debt:          number;
  claimableFees: number;   // live USDC fee share, same computation as ClaimFees.tsx
  allocated:     number;   // hiSOLA already voted with this epoch (0 = no vote yet)
  locked:        number;   // VeLockPosition.amount_locked — partner bag, team, contributor, own locks
  permanent:     number;   // the part of `locked` that can never be released (unfinanced grants)
  lockEndTs:     number;
  vePower:       number;   // ve power now: locked x time left x 4 / 4 years
  credit:        number;   // what borrow could still lend: min(staked, hi + locked) - debt
}

// state/ve.rs: owner(32) · amount_locked(8) · lock_end_ts(8) · bump(1) · permanent_amount(8)
const MAX_LOCK_SECS = 208 * 604_800;

export function Portfolio() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint, protocolState, vaultInfos, ammPools } = useSoladrome();

  const [data, setData] = useState<PortfolioData | null>(null);
  const [bribeSummary, setBribeSummary] = useState<ClaimableBribesSummary | null>(null);

  const load = useCallback(async () => {
    if (!wallet || !usdcMint) return;
    const provider = new AnchorProvider(connection, wallet, {});
    const program  = getProgram(provider);

    // Batch the four raw account reads (3 token ATAs + the current-epoch UEV
    // PDA) into ONE getMultipleAccountsInfo, run concurrently with the Anchor
    // userPosition fetch: 2 RPC calls per tick instead of 5. All SOLA-family
    // mints use 6 decimals (protocol invariant), so amount/1e6 is exact.
    const solaAta   = userAta(solaM,   wallet.publicKey);
    const oSolaAta   = userAta(oSolaM,  wallet.publicKey);
    const ep = currentEpoch();
    const eb = Buffer.alloc(8);
    eb.writeBigUInt64LE(BigInt(ep));
    const [uevPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("uev"), wallet.publicKey.toBuffer(), eb], PROGRAM_ID
    );

    // The ve lock: where every locked-for-life grant lives (partner bag, team, contributor).
    // Until 2026-11-10 this panel never read it, so a partner saw no hiSOLA at all.
    const [velockPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("velock"), wallet.publicKey.toBuffer()], PROGRAM_ID
    );

    const [multiRes, posRes] = await Promise.allSettled([
      connection.getMultipleAccountsInfo([solaAta, oSolaAta, uevPda, velockPda]),
      (program.account as any).userPosition.fetch(positionPda(wallet.publicKey)),
    ]);

    const multi = multiRes.status === "fulfilled" ? multiRes.value : [null, null, null, null];
    const balOf = (info: any, ata: PublicKey) =>
      info ? Number(unpackAccount(ata, info).amount) / 1e6 : 0;
    const solaBalance   = balOf(multi[0], solaAta);
    const oSolaBalance  = balOf(multi[1], oSolaAta);
    // hiSOLA has no wallet balance to read — it is a position, so it comes from the
    // UserPosition fetch below. This is the cost the model was accepted with: hiSOLA no
    // longer shows up in Phantom, so the Portfolio is the only place it is visible.
    let hiSolaBalance = 0;

    let debt = 0;
    let feesDebt: BN | null = null;
    let stakedAmount = 0;
    let feeShares = 0;
    if (posRes.status === "fulfilled" && posRes.value) {
      feeShares = toUi((posRes.value.feeShares ?? new BN(0)) as BN);
      if (posRes.value.usdcBorrowed) debt = toUi(posRes.value.usdcBorrowed as BN);
      feesDebt = posRes.value.feesDebt as BN;
      hiSolaBalance = toUi(posRes.value.hiSola as BN);
      stakedAmount  = toUi(posRes.value.stakedAmount as BN);
    }

    // Fee accumulator uses protocolState + the marketVault account info already
    // fetched every 10s by SoladromeContext — no extra RPC calls needed here.
    let claimableFees = 0;
    const marketVaultInfo = vaultInfos[1];
    if (protocolState && marketVaultInfo && feesDebt) {
      const mktBal = BigInt(unpackAccount(marketVault, marketVaultInfo).amount);
      const acc = jsAdvanceAccumulator(
        BigInt(protocolState.feesPerHiSola.toString()),
        mktBal,
        BigInt(protocolState.lastMarketVaultBalance.toString()),
        BigInt(protocolState.totalHiSola.toString()),
      );
      // The on-chain basis is `min(staked_amount, hi_sola)` (math::fee_basis), not the raw
      // balance: hiSOLA released by an expired ve lock was never financed and earns nothing.
      // Showing the balance here would quote a claimable figure the program will not pay.
      // Plus `fee_shares`: locked-for-life grants earn fees without being a balance.
      const basis = Math.min(stakedAmount, hiSolaBalance) + feeShares;
      const raw = jsPendingFees(acc, BigInt(feesDebt.toString()), BigInt(Math.round(basis * 1e6)));
      claimableFees = Number(raw) / 1e6;
    }

    // o_sola_bonus + allocated from UserEpochVotes (current epoch). Layout:
    // discriminator(8) + epoch(8) + allocated(8) + total_power_snapshot(8) + o_sola_bonus(8)
    let oSolaBonus = 0;
    let allocated  = 0;
    const uevInfo = multi[2];
    if (uevInfo && uevInfo.data.length >= 40) {
      allocated  = Number(uevInfo.data.readBigUInt64LE(16)) / 1e6;
      oSolaBonus = Number(uevInfo.data.readBigUInt64LE(32)) / 1e6;
    }

    let locked = 0, permanent = 0, lockEndTs = 0;
    const lockInfo = multi[3];
    if (lockInfo && lockInfo.data.length >= 8 + 57) {
      locked    = Number(lockInfo.data.readBigUInt64LE(8 + 32)) / 1e6;
      lockEndTs = Number(lockInfo.data.readBigInt64LE(8 + 40));
      permanent = Number(lockInfo.data.readBigUInt64LE(8 + 49)) / 1e6;
    }
    const left = Math.max(0, lockEndTs - Math.floor(Date.now() / 1000));
    const vePower = (locked * left * 4) / MAX_LOCK_SECS;
    const credit = Math.max(0, Math.min(stakedAmount, hiSolaBalance + locked) - debt);

    setData({
      solaBalance, hiSolaBalance, oSolaBalance, oSolaBonus, debt, claimableFees, allocated,
      locked, permanent, lockEndTs, vePower, credit,
    });
  }, [connection, wallet, usdcMint, protocolState, vaultInfos]);

  useEffect(() => {
    load();
    const id = setInterval(load, 8_000);
    const onRefresh = () => load();
    window.addEventListener("soladrome:refresh", onRefresh);
    return () => { clearInterval(id); window.removeEventListener("soladrome:refresh", onRefresh); };
  }, [load]);

  // Bribe-claimable summary scans every past-epoch vote via chunked
  // getMultipleAccountsInfo (see computeClaimableBribesSummary in
  // lib/claims.ts) — meaningfully more RPC-heavy than the balance poll above,
  // so it only runs on wallet connect and on the existing "soladrome:refresh"
  // event (fired after transactions elsewhere in the app), never on a timer.
  const loadBribeSummary = useCallback(async () => {
    if (!wallet) { setBribeSummary(null); return; }
    setBribeSummary(await computeClaimableBribesSummary(connection, wallet));
  }, [connection, wallet]);

  useEffect(() => {
    loadBribeSummary();
    window.addEventListener("soladrome:refresh", loadBribeSummary);
    return () => window.removeEventListener("soladrome:refresh", loadBribeSummary);
  }, [loadBribeSummary]);

  // Realisable valuation: value SOLA (and hiSOLA, which unstakes 1:1) at the SOLA/USDC AMM
  // market price when such a pool exists, else at what `sell_sola` pays for it now — the
  // curve's price less the 1 % fee, never below the $1 floor. (Until 2026-10-07 a sale paid the
  // floor and nothing else, so this fell back to $1.) oSOLA is an option: its market price if a
  // pool exists, else its intrinsic value max(0, SOLA − 1), the $1 exercise cost.
  const usdcStr   = usdcMint?.toString() ?? "";
  const curveSell = protocolState
    ? marginalSellPrice({
        virtualUsdc: BigInt(protocolState.virtualUsdc.toString()),
        virtualSola: BigInt(protocolState.virtualSola.toString()),
        k:           BigInt(protocolState.k.toString()),
      })
    : FLOOR_PRICE;
  // ☢️ The marginal price is the price of an infinitesimal sale. Selling a whole balance walks the
  // curve down, so without a pool the balance is valued at what `sell_sola` would pay for ALL of
  // it (`quoteSell`), averaged back to a per-SOLA figure — never the marginal price times the size.
  const reserves = protocolState
    ? {
        virtualUsdc: BigInt(protocolState.virtualUsdc.toString()),
        virtualSola: BigInt(protocolState.virtualSola.toString()),
        k:           BigInt(protocolState.k.toString()),
      }
    : null;
  const held = data ? data.solaBalance + data.hiSolaBalance : 0;
  const wholeSale = reserves && held > 0 ? quoteSell(reserves, BigInt(Math.floor(held * 1e6))) : null;
  const curveAvg = wholeSale ? Number(wholeSale.usdcOut) / 1e6 / held : curveSell;
  const solaPrice = ammPriceVsUsdc(ammPools, solaM.toString(), usdcStr) ?? curveAvg;
  const oSolaPrice = ammPriceVsUsdc(ammPools, oSolaM.toString(), usdcStr)
    ?? Math.max(0, (ammPriceVsUsdc(ammPools, solaM.toString(), usdcStr) ?? curveSell) - FLOOR_PRICE);
  const totalValue = data
    ? data.solaBalance * solaPrice
      + data.hiSolaBalance * solaPrice
      // Only the releasable part of a lock is worth SOLA; a permanent grant can never be sold.
      + Math.max(0, data.locked - data.permanent) * solaPrice
      + data.oSolaBalance * oSolaPrice
      - data.debt
    : null;

  return (
    <div className="card space-y-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <p className="text-base font-bold text-white">Portfolio</p>
        <p className="text-lg font-black text-brand-green">
          {totalValue !== null
            ? `$${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : "—"}
        </p>
      </div>

      {/* hiSOLA row */}
      <div className="flex items-start justify-between py-3 border-b border-brand-border/60">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-white">hiSOLA</p>
          <p className="text-xs text-gray-500">
            Voting Power{" "}
            <span className="text-gray-300 font-mono">
              {data
                ? (data.hiSolaBalance + data.vePower + data.oSolaBonus).toLocaleString(undefined, { maximumFractionDigits: 2 })
                : "—"}
            </span>
            {(data?.oSolaBonus ?? 0) > 0 && (
              <span className="ml-1 text-brand-green text-[10px]">
                (incl. 🔥 {data!.oSolaBonus.toLocaleString(undefined, { maximumFractionDigits: 2 })} burn)
              </span>
            )}
          </p>
          <p className="text-xs text-gray-500">
            Available credit{" "}
            <span className="text-gray-300">
              {data
                ? `${data.credit.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`
                : "—"}
            </span>
          </p>
          {(data?.debt ?? 0) > 0 && (
            <p className="text-xs text-red-400">
              Debt {data!.debt.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="font-bold text-white text-sm">
            {data ? data.hiSolaBalance.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}
          </p>
          <p className="text-xs text-gray-600">
            ≈ ${data
              ? (data.hiSolaBalance * solaPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })
              : "0"}
          </p>
        </div>
      </div>

      {/* Locked hiSOLA — partner bag, team tranche, contributor bag, or the holder's own lock */}
      {data && data.locked > 0 && (
        <div className="flex items-start justify-between py-3 border-b border-brand-border/60">
          <div className="space-y-0.5">
            <p className="text-sm font-semibold text-white">hiSOLA locked</p>
            <p className="text-xs text-gray-500">
              Vote power now{" "}
              <span className="text-gray-300 font-mono">
                {data.vePower.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
              {data.lockEndTs > 0 && (
                <span className="text-gray-600">
                  {" "}· lock {data.lockEndTs * 1000 > Date.now() ? "until" : "expired"}{" "}
                  {new Date(data.lockEndTs * 1000).toLocaleDateString()}
                </span>
              )}
            </p>
            {data.permanent > 0 && (
              <p className="text-xs text-gray-500">
                <span className="text-gray-300 font-mono">
                  {data.permanent.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>{" "}
                locked for life — earns fees, votes, never sold or borrowed
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="font-bold text-white text-sm">
              {data.locked.toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </p>
            <p className="text-xs text-gray-600">
              {data.permanent >= data.locked
                ? "not sellable"
                : `≈ $${((data.locked - data.permanent) * solaPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })} releasable`}
            </p>
          </div>
        </div>
      )}

      {/* oSOLA row */}
      <div className="flex items-start justify-between py-3 border-b border-brand-border/60">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-white">oSOLA</p>
          <p className="text-xs text-gray-500">LP Rewards</p>
        </div>
        <div className="text-right">
          <p className="font-bold text-white text-sm">
            {data ? data.oSolaBalance.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}
          </p>
          <p className="text-xs text-gray-600">
            ≈ ${data ? (data.oSolaBalance * oSolaPrice).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "0"}
          </p>
        </div>
      </div>

      {/* SOLA row */}
      <div className="flex items-start justify-between py-3 border-b border-brand-border/60">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-white">SOLA</p>
          <p className="text-xs text-gray-500">Wallet balance</p>
        </div>
        <div className="text-right">
          <p className="font-bold text-white text-sm">
            {data ? data.solaBalance.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}
          </p>
          <p className="text-xs text-gray-600">
            ≈ ${data
              ? (data.solaBalance * solaPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })
              : "0"}
          </p>
        </div>
      </div>

      {/* CTAs — data-driven where possible so users don't need to know the
          ve(3,3) cycle by heart to find what's actionable. */}
      <div className="pt-4 space-y-3">
        <button
          className="btn-primary w-full text-sm"
          onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "claim" }))}
        >
          {data && data.claimableFees > 0
            ? `Claim ${data.claimableFees.toLocaleString(undefined, { maximumFractionDigits: 4 })} USDC in fees →`
            : "Claim Fees"}
        </button>
        <button
          className="btn-secondary w-full text-sm"
          onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "pools" }))}
        >
          Pools &amp; LP Rewards →
        </button>
        {bribeSummary && bribeSummary.claimableCount > 0 && (
          <button
            className="btn-secondary w-full text-sm"
            onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "claim" }))}
          >
            Claim bribes — {bribeSummary.claimableCount} available across {bribeSummary.poolCount} pool{bribeSummary.poolCount === 1 ? "" : "s"} →
          </button>
        )}
        {data && data.allocated === 0 && (data.hiSolaBalance > 0 || data.vePower > 0) && (
          <button
            className="w-full text-sm py-2.5 rounded-xl border border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10 transition-colors"
            onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "vote" }))}
          >
            No vote this epoch — {(data.hiSolaBalance + data.vePower).toLocaleString(undefined, { maximumFractionDigits: 2 })} voting power unused →
          </button>
        )}
      </div>
    </div>
  );
}
