// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  getProgram, statePda, PROGRAM_ID, sendTx, userAta, explainTxError,
} from "@/lib/program";

const EPOCH_DURATION = 604_800; // state.rs
const BASE_BAG_VEST_SECS = 180 * 24 * 3_600; // state.rs
const MAX_LOCK_EPOCHS = 208;

const pda = (seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

const partnerPda = (o: PublicKey) => pda([Buffer.from("partner"), o.toBuffer()]);
const streamPda = (o: PublicKey) => pda([Buffer.from("bribe_stream"), o.toBuffer()]);
const streamVaultPda = (o: PublicKey) => pda([Buffer.from("stream_tokens"), o.toBuffer()]);

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
  rateNum: bigint;
  rateDen: bigint;
  capHiSola: bigint;
  baseHiSola: bigint;
  streamStartTs: number;
}

interface StreamData {
  poolId: PublicKey;
  amountPerEpoch: bigint;
  epochsTotal: number;
  epochsReleased: number;
  lastReleaseEpoch: number;
  startTs: number;
}

/// The card that decides whether the partnership runs itself.
///
/// `fund_partner_bribe_stream` is the one action that opens the welcome bag, so this is the
/// first thing a partner should see — and the copy has to say plainly that the bag is the
/// consideration for the schedule, not a signing bonus.
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
  const [nowSecs, setNowSecs] = useState(Math.floor(Date.now() / 1000));
  const [epochs, setEpochs] = useState("52");
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
      const b = await connection.getTokenAccountBalance(
        userAta(alloc.bribeMint, wallet.publicKey)
      ).catch(() => null);
      setWalletBal(BigInt(b?.value.amount ?? "0"));

      const slot = await connection.getSlot();
      const bt = await connection.getBlockTime(slot);
      if (bt) setNowSecs(bt);
    } catch (e) {
      console.error("PartnerStream fetch:", e);
    }
  }, [connection, wallet, alloc.bribeMint]);

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
  const running = stream !== null && !spent;
  const canRelease = running && stream.lastReleaseEpoch < currentEpoch;

  // ── What the schedule being typed would actually buy ────────────────────────
  const nEpochs = /^\d+$/.test(epochs.trim()) ? parseInt(epochs, 10) : NaN;
  const perBase = toBaseUnits(perEpoch, bribeDec);
  const plan = (() => {
    if (!Number.isFinite(nEpochs) || nEpochs < 1)
      return { err: "Choose at least 1 epoch." };
    if (perBase === null)
      return { err: `At most ${bribeDec} decimals — that is all this mint has.` };
    if (perBase <= BigInt(0)) return { err: "Amount per epoch must be above 0." };
    const total = perBase * BigInt(nEpochs);
    if (total > walletBal)
      return {
        err: `You hold ${fmt(walletBal, bribeDec)} — this schedule escrows ${fmt(total, bribeDec)} up front.`,
      };
    // Same arithmetic the program runs: credited × num / den, capped.
    const earnedRaw = alloc.rateDen > BigInt(0)
      ? (total * alloc.rateNum) / alloc.rateDen
      : BigInt(0);
    const earned = earnedRaw < alloc.capHiSola ? earnedRaw : alloc.capHiSola;
    return { total, earned, earnedRaw, nEpochs };
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
      const ix = await program.methods
        .fundPartnerBribeStream(new BN(planOk.nEpochs), new BN(perBase!.toString()))
        .accounts({
          partner: wallet.publicKey,
          protocolState: statePda,
          partnerAllocation: partnerPda(wallet.publicKey),
          poolId: pool,
          bribeMint: alloc.bribeMint,
          partnerToken: userAta(alloc.bribeMint, wallet.publicKey),
          bribeStream: streamPda(wallet.publicKey),
          streamVault: streamVaultPda(wallet.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
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

  async function release() {
    if (!wallet || !stream) return;
    setBusy(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program = getProgram(provider);
      const ix = await program.methods
        .releasePartnerBribe(new BN(currentEpoch))
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
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any).instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setStatus(`✅ Tranche released to this epoch's voters — tx: ${tx.slice(0, 16)}…`);
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
      <div className="card">
        <div className="flex items-center gap-3 mb-1">
          <span className="text-2xl">⏳</span>
          <div>
            <h3 className="text-base font-bold text-white">Your bribe schedule</h3>
            <p className="text-xs text-gray-500">
              Escrowed once · pays one tranche per epoch · nothing left to sign
            </p>
          </div>
        </div>

        <div className="flex justify-between items-baseline mt-4 mb-1">
          <span className="text-xs text-gray-400">Tranches released</span>
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
            <span className="text-gray-500">Per epoch</span>
            <span className="text-gray-300 font-mono">
              {fmt(stream.amountPerEpoch, bribeDec)}
            </span>
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

        {spent ? (
          <p className="text-xs text-brand-green">
            ✅ Schedule complete — every funded tranche was released. You can escrow a new term
            below, or keep bribing manually from the Bribe tab.
          </p>
        ) : (
          <>
            <p className="text-[11px] text-gray-500 leading-relaxed mb-3">
              Release is <strong className="text-gray-300">permissionless</strong>: anyone may
              crank it, and the epoch&apos;s voters are the ones owed the money, so it does not
              depend on you. The button is here for convenience. A missed epoch is not lost —
              the schedule simply slips one epoch further out, never paying two at once.
            </p>
            <button
              className="btn-primary w-full"
              onClick={release}
              disabled={busy || !canRelease}
            >
              {busy ? "Processing…"
                : canRelease ? `Release this epoch's ${fmt(stream.amountPerEpoch, bribeDec)}`
                : "This epoch's tranche is already out"}
            </button>
            <p className="text-[11px] text-gray-500 mt-2">
              {weeksLeft} tranche{weeksLeft === 1 ? "" : "s"} left · epoch {currentEpoch}
            </p>
          </>
        )}

        {status && <p className="text-xs text-gray-400 break-all mt-3">{status}</p>}
      </div>
    );
  }

  // ── No schedule yet — the welcome bag is shut ───────────────────────────────
  return (
    <div className="card border-amber-500/30">
      <div className="flex items-center gap-3 mb-1">
        <span className="text-2xl">🔒</span>
        <div>
          <h3 className="text-base font-bold text-white">Commit your bribe schedule</h3>
          <p className="text-xs text-gray-500">
            One signature, then the partnership runs on its own
          </p>
        </div>
      </div>

      <p className="text-xs text-amber-400/90 leading-relaxed mt-3 mb-4">
        ⚠️ Your welcome bag of{" "}
        <span className="font-mono text-white">{fmt(alloc.baseHiSola)}</span> hiSOLA vests
        nothing until this is done. It is the consideration for the schedule, not a signing
        bonus — and it starts streaming over 6 months from the moment you escrow, not from the
        day you were registered.
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
              placeholder="300"
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
            <input
              className="w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green"
              type="text"
              inputMode="numeric"
              placeholder="52"
              value={epochs}
              onChange={(e) => {
                if (e.target.value === "" || /^\d+$/.test(e.target.value))
                  setEpochs(e.target.value);
              }}
            />
          </div>
        </div>

        <p className="text-[10px] text-gray-500">
          1 epoch = 7 days · 52 epochs ≈ 12 months · you hold{" "}
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
                Which earns you{" "}
                <span className="font-mono text-white">{fmt(planOk.earned)}</span> hiSOLA of
                your <span className="font-mono">{fmt(alloc.capHiSola)}</span> cap, credited
                epoch by epoch as it pays out.
              </li>
              <li>
                And unlocks the{" "}
                <span className="font-mono text-white">{fmt(alloc.baseHiSola)}</span> hiSOLA
                welcome bag, streaming from today over{" "}
                {Math.round(BASE_BAG_VEST_SECS / 86_400)} days.
              </li>
            </ul>

            {/* The two ways a schedule is mis-sized. Both are silent on-chain: the program
                simply caps or never reaches the cap, and nothing tells you afterwards. */}
            {planOk.earnedRaw > alloc.capHiSola && (
              <p className="text-[11px] text-amber-400/90 leading-relaxed">
                ⚠️ This overshoots your cap. Bribes past{" "}
                <span className="font-mono">{fmt(alloc.capHiSola)}</span> hiSOLA still pay
                voters in full, but earn you nothing further.
              </p>
            )}
            {planOk.earnedRaw < alloc.capHiSola && (
              <p className="text-[11px] text-amber-400/90 leading-relaxed">
                ⚠️ This schedule stops short of your cap — it earns{" "}
                <span className="font-mono">{fmt(planOk.earned)}</span> of{" "}
                <span className="font-mono">{fmt(alloc.capHiSola)}</span>. You can top up
                manually later, but this escrow cannot be extended once it is running.
              </p>
            )}
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
