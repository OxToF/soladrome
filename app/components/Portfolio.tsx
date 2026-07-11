// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  getProgram, solaM, hiSolaM, oSolaM,
  positionPda, userAta, toUi, PROGRAM_ID,
  marketVault,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";
import { ammPriceVsUsdc, FLOOR_PRICE } from "@/lib/prices";
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
}

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
    const hiSolaAta  = userAta(hiSolaM, wallet.publicKey);
    const oSolaAta   = userAta(oSolaM,  wallet.publicKey);
    const ep = currentEpoch();
    const eb = Buffer.alloc(8);
    eb.writeBigUInt64LE(BigInt(ep));
    const [uevPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("uev"), wallet.publicKey.toBuffer(), eb], PROGRAM_ID
    );

    const [multiRes, posRes] = await Promise.allSettled([
      connection.getMultipleAccountsInfo([solaAta, hiSolaAta, oSolaAta, uevPda]),
      (program.account as any).userPosition.fetch(positionPda(wallet.publicKey)),
    ]);

    const multi = multiRes.status === "fulfilled" ? multiRes.value : [null, null, null, null];
    const balOf = (info: any, ata: PublicKey) =>
      info ? Number(unpackAccount(ata, info).amount) / 1e6 : 0;
    const solaBalance   = balOf(multi[0], solaAta);
    const hiSolaBalance = balOf(multi[1], hiSolaAta);
    const oSolaBalance  = balOf(multi[2], oSolaAta);

    // UserPosition only has: owner, usdcBorrowed, feesDebt, bump
    let debt = 0;
    let feesDebt: BN | null = null;
    if (posRes.status === "fulfilled" && posRes.value) {
      if (posRes.value.usdcBorrowed) debt = toUi(posRes.value.usdcBorrowed as BN);
      feesDebt = posRes.value.feesDebt as BN;
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
      const raw = jsPendingFees(acc, BigInt(feesDebt.toString()), BigInt(Math.round(hiSolaBalance * 1e6)));
      claimableFees = Number(raw) / 1e6;
    }

    // o_sola_bonus + allocated from UserEpochVotes (current epoch). Layout:
    // discriminator(8) + epoch(8) + allocated(8) + total_power_snapshot(8) + o_sola_bonus(8)
    let oSolaBonus = 0;
    let allocated  = 0;
    const uevInfo = multi[3];
    if (uevInfo && uevInfo.data.length >= 40) {
      allocated  = Number(uevInfo.data.readBigUInt64LE(16)) / 1e6;
      oSolaBonus = Number(uevInfo.data.readBigUInt64LE(32)) / 1e6;
    }

    setData({ solaBalance, hiSolaBalance, oSolaBalance, oSolaBonus, debt, claimableFees, allocated });
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
    setBribeSummary(await computeClaimableBribesSummary(connection, wallet, usdcMint ?? null));
  }, [connection, wallet, usdcMint]);

  useEffect(() => {
    loadBribeSummary();
    window.addEventListener("soladrome:refresh", loadBribeSummary);
    return () => window.removeEventListener("soladrome:refresh", loadBribeSummary);
  }, [loadBribeSummary]);

  // Realisable valuation: value SOLA (and hiSOLA, which unstakes 1:1) at the
  // SOLA/USDC AMM market price when such a pool exists, else the $1 floor
  // (sell_sola redemption). We deliberately do NOT use the curve price
  // (virtual_usdc/virtual_sola) — that is the buy/mint price and can't be
  // realised by a seller, so it would overstate the balance. oSOLA is an option:
  // its market price if a pool exists, else its intrinsic value max(0, SOLA − 1)
  // (the $1 exercise cost), which is 0 while SOLA sits at the floor.
  const usdcStr   = usdcMint?.toString() ?? "";
  const solaPrice = ammPriceVsUsdc(ammPools, solaM.toString(), usdcStr) ?? FLOOR_PRICE;
  const oSolaPrice = ammPriceVsUsdc(ammPools, oSolaM.toString(), usdcStr)
    ?? Math.max(0, solaPrice - FLOOR_PRICE);
  const totalValue = data
    ? data.solaBalance * solaPrice
      + data.hiSolaBalance * solaPrice
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
                ? (data.hiSolaBalance + data.oSolaBonus).toLocaleString(undefined, { maximumFractionDigits: 2 })
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
                ? `${Math.max(0, data.hiSolaBalance - data.debt).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`
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
        {data && data.allocated === 0 && data.hiSolaBalance > 0 && (
          <button
            className="w-full text-sm py-2.5 rounded-xl border border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10 transition-colors"
            onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "vote" }))}
          >
            No vote this epoch — {data.hiSolaBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })} hiSOLA unused →
          </button>
        )}
      </div>
    </div>
  );
}
