// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  getProgram, statePda, solaM, solaVaultAddr, marketVault, positionPda,
  PROGRAM_ID, sendTx, userAta, userAtaAuto, explainTxError,
  getMintProgram,
} from "@/lib/program";
import { partnerLpVaultPda, retainerEpochsEarned } from "./PartnerDealForm";

const EPOCH_DURATION = 604_800; // state.rs

const pda = (seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

const partnerPda = (o: PublicKey) => pda([Buffer.from("partner"), o.toBuffer()]);
const streamPda = (o: PublicKey) => pda([Buffer.from("bribe_stream"), o.toBuffer()]);
const streamVaultPda = (o: PublicKey) => pda([Buffer.from("stream_tokens"), o.toBuffer()]);
const velockPda = (o: PublicKey) => pda([Buffer.from("velock"), o.toBuffer()]);

const le8 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const bribeVaultPda = (pool: PublicKey, mint: PublicKey, epoch: number) =>
  pda([Buffer.from("bribe_vault"), pool.toBuffer(), mint.toBuffer(), le8(epoch)]);
const bribeTokensPda = (pool: PublicKey, mint: PublicKey, epoch: number) =>
  pda([Buffer.from("bribe_tokens"), pool.toBuffer(), mint.toBuffer(), le8(epoch)]);

// ── Exact amounts, no floats ─────────────────────────────────────────────────
// Same discipline as the register form: these numbers are escrowed and the
// schedule cannot be edited afterwards, so nothing goes through parseFloat.
function toBaseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim();
  if (!s || s === "." || !/^\d*\.?\d*$/.test(s)) return null;
  const [whole = "", frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * BigInt(10) ** BigInt(decimals) + BigInt(padded || "0");
}
function fmt(v: bigint, decimals = 6): string {
  const d = BigInt(10) ** BigInt(decimals);
  const whole = (v / d).toLocaleString("en-US");
  const frac = v % d;
  if (frac === BigInt(0)) return whole;
  return `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

export interface StreamAlloc {
  bribeMint: PublicKey;
  lpMint: PublicKey;
  lpThreshold: bigint;
  retainerPerEpoch: bigint;
  minBribePerEpoch: bigint;
  scheduleEpochs: number;
  baseHiSola: bigint;
  streamStartTs: number;
  lpWithdrawnEpoch: number;
  lpQualifiedSinceTs: number;
  epochsQualified: number;
}

interface StreamData {
  poolId: PublicKey;
  amountPerEpoch: bigint;
  epochsTotal: number;
  epochsReleased: number;
  lastReleaseEpoch: number;
  startTs: number;
}

/// The card that runs the partnership week by week.
///
/// Two things live here because they are one transaction: `fund_partner_bribe_stream`, the one
/// action that opens the deal at all, and `crank_partner_epoch`, which every epoch releases the
/// bribe tranche and buys that epoch of the retainer against the partner's liquidity.
///
/// ☢️ The copy has to be blunt about the asymmetry between the two halves, because the money
/// difference is real: a missed epoch costs the partner the retainer permanently, while the
/// bribe side merely slips.
export function PartnerStream({
  alloc,
  bribeDec,
  onChanged,
}: {
  alloc: StreamAlloc;
  bribeDec: number | null;
  onChanged: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const [stream, setStream] = useState<StreamData | null>(null);
  const [escrowLeft, setEscrowLeft] = useState<bigint>(BigInt(0));
  const [walletBal, setWalletBal] = useState<bigint>(BigInt(0));
  const [lpBal, setLpBal] = useState<bigint>(BigInt(0));
  const [escrowLp, setEscrowLp] = useState<bigint>(BigInt(0));
  const [paused, setPaused] = useState(false);
  const [lpDec, setLpDec] = useState<number>(6);
  const [nowSecs, setNowSecs] = useState(Math.floor(Date.now() / 1000));
  // Not state the partner controls: the rhythm is a term of the deal.
  const epochs = String(alloc.scheduleEpochs || 52);
  const [perEpoch, setPerEpoch] = useState("300");
  const [poolInput, setPoolInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const fetchStream = useCallback(async () => {
    if (!wallet) return;
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program = getProgram(provider);
      const s: any = await (program.account as any).partnerBribeStream
        .fetchNullable(streamPda(wallet.publicKey));
      if (s) {
        setStream({
          poolId: s.poolId,
          amountPerEpoch: BigInt(s.amountPerEpoch.toString()),
          epochsTotal: Number(s.epochsTotal.toString()),
          epochsReleased: Number(s.epochsReleased.toString()),
          lastReleaseEpoch: Number(s.lastReleaseEpoch.toString()),
          startTs: Number(s.startTs.toString()),
        });
        const v = await connection.getTokenAccountBalance(
          streamVaultPda(wallet.publicKey)
        ).catch(() => null);
        setEscrowLeft(BigInt(v?.value.amount ?? "0"));
      } else {
        setStream(null);
      }
      // `bribeMint` is arbitrary by design — a partner bribing in USDG or a Token-2022 asset
      // never touches the AMM — so it gets the same treatment as a pool side. The transaction
      // below already resolves it via `getMintProgram`; this read did not, and would have shown
      // a partner a zero balance of a bribe token they actually hold.
      const bribeAta = await userAtaAuto(connection, alloc.bribeMint, wallet.publicKey);
      const b = await connection.getTokenAccountBalance(bribeAta).catch(() => null);
      setWalletBal(BigInt(b?.value.amount ?? "0"));

      // The liquidity condition, read exactly as the program reads it: one balance, one
      // comparison, no custody anywhere.
      const lp = await connection.getTokenAccountBalance(
        userAta(alloc.lpMint, wallet.publicKey)
      ).catch(() => null);
      setLpBal(BigInt(lp?.value.amount ?? "0"));
      if (typeof lp?.value.decimals === "number") setLpDec(lp.value.decimals);
      const esc = await connection.getTokenAccountBalance(
        partnerLpVaultPda(wallet.publicKey)
      ).catch(() => null);
      setEscrowLp(BigInt(esc?.value.amount ?? "0"));
      const st: any = await (program.account as any).protocolState.fetch(statePda).catch(() => null);
      setPaused(Boolean(st?.paused));

      const slot = await connection.getSlot();
      const bt = await connection.getBlockTime(slot);
      if (bt) setNowSecs(bt);
    } catch (e) {
      console.error("PartnerStream fetch:", e);
    }
  }, [connection, wallet, alloc.bribeMint, alloc.lpMint]);

  useEffect(() => { fetchStream(); }, [fetchStream]);

  if (!wallet || bribeDec === null) {
    return (
      <div className="card text-center py-8 text-gray-500 text-sm">
        Reading your committed bribe token…
      </div>
    );
  }

  const currentEpoch = Math.floor(nowSecs / EPOCH_DURATION);
  const spent = stream !== null && stream.epochsReleased >= stream.epochsTotal;
  const tranceDue = stream !== null && !spent && stream.lastReleaseEpoch < currentEpoch;
  const lpOk = escrowLp >= alloc.lpThreshold;
  const term = alloc.scheduleEpochs;
  const earned = retainerEpochsEarned(
    { lpQualifiedSinceTs: alloc.lpQualifiedSinceTs, lpWithdrawnEpoch: alloc.lpWithdrawnEpoch, scheduleEpochs: term },
    currentEpoch,
  );
  const dueEpochs = Math.max(earned - alloc.epochsQualified, 0);
  const retainerDue = dueEpochs > 0 && alloc.retainerPerEpoch > BigInt(0);
  const epochOpen = retainerDue;
  const canCrank = stream !== null && (tranceDue || retainerDue);
  const lpLeft = alloc.lpWithdrawnEpoch !== 0;
  const termOver = earned >= term;
  const canWithdraw = escrowLp > BigInt(0) && (alloc.lpQualifiedSinceTs === 0 || termOver || paused);
  const toDeposit = alloc.lpThreshold > escrowLp ? alloc.lpThreshold - escrowLp : BigInt(0);

  // ── What the schedule being typed would actually escrow ─────────────────────
  const nEpochs = /^\d+$/.test(epochs.trim()) ? parseInt(epochs, 10) : NaN;
  const perBase = toBaseUnits(perEpoch, bribeDec);
  const plan = (() => {
    if (!Number.isFinite(nEpochs) || nEpochs < 1)
      return { err: "Choose at least 1 epoch." };
    if (perBase === null)
      return { err: `At most ${bribeDec} decimals — that is all this mint has.` };
    if (perBase <= BigInt(0)) return { err: "Amount per epoch must be above 0." };
    // Refused on-chain as ScheduleUnderfunded, not merely suboptimal: the escrow IS the
    // commitment the bag is released against, so a derisory tranche is not the deal. Name the
    // number that works rather than letting a doomed transaction go out.
    if (perBase < alloc.minBribePerEpoch)
      return {
        err: `Your deal commits to at least ${fmt(alloc.minBribePerEpoch, bribeDec)} per epoch — the program refuses less.`,
      };
    const total = perBase * BigInt(nEpochs);
    if (total > walletBal)
      return {
        err: `You hold ${fmt(walletBal, bribeDec)} — this schedule escrows ${fmt(total, bribeDec)} up front.`,
      };
    return { total, nEpochs };
  })();
  const planErr = "err" in plan ? (plan.err as string) : null;
  const planOk = planErr ? null : (plan as Extract<typeof plan, { total: bigint }>);

  async function fund() {
    if (!wallet || !planOk) return;
    setBusy(true); setStatus("");
    try {
      let pool: PublicKey;
      try { pool = new PublicKey(poolInput.trim()); }
      catch { setStatus("❌ Enter the pool address this schedule should bribe."); return; }

      const provider = new AnchorProvider(connection, wallet, {});
      const program = getProgram(provider);
      // The bribe token is the partner's own choice — it may well be Token-2022 (USDG, PYUSD).
      const bribeProgram = await getMintProgram(connection, alloc.bribeMint);
      const ix = await program.methods
        .fundPartnerBribeStream(new BN(planOk.nEpochs), new BN(perBase!.toString()))
        .accounts({
          partner: wallet.publicKey,
          protocolState: statePda,
          partnerAllocation: partnerPda(wallet.publicKey),
          poolId: pool,
          bribeMint: alloc.bribeMint,
          partnerToken: userAta(alloc.bribeMint, wallet.publicKey, bribeProgram),
          bribeStream: streamPda(wallet.publicKey),
          streamVault: streamVaultPda(wallet.publicKey),
          tokenProgram: bribeProgram,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any).instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setStatus(`✅ Schedule escrowed — tx: ${tx.slice(0, 16)}…`);
      await fetchStream();
      onChanged();
    } catch (e: any) { setStatus(`❌ ${explainTxError(e)}`); }
    finally { setBusy(false); }
  }

  async function depositLp() {
    if (!wallet || toDeposit === BigInt(0)) return;
    setBusy(true); setStatus("");
    try {
      const program = getProgram(new AnchorProvider(connection, wallet, {}));
      const ix = await program.methods
        .depositPartnerLp(new BN(toDeposit.toString()))
        .accounts({
          partner: wallet.publicKey,
          protocolState: statePda,
          partnerAllocation: partnerPda(wallet.publicKey),
          lpMint: alloc.lpMint,
          partnerLpToken: userAta(alloc.lpMint, wallet.publicKey),
          partnerLpVault: partnerLpVaultPda(wallet.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any).instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setStatus(`✅ LP locked in escrow — tx: ${tx.slice(0, 16)}…`);
      await fetchStream();
      onChanged();
    } catch (e: any) { setStatus(`❌ ${explainTxError(e)}`); }
    finally { setBusy(false); }
  }

  async function withdrawLp() {
    if (!wallet) return;
    setBusy(true); setStatus("");
    try {
      const program = getProgram(new AnchorProvider(connection, wallet, {}));
      const ix = await program.methods
        .withdrawPartnerLp()
        .accounts({
          partner: wallet.publicKey,
          protocolState: statePda,
          partnerAllocation: partnerPda(wallet.publicKey),
          lpMint: alloc.lpMint,
          partnerLpToken: userAta(alloc.lpMint, wallet.publicKey),
          partnerLpVault: partnerLpVaultPda(wallet.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any).instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setStatus(`✅ LP returned — tx: ${tx.slice(0, 16)}…`);
      await fetchStream();
      onChanged();
    } catch (e: any) { setStatus(`❌ ${explainTxError(e)}`); }
    finally { setBusy(false); }
  }

  async function crank() {
    if (!wallet || !stream) return;
    setBusy(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program = getProgram(provider);
      const bribeProgram = await getMintProgram(connection, alloc.bribeMint);
      const ix = await program.methods
        .crankPartnerEpoch(new BN(currentEpoch))
        .accounts({
          caller: wallet.publicKey,
          protocolState: statePda,
          partner: wallet.publicKey,
          bribeStream: streamPda(wallet.publicKey),
          partnerAllocation: partnerPda(wallet.publicKey),
          streamVault: streamVaultPda(wallet.publicKey),
          poolId: stream.poolId,
          rewardMint: alloc.bribeMint,
          bribeVault: bribeVaultPda(stream.poolId, alloc.bribeMint, currentEpoch),
          bribeTokenVault: bribeTokensPda(stream.poolId, alloc.bribeMint, currentEpoch),
          solaMint: solaM,
          solaVault: solaVaultAddr,
          marketVault,
          lockPosition: velockPda(wallet.publicKey),
          partnerPosition: positionPda(wallet.publicKey),
          // ☢️ Two programs: the bribe tranche moves the partner's token, the retainer mints
          // SOLA. SOLA and the LP mint are always classic SPL Token.
          bribeTokenProgram: bribeProgram,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any).instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setStatus(`✅ Epoch ${currentEpoch} run — tx: ${tx.slice(0, 16)}…`);
      await fetchStream();
      onChanged();
    } catch (e: any) { setStatus(`❌ ${explainTxError(e)}`); }
    finally { setBusy(false); }
  }

  // ── Running or spent ────────────────────────────────────────────────────────
  if (stream) {
    const pctDone = (stream.epochsReleased / stream.epochsTotal) * 100;
    const weeksLeft = stream.epochsTotal - stream.epochsReleased;
    return (
      <div className={`card ${epochOpen && lpOk ? "border-brand-green/40" : ""}`}>
        <div className="flex items-center gap-3 mb-1">
          <span className="text-2xl">⏳</span>
          <div>
            <h3 className="text-base font-bold text-white">This epoch</h3>
            <p className="text-xs text-gray-500">
              One call pays your bribe tranche and buys this week of your retainer
            </p>
          </div>
        </div>

        {/* ── The LP escrow: the whole liquidity condition ── */}
        <div className="mt-4 rounded-xl border border-brand-border bg-brand-dark/60 px-3 py-3">
          <div className="flex justify-between items-baseline mb-1">
            <span className="text-[10px] text-gray-500 uppercase tracking-widest">LP escrow</span>
            <span className={`text-[11px] font-mono ${lpOk ? "text-brand-green" : "text-amber-400"}`}>
              {lpLeft ? "returned" : lpOk ? "locked" : "not yet"}
            </span>
          </div>
          <div className="flex justify-between text-[11px]">
            <span className="text-gray-500">In escrow / required</span>
            <span className="text-gray-300 font-mono">{fmt(escrowLp, lpDec)} / {fmt(alloc.lpThreshold, lpDec)} LP</span>
          </div>
          <div className="flex justify-between text-[11px]">
            <span className="text-gray-500">Epochs earned / term</span>
            <span className="text-gray-300 font-mono">{earned} / {term}</span>
          </div>
          <p className="text-[10px] text-gray-600 mt-2 leading-relaxed">
            Your LP stays in the pool and keeps earning swap fees; the protocol holds the LP
            token until the term is over. Every full epoch it covers earns {fmt(alloc.retainerPerEpoch)} hiSOLA
            — late cranks lose nothing. Claim your LP rewards before locking.
          </p>
          {!lpLeft && toDeposit > BigInt(0) && (
            <button className="btn-primary w-full mt-3" onClick={depositLp}
                    disabled={busy || lpBal < toDeposit}>
              {lpBal < toDeposit
                ? `You hold ${fmt(lpBal, lpDec)} LP — ${fmt(toDeposit, lpDec)} needed`
                : `Lock ${fmt(toDeposit, lpDec)} LP for ${term} epochs`}
            </button>
          )}
          {canWithdraw && (
            <button className="btn-secondary w-full mt-3" onClick={withdrawLp} disabled={busy}>
              {termOver ? "Term complete — withdraw my LP" : paused ? "Protocol paused — withdraw my LP" : "Withdraw my LP"}
            </button>
          )}
        </div>

        <div className="flex justify-between items-baseline mt-4 mb-1">
          <span className="text-xs text-gray-400">Bribe tranches released</span>
          <span className="text-xs text-white font-mono font-semibold">
            {stream.epochsReleased} / {stream.epochsTotal}
          </span>
        </div>
        <div className="w-full bg-brand-border rounded-full h-2 mb-3">
          <div className="bg-brand-green h-2 rounded-full transition-all"
               style={{ width: `${Math.min(100, pctDone)}%` }} />
        </div>

        <div className="flex flex-col gap-1 text-[11px] mb-4">
          <div className="flex justify-between">
            <span className="text-gray-500">Bribe per epoch</span>
            <span className="text-gray-300 font-mono">
              {fmt(stream.amountPerEpoch, bribeDec)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Retainer per epoch</span>
            <span className="text-gray-300 font-mono">
              {fmt(alloc.retainerPerEpoch)} hiSOLA
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Epochs earned so far</span>
            <span className="text-gray-300 font-mono">{alloc.epochsQualified}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Still in escrow</span>
            <span className="text-gray-300 font-mono">{fmt(escrowLeft, bribeDec)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Gauge being bribed</span>
            <span className="text-gray-300 font-mono">
              {stream.poolId.toBase58().slice(0, 8)}…
            </span>
          </div>
        </div>

        <p className="text-[11px] text-gray-500 leading-relaxed mb-3">
          Running this is <strong className="text-gray-300">permissionless</strong>: anyone may
          call it. It releases this epoch&apos;s bribe tranche and credits every epoch your LP
          has covered since the last run.
        </p>

        <button
          className="btn-primary w-full"
          onClick={crank}
          disabled={busy || !canCrank}
        >
          {busy ? "Processing…"
            : canCrank
              ? tranceDue && retainerDue
                ? `Run epoch ${currentEpoch} — bribe + ${fmt(alloc.retainerPerEpoch * BigInt(dueEpochs))} hiSOLA`
                : retainerDue
                  ? `Claim ${dueEpochs} epoch${dueEpochs === 1 ? "" : "s"} — ${fmt(alloc.retainerPerEpoch * BigInt(dueEpochs))} hiSOLA`
                  : "Release this epoch's bribe tranche"
              : "Nothing to do this epoch"}
        </button>
        <p className="text-[11px] text-gray-500 mt-2">
          {spent
            ? "Bribe schedule complete."
            : `${weeksLeft} tranche${weeksLeft === 1 ? "" : "s"} left`}
          {" · "}epoch {currentEpoch}
        </p>

        {spent && (
          <p className="text-xs text-brand-green mt-3">
            ✅ Every funded tranche was released. You can escrow a new term below, or keep
            bribing manually from the Bribe tab.
          </p>
        )}

        {status && <p className="text-xs text-gray-400 break-all mt-3">{status}</p>}
      </div>
    );
  }

  // ── No schedule yet — the whole deal is shut ────────────────────────────────
  return (
    <div className="card border-amber-500/30">
      <div className="flex items-center gap-3 mb-1">
        <span className="text-2xl">🔒</span>
        <div>
          <h3 className="text-base font-bold text-white">Commit your bribe schedule</h3>
          <p className="text-xs text-gray-500">
            One signature, and the partnership starts
          </p>
        </div>
      </div>

      <p className="text-xs text-amber-400/90 leading-relaxed mt-3 mb-4">
        ⚠️ Nothing accrues until this is done — not your{" "}
        <span className="font-mono text-white">{fmt(alloc.baseHiSola)}</span> hiSOLA bag, not a
        single epoch of your{" "}
        <span className="font-mono text-white">{fmt(alloc.retainerPerEpoch)}</span> hiSOLA
        retainer. The schedule is what they are paid against, so it cannot come second.
      </p>

      <div className="flex flex-col gap-3">
        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 block">
            Gauge to bribe (pool address)
          </label>
          <input
            className="w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green"
            type="text"
            placeholder="Fixed for the life of the schedule"
            value={poolInput}
            onChange={(e) => setPoolInput(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 block">
              Amount per epoch
            </label>
            <input
              className="w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green"
              type="text"
              inputMode="decimal"
              placeholder={fmt(alloc.minBribePerEpoch, bribeDec)}
              value={perEpoch}
              onChange={(e) => {
                if (e.target.value === "" || /^\d*\.?\d*$/.test(e.target.value))
                  setPerEpoch(e.target.value);
              }}
            />
          </div>
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 block">
              Over how many epochs
            </label>
            {/* Fixed at registration — fund_partner_bribe_stream refuses any other length, so
                offering an editable field here would only produce a rejected transaction. */}
            <div className="w-full bg-brand-dark/60 border border-brand-border rounded-xl px-3 py-2 text-sm text-gray-400 font-mono flex items-center justify-between">
              <span>{epochs}</span>
              <span className="text-[10px] uppercase tracking-widest text-gray-600">
                agreed
              </span>
            </div>
          </div>
        </div>

        <p className="text-[10px] text-gray-500">
          1 epoch = 7 days · the {alloc.scheduleEpochs}-epoch rhythm and the{" "}
          <span className="font-mono text-gray-400">
            {fmt(alloc.minBribePerEpoch, bribeDec)}
          </span>{" "}
          minimum per epoch were agreed at registration · you hold{" "}
          <span className="font-mono text-gray-400">{fmt(walletBal, bribeDec)}</span>
        </p>

        {planErr && <p className="text-[11px] text-red-400">❌ {planErr}</p>}

        {planOk && (
          <div className="rounded-xl border border-brand-border bg-brand-dark/60 px-3 py-3 flex flex-col gap-2">
            <p className="text-[10px] text-gray-500 uppercase tracking-widest">
              What you are escrowing · immutable
            </p>
            <ul className="text-xs text-gray-300 leading-relaxed flex flex-col gap-1">
              <li>
                <span className="font-mono text-white">{fmt(planOk.total, bribeDec)}</span>{" "}
                leaves your wallet <strong className="text-white">now</strong>, into an escrow
                only the program can move.
              </li>
              <li>
                It pays{" "}
                <span className="font-mono text-white">{fmt(perBase!, bribeDec)}</span>{" "}
                to that gauge&apos;s voters every epoch for{" "}
                <span className="font-mono text-white">{planOk.nEpochs}</span> epochs
                {" "}(≈ {Math.round((planOk.nEpochs * 7) / 30.4)} months).
              </li>
              <li>
                It delivers your{" "}
                <span className="font-mono text-white">{fmt(alloc.baseHiSola)}</span> hiSOLA bag
                in one go, claimable immediately below.
              </li>
              <li>
                And it opens the retainer:{" "}
                <span className="font-mono text-white">{fmt(alloc.retainerPerEpoch)}</span>{" "}
                hiSOLA per epoch, for as long as your liquidity stays in place — with no cap and
                no end date.
              </li>
            </ul>

            <p className="text-[11px] text-gray-500 leading-relaxed">
              🔒 The escrow cannot be withdrawn, retimed, or topped up while it runs — that is
              what makes it a commitment. A new term can only be escrowed once this one has
              paid out in full.
            </p>
          </div>
        )}

        <button
          className="btn-primary w-full"
          onClick={fund}
          disabled={busy || !planOk || !poolInput.trim()}
        >
          {busy ? "Processing…"
            : !poolInput.trim() ? "Enter the gauge to bribe"
            : !planOk ? "Complete the schedule above"
            : `Escrow ${fmt(planOk.total, bribeDec)} over ${planOk.nEpochs} epochs`}
        </button>

        {status && <p className="text-xs text-gray-400 break-all">{status}</p>}
      </div>
    </div>
  );
}
