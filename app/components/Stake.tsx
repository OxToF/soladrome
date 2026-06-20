// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  getProgram, statePda, solaM, hiSolaM, oSolaM, solaVaultAddr,
  marketVault, positionPda, userAta, commonAccounts, fromUi, PROGRAM_ID,
} from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";
import { currentEpoch } from "@/lib/epoch";
import { trackQuest } from "@/lib/quests";

type Tab = "stake" | "unstake" | "burn";
const PCT = [25, 50, 75, 100] as const;

export function Stake({ embedded = false }: { embedded?: boolean }) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const [tab, setTab] = useState<Tab>("stake");
  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  const [oSolaBonus, setOSolaBonus] = useState<number>(0);

  const fetchBalance = useCallback(async () => {
    if (!wallet) { setBalance(null); return; }
    const mint = tab === "stake" ? solaM : tab === "unstake" ? hiSolaM : oSolaM;
    try {
      const ata  = userAta(mint, wallet.publicKey);
      const info = await connection.getTokenAccountBalance(ata);
      setBalance(Number(info.value.uiAmount ?? 0));
    } catch { setBalance(0); }

    // Read current epoch's oSOLA burn bonus for display
    if (tab === "burn") {
      try {
        const ep = currentEpoch();
        const eb = Buffer.alloc(8);
        eb.writeBigUInt64LE(BigInt(ep));
        const [uevPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("uev"), wallet.publicKey.toBuffer(), eb], PROGRAM_ID
        );
        const uevInfo = await connection.getAccountInfo(uevPda);
        if (uevInfo && uevInfo.data.length >= 40) {
          setOSolaBonus(Number(uevInfo.data.readBigUInt64LE(32)) / 1e6);
        } else { setOSolaBonus(0); }
      } catch { setOSolaBonus(0); }
    }
  }, [connection, wallet, tab]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  function applyPct(pct: number) {
    if (!balance || balance <= 0) return;
    setAmount(((balance * pct) / 100).toFixed(6).replace(/\.?0+$/, ""));
  }

  async function burnForVotes() {
    if (!wallet || !amount) return;
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return;
    setLoading(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const ep = currentEpoch();
      const eb = Buffer.alloc(8);
      eb.writeBigUInt64LE(BigInt(ep));
      const [userEpochVotes] = PublicKey.findProgramAddressSync(
        [Buffer.from("uev"), wallet.publicKey.toBuffer(), eb], PROGRAM_ID
      );
      const tx = await program.methods
        .burnOSolaForVotes(new BN(Math.floor(amt * 1_000_000)), new BN(ep))
        .accounts({
          user:           wallet.publicKey,
          protocolState:  statePda,
          oSolaMint:      oSolaM,
          userOSola:      userAta(oSolaM, wallet.publicKey),
          userEpochVotes,
          tokenProgram:   (await import("@solana/spl-token")).TOKEN_PROGRAM_ID,
          systemProgram:  SystemProgram.programId,
          rent:           SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
      setStatus(`✅ ${amt.toFixed(4)} oSOLA brûlés → +${amt.toFixed(4)} votes — tx: ${tx.slice(0, 16)}…`);
      setAmount("");
      setOSolaBonus(prev => prev + amt);
      setTimeout(() => { fetchBalance(); window.dispatchEvent(new CustomEvent("soladrome:refresh")); }, 2000);
    } catch (e: any) { setStatus(`❌ ${e?.message ?? e}`); }
    finally { setLoading(false); }
  }

  async function submit() {
    if (!wallet || !amount) return;
    setLoading(true);
    setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program = getProgram(provider);
      const userSola   = userAta(solaM,   wallet.publicKey);
      const userHiSola = userAta(hiSolaM, wallet.publicKey);
      const position   = positionPda(wallet.publicKey);

      if (tab === "stake") {
        // Auto-migrate user_position if it exists with the old 128-byte layout
        const posInfo = await connection.getAccountInfo(position);
        if (posInfo && posInfo.data.length === 128) {
          setStatus("Migrating account layout…");
          await program.methods
            .migrateUserPosition()
            .accounts({
              user: wallet.publicKey,
              userPosition: position,
              systemProgram: SystemProgram.programId,
            } as any)
            .rpc();
        }

        // user_usdc receives any pending fees auto-harvested when adding to an
        // existing stake (mirrors unstake). usdcMint comes from on-chain state.
        const stakeUserUsdc = usdcMint ? userAta(usdcMint, wallet.publicKey) : null;

        const tx = await program.methods
          .stakeSola(fromUi(+amount))
          .accounts({
            user: wallet.publicKey,
            protocolState: statePda,
            solaMint: solaM,
            hiSolaMint: hiSolaM,
            userSola,
            userHiSola,
            solaVault: solaVaultAddr,
            marketVault,
            usdcMint,
            userUsdc: stakeUserUsdc,
            userPosition: position,
            ...commonAccounts,
          } as any)
          .rpc();
        setStatus(`✅ Staked → hiSOLA — tx: ${tx.slice(0, 16)}…`);
        trackQuest(wallet.publicKey.toBase58(), "stake");
        window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      } else {
        // Auto-migrate user_position if it exists with the old 128-byte layout
        const posInfo = await connection.getAccountInfo(position);
        if (posInfo && posInfo.data.length === 128) {
          setStatus("Migrating account layout…");
          await program.methods
            .migrateUserPosition()
            .accounts({
              user: wallet.publicKey,
              userPosition: position,
              systemProgram: SystemProgram.programId,
            } as any)
            .rpc();
        }

        const userUsdc = usdcMint ? userAta(usdcMint, wallet.publicKey) : null;

        // Founder vesting lock: pass the vesting PDA when caller is founder,
        // SystemProgram otherwise (program ignores it for non-founder callers).
        const FOUNDER_WALLET = "46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4";
        const founderHiVesting = wallet.publicKey.toBase58() === FOUNDER_WALLET
          ? PublicKey.findProgramAddressSync([Buffer.from("founder_hi_vesting")], PROGRAM_ID)[0]
          : SystemProgram.programId;

        const tx = await program.methods
          .unstakeHiSola(fromUi(+amount))
          .accounts({
            user: wallet.publicKey,
            protocolState: statePda,
            solaMint: solaM,
            hiSolaMint: hiSolaM,
            userHiSola,
            userSola,
            solaVault: solaVaultAddr,
            marketVault,
            usdcMint: usdcMint ?? PublicKey.default,
            userUsdc: userUsdc ?? PublicKey.default,
            userPosition: position,
            founderHiVesting,
            ...commonAccounts,
          } as any)
          .rpc();
        setStatus(`✅ Unstaked → SOLA — tx: ${tx.slice(0, 16)}…`);
        window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      }
      setAmount("");
      fetchBalance();
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  const tabLabel = { stake: "Stake", unstake: "Unstake", burn: "🔥 Burn" };
  const inputLabel = { stake: "SOLA to lock", unstake: "hiSOLA to unlock", burn: "oSOLA to burn" };
  const tokenLabel = { stake: "SOLA", unstake: "hiSOLA", burn: "oSOLA" };

  return (
    <div className={embedded ? "" : "card"}>
      <h2 className="text-lg font-bold mb-4 text-white">
        {tab === "stake" ? "Stake SOLA → hiSOLA"
          : tab === "unstake" ? "Unstake hiSOLA → SOLA"
          : "🔥 Burn oSOLA → Voting Power"}
      </h2>

      <div className="flex gap-6 mb-6 border-b border-brand-border">
        {(["stake", "unstake", "burn"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setAmount(""); setStatus(""); }}
            className={`pb-2 text-sm font-semibold uppercase tracking-wide transition-colors ${
              tab === t ? "tab-active" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {tabLabel[t]}
          </button>
        ))}
      </div>

      {/* Burn bonus info */}
      {tab === "burn" && oSolaBonus > 0 && (
        <div className="rounded-lg border border-brand-green/30 bg-brand-green/5 px-3 py-2 mb-3 text-xs text-brand-green">
          🔥 Already burned this epoch: <span className="font-mono font-bold">{oSolaBonus.toFixed(4)} oSOLA</span> = <span className="font-mono font-bold">+{oSolaBonus.toFixed(4)} votes</span>
        </div>
      )}

      <div className="rounded-xl bg-brand-dark border border-brand-border p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">{inputLabel[tab]}</span>
          {balance !== null && (
            <span className="text-xs text-gray-500">
              Balance:{" "}
              <button
                className="text-gray-300 hover:text-brand-green transition-colors font-mono"
                onClick={() => applyPct(100)}
              >
                {balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} {tokenLabel[tab]}
              </button>
            </span>
          )}
        </div>
        <input
          className="w-full bg-transparent text-right text-2xl font-bold text-white placeholder-gray-600 focus:outline-none mb-3"
          type="text"
          inputMode="decimal"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <div className="flex gap-2">
          {PCT.map((pct) => (
            <button
              key={pct}
              onClick={() => applyPct(pct)}
              disabled={!balance}
              className="flex-1 text-xs py-1 rounded-md border border-brand-border text-gray-400
                         hover:border-brand-green hover:text-brand-green transition-colors
                         disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {pct === 100 ? "Max" : `${pct}%`}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-gray-500 mb-4">
        {tab === "stake"
          ? "hiSOLA gives governance rights, fee share & borrow power"
          : tab === "unstake"
          ? "Repay outstanding debt before unstaking"
          : "1 oSOLA burned = 1 vote unit for this epoch only — resets each epoch"}
      </p>

      <button
        className="btn-primary w-full"
        onClick={tab === "burn" ? burnForVotes : submit}
        disabled={loading || !wallet || !amount}
      >
        {loading ? "Processing…"
          : tab === "stake" ? "Stake"
          : tab === "unstake" ? "Unstake"
          : "🔥 Burn oSOLA for votes"}
      </button>

      {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
    </div>
  );
}