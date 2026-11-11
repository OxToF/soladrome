// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  getProgram, statePda, solaM, oSolaM, readPosition,
  solaVaultAddr, marketVault, floorVault,
  positionPda, userAta, commonAccounts, fromUi, toUi, sendTx,
} from "@/lib/program";
import { useSoladrome, useFloorHeadroom } from "@/lib/SoladromeContext";
import { PROGRAM_ID } from "@/lib/program";
import PartnerDealForm, { partnerLpVaultPda, retainerEpochsEarned } from "./PartnerDealForm";


// ── Partner registration ──────────────────────────────────────────────────────
const PARTNER_SEED        = Buffer.from("partner");
const CONTRIBUTOR_SEED    = Buffer.from("contributor");
// One binary since 2026-08-23, so this is 604 800 on every cluster — there is no longer a
// devnet variant of EPOCH_DURATION to qualify this with.
const EPOCH_DURATION_SECS = 604_800; // state.rs: EPOCH_DURATION

function contributorVestingPda(contributorWallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [CONTRIBUTOR_SEED, contributorWallet.toBuffer()],
    PROGRAM_ID
  )[0];
}

function partnerAllocPda(partnerWallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PARTNER_SEED, partnerWallet.toBuffer()],
    PROGRAM_ID
  )[0];
}

/// Everything `close_partner_allocation` weighs, resolved before the transaction is built so
/// the panel says the same thing the program will.
interface CloseInfo {
  lpMint: PublicKey;
  lpThreshold: bigint;
  lpBalance: bigint;
  baseHiSola: bigint;
  bagClaimed: boolean;
  hiSolaClaimed: bigint;
  epochsQualified: number;
  streamStartTs: number;
  epochsReleased: number;
  epochsTotal: number;
  closable: boolean;
  reason: string;
}

/// The singleton the contributor caps are counted against — 100 000 hiSOLA and 100 000 oSOLA,
/// summed over every contributor ever registered. There was no bound at all until 2026-08-27.
const contributorRegistryPda = PublicKey.findProgramAddressSync(
  [Buffer.from("contributor_registry")],
  PROGRAM_ID
)[0];

// ── Exact amounts, no floats ─────────────────────────────────────────────────
// `register_partner` writes numbers that can never be edited afterwards, so every figure
// on this form is parsed and displayed with BigInt. `parseFloat(x) * 1e6` was the previous
// route and it is not safe here: it silently rounds past 2^53 and turns a typed amount into
// a neighbouring one, on an instruction with no second chance.
const U64_MAX = BigInt("18446744073709551615");

/// Decimal string → base units. Returns null on anything not exactly representable,
/// including more decimal places than the mint actually has.
function toBaseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim();
  if (!s || s === "." || !/^\d*\.?\d*$/.test(s)) return null;
  const [whole = "", frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (
    BigInt(whole || "0") * BigInt(10) ** BigInt(decimals) + BigInt(padded || "0")
  );
}

/// Base units → display string. A whole amount renders whole: 1 000 000 base units of a
/// 6-decimal mint is "1,000,000", never "1,000,000.000000" and never "1000000.00". Trailing
/// zeros inside a real fraction are dropped too.
function fromBaseUnits(v: bigint, decimals: number): string {
  const d = BigInt(10) ** BigInt(decimals);
  const whole = (v / d).toLocaleString("en-US");
  const frac = v % d;
  if (frac === BigInt(0)) return whole;
  const f = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${f}`;
}

// (`gcd` removed 2026-08-27 with the 1:1 bribe match. It reduced a negotiated pair —
//  tokens committed, hiSOLA earned — into the `rate_num`/`rate_den` the program stored for
//  life. There is no conversion rate anywhere in the partner path any more.)

// ── Vesting constants — must match state.rs ──────────────────────────────────
// One set of values, for every cluster. These read 6 h / 24 h until 2026-08-23, mirroring
// the `devnet` feature the program no longer has; the "flip these before launch" note they
// carried is exactly the kind of manual step that gets forgotten. The program's constants are
// now unconditional, so these are too.
const VESTING_CLIFF_SECS    = 180 * 24 * 3_600; // 6 months
const VESTING_DURATION_SECS = 720 * 24 * 3_600; // 24 months, linear after the cliff
// The 5M oSOLA have their own schedule (constants.rs FOUNDER_O_SOLA_*): 12-month cliff, 48 months
// in all. Until 2026-11-11 this panel showed them on the hiSOLA 6/24 schedule above.
const O_SOLA_CLIFF_SECS    = 365 * 24 * 3_600;
const O_SOLA_DURATION_SECS = 4 * 365 * 24 * 3_600;
// FOUNDER_O_SOLA_MARKET_CAP_BPS: the total claimed never exceeds 20 % of the SOLA held off the curve.
const O_SOLA_MARKET_CAP_BPS = 2_000;

// ── PDAs ─────────────────────────────────────────────────────────────────────
const founderHiVestingPda = PublicKey.findProgramAddressSync(
  [Buffer.from("founder_hi_vesting")],
  PROGRAM_ID
)[0];

const founderVestingPda = PublicKey.findProgramAddressSync(
  [Buffer.from("founder_vesting")],
  PROGRAM_ID
)[0];

// Lifetime ve escrow — claim_founder_hi_sola credits this position, never the wallet.
// Same seed as the partner ve lock ([b"velock"], keyed by owner). There is no longer a
// paired [b"ve_vault"] token account: both sides of the move are ledger figures.
function veLockPositionPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("velock"), owner.toBuffer()],
    PROGRAM_ID
  )[0];
}

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
  marketCapRaw,
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
  /// Total the program lets be claimed given the market; undefined = no market cap.
  marketCapRaw?: number;
}) {
  const elapsed      = Math.max(0, nowSecs - startTs);
  const afterCliff   = elapsed >= cliffSecs;
  const vestedRaw    = afterCliff
    ? Math.floor((totalRaw * Math.min(elapsed, durationSecs)) / durationSecs)
    : 0;
  const allowedRaw   = marketCapRaw === undefined ? vestedRaw : Math.min(vestedRaw, marketCapRaw);
  const claimableRaw = Math.max(0, allowedRaw - claimedRaw);
  const capBinds     = marketCapRaw !== undefined && afterCliff && marketCapRaw < vestedRaw;
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
      {capBinds && (
        <p className="text-[11px] text-gray-500 mt-2">
          Market cap: at most{" "}
          <span className="text-gray-300 font-mono">{fmtSola(marketCapRaw!)} {tokenSymbol}</span>{" "}
          claimed in total — 20 % of the SOLA buyers hold off the curve. The rest unlocks as the
          market buys, and a sale lowers it.
        </p>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function FounderPanel() {
  const { connection } = useConnection();
  const wallet         = useAnchorWallet();
  const { usdcMint, protocolState } = useSoladrome();

  // On-chain, not hardcoded — see the note in app/app/page.tsx. The address differs per
  // cluster now that one binary serves all of them.
  const founderWallet = protocolState?.founderWallet?.toBase58() ?? null;
  // The curve started at vu = vs = sqrt(k); what it has given out is sqrt(k) − virtual_sola.
  // The program reads the curve as it stood before the current slot's trades — a hair stricter.
  const oSolaMarketCapRaw = (() => {
    const ps: any = protocolState;
    if (!ps?.k || !ps?.virtualSola) return undefined;
    const start = Math.round(Math.sqrt(Number(ps.k.toString())));
    const sold  = Math.max(0, start - Number(ps.virtualSola.toString()));
    return Math.floor((sold * O_SOLA_MARKET_CAP_BPS) / 10_000);
  })();
  const isFounder = !!wallet && !!founderWallet &&
    wallet.publicKey.toBase58() === founderWallet;

  // ── On-chain state ──────────────────────────────────────────────────────────
  const [hiVesting,       setHiVesting]       = useState<{ totalAmount: number; claimed: number; startTs: number } | null>(null);
  const [oVesting,        setOVesting]        = useState<{ totalAmount: number; claimed: number; startTs: number } | null>(null);
  const [founderPos,      setFounderPos]      = useState<{ usdcBorrowed: number } | null>(null);
  const [hiSolaBal,       setHiSolaBal]       = useState<number>(0);
  // The 7M reserve lives in the ve lock, never in the position — and `borrow_against_locked`
  // caps on `lock_position.amount_locked`, so that is the figure the cap must be read from.
  const [lockedRaw,       setLockedRaw]       = useState<number>(0);
  const [floorVaultBal,   setFloorVaultBal]   = useState<number>(0); // raw USDC
  const [nowSecs,         setNowSecs]         = useState<number>(Math.floor(Date.now() / 1000));

  // ── UI state ────────────────────────────────────────────────────────────────
  const [loadingHi,  setLoadingHi]  = useState(false);
  const [loadingO,   setLoadingO]   = useState(false);
  const [loadingBor, setLoadingBor] = useState(false);
  const [borrowTab,  setBorrowTab]  = useState<"borrow" | "repay">("borrow");
  const [borrowAmt,  setBorrowAmt]  = useState("");
  const [status,     setStatus]     = useState("");

  // ── Close partner allocation ────────────────────────────────────────────────
  const [closeWallet,  setCloseWallet]  = useState("");
  const [closeInfo,    setCloseInfo]    = useState<CloseInfo | null>(null);
  const [closeErr,     setCloseErr]     = useState<string | null>(null);
  const [loadingClose, setLoadingClose] = useState(false);
  const [statusClose,  setStatusClose]  = useState("");

  // ── Register contributor form ───────────────────────────────────────────────
  // Until 2026-08-25 this had no UI at all: register_contributor was reachable only through
  // scripts/register_contributor.ts, which read the amounts with parseFloat out of environment
  // variables. Two immutable figures, typed into a shell, with nothing shown back.
  const [conWallet,  setConWallet]  = useState("");
  const [conHiSola,  setConHiSola]  = useState("");
  const [conOSola,   setConOSola]   = useState("");
  const [loadingCon, setLoadingCon] = useState(false);
  const [statusCon,  setStatusCon]  = useState("");

  const contributor = (() => {
    const hi = toBaseUnits(conHiSola || "0", 6);
    const o  = toBaseUnits(conOSola  || "0", 6);
    if (hi === null) return { err: "hiSOLA must be a plain amount, at most 6 decimals." };
    if (o === null)  return { err: "oSOLA must be a plain amount, at most 6 decimals." };
    if (hi > U64_MAX || o > U64_MAX) return { err: "Amount too large for u64." };
    // The program's own require!: at least one side must be non-zero.
    if (hi === BigInt(0) && o === BigInt(0))
      return { err: "Give the contributor hiSOLA, oSOLA, or both — both cannot be zero." };
    // And its second one, added 2026-08-27: the two sides are not interchangeable. hiSOLA is
    // permanent governance plus a real share of revenue; oSOLA is an option the holder pays
    // 1 USDC a unit to exercise, financing the floor as they do. One without the other is
    // either pure dilution or a pure lottery ticket.
    if (hi !== o)
      return { err: "The two tranches must be equal — the split is 50/50, enforced on-chain." };
    return { hi, o };
  })();
  const conErr = "err" in contributor ? (contributor.err as string) : null;
  const conOk  = conErr ? null : (contributor as Extract<typeof contributor, { hi: bigint }>);

  // This section is authority-only (`address = protocol_state.authority`), and the panel it
  // sits in is founder-only. Those are two different wallets on purpose, so the form was
  // being shown to precisely the wallet that cannot submit it.
  const authorityWallet = protocolState?.authority?.toBase58() ?? null;
  const isAuthority = !!wallet && !!authorityWallet &&
    wallet.publicKey.toBase58() === authorityWallet;

  // ── What close_partner_allocation will decide, decided here first ───────────
  // Every branch below mirrors a line of the instruction. It has to: an operator who is told
  // "closable" and then gets PartnerAllocationNotSettled learns nothing about which of the four
  // conditions failed, and the account has no editor to try again with.
  useEffect(() => {
    const addr = closeWallet.trim();
    setCloseInfo(null); setCloseErr(null);
    if (!addr) return;
    let cancelled = false;
    let wallet: PublicKey;
    try { wallet = new PublicKey(addr); }
    catch { setCloseErr("Not a valid address."); return; }

    (async () => {
      try {
        const provider = new AnchorProvider(connection, wallet as any, {});
        const program  = getProgram(provider);
        const pa: any = await (program.account as any).partnerAllocation
          .fetchNullable(partnerAllocPda(wallet));
        if (cancelled) return;
        if (!pa) { setCloseErr("No partner allocation registered for this wallet."); return; }

        const [streamPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("bribe_stream"), wallet.toBuffer()], PROGRAM_ID
        );
        const stream: any = await (program.account as any).partnerBribeStream
          .fetchNullable(streamPda);
        const lpMint = pa.lpMint as PublicKey;
        const lpBalance = await connection
          .getTokenAccountBalance(partnerLpVaultPda(wallet))
          .then((b) => BigInt(b.value.amount))
          // No LP account at all reads as zero, exactly as the program reads it.
          .catch(() => BigInt(0));
        if (cancelled) return;

        const streamStartTs = Number(pa.streamStartTs.toString());
        const epochsReleased = stream ? Number(stream.epochsReleased.toString()) : 0;
        const epochsTotal    = stream ? Number(stream.epochsTotal.toString()) : 0;
        const lpThreshold    = BigInt(pa.lpThreshold.toString());
        const epoch = Math.floor(Date.now() / 1000 / EPOCH_DURATION_SECS);

        const neverActivated = streamStartTs === 0;
        const bagSettled = Boolean(pa.bagClaimed) || BigInt(pa.baseHiSola.toString()) === BigInt(0);
        const lpReturned = lpBalance === BigInt(0);
        const epochDecided = retainerEpochsEarned(pa, epoch) <= Number(pa.epochsQualified.toString());
        const escrowSpent = !stream || epochsReleased >= epochsTotal;
        const closable = lpReturned && (neverActivated || (bagSettled && epochDecided && escrowSpent));

        const reason = !lpReturned
          ? "the partner's LP is still in the escrow — they withdraw it once the term is over"
          : neverActivated
          ? "no schedule was ever escrowed, so nothing has accrued and nothing is owed"
          : !bagSettled
            ? "the signature bag is still unclaimed, and a schedule stands against it"
            : !escrowSpent
              ? `${epochsTotal - epochsReleased} bribe tranche${epochsTotal - epochsReleased === 1 ? "" : "s"} are still escrowed, and the gauge's voters are owed them`
              : !epochDecided
                ? "epochs the LP covered are not credited yet — crank the partner first"
                : "the bag is settled, the escrow is spent, the LP is back and every epoch is credited";

        setCloseInfo({
          lpMint, lpThreshold, lpBalance,
          baseHiSola: BigInt(pa.baseHiSola.toString()),
          bagClaimed: Boolean(pa.bagClaimed),
          hiSolaClaimed: BigInt(pa.hiSolaClaimed.toString()),
          epochsQualified: Number(pa.epochsQualified.toString()),
          streamStartTs, epochsReleased, epochsTotal, closable, reason,
        });
      } catch (e: any) {
        if (!cancelled) setCloseErr(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [closeWallet, connection]);

  async function closePartnerAllocation() {
    if (!wallet || !closeInfo) return;
    setLoadingClose(true); setStatusClose("");
    try {
      const partnerKey = new PublicKey(closeWallet.trim());
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const ix = await program.methods
        .closePartnerAllocation()
        .accounts({
          authority:         wallet.publicKey,
          protocolState:     statePda,
          partnerWallet:     partnerKey,
          partnerAllocation: partnerAllocPda(partnerKey),
          partnerLpVault:    partnerLpVaultPda(partnerKey),
          bribeStream: PublicKey.findProgramAddressSync(
            [Buffer.from("bribe_stream"), partnerKey.toBuffer()], PROGRAM_ID
          )[0],
        } as any)
        .instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setStatusClose(`✅ Allocation closed — tx: ${tx.slice(0, 16)}… The seeds are free: register this wallet again for a fresh deal.`);
      setCloseWallet("");
    } catch (e: any) {
      setStatusClose(`❌ ${e?.message ?? e}`);
    } finally {
      setLoadingClose(false);
    }
  }

  // ── Fetch all vesting + position data ───────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!wallet || !isFounder) return;
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);

      const [hiV, oV, pos, hiBal, lock, floorBal, slot] = await Promise.allSettled([
        (program.account as any).founderHiSolaVesting.fetch(founderHiVestingPda),
        (program.account as any).founderVesting.fetch(founderVestingPda),
        (program.account as any).userPosition.fetchNullable(positionPda(wallet.publicKey)),
        // hiSOLA is a position, not a token — reading an ATA here would display 0 for
        // everyone, including the founder tranche this panel exists to show.
        readPosition(connection, wallet.publicKey),
        (program.account as any).veLockPosition.fetchNullable(veLockPositionPda(wallet.publicKey)),
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
        setHiSolaBal(Number(hiBal.value.hiSola) / 1e6);
      }
      if (lock.status === "fulfilled" && lock.value) {
        setLockedRaw(Number((lock.value as any).amountLocked.toString()));
      } else {
        setLockedRaw(0);
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

      const ix = await program.methods
        .claimFounderHiSola()
        .accounts({
          founder,
          protocolState:       statePda,
          solaMint:            solaM,
          solaVault:           solaVaultAddr,
          marketVault:         marketVault,
          // Escrow accounts — the wallet never receives the hiSOLA (no ATA involved).
          lockPosition:        veLockPositionPda(founder),
          founderPosition:     positionPda(founder),
          founderHiVesting:    founderHiVestingPda,
          tokenProgram:        commonAccounts.tokenProgram,
          associatedTokenProgram: commonAccounts.associatedTokenProgram,
          systemProgram:       commonAccounts.systemProgram,
        } as any)
        .instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setStatus(`✅ hiSOLA claimed into the lifetime ve escrow (not your wallet — by design) — tx: ${tx.slice(0, 16)}…`);
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
      const ix = await program.methods
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
        .instruction();
      const tx = await sendTx(connection, wallet, [ix]);
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
  // `founder_borrow_usdc` and its 10% `FOUNDER_BORROW_CAP_BPS` were deleted in July 2026:
  // the 7M is ve-escrowed, so the wallet balance is 0 and the instruction's
  // `new_borrowed <= hi_sola_balance` check could never pass. The single remaining valve is
  // `borrow_against_locked` at 20% of `amount_locked` — the same one the contributor and
  // partner panels use, open to any ve-locker.
  // ☢️ 2026-11-09: no unfinanced allocation borrows. `borrow_against_locked` now lends only
  // `min(staked_amount, hi_sola + amount_locked)`, and the 7M were never financed, so the
  // founder's cap is 0. The card stays for repaying any debt taken before the change.
  const borrowCap      = 0;
  const currentDebt    = founderPos?.usdcBorrowed ?? 0;
  const capHeadroom    = Math.max(0, borrowCap - currentDebt);          // raw
  // Actual borrowable = min(cap headroom, floor buffer headroom).
  // This bound used to be the whole `floorVaultBal`, which is the wrong guard: that one is
  // `InsufficientFloorReserve`, and the 75% buffer bites long before the vault runs dry.
  // The buffer headroom is always the smaller of the two, so it supersedes it outright —
  // `floorVaultBal` stays only as the fallback while the protocol state is still loading.
  const floorHeadroomRaw = useFloorHeadroom();
  const floorBound     = floorHeadroomRaw ?? floorVaultBal;
  const borrowAvailRaw = Math.min(capHeadroom, floorBound);
  const borrowAvail    = borrowAvailRaw / 1_000_000;
  const limitedByFloor = floorBound < capHeadroom && capHeadroom > 0;

  async function submitBorrow() {
    if (!wallet || !borrowAmt || !usdcMint) return;
    setLoadingBor(true);
    setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const founder  = wallet.publicKey;

      if (borrowTab === "borrow") {
        const ix = await program.methods
          .borrowAgainstLocked(fromUi(+borrowAmt))
          .accounts({
            partner:                founder,
            protocolState:          statePda,
            lockPosition:           veLockPositionPda(founder),
            floorVault:             floorVault,
            marketVault:            marketVault,
            usdcMint:               usdcMint,
            partnerUsdc:            userAta(usdcMint, founder),
            partnerPosition:        positionPda(founder),
            tokenProgram:           commonAccounts.tokenProgram,
            associatedTokenProgram: commonAccounts.associatedTokenProgram,
            systemProgram:          commonAccounts.systemProgram,
          } as any)
          .instruction();
        const tx = await sendTx(connection, wallet, [ix]);
        setStatus(`✅ Borrowed ${borrowAmt} USDC — tx: ${tx.slice(0, 16)}…`);
      } else {
        // Regular repay_usdc — same PDA, no special auth check
        const ix = await program.methods
          .repayUsdc(fromUi(+borrowAmt))
          .accounts({
            user:          founder,
            protocolState: statePda,
            userPosition:  positionPda(founder),
            floorVault:    floorVault,
            userUsdc:      userAta(usdcMint, founder),
            tokenProgram:  commonAccounts.tokenProgram,
          } as any)
          .instruction();
        const tx = await sendTx(connection, wallet, [ix]);
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

  // ── Register contributor (authority-only) ────────────────────────────────

  async function registerContributor() {
    if (!wallet) return;
    setLoadingCon(true); setStatusCon("");
    try {
      if (conErr || !conOk) { setStatusCon(`❌ ${conErr}`); return; }
      let contributorKey: PublicKey;
      try { contributorKey = new PublicKey(conWallet.trim()); }
      catch { setStatusCon("❌ That is not a valid Solana address."); return; }

      const vestingPda = contributorVestingPda(contributorKey);
      // `init`, so a second registration for the same wallet fails on-chain. Say so here
      // rather than let it come back as a raw account-already-in-use error.
      const existing = await connection.getAccountInfo(vestingPda);
      if (existing) {
        setStatusCon(`⚠️ ${conWallet.slice(0, 8)}… is already registered. There is no editor: close nothing, this is final.`);
        return;
      }

      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const ix = await program.methods
        .registerContributor(
          new BN(conOk.hi.toString()),
          new BN(conOk.o.toString())
        )
        .accounts({
          authority:           wallet.publicKey,
          protocolState:       statePda,
          contributorWallet:   contributorKey,
          contributorVesting:  vestingPda,
          contributorRegistry: contributorRegistryPda,
          systemProgram:       SystemProgram.programId,
          rent:                SYSVAR_RENT_PUBKEY,
        } as any)
        .instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setStatusCon(`✅ Contributor registered — tx: ${tx.slice(0, 16)}…`);
      setConWallet("");
    } catch (e: any) {
      setStatusCon(`❌ ${e?.message ?? e}`);
    } finally {
      setLoadingCon(false);
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

  // Two roles reach this panel, and they are different wallets by design: the founder owns
  // the vesting and borrow sections, the authority owns Register Partner. Gating the whole
  // panel on the founder meant the authority saw nothing at all — not even the one section
  // it is the only wallet allowed to use.
  if (!isFounder && !isAuthority) {
    return (
      <div className="card text-center py-12">
        <div className="text-4xl mb-4">🔒</div>
        <p className="text-gray-400 text-sm">Founder or authority access only.</p>
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
          <span className="text-2xl">{isFounder ? "👑" : "🛠"}</span>
          <h2 className="text-xl font-black text-white">
            {isFounder ? "Founder Panel" : "Authority Panel"}
          </h2>
        </div>
        <p className="text-xs text-gray-500">
          {isFounder ? (
            <>Private — only visible to wallet <span className="font-mono text-gray-400">{founderWallet ? `${founderWallet.slice(0, 8)}…` : "—"}</span></>
          ) : (
            <>Connected as the protocol <strong>authority</strong> <span className="font-mono text-gray-400">{authorityWallet ? `${authorityWallet.slice(0, 8)}…` : "—"}</span>. The founder vesting sections belong to a different wallet and are hidden.</>
          )}
        </p>
      </div>

      {!isFounder ? null : !vestingStarted ? (
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
                cliffSecs={O_SOLA_CLIFF_SECS}
                durationSecs={O_SOLA_DURATION_SECS}
                nowSecs={nowSecs}
                marketCapRaw={oSolaMarketCapRaw}
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
              <span className="ml-2 text-xs font-normal text-gray-500">(repay only — allocations are not borrowable)</span>
            </h3>

            {/* Cap info banner */}
            <div className="flex items-start gap-2 text-xs text-gray-500 bg-brand-dark border border-brand-border rounded-lg px-3 py-2 mb-3">
              <span className="text-brand-green text-base leading-none shrink-0">ℹ</span>
              <span>
                Cap: <span className="text-white font-mono font-semibold">{fmtSola(borrowCap)} USDC</span>
                {" "}(the 7M were never financed, so they back no loan) ·{" "}
                Debt: <span className="text-yellow-400 font-mono">{fmtSola(currentDebt)} USDC</span> ·{" "}
                Available: <span className="text-brand-green font-mono font-semibold">{borrowAvail.toFixed(4)} USDC</span>
              </span>
            </div>
            {limitedByFloor && (
              <div className="flex items-start gap-2 text-xs bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 mb-3">
                <span className="text-yellow-400 text-base leading-none shrink-0">⚠</span>
                <span className="text-yellow-300">
                  The protocol&apos;s 75% floor buffer ({fmtSola(floorBound)} USDC left before the
                  floor vault reaches 75% of floor-backed supply) is lower than your 20% cap.
                  That budget is shared by every borrower; repayments and SOLA purchases grow
                  it back.
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

      {/* ── Register Contributor ─────────────────────────────── */}
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <span className="text-2xl">🧑‍💻</span>
          <div>
            <h3 className="text-base font-bold text-white">Register Contributor</h3>
            <p className="text-xs text-gray-500">
              Authority-only · both tranches claimable in full, immediately
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 block">
              Contributor wallet
            </label>
            <input
              className="w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green"
              type="text"
              placeholder="Solana wallet address"
              value={conWallet}
              onChange={(e) => setConWallet(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 block">
                hiSOLA (locked for life)
              </label>
              <input
                className="w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green"
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={conHiSola}
                onChange={(e) => {
                  if (e.target.value === "" || /^\d*\.?\d*$/.test(e.target.value))
                    setConHiSola(e.target.value);
                }}
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 block">
                oSOLA (an option)
              </label>
              <input
                className="w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green"
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={conOSola}
                onChange={(e) => {
                  if (e.target.value === "" || /^\d*\.?\d*$/.test(e.target.value))
                    setConOSola(e.target.value);
                }}
              />
            </div>
          </div>

          {conErr && conWallet.trim() !== "" && (
            <p className="text-[11px] text-red-400">❌ {conErr}</p>
          )}

          {conOk && (
            <div className="rounded-xl border border-brand-border bg-brand-dark/60 px-3 py-3 flex flex-col gap-2.5">
              <p className="text-[10px] text-gray-500 uppercase tracking-widest">
                This allocation, once signed · immutable
              </p>

              {/* The two tranches are different instruments, and conflating them is the
                  mistake this block exists to prevent. */}
              {conOk.hi > BigInt(0) && (
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-gray-300 leading-relaxed">
                    <span className="font-mono text-white">{fromBaseUnits(conOk.hi, 6)}</span>{" "}
                    hiSOLA, claimable in full straight away and landing in a{" "}
                    <strong className="text-white">lifetime</strong> ve lock.
                  </p>
                  <p className="text-[11px] text-gray-500 leading-relaxed">
                    It can never be unlocked or sold — <span className="font-mono">unlock_hi_sola</span>{" "}
                    releases nothing of it, at any date. In exchange it works for them
                    permanently: it votes forever (up to 4×), borrows up to{" "}
                    <span className="font-mono text-gray-300">
                      {fromBaseUnits(conOk.hi / BigInt(5), 6)} USDC
                    </span>{" "}
                    (20%), and <strong className="text-white">earns protocol fees for life</strong>{" "}
                    on the full {fromBaseUnits(conOk.hi, 6)}, claimable from the Portfolio like
                    any staker&apos;s.
                  </p>
                  <p className="text-[11px] text-gray-500 leading-relaxed">
                    That yield is the real compensation — the bag itself can never be sold, so
                    without it the tranche would pay nothing at all. The share is not printed:
                    it joins <span className="font-mono">total_hi_sola</span>, so every other
                    holder is diluted by exactly what the contributor receives.
                  </p>
                </div>
              )}

              {conOk.o > BigInt(0) && (
                <div className="flex flex-col gap-1 border-t border-brand-border pt-2">
                  <p className="text-xs text-gray-300 leading-relaxed">
                    <span className="font-mono text-white">{fromBaseUnits(conOk.o, 6)}</span>{" "}
                    oSOLA — an <strong className="text-white">option</strong>, not a payment.
                  </p>
                  <p className="text-[11px] text-amber-400/90 leading-relaxed">
                    ⚠️ It is the right to buy {fromBaseUnits(conOk.o, 6)} SOLA at 1 USDC each.
                    Taking all of it costs the contributor{" "}
                    <span className="font-mono text-white">
                      {fromBaseUnits(conOk.o, 6)} USDC
                    </span>{" "}
                    of their own money, paid into the floor. At or below the 1 USDC floor it is
                    worth <strong>nothing</strong>; above it the gain is (price − 1) per unit,
                    less the exercise fee charged on that gain.
                  </p>
                  <p className="text-[11px] text-gray-500 leading-relaxed">
                    That is also why it is safe to grant: every unit exercised puts 1 USDC in the
                    floor, so unlike the hiSOLA tranche this side finances the SOLA it creates.
                    Note it is <strong>not</strong> drawn from the 1.75M ecosystem budget —
                    <span className="font-mono"> ECOSYSTEM_TOTAL</span> caps{" "}
                    <span className="font-mono">distribute_o_sola</span> only, so the figure
                    above is bounded by nothing but this form.
                  </p>
                </div>
              )}

              <div className="border-t border-brand-border pt-2 flex flex-col gap-0.5">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-0.5">
                  Stored values
                </p>
                {([
                  ["hi_sola_amount", conOk.hi.toString()],
                  ["o_sola_amount", conOk.o.toString()],
                ] as const).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 text-[11px]">
                    <span className="text-gray-500 font-mono">{k}</span>
                    <span className="text-gray-300 font-mono break-all text-right">{v}</span>
                  </div>
                ))}
                <p className="text-[10px] text-gray-600 mt-1">
                  There is no vesting and no editor. Both tranches are claimable the moment this
                  is signed, and the amounts can never be changed.
                </p>
              </div>
            </div>
          )}

          {!isAuthority && (
            <p className="text-[11px] text-amber-400/90 leading-relaxed">
              ⚠️ Signed by the protocol <strong>authority</strong>, a different wallet from the
              founder. Connect the authority wallet to register a contributor.
            </p>
          )}

          <button
            className="btn-primary w-full"
            onClick={registerContributor}
            disabled={loadingCon || !isAuthority || !conWallet.trim() || !conOk}
          >
            {loadingCon ? "Processing…"
              : !isAuthority ? "Authority wallet required"
              : !conOk ? "Enter an allocation above"
              : "Register Contributor"}
          </button>

          {statusCon && <p className="text-xs text-gray-400 break-all">{statusCon}</p>}
        </div>
      </div>

      {/* ── Register Partner — three figures (2026-11-09) ── */}
      <PartnerDealForm isAuthority={isAuthority} />

      {/* ── Close Partner Allocation ─────────────────────────── */}
      {/* `register_partner` has no editor and no undo, so the only way to correct a mistyped
          deal is to close it and register again. That has to live next to the form that made
          the mistake — otherwise the correction is a script, and a typo becomes permanent for
          whoever does not have one. */}
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <span className="text-2xl">🧹</span>
          <div>
            <h3 className="text-base font-bold text-white">Close a Partner Allocation</h3>
            <p className="text-xs text-gray-500">
              Authority-only · correct a mistyped deal, or tidy one that has ended
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 block">
              Partner wallet
            </label>
            <input
              className="w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green"
              type="text"
              placeholder="Wallet whose allocation to close"
              value={closeWallet}
              onChange={(e) => setCloseWallet(e.target.value)}
            />
          </div>

          {closeErr && <p className="text-[11px] text-red-400">❌ {closeErr}</p>}

          {closeInfo && (
            <div className="rounded-xl border border-brand-border bg-brand-dark/60 px-3 py-3 flex flex-col gap-2">
              <p className="text-[10px] text-gray-500 uppercase tracking-widest">
                What this account holds
              </p>
              <div className="flex flex-col gap-0.5 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-gray-500">Signature bag</span>
                  <span className="text-gray-300 font-mono">
                    {fromBaseUnits(closeInfo.baseHiSola, 6)} hiSOLA ·{" "}
                    {closeInfo.bagClaimed ? "claimed" : "unclaimed"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Retainer credited</span>
                  <span className="text-gray-300 font-mono">
                    {fromBaseUnits(closeInfo.hiSolaClaimed, 6)} hiSOLA over{" "}
                    {closeInfo.epochsQualified} epoch
                    {closeInfo.epochsQualified === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Bribe schedule</span>
                  <span className="text-gray-300 font-mono">
                    {closeInfo.streamStartTs === 0
                      ? "never escrowed"
                      : `${closeInfo.epochsReleased} / ${closeInfo.epochsTotal} released`}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">LP in escrow vs required</span>
                  <span className="text-gray-300 font-mono break-all text-right">
                    {closeInfo.lpBalance.toString()} / {closeInfo.lpThreshold.toString()}
                  </span>
                </div>
              </div>

              {closeInfo.closable ? (
                <p className="text-[11px] text-brand-green leading-relaxed">
                  ✅ Closable — {closeInfo.reason}. Everything already credited stays exactly
                  where it is: the ve lock and the fee share are separate accounts and nothing
                  is burned here. Re-registering this wallet afterwards is a{" "}
                  <strong>fresh deal, with a fresh bag</strong>.
                </p>
              ) : (
                <p className="text-[11px] text-amber-400/90 leading-relaxed">
                  ⛔ Not closable — {closeInfo.reason}. This is the guarantee the partner is
                  sold: the authority cannot delete what they have already earned, or what they
                  can still earn this epoch.
                </p>
              )}
            </div>
          )}

          {!isAuthority && (
            <p className="text-[11px] text-amber-400/90 leading-relaxed">
              ⚠️ Signed by the protocol <strong>authority</strong>, a different wallet from the
              founder. Connect the authority wallet to close an allocation.
            </p>
          )}

          <button
            className="btn-primary w-full"
            onClick={closePartnerAllocation}
            disabled={loadingClose || !isAuthority || !closeInfo || !closeInfo.closable}
          >
            {loadingClose ? "Processing…"
              : !isAuthority ? "Authority wallet required"
              : !closeInfo ? "Enter a registered partner wallet"
              : !closeInfo.closable ? "This allocation is live"
              : "Close allocation & reclaim rent"}
          </button>

          {statusClose && (
            <p className="text-xs text-gray-400 break-all">{statusClose}</p>
          )}
        </div>
      </div>

      {/* ── Status ──────────────────────────────────────────── */}
      {status && (
        <p className="text-xs text-gray-400 break-all px-1">{status}</p>
      )}
    </div>
  );
}
