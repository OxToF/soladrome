// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  getProgram, statePda, solaM, hiSolaM, oSolaM, solaVaultAddr,
  marketVault, positionPda, userAta, commonAccounts, fromUi, PROGRAM_ID, sendTx,
  readPosition,
} from "@/lib/program";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useSoladrome } from "@/lib/SoladromeContext";
import { currentEpoch } from "@/lib/epoch";
import { trackQuest } from "@/lib/quests";
import { StatusBanner } from "./ui/StatusBanner";
import { EmptyState } from "./ui/EmptyState";
import { ButtonHint } from "./ui/ButtonHint";

type Tab = "stake" | "unstake" | "burn";
const PCT = [25, 50, 75, 100] as const;

export function Stake({ embedded = false }: { embedded?: boolean }) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint, protocolState } = useSoladrome();
  const [tab, setTab] = useState<Tab>("stake");
  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  const [oSolaBonus, setOSolaBonus] = useState<number>(0);
  // Immobilised by this epoch's votes — shown so "why can't I unstake it all" is answered
  // on the card rather than by a VoteEscrowLocked error after signing.
  const [voteLocked, setVoteLocked] = useState<number>(0);
  // Legacy SPL hiSOLA still stranded in the old escrow vault, recoverable by converting.
  const [legacyHiSola, setLegacyHiSola] = useState<number>(0);

  const fetchBalance = useCallback(async () => {
    if (!wallet) { setBalance(null); return; }
    if (tab === "unstake") {
      // hiSOLA has no token account to query — the balance is the position. What can
      // actually be unstaked right now is the balance minus whatever this epoch's votes
      // still immobilise, which is the figure the program itself enforces.
      try {
        const pos = await readPosition(connection, wallet.publicKey, currentEpoch());
        const free = pos.hiSola > pos.voteLocked ? pos.hiSola - pos.voteLocked : BigInt(0);
        setBalance(Number(free) / 1e6);
        setVoteLocked(Number(pos.voteLocked) / 1e6);
        // Both halves of the legacy sweep: tokens still in the old ATA, plus whatever the
        // position records as stuck in the global escrow vault.
        let inWallet = 0;
        try {
          const legacy = await connection.getTokenAccountBalance(
            userAta(hiSolaM, wallet.publicKey)
          );
          inWallet = Number(legacy.value.uiAmount ?? 0);
        } catch { /* no legacy token account — the normal case for a new wallet */ }
        setLegacyHiSola(inWallet + Number(pos.voteEscrowed) / 1e6);
      } catch { setBalance(0); }
    } else {
      const mint = tab === "stake" ? solaM : oSolaM;
      try {
        const ata  = userAta(mint, wallet.publicKey);
        const info = await connection.getTokenAccountBalance(ata);
        setBalance(Number(info.value.uiAmount ?? 0));
      } catch { setBalance(0); }
    }

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
      // Same velock PDA vote_gauge uses — try_load_ve_power returns 0 if it
      // doesn't exist, so it's always safe to pass. Needed so burning oSOLA
      // first snapshots hiSOLA power instead of zeroing the epoch vote cap.
      const [lockPosition] = PublicKey.findProgramAddressSync(
        [Buffer.from("velock"), wallet.publicKey.toBuffer()], PROGRAM_ID
      );
      const tx = await program.methods
        .burnOSolaForVotes(new BN(Math.floor(amt * 1_000_000)), new BN(ep))
        .accounts({
          user:           wallet.publicKey,
          protocolState:  statePda,
          oSolaMint:      oSolaM,
          userOSola:      userAta(oSolaM, wallet.publicKey),
          userPosition:   positionPda(wallet.publicKey),
          lockPosition,
          userEpochVotes,
          tokenProgram:   (await import("@solana/spl-token")).TOKEN_PROGRAM_ID,
          systemProgram:  SystemProgram.programId,
          rent:           SYSVAR_RENT_PUBKEY,
        } as any)
        .instruction()
        .then((ix) => sendTx(connection, wallet!, [ix]));
      setStatus(`✅ ${amt.toFixed(4)} oSOLA brûlés → +${amt.toFixed(4)} votes — tx: ${tx.slice(0, 16)}…`);
      setAmount("");
      setOSolaBonus(prev => prev + amt);
      setTimeout(() => { fetchBalance(); window.dispatchEvent(new CustomEvent("soladrome:refresh")); }, 2000);
    } catch (e: any) { setStatus(`❌ ${e?.message ?? e}`); }
    finally { setLoading(false); }
  }

  /// Sweep a legacy SPL hiSOLA balance into the position that replaced it.
  ///
  /// Only devnet wallets from before the change have anything to sweep. It burns the old
  /// tokens — from the wallet and from the global vote-escrow vault — and credits the
  /// position by the same amount. Nothing else moves, so it is safe to run at any time; but
  /// it can only be run BY the holder, since the program has no authority over their tokens.
  async function convertLegacy() {
    if (!wallet) return;
    setLoading(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const [voteEscrowVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote_escrow")], PROGRAM_ID
      );
      const ix = await program.methods
        .convertHiSola()
        .accounts({
          user:            wallet.publicKey,
          protocolState:   statePda,
          hiSolaMint:      hiSolaM,
          userHiSola:      userAta(hiSolaM, wallet.publicKey),
          voteEscrowVault,
          marketVault,
          userPosition:    positionPda(wallet.publicKey),
          tokenProgram:    TOKEN_PROGRAM_ID,
          systemProgram:   SystemProgram.programId,
        } as any)
        .instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setStatus(`✅ hiSOLA converti en position — tx: ${tx.slice(0, 16)}…`);
      fetchBalance();
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
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
      const userSola   = userAta(solaM, wallet.publicKey);
      const position   = positionPda(wallet.publicKey);

      if (tab === "stake") {
        // Auto-migrate user_position if it exists with the old 128-byte layout
        const posInfo = await connection.getAccountInfo(position);
        if (posInfo && posInfo.data.length === 128) {
          setStatus("Migrating account layout…");
          const migIx = await program.methods
            .migrateUserPosition()
            .accounts({
              user: wallet.publicKey,
              userPosition: position,
              systemProgram: SystemProgram.programId,
            } as any)
            .instruction();
          await sendTx(connection, wallet, [migIx]);
        }

        // user_usdc receives any pending fees auto-harvested when adding to an
        // existing stake (mirrors unstake). usdcMint comes from on-chain state.
        const stakeUserUsdc = usdcMint ? userAta(usdcMint, wallet.publicKey) : null;

        const ix = await program.methods
          .stakeSola(fromUi(+amount))
          .accounts({
            user: wallet.publicKey,
            protocolState: statePda,
            solaMint: solaM,
            userSola,
            solaVault: solaVaultAddr,
            marketVault,
            usdcMint: usdcMint ?? PublicKey.default,
            userUsdc: stakeUserUsdc ?? PublicKey.default,
            userPosition: position,
            ...commonAccounts,
          } as any)
          .instruction();
        const tx = await sendTx(connection, wallet, [ix]);
        setStatus(`✅ Staked → hiSOLA — tx: ${tx.slice(0, 16)}…`);
        trackQuest(wallet.publicKey.toBase58(), "stake");
        window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      } else {
        // Auto-migrate user_position if it exists with the old 128-byte layout
        const posInfo = await connection.getAccountInfo(position);
        if (posInfo && posInfo.data.length === 128) {
          setStatus("Migrating account layout…");
          const migIx = await program.methods
            .migrateUserPosition()
            .accounts({
              user: wallet.publicKey,
              userPosition: position,
              systemProgram: SystemProgram.programId,
            } as any)
            .instruction();
          await sendTx(connection, wallet, [migIx]);
        }

        const userUsdc = usdcMint ? userAta(usdcMint, wallet.publicKey) : null;

        // Founder vesting lock: pass the vesting PDA when the caller is the founder,
        // SystemProgram otherwise (the program never dereferences it for anyone else).
        // The address comes from on-chain state — it is no longer a compile-time constant,
        // and it differs between clusters, so a hardcoded copy would be wrong on devnet.
        const founderWallet = protocolState?.founderWallet?.toBase58() ?? null;
        const founderHiVesting = founderWallet && wallet.publicKey.toBase58() === founderWallet
          ? PublicKey.findProgramAddressSync([Buffer.from("founder_hi_vesting")], PROGRAM_ID)[0]
          : SystemProgram.programId;

        const ix = await program.methods
          .unstakeHiSola(fromUi(+amount))
          .accounts({
            user: wallet.publicKey,
            protocolState: statePda,
            solaMint: solaM,
            userSola,
            solaVault: solaVaultAddr,
            marketVault,
            usdcMint: usdcMint ?? PublicKey.default,
            userUsdc: userUsdc ?? PublicKey.default,
            userPosition: position,
            founderHiVesting,
            ...commonAccounts,
          } as any)
          .instruction();
        const tx = await sendTx(connection, wallet, [ix]);
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

      {/* Legacy hiSOLA sweep. Only ever shown to wallets that held the old SPL token —
          nothing mints it any more, so for everyone else this is dead UI. */}
      {tab === "unstake" && legacyHiSola > 0 && (
        <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/5 px-3 py-3 mb-3 text-xs text-yellow-200">
          <p className="mb-2">
            <span className="font-bold">
              {legacyHiSola.toLocaleString(undefined, { maximumFractionDigits: 4 })} hiSOLA
            </span>{" "}
            sont encore sous l&apos;ancien format token. hiSOLA est devenu une position non
            transférable : convertis-les pour les revoir dans ton solde, voter avec, et les
            unstake. Rien d&apos;autre ne bouge — ni ta dette, ni tes frais, ni ton stake.
          </p>
          <button
            className="btn-secondary w-full text-xs py-2"
            onClick={convertLegacy}
            disabled={loading}
          >
            {loading ? "…" : "Convertir mes hiSOLA"}
          </button>
        </div>
      )}

      {/* What this epoch's votes still hold. Answers "why is my balance short" before the
          transaction fails, rather than after. */}
      {tab === "unstake" && voteLocked > 0 && (
        <div className="rounded-lg border border-brand-border bg-brand-dark px-3 py-2 mb-3 text-xs text-gray-400">
          🗳️{" "}
          <span className="font-mono font-bold text-gray-200">
            {voteLocked.toLocaleString(undefined, { maximumFractionDigits: 4 })} hiSOLA
          </span>{" "}
          adossés à ton vote de cette epoch — libérés dès la suivante. Le reste est disponible.
        </div>
      )}

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

      {wallet && balance === 0 && (
        <EmptyState
          icon="✨"
          title={`No ${tokenLabel[tab]} to ${tab === "burn" ? "burn" : tab} yet.`}
          hint={
            tab === "stake"   ? "Get SOLA from the Swap tab first."
            : tab === "unstake" ? "Stake SOLA to receive hiSOLA."
            : "Exercise oSOLA options to receive oSOLA to burn."
          }
        />
      )}

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
      <ButtonHint
        text={
          !wallet ? "Connect your wallet to continue"
          : !amount && !loading ? "Enter an amount"
          : null
        }
      />

      <StatusBanner message={status} />
    </div>
  );
}