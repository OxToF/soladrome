// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
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
import { useSoladrome } from "@/lib/SoladromeContext";
import { PROGRAM_ID } from "@/lib/program";


// ── Partner registration ──────────────────────────────────────────────────────
const PARTNER_SEED        = Buffer.from("partner");
// One binary since 2026-08-23, so this is 604 800 on every cluster — there is no longer a
// devnet variant of EPOCH_DURATION to qualify this with.
const EPOCH_DURATION_SECS = 604_800; // state.rs: EPOCH_DURATION
// state.rs: MAX_LOCK_DURATION = 208 * EPOCH_DURATION. The form used to say 104.
const MAX_LOCK_EPOCHS = 208;

function partnerAllocPda(partnerWallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PARTNER_SEED, partnerWallet.toBuffer()],
    PROGRAM_ID
  )[0];
}

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

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

// ── Vesting constants — must match state.rs ──────────────────────────────────
// One set of values, for every cluster. These read 6 h / 24 h until 2026-08-23, mirroring
// the `devnet` feature the program no longer has; the "flip these before launch" note they
// carried is exactly the kind of manual step that gets forgotten. The program's constants are
// now unconditional, so these are too.
const VESTING_CLIFF_SECS    = 180 * 24 * 3_600; // 6 months
const VESTING_DURATION_SECS = 720 * 24 * 3_600; // 24 months, linear after the cliff

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
}) {
  const elapsed      = Math.max(0, nowSecs - startTs);
  const afterCliff   = elapsed >= cliffSecs;
  const vestedRaw    = afterCliff
    ? Math.floor((totalRaw * Math.min(elapsed, durationSecs)) / durationSecs)
    : 0;
  const claimableRaw = Math.max(0, vestedRaw - claimedRaw);
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

  // ── Register partner form ───────────────────────────────────────────────────
  // `register_partner` takes SIX arguments, not two. The form used to collect the welcome
  // bag and the lock only, and passed those two to a six-argument method — Anchor then read
  // the accounts object as a positional argument and reported "Account `authority` not
  // provided", which points at the wrong thing entirely. All six are collected now.
  const [regWallet,    setRegWallet]    = useState("");
  const [regBribeMint, setRegBribeMint] = useState("");
  // The deal in the terms it is actually negotiated in: the partner commits N bribe tokens,
  // and those bribes earn them up to M hiSOLA. `rate_num`/`rate_den` are DERIVED from that
  // pair — see below. They used to be typed by hand, which is what put decimals on screen.
  const [regCommit,    setRegCommit]    = useState("1000000");
  const [regCap,       setRegCap]       = useState("1000000");
  const [regAmount,    setRegAmount]    = useState("100000");
  const [regEpochs,    setRegEpochs]    = useState("52");
  // The bribe rhythm, agreed with the partner and written at registration. The partner can no
  // longer pick it at funding time — fund_partner_bribe_stream refuses any other length.
  const [regSchedule,  setRegSchedule]  = useState("52");
  const [loadingReg,   setLoadingReg]   = useState(false);
  const [statusReg,    setStatusReg]    = useState("");

  // This section is authority-only (`address = protocol_state.authority`), and the panel it
  // sits in is founder-only. Those are two different wallets on purpose, so the form was
  // being shown to precisely the wallet that cannot submit it.
  const authorityWallet = protocolState?.authority?.toBase58() ?? null;
  const isAuthority = !!wallet && !!authorityWallet &&
    wallet.publicKey.toBase58() === authorityWallet;

  // ── The rate is derived, never typed ────────────────────────────────────────
  // `partner_deposit_bribe` credits `total_bribed_credited += amount` in the BRIBE MINT's
  // base units, and `claim_partner_allocation` turns that into hiSOLA base units (6 dec) with
  // `× rate_num / rate_den`. The decimal gap therefore lands entirely inside the rate:
  //
  //     hiSOLA per 1 whole bribe token = 10^(decimals − 6) × num/den
  //
  // Asking an operator to type num/den means asking them to hold that exponent in their head
  // against whatever decimals the mint happens to have — 1/1 looks 1:1 and pays 1000× on a
  // 9-decimal mint like wSOL. So the form no longer asks. It takes the two figures the deal
  // is actually written in — tokens committed, hiSOLA earned — and reduces them to num/den.
  const [bribeDecimals, setBribeDecimals] = useState<number | null>(null);
  const [bribeMintErr,  setBribeMintErr]  = useState<string | null>(null);

  useEffect(() => {
    const raw = regBribeMint.trim();
    if (!raw) { setBribeDecimals(null); setBribeMintErr(null); return; }
    let cancelled = false;
    let key: PublicKey;
    try { key = new PublicKey(raw); }
    catch { setBribeDecimals(null); setBribeMintErr("Not a valid address."); return; }
    setBribeMintErr(null);
    connection.getParsedAccountInfo(key)
      .then((res) => {
        if (cancelled) return;
        const parsed: any = res.value?.data;
        const dec = parsed?.parsed?.info?.decimals;
        if (typeof dec === "number") { setBribeDecimals(dec); setBribeMintErr(null); }
        else { setBribeDecimals(null); setBribeMintErr("That address is not an SPL mint."); }
      })
      .catch(() => { if (!cancelled) { setBribeDecimals(null); setBribeMintErr("Could not read the mint."); } });
    return () => { cancelled = true; };
  }, [regBribeMint, connection]);

  // ── Everything the instruction will write, derived exactly from what was typed ──────
  // One object, so the summary block and the submit handler can never disagree about what
  // is going on-chain. `err` is the single place a bad input is named.
  // Split in two on purpose. The hiSOLA side of the deal — cap, welcome bag, lock term, and
  // therefore the permanent-vs-releasable split that is the whole floor exposure — is fixed in
  // 6-decimal hiSOLA and owes the bribe mint nothing. Gating all of it behind the mint left the
  // panel looking unchanged until an address was pasted, which is exactly the moment an
  // operator is still deciding the terms.
  const terms = (() => {
    const capBase  = toBaseUnits(regCap, 6);
    const baseBase = toBaseUnits(regAmount, 6);
    const epochs   = /^\d+$/.test(regEpochs.trim()) ? parseInt(regEpochs, 10) : NaN;

    if (capBase === null)  return { err: "Cap must be a plain amount, at most 6 decimals." };
    if (baseBase === null) return { err: "Welcome bag must be a plain amount, at most 6 decimals." };
    if (capBase <= BigInt(0)) return { err: "Cap must be greater than 0." };
    if (capBase > U64_MAX || baseBase > U64_MAX)
      return { err: "Amount too large for u64." };
    if (!Number.isFinite(epochs) || epochs < 1 || epochs > MAX_LOCK_EPOCHS)
      return { err: `Lock must be between 1 and ${MAX_LOCK_EPOCHS} epochs.` };
    const schedule = /^\d+$/.test(regSchedule.trim()) ? parseInt(regSchedule, 10) : NaN;
    if (!Number.isFinite(schedule) || schedule < 1 || schedule > MAX_LOCK_EPOCHS)
      return { err: `Bribe schedule must be between 1 and ${MAX_LOCK_EPOCHS} epochs.` };
    return { capBase, baseBase, epochs, schedule, lockSecs: epochs * EPOCH_DURATION_SECS };
  })();
  const termsErr = "err" in terms ? (terms.err as string) : null;
  const termsOk  = termsErr ? null : (terms as Extract<typeof terms, { capBase: bigint }>);

  const deal = (() => {
    if (!termsOk) return { err: termsErr as string };
    const { capBase, baseBase, epochs } = termsOk;
    if (bribeDecimals === null) return { pending: true as const };

    const commitBase = toBaseUnits(regCommit, bribeDecimals);
    if (commitBase === null)
      return { err: `Commitment must be a plain amount, at most ${bribeDecimals} decimals — that is all this mint has.` };
    if (commitBase <= BigInt(0)) return { err: "Commitment must be greater than 0." };

    // rate = cap / commitment, reduced. At exactly `commitBase` bribed the program computes
    // commitBase × num / den = capBase with no remainder, so the cap lands on the committed
    // amount to the base unit — which is the property the operator is really buying here.
    const g   = gcd(capBase, commitBase);
    const num = capBase / g;
    const den = commitBase / g;
    if (num > U64_MAX || den > U64_MAX)
      return { err: "That ratio does not fit in u64. Round the commitment or the cap." };

    // hiSOLA base units credited by one whole bribe token — exact when it divides evenly.
    const perTokenBase = (BigInt(10) ** BigInt(bribeDecimals) * num) / den;
    const perTokenExact =
      (BigInt(10) ** BigInt(bribeDecimals) * num) % den === BigInt(0);

    return {
      capBase, baseBase, commitBase, num, den, epochs, perTokenBase, perTokenExact,
      lockSecs: epochs * EPOCH_DURATION_SECS,
    };
  })();
  const dealErr     = "err" in deal ? (deal.err as string) : null;
  const dealPending = "pending" in deal;
  const dealOk      = !dealErr && !dealPending
    ? (deal as Extract<typeof deal, { num: bigint }>)
    : null;

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

      // Auto-migrate if UserPosition is on old 128-byte layout
      const posInfo = await connection.getAccountInfo(positionPda(founder));
      if (posInfo && posInfo.data.length < 136) {
        setStatus("⚙️ Migrating position account…");
        const migIx = await program.methods.migrateUserPosition()
          .accounts({ user: founder, userPosition: positionPda(founder), systemProgram: SystemProgram.programId } as any)
          .instruction();
        await sendTx(connection, wallet, [migIx]);
      }

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
  const borrowCap      = Math.floor(lockedRaw * 0.20);
  const currentDebt    = founderPos?.usdcBorrowed ?? 0;
  const capHeadroom    = Math.max(0, borrowCap - currentDebt);          // raw
  // Actual borrowable = min(cap headroom, floor vault liquidity)
  const borrowAvailRaw = Math.min(capHeadroom, floorVaultBal);
  const borrowAvail    = borrowAvailRaw / 1_000_000;
  const limitedByFloor = floorVaultBal < capHeadroom && capHeadroom > 0;

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

  // ── Register partner (authority-only) ────────────────────────────────────

  async function registerPartner() {
    if (!wallet) return;
    setLoadingReg(true); setStatusReg("");
    try {
      // Every figure comes from the same derivation the summary block renders, so what is
      // signed is exactly what was read on screen. No second parse, no second rounding.
      if (dealErr || !dealOk) {
        setStatusReg(`❌ ${dealErr ?? "Waiting for the bribe mint."}`);
        return;
      }
      const partnerKey = new PublicKey(regWallet.trim());
      const bribeMint  = new PublicKey(regBribeMint.trim());
      const rateNumBN  = new BN(dealOk.num.toString());
      const rateDenBN  = new BN(dealOk.den.toString());
      const capBN      = new BN(dealOk.capBase.toString());
      const baseBN     = new BN(dealOk.baseBase.toString());
      const lockBN     = new BN(dealOk.lockSecs);
      const schedBN    = new BN(termsOk!.schedule);
      const allocPda   = partnerAllocPda(partnerKey);

      // Guard: already registered?
      const existing = await connection.getAccountInfo(allocPda);
      if (existing) {
        setStatusReg(`⚠️ ${regWallet.slice(0, 8)}… is already registered.`);
        return;
      }

      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);

      const ix = await program.methods
        .registerPartner(bribeMint, rateNumBN, rateDenBN, capBN, baseBN, lockBN, schedBN)
        .accounts({
          authority:         wallet.publicKey,
          protocolState:     statePda,
          partnerWallet:     partnerKey,
          partnerAllocation: allocPda,
          systemProgram:     SystemProgram.programId,
          rent:              SYSVAR_RENT_PUBKEY,
        } as any)
        .instruction();
      const tx = await sendTx(connection, wallet, [ix]);

      setStatusReg(`✅ Partner registered — tx: ${tx.slice(0, 16)}…`);
      setRegWallet("");
    } catch (e: any) {
      setStatusReg(`❌ ${e?.message ?? e}`);
    } finally {
      setLoadingReg(false);
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
                cliffSecs={VESTING_CLIFF_SECS}
                durationSecs={VESTING_DURATION_SECS}
                nowSecs={nowSecs}
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
              <span className="ml-2 text-xs font-normal text-gray-500">(capped at 20% of locked hiSOLA)</span>
            </h3>

            {/* Cap info banner */}
            <div className="flex items-start gap-2 text-xs text-gray-500 bg-brand-dark border border-brand-border rounded-lg px-3 py-2 mb-3">
              <span className="text-brand-green text-base leading-none shrink-0">ℹ</span>
              <span>
                Cap: <span className="text-white font-mono font-semibold">{fmtSola(borrowCap)} USDC</span>
                {" "}(20% × {fmtSola(lockedRaw)} hiSOLA locked) ·{" "}
                Debt: <span className="text-yellow-400 font-mono">{fmtSola(currentDebt)} USDC</span> ·{" "}
                Available: <span className="text-brand-green font-mono font-semibold">{borrowAvail.toFixed(4)} USDC</span>
              </span>
            </div>
            {limitedByFloor && (
              <div className="flex items-start gap-2 text-xs bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 mb-3">
                <span className="text-yellow-400 text-base leading-none shrink-0">⚠</span>
                <span className="text-yellow-300">
                  Floor vault liquidity ({fmtSola(floorVaultBal)} USDC) is lower than your cap.
                  Available borrow is limited to floor vault balance.
                  More SOLA purchases will increase this limit.
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

      {/* ── Register Partner ────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center gap-3 mb-4">
          <span className="text-2xl">🤝</span>
          <div>
            <h3 className="text-base font-bold text-white">Register Protocol Partner</h3>
            <p className="text-xs text-gray-500">Authority-only · hiSOLA locked directly in governance vault</p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {/* Partner wallet */}
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 block">
              Partner wallet
            </label>
            <input
              className="w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green"
              type="text"
              placeholder="Solana wallet address"
              value={regWallet}
              onChange={(e) => setRegWallet(e.target.value)}
            />
          </div>

          {/* Bribe mint */}
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 block">
              Bribe mint
            </label>
            <input
              className="w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green"
              type="text"
              placeholder="Mint the partner will pay bribes in"
              value={regBribeMint}
              onChange={(e) => setRegBribeMint(e.target.value)}
            />
          </div>

          {/* ── The deal, in the terms it is negotiated in ──────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 block">
                Partner commits (bribe tokens)
              </label>
              <input
                className="w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green"
                type="text"
                inputMode="decimal"
                placeholder="1000000"
                value={regCommit}
                onChange={(e) => {
                  if (e.target.value === "" || /^\d*\.?\d*$/.test(e.target.value))
                    setRegCommit(e.target.value);
                }}
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 block">
                Which earns (hiSOLA)
              </label>
              <input
                className="w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green"
                type="text"
                inputMode="decimal"
                placeholder="1000000"
                value={regCap}
                onChange={(e) => {
                  if (e.target.value === "" || /^\d*\.?\d*$/.test(e.target.value))
                    setRegCap(e.target.value);
                }}
              />
            </div>
          </div>

          {/* Welcome bag + Epochs row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 block">
                Welcome bag (hiSOLA)
              </label>
              <input
                className="w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green"
                type="text"
                inputMode="decimal"
                placeholder="100000"
                value={regAmount}
                onChange={(e) => {
                  if (e.target.value === "" || /^\d*\.?\d*$/.test(e.target.value))
                    setRegAmount(e.target.value);
                }}
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 block">
                Lock (epochs)
              </label>
              <input
                className="w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green"
                type="text"
                inputMode="numeric"
                placeholder="52"
                value={regEpochs}
                onChange={(e) => {
                  if (e.target.value === "" || /^\d+$/.test(e.target.value))
                    setRegEpochs(e.target.value);
                }}
              />
            </div>
          </div>

          {/* ── The bribe rhythm ────────────────────────────────────────────────
              Nothing on-chain paces a bribe by itself: partner_deposit_bribe credits a
              lifetime cumulative counter. This is the field that turns the commitment into a
              schedule, and it is written here rather than chosen by the partner at funding
              time, because it is a term of the agreement. */}
          <div>
            <label className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 block">
              Bribes spread over
            </label>
            <div className="flex gap-2 mb-2">
              {([["6 months", 26], ["1 year", 52], ["2 years", 104]] as const).map(
                ([label, n]) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setRegSchedule(String(n))}
                    className={`flex-1 rounded-xl border px-3 py-2 text-xs transition-colors ${
                      regSchedule === String(n)
                        ? "border-brand-green text-white bg-brand-green/10"
                        : "border-brand-border text-gray-400 hover:border-gray-600"
                    }`}
                  >
                    {label}
                    <span className="block text-[10px] text-gray-500">{n} epochs</span>
                  </button>
                )
              )}
            </div>
            <input
              className="w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green"
              type="text"
              inputMode="numeric"
              placeholder="52"
              value={regSchedule}
              onChange={(e) => {
                if (e.target.value === "" || /^\d+$/.test(e.target.value))
                  setRegSchedule(e.target.value);
              }}
            />
          </div>

          {/* Info line */}
          <p className="text-[10px] text-gray-500">
            1 epoch = 7 days · 52 epochs ≈ 12 months · max {MAX_LOCK_EPOCHS} epochs (≈ 4 years)
          </p>
          <p className="text-[10px] text-gray-500">
            Welcome bag streams into the partner&apos;s vote-locked position over 6 months.
            The commitment pair above bounds what their bribes can additionally earn — enter
            whole tokens, the decimals of each mint are handled for you.
          </p>

          {/* ── What will be written on-chain ──────────────────────────────────
              register_partner has no editor and no undo, so the deal is restated in plain
              language and then in the exact integers that go into the account. Anything
              unreadable here is a figure nobody can fix later. */}
          {bribeMintErr && (
            <p className="text-[11px] text-red-400">❌ {bribeMintErr}</p>
          )}
          {dealErr && (
            <p className="text-[11px] text-red-400">❌ {dealErr}</p>
          )}

          {termsOk && (
            <div className="rounded-xl border border-brand-border bg-brand-dark/60 px-3 py-3 flex flex-col gap-2.5">
              <p className="text-[10px] text-gray-500 uppercase tracking-widest">
                This deal, once signed · immutable
              </p>

              <ul className="text-xs text-gray-300 leading-relaxed flex flex-col gap-1">
                {!dealOk || bribeDecimals === null ? (
                  <li className="text-gray-500">
                    Enter the bribe mint to price the commitment — its decimals decide the
                    rate. Everything below is already fixed by the figures above.
                  </li>
                ) : (
                <>
                <li>
                  Partner bribes{" "}
                  <span className="font-mono text-white">
                    {fromBaseUnits(dealOk.commitBase, bribeDecimals)}
                  </span>{" "}
                  tokens <strong className="text-white">in total, ever</strong> — and earns{" "}
                  <span className="font-mono text-white">
                    {fromBaseUnits(dealOk.capBase, 6)}
                  </span>{" "}
                  hiSOLA for it, reached to the base unit.
                </li>
                <li>
                  Each{" "}
                  <span className="font-mono text-white">1</span> token bribed credits{" "}
                  <span className="font-mono text-white">
                    {fromBaseUnits(dealOk.perTokenBase, 6)}
                  </span>{" "}
                  hiSOLA{dealOk.perTokenExact ? "" : " (rounded down per claim)"}.
                </li>
                <li>
                  Plus a welcome bag of{" "}
                  <span className="font-mono text-white">
                    {fromBaseUnits(dealOk.baseBase, 6)}
                  </span>{" "}
                  hiSOLA, streaming over 6 months whether they bribe or not.
                </li>
                </>
                )}
              </ul>

              {termsOk && (
                <p className="text-xs text-gray-300 leading-relaxed">
                  Bribes are escrowed once and paid out over{" "}
                  <span className="font-mono text-white">{termsOk.schedule}</span> epochs
                  {" "}(≈ {Math.round((termsOk.schedule * 7) / 30.4)} months)
                  {dealOk && bribeDecimals !== null && (
                    <>
                      {" "}—{" "}
                      <span className="font-mono text-white">
                        {fromBaseUnits(
                          dealOk.commitBase / BigInt(termsOk.schedule),
                          bribeDecimals
                        )}
                      </span>{" "}
                      per epoch, released to that gauge&apos;s voters one epoch at a time
                    </>
                  )}
                  . The partner escrows the whole schedule in one signature and has nothing
                  further to sign.
                </p>
              )}

              {/* ── What the schedule does and does not bind ─────────────────────
                  The escrow paces the committed amount. It does not stop the partner bribing
                  MORE on top through partner_deposit_bribe, and it does not make the cap
                  time-bounded: total_bribed_credited stays a lifetime counter. */}
              <p className="text-[11px] text-gray-500 leading-relaxed">
                The escrow paces the committed amount and cannot be withdrawn or retimed once
                running. It does not stop the partner bribing more on top — extra bribes still
                credit the allocation, up to the cap.
              </p>

              {/* ── The rate is frozen ───────────────────────────────────────────
                  There is no oracle anywhere in the partner path. rate_num/rate_den is a
                  fixed base-unit ratio, so whatever USD equivalence justified it today is
                  frozen for the life of the deal. */}
              <p className="text-[11px] text-amber-400/90 leading-relaxed">
                🔒 The rate is <strong>final</strong>. There is no oracle: hiSOLA is not priced
                at floor, nor in USDC, nor re-quoted later. Whatever this ratio is worth today
                is what it stays worth, for {termsOk.epochs} epochs and beyond.
              </p>

              {/* ── Which half comes back out ────────────────────────────────────
                  permanent_amount = the bag only; unlock_hi_sola releases
                  amount_locked − permanent_amount. Released hiSOLA can be unstaked and sold
                  1:1 against a floor it never financed, so the releasable figure is the
                  exposure this form actually writes. */}
              <div className="border-t border-brand-border pt-2 flex flex-col gap-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-gray-500">Permanent · never unlockable</span>
                  <span className="text-gray-300 font-mono">
                    {fromBaseUnits(termsOk.baseBase, 6)} hiSOLA
                  </span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-gray-500">
                    Releasable after {termsOk.epochs} epochs
                    {" "}({(termsOk.lockSecs / 86_400).toLocaleString("en-US")} days)
                  </span>
                  <span className="text-white font-mono">
                    {fromBaseUnits(termsOk.capBase, 6)} hiSOLA
                  </span>
                </div>
                {termsOk.capBase > termsOk.baseBase && (
                  <p className="text-[11px] text-amber-400/90 leading-relaxed mt-0.5">
                    ⚠️ The releasable tranche is{" "}
                    <span className="font-mono">
                      {termsOk.baseBase === BigInt(0)
                        ? "all"
                        : `${(Number((termsOk.capBase * BigInt(100)) / termsOk.baseBase) / 100)
                            .toLocaleString("en-US", { maximumFractionDigits: 1 })}×`}
                    </span>{" "}
                    {termsOk.baseBase === BigInt(0) ? "of it — there is no permanent bag at all" : "the permanent one"}. Once unlocked it can be unstaked and sold at the 1 USDC
                    floor, which no bribe ever funded — so this line is the floor exposure this
                    deal creates. Raising the welcome bag or lowering the cap is what shrinks it.
                  </p>
                )}
              </div>

              {/* The raw u64s. Present because this is the row that will sit in the account
                  for the life of the partnership, and because a mismatch between this and
                  the sentences above is the one thing worth catching before signing. */}
              <div className="border-t border-brand-border pt-2 flex flex-col gap-0.5">
                <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-0.5">
                  Stored values
                </p>
                {!dealOk ? (
                  <p className="text-[11px] text-gray-500">
                    rate_num and rate_den are derived from the bribe mint&apos;s decimals —
                    enter it to see the exact integers.
                  </p>
                ) : (<>
                {([
                  ["rate_num", dealOk.num.toString()],
                  ["rate_den", dealOk.den.toString()],
                  ["cap_hi_sola", dealOk.capBase.toString()],
                  ["base_hi_sola", dealOk.baseBase.toString()],
                  ["lock_duration_secs", dealOk.lockSecs.toString()],
                ] as const).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 text-[11px]">
                    <span className="text-gray-500 font-mono">{k}</span>
                    <span className="text-gray-300 font-mono break-all text-right">{v}</span>
                  </div>
                ))}
                <p className="text-[10px] text-gray-600 mt-1">
                  Bribe mint has {bribeDecimals} decimals; hiSOLA has 6. The rate carries that
                  gap so you never have to.
                </p>
                </>)}
              </div>
            </div>
          )}

          {!isAuthority && (
            <p className="text-[11px] text-amber-400/90 leading-relaxed">
              ⚠️ This action is signed by the protocol <strong>authority</strong>
              {authorityWallet ? <> (<span className="font-mono">{authorityWallet.slice(0, 8)}…</span>)</> : null},
              which is a different wallet from the founder. Connect the authority wallet to
              register a partner.
            </p>
          )}

          <button
            className="btn-primary w-full"
            onClick={registerPartner}
            disabled={loadingReg || !isAuthority || !regWallet.trim() || !regBribeMint.trim() ||
                      !dealOk}
          >
            {loadingReg ? "Processing…"
              : !isAuthority ? "Authority wallet required"
              : !dealOk ? "Complete the deal above"
              : "Register Partner"}
          </button>

          {statusReg && (
            <p className="text-xs text-gray-400 break-all">{statusReg}</p>
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
