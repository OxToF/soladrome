// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  getProgram, solaM, hiSolaM, oSolaM,
  positionPda, userAta, toUi, PROGRAM_ID,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";
import { currentEpoch } from "@/lib/epoch";
import { PublicKey } from "@solana/web3.js";

interface PortfolioData {
  solaBalance:   number;
  hiSolaBalance: number;
  oSolaBalance:  number;
  oSolaBonus:    number;   // extra voting power from burning oSOLA this epoch
  debt:          number;
}

export function Portfolio() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();

  const [data, setData] = useState<PortfolioData | null>(null);

  const load = useCallback(async () => {
    if (!wallet || !usdcMint) return;
    const provider = new AnchorProvider(connection, wallet, {});
    const program  = getProgram(provider);

    const [solaRes, hiSolaRes, oSolaRes, posRes] = await Promise.allSettled([
      connection.getTokenAccountBalance(userAta(solaM,   wallet.publicKey)),
      connection.getTokenAccountBalance(userAta(hiSolaM, wallet.publicKey)),
      connection.getTokenAccountBalance(userAta(oSolaM,  wallet.publicKey)),
      (program.account as any).userPosition.fetch(positionPda(wallet.publicKey)),
    ]);

    const solaBalance   = solaRes.status   === "fulfilled" ? (solaRes.value.value.uiAmount   ?? 0) : 0;
    const hiSolaBalance = hiSolaRes.status === "fulfilled" ? (hiSolaRes.value.value.uiAmount ?? 0) : 0;
    const oSolaBalance  = oSolaRes.status  === "fulfilled" ? (oSolaRes.value.value.uiAmount  ?? 0) : 0;

    // UserPosition only has: owner, usdcBorrowed, feesDebt, bump
    let debt = 0;
    if (posRes.status === "fulfilled" && posRes.value?.usdcBorrowed) {
      debt = toUi(posRes.value.usdcBorrowed as BN);
    }

    // Read o_sola_bonus from UserEpochVotes for current epoch
    // Layout: discriminator(8) + epoch(8) + allocated(8) + total_power_snapshot(8) + o_sola_bonus(8)
    let oSolaBonus = 0;
    try {
      const ep = currentEpoch();
      const eb = Buffer.alloc(8);
      eb.writeBigUInt64LE(BigInt(ep));
      const [uevPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("uev"), wallet.publicKey.toBuffer(), eb], PROGRAM_ID
      );
      const uevInfo = await connection.getAccountInfo(uevPda);
      if (uevInfo && uevInfo.data.length >= 40) {
        oSolaBonus = Number(uevInfo.data.readBigUInt64LE(32)) / 1e6;
      }
    } catch { /* no UEV account yet — bonus stays 0 */ }

    setData({ solaBalance, hiSolaBalance, oSolaBalance, oSolaBonus, debt });
  }, [connection, wallet, usdcMint]);

  useEffect(() => {
    load();
    const id = setInterval(load, 8_000);
    const onRefresh = () => load();
    window.addEventListener("soladrome:refresh", onRefresh);
    return () => { clearInterval(id); window.removeEventListener("soladrome:refresh", onRefresh); };
  }, [load]);

  // Value SOLA & hiSOLA at the $1 floor (each is floor-backed 1:1 and redeemable
  // via sell_sola). The bonding-curve marginal price is unsuitable here: sells
  // don't move virtual reserves, so it only ratchets up and overstates a balance
  // you could never realise at that marginal price.
  const totalValue = data
    ? data.solaBalance + data.hiSolaBalance
      + data.oSolaBalance       // oSOLA floor value ≈ $1
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
              ? data.hiSolaBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })
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
            ≈ ${data ? data.oSolaBalance.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "0"}
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
              ? data.solaBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })
              : "0"}
          </p>
        </div>
      </div>

      {/* CTAs */}
      <div className="pt-4 space-y-3">
        <button
          className="btn-primary w-full text-sm"
          onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "claim" }))}
        >
          Claim Fees
        </button>
        <button
          className="btn-secondary w-full text-sm"
          onClick={() => window.dispatchEvent(new CustomEvent("nav", { detail: "pools" }))}
        >
          Pools &amp; LP Rewards →
        </button>
      </div>
    </div>
  );
}
