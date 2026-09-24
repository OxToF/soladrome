// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
import { useCallback, useEffect, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { sendTx } from "@/lib/program";
import { explainRpcRefusal } from "@/lib/txerror";
import { useSoladrome } from "@/lib/SoladromeContext";
import {
  buildArmInstructions, buildDisarmInstructions, readStandingOrder,
  type Allowances, type StandingOrder as Order, type Destination,
} from "@/lib/autocompound";
import { StatusBanner } from "./ui/StatusBanner";

// The only thing in this app that acts while nobody is looking, so the screen's job is not to
// sell it — it is to make three things impossible to miss: what it will spend, what stops it,
// and who can end it.
//
// ☢️ IT USED TO ASK FOR FIVE NUMBERS. "Fires at", "each round", "never pay more than",
// "authorise N rounds", "at most once per" — five labelled fields the reader had to assemble in
// their head, next to a Compound card that also had a budget and a threshold of its own. Now it
// asks for three and states the result as one sentence, because a sentence is the only form in
// which someone can actually check that it says what they meant.
//
// The two that went away did not lose anything:
//   · "Fires at" is gone because it was always the same number as the round size in practice —
//     it is now set to it. (The program still takes both; `threshold >= chunk` is its rule.)
//   · The cost ceiling is defaulted and shown in the sentence. It is the feature's whole safety
//     story, so it stays visible and editable — just not as a field everyone must fill in
//     before they can begin. See `CEILING_TOLERATES_SOLA_AT` for what the default now means,
//     and why "ten percent above today's cost" was the wrong anchor.

const UNIT = 1_000_000;

const INTERVALS = [
  { secs: 60, label: "minute", every: "Every minute" },
  { secs: 3600, label: "hour", every: "Every hour" },
  { secs: 86400, label: "day", every: "Every day" },
] as const;

/// The SOLA price the default cost ceiling is built to tolerate.
///
/// ☢️ The ceiling is denominated in USDC per oSOLA, and the person setting it thinks in SOLA
/// price. The two are an order of magnitude apart: a round costs the 1 USDC strike — fixed for
/// ever — plus a share of the gain, so at a 10% fee only a tenth of any price move reaches the
/// ceiling. The previous default, "ten percent over what a round costs today", therefore read as
/// prudent and actually meant "stop once SOLA has doubled". Nobody could have known that from
/// the screen, because the screen never showed the price the ceiling implied.
///
/// Anchoring the default to a price fixes both halves: the number is derived from something the
/// reader can picture, and `stopsAboveSolaPrice` shows the same picture back.
///
/// It is deliberately generous, and that is the point rather than a compromise. **A rising price
/// makes a round MORE profitable, not less** — the strike stays at 1 USDC while the SOLA received
/// is worth more — so a ceiling that bites on a price rise stops the order exactly when it earns
/// the most. What the ceiling genuinely defends against is a change to `exercise_fee_bps`, which
/// the protocol authority may raise as far as 50%, and against that it still bounds hard: being
/// written in USDC rather than in basis points is what makes it survive a fee it did not expect.
const CEILING_TOLERATES_SOLA_AT = 10;

/// Mirrors `MAX_EXERCISE_FEE_BPS` in the program: the highest rate `set_exercise_fee` will take,
/// and therefore the highest tolerance worth offering. `configure_auto_compound` refuses above it.
const MAX_EXERCISE_FEE_BPS = 5_000;

/// Translate a ceiling in USDC per oSOLA into the SOLA price at which it starts refusing.
///
/// `cost = 1 + fee_bps/10_000 × (price − 1)`, so the ceiling is met at
/// `price = 1 + (ceiling − 1) × 10_000 / fee_bps`.
///
/// Null when the fee is zero: the cost is then exactly the strike at any price, so no price ever
/// reaches the ceiling and there is no threshold to name.
function stopsAboveSolaPrice(ceiling: number, feeBps: number): number | null {
  if (feeBps <= 0) return null;
  return 1 + ((ceiling - 1) * 10_000) / feeBps;
}

/// Round DOWN to something a human would have typed: 81.67 → 80, 2 480 → 2 000, 7.3 → 7.
/// Down, never up, because a suggestion that cannot fire is worse than no suggestion.
function neatFloor(n: number): number {
  if (n <= 0) return 0;
  if (n < 10) return Math.floor(n);
  const mag = 10 ** Math.floor(Math.log10(n));
  return Math.floor(n / (mag / 2)) * (mag / 2);
}

function num(v: string, set: (s: string) => void) {
  if (v === "" || /^\d*\.?\d*$/.test(v)) set(v);
}

/// A pool the order may compound into — already filtered by the caller to what the program
/// accepts as a destination (pairs USDC or SOL, holds no oSOLA).
export type LpChoice = { address: string; label: string };

/// The floor on the sale, as a share of an oSOLA's exercise value. 70 % was agreed on
/// 2026-09-23: loose enough that an ordinary market clears it, tight enough that a sandwich
/// which crushes the pool price cannot make the order sell.
const DEFAULT_MIN_INTRINSIC_BPS = 7_000;

export function StandingOrder({
  lpChoices = [],
  voters = 0,
}: {
  lpChoices?: LpChoice[];
  /// How many positions have a voting strategy. They spend from the same USDC allowance as this
  /// order, so arming or revoking here must not take it away from them.
  voters?: number;
}) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint, protocolState, refresh } = useSoladrome();

  const [order, setOrder] = useState<Order | null>(null);
  const [allowances, setAllowances] = useState<Allowances | null>(null);
  const [balances, setBalances] = useState<{ oSola: bigint; usdc: bigint } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [setting, setSetting] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  const [chunk, setChunk] = useState("500");
  const [rounds, setRounds] = useState("10");
  const [interval, setIntervalSecs] = useState(3600);
  const [feeText, setFeeText] = useState("");
  const [budgetText, setBudgetText] = useState("");
  // ── Where it goes: voting power, or a pool ────────────────────────────────
  const [dest, setDest] = useState<"vote" | "lp">("vote");
  const [target, setTarget] = useState("");
  const [minPctText, setMinPctText] = useState("");
  const minIntrinsicBps = (() => {
    if (minPctText === "") return DEFAULT_MIN_INTRINSIC_BPS;
    const bps = Math.round((parseFloat(minPctText) || 0) * 100);
    return Math.min(10_000, Math.max(1, bps));
  })();
  const poolLabel = (address: string | null | undefined) =>
    !address
      ? ""
      : lpChoices.find((c) => c.address === address)?.label ?? `${address.slice(0, 4)}…${address.slice(-4)}`;
  const chosenTarget = target || lpChoices[0]?.address || "";

  // The fee rate the curve charges on the gain. Everything below is a function of it, and it is
  // a protocol parameter rather than a market one — which is why the ceiling exists at all.
  const feeBps = Number(protocolState?.exerciseFeeBps ?? 0);
  // Today's SOLA price on the curve, and what a round costs right now, priced exactly as
  // `exercise_fee` prices it. No RPC: the curve is already in the protocol state the context
  // holds.
  const solaPrice = (() => {
    if (!protocolState) return 1;
    const vu = Number(protocolState.virtualUsdc.toString());
    const vs = Number(protocolState.virtualSola.toString());
    return vs > 0 ? vu / vs : 1;
  })();
  const costPerUnit = 1 + (Math.max(0, solaPrice - 1) * feeBps) / 10_000;

  // What a round would cost if SOLA reached `CEILING_TOLERATES_SOLA_AT`, rounded up to the cent.
  //
  // ⚠️ Floored at 1.10 for the degenerate case the price anchor cannot express: at `fee_bps = 0`
  // a round costs exactly the strike whatever the price, so the anchor computes 1.00 — which is
  // the program's own minimum (`max_cost_per_unit >= UNIT_ONE`) and would leave the order with
  // no headroom at all the instant a fee is switched on.
  const suggestedMaxCost = Math.max(
    1.1,
    Math.ceil((1 + (Math.max(0, CEILING_TOLERATES_SOLA_AT - 1) * feeBps) / 10_000) * 100) / 100,
  );
  // ⚠️ No longer offered as a field. It survives only to size the budget below, because "what
  // ten rounds would cost with SOLA at ten dollars" is a good generous default for a budget and
  // was a bad bound to hand someone as a price they had to commit to.

  // ── The two bounds the order actually runs on ─────────────────────────────
  //
  // ☢️ The fee share is the one that does not expire against the market. An absolute ceiling can
  // only be reached by the price RISING, and a rise is when a round earns the most — so enforcing
  // it alone stopped the order at exactly the wrong moment, on a forecast nobody can make. The
  // rate is price-independent and answers a question its owner can: how much of the gain are they
  // willing to leave behind.
  //
  // Defaulted to today's rate plus half again, rounded to a whole percent, so ordinary rounding
  // never trips it and a real change to `exercise_fee_bps` still does.
  const suggestedFeeBps = Math.min(
    MAX_EXERCISE_FEE_BPS,
    Math.max(100, Math.ceil((feeBps * 1.5) / 100) * 100),
  );
  const maxFeeBps = feeText === "" ? suggestedFeeBps : Math.round((parseFloat(feeText) || 0) * 100);

  // The budget is the spending bound, and it becomes the SPL allowance verbatim. Defaulted to
  // what the rounds would cost with SOLA at `CEILING_TOLERATES_SOLA_AT`, which is generous
  // enough that a rising market spends it rather than stalling against it.
  const roundsN = parseInt(rounds, 10) || 0;
  const chunkN = parseFloat(chunk) || 0;
  const suggestedBudget = Math.ceil(chunkN * roundsN * suggestedMaxCost);
  const budget = budgetText === "" ? suggestedBudget : parseFloat(budgetText) || suggestedBudget;

  // ⚠️ `max_cost_per_unit` stays on chain and still has a job, but it is no longer the control:
  // one round may consume at most the whole budget. That is a real bound — it stops a single
  // round emptying an allowance meant for ten — and it is not a price forecast, because it moves
  // with the budget rather than with the curve. The program refuses anything below the 1 USDC
  // strike, so a budget too small to pay even one strike is clamped here and warned about below.
  const perUnitCeiling = chunkN > 0 ? Math.max(1, budget / chunkN) : 1;
  const budgetTooSmall = chunkN > 0 && budget < chunkN;

  const load = useCallback(async () => {
    if (!wallet || !usdcMint) return;
    try {
      const next = await readStandingOrder(connection, wallet, usdcMint);
      setOrder(next.order);
      // The form opens on what the order does today, so "Change it" starts from the truth.
      if (next.order?.lpTarget) {
        setDest("lp");
        setTarget(next.order.lpTarget.toBase58());
        setMinPctText(String(next.order.minIntrinsicBps / 100));
      } else if (next.order) {
        setDest("vote");
      }
      setAllowances(next.allowances);
      setBalances(next.balances);
    } catch (e: any) {
      setStatus(`❌ ${explainRpcRefusal(e) ?? e?.message ?? e}`);
    }
  }, [connection, wallet, usdcMint]);

  useEffect(() => { load(); }, [load]);

  async function arm() {
    if (!wallet || !usdcMint) return;
    setBusy(true);
    setStatus("");
    try {
      const size = parseFloat(chunk) || 0;
      if (dest === "lp" && !chosenTarget) throw new Error("Choose the pool to compound into.");
      const destination: Destination =
        dest === "lp"
          ? { kind: "lp", pool: new PublicKey(chosenTarget), minIntrinsicBps }
          : { kind: "vote" };
      const ixs = await buildArmInstructions(connection, wallet, usdcMint, {
        destination,
        // The threshold IS the round size: "fire when there is a full round's worth".
        threshold: size,
        chunk: size,
        // No longer a price forecast: one round may consume at most the whole budget.
        maxCostPerUnit: perUnitCeiling,
        minInterval: interval,
        rounds: parseInt(rounds, 10) || 1,
        maxFeeBps,
        budgetUsdc: budget,
        usdcSharedWithStrategies: voters > 0,
      });
      const sig = await sendTx(connection, wallet, ixs);
      setStatus(`✅ Armed — tx: ${sig.slice(0, 16)}…`);
      setSetting(false);
      refresh();
      setTimeout(load, 2000);
    } catch (e: any) {
      setStatus(`❌ ${explainRpcRefusal(e) ?? e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  async function disarm() {
    if (!wallet || !usdcMint) return;
    setBusy(true);
    setStatus("");
    try {
      const ixs = await buildDisarmInstructions(connection, wallet, usdcMint, true, voters > 0);
      const sig = await sendTx(connection, wallet, ixs);
      setStatus(
        voters > 0
          ? `✅ Stopped: it can no longer touch your wallet oSOLA. Your voting positions keep their USDC budget. tx: ${sig.slice(0, 16)}…`
          : `✅ Revoked — it can no longer touch anything. tx: ${sig.slice(0, 16)}…`,
      );
      setTimeout(load, 2000);
    } catch (e: any) {
      setStatus(`❌ ${explainRpcRefusal(e) ?? e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  if (!wallet) return null;

  const roundsLeft =
    order && allowances?.oSola != null && order.chunk > 0
      ? Math.floor(Number(allowances.oSola) / UNIT / order.chunk)
      : null;
  const spent = order !== null && roundsLeft === null && order.rounds > 0;
  const armed = !!order && roundsLeft !== null && roundsLeft > 0 && order.enabled;

  // Why nothing is happening, in the user's own terms. Mirrors `listCrankableOrders`, which is
  // the keeper's version of the same judgement — and both are mirrors of the chain, which
  // refuses anyway. Null when the order really is ready to fire.
  const waiting = (() => {
    if (!order || !balances) return null;
    if (!order.enabled) return "it is paused.";
    if (roundsLeft === null) {
      return order.rounds > 0
        ? "its allowance is used up. Set it up again to keep going."
        : "no allowance has been granted yet.";
    }
    const held = Number(balances.oSola) / UNIT;
    if (held < order.chunk) {
      return `you hold ${held.toLocaleString("en-US", { maximumFractionDigits: 2 })} of the ${order.chunk.toLocaleString("en-US")} oSOLA it needs.`;
    }
    // A liquidity order pays nothing: it sells its oSOLA. What can still hold it back — a pool
    // paying under the price floor, a leg too big for its pool — the keeper finds in simulation.
    const cost = order.chunk * costPerUnit;
    const usdc = Number(balances.usdc) / UNIT;
    if (order.lpTarget) {
      const dueIn = order.lastCrankTs + order.minInterval - Math.floor(Date.now() / 1000);
      if (dueIn > 0) {
        const mins = Math.ceil(dueIn / 60);
        return mins >= 120
          ? `the next round is due in about ${Math.round(mins / 60)} hours.`
          : `the next round is due in about ${mins} minute${mins === 1 ? "" : "s"}.`;
      }
      return null;
    }
    if (usdc < cost) {
      return `a round costs about ${cost.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC and you hold ${usdc.toLocaleString("en-US", { maximumFractionDigits: 2 })}.`;
    }
    // The fee bound first: it is the one an order armed today actually runs on, and the one a
    // reader can act on — nothing about the curve will clear it, only the protocol lowering the
    // rate again or the owner accepting the new one.
    if (order.maxFeeBps > 0 && feeBps > order.maxFeeBps) {
      return `the protocol now takes ${(feeBps / 100).toFixed(1)}% of the gain, above the ${(order.maxFeeBps / 100).toFixed(0)}% you accepted. It waits until the fee comes back down, or until you re-arm at the new rate.`;
    }
    if (costPerUnit > order.maxCostPerUnit) {
      return `a round costs ${costPerUnit.toFixed(3)} USDC per oSOLA right now, above your ${order.maxCostPerUnit.toFixed(2)} ceiling. It will fire again when the curve comes back.`;
    }
    const due = order.lastCrankTs + order.minInterval - Math.floor(Date.now() / 1000);
    if (due > 0) {
      const mins = Math.ceil(due / 60);
      return mins >= 120
        ? `the next round is due in about ${Math.round(mins / 60)} hours.`
        : `the next round is due in about ${mins} minute${mins === 1 ? "" : "s"}.`;
    }
    return null;
  })();

  // ── What the wallet can actually sustain ──────────────────────────────────
  //
  // Two ceilings, and the smaller one wins: a round cannot exceed the oSOLA held (the crank
  // reads the wallet balance, nothing else), and it cannot exceed what the USDC can pay for.
  //
  // ☢️ THE oSOLA CEILING IS THE WALLET, NOT THE WALLET PLUS PENDING LP REWARDS. The crank does
  // not claim: `crank_auto_compound` exercises and stakes, and nothing in it calls
  // `claim_lp_rewards`. So a suggestion built on pending rewards would propose a round that
  // can never fire, and the order would sit "on" forever waiting for oSOLA that is sitting
  // one uncalled instruction away.
  const heldOSola = balances ? Number(balances.oSola) / UNIT : 0;
  const heldUsdc = balances ? Number(balances.usdc) / UNIT : 0;
  const maxRound = Math.min(heldOSola, costPerUnit > 0 ? heldUsdc / costPerUnit : 0);
  const suggestedRound = neatFloor(maxRound);
  const suggestedRounds = suggestedRound > 0 ? Math.max(1, Math.floor(heldOSola / suggestedRound)) : 1;

  const wanted = parseFloat(chunk) || 0;
  const tooBig = setting && wanted > heldOSola;

  function useMyBalance() {
    if (suggestedRound <= 0) return;
    setChunk(String(suggestedRound));
    setRounds(String(suggestedRounds));
  }

  const everyLabel = (secs: number) =>
    INTERVALS.find((i) => i.secs === secs)?.every ??
    `Every ${secs >= 86400 ? `${Math.round(secs / 86400)} days` : `${Math.round(secs / 3600)} hours`}`;

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-bold text-white">Automate the oSOLA in your wallet</h3>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            Only for oSOLA already in your wallet; your positions have their own setting above.
            Keeps doing it while you are away. Anyone can trigger it, nobody can redirect it, and
            you can stop it from your wallet.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
            armed
              ? "bg-brand-green/10 text-brand-green"
              : order
                ? "bg-yellow-500/10 text-yellow-300"
                : "bg-black/30 text-gray-600"
          }`}
        >
          {armed ? "On" : spent ? "Spent" : order ? "Paused" : "Off"}
        </span>
      </div>

      {allowances?.hijacked && (
        <p className="mt-4 rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-3 py-2 text-[11px] leading-relaxed text-yellow-200/90">
          Another application took the delegate slot on one of your token accounts — there is only
          ever one — so this cannot act until you set it up again. Nothing was lost; it went quiet,
          which is the safe direction.
        </p>
      )}

      {/* ── Live order: the same sentence it was armed with ──────────── */}
      {order && !setting && (
        <>
          <p className="mt-4 rounded-xl border border-brand-border bg-brand-dark px-4 py-3 text-sm leading-relaxed text-gray-300">
            {everyLabel(order.minInterval)}, when you hold at least{" "}
            <strong className="text-white">{order.chunk.toLocaleString("en-US")} oSOLA</strong>,
            {order.lpTarget ? (
              <>
                {" "}sell them — never below{" "}
                <strong className="text-white">
                  {(order.minIntrinsicBps / 100).toFixed(0)}% of their exercise value
                </strong>{" "}
                — and add the proceeds to{" "}
                <strong className="text-white">{poolLabel(order.lpTarget.toBase58())}</strong>.
              </>
            ) : (
              <> compound them into hiSOLA — </>
            )}
            {order.lpTarget ? null : order.maxFeeBps > 0 ? (
              <>
                never giving up more than{" "}
                <strong className="text-white">
                  {(order.maxFeeBps / 100).toFixed(0)}% of the gain
                </strong>
                .
              </>
            ) : (
              <>
                never paying more than{" "}
                <strong className="text-white">{order.maxCostPerUnit.toFixed(2)} USDC</strong> each.
              </>
            )}
            {roundsLeft !== null ? (
              <> <strong className="text-white">{roundsLeft}</strong> round{roundsLeft === 1 ? "" : "s"} left.</>
            ) : spent ? (
              <> Its allowance is used up, which is how it was meant to end.</>
            ) : (
              <> No allowance granted yet.</>
            )}
            {/* ⚠️ An order armed before the fee bound existed still runs on an absolute ceiling,
                which is a price bet it never asked to make. Say so, in the unit its owner thinks
                in, and against TODAY's fee rather than the fee at arming — a rate change moves
                that threshold under an order that never changed. Re-arming is what clears it. */}
            {!order.lpTarget && order.maxFeeBps === 0 &&
              (() => {
                const live = stopsAboveSolaPrice(order.maxCostPerUnit, feeBps);
                return live === null ? null : (
                  <>
                    {" "}
                    <span className="text-yellow-200/80">
                      ⚠️ It stops if SOLA rises above {live.toFixed(2)} USDC — it is{" "}
                      {solaPrice.toFixed(2)} now. Re-arm it to swap that price bet for a bound on
                      the fee instead.
                    </span>
                  </>
                );
              })()}
          </p>
          {/* ☢️ What it is waiting for. Without this the card reads "on, 10 rounds left" at a
              wallet that cannot satisfy one of them — true about the allowance, and quietly
              wrong about what is going to happen. It mirrors the keeper's own reasons. */}
          {waiting && (
            <p className="mt-2 rounded-lg border border-brand-border bg-brand-dark px-3 py-2 text-[11px] leading-relaxed text-gray-400">
              Waiting — {waiting}
            </p>
          )}

          <p className="mt-2 text-[11px] leading-relaxed text-gray-600">
            {order.rounds} round{order.rounds === 1 ? "" : "s"} fired so far
            {order.lpTarget ? (
              <>. It needs no USDC — the oSOLA is sold, not exercised.</>
            ) : (
              <>
                {order.rounds > 0 && `, ${order.usdcSpent.toFixed(2)} USDC spent`}. A round costs about{" "}
                {costPerUnit.toFixed(3)} USDC per oSOLA today.
              </>
            )}
          </p>

          <div className="mt-4 flex gap-2">
            <button
              onClick={() => setSetting(true)}
              className="flex-1 rounded-lg border border-brand-border py-2.5 text-xs font-semibold text-gray-300 transition-colors hover:border-brand-green/40 hover:text-brand-green"
            >
              {spent ? "Set it up again" : "Change it"}
            </button>
            <button
              onClick={disarm}
              disabled={busy}
              className="flex-1 rounded-lg border border-brand-border py-2.5 text-xs font-semibold text-gray-400 transition-colors hover:border-red-500/40 hover:text-red-300 disabled:opacity-40"
            >
              {busy ? "Sending…" : "Stop it"}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-gray-600">
            Stopping revokes the allowance in the token program — an instruction on your own
            accounts that this protocol neither sees nor can refuse. It would still work if this
            application disappeared.
          </p>
        </>
      )}

      {/* ── Not set, or being changed ─────────────────────────────────── */}
      {(!order || setting) && (
        <>
          {!setting ? (
            <button onClick={() => setSetting(true)} className="btn-primary mt-4 w-full">
              Set it up
            </button>
          ) : (
            <>
              {/* ── Where it goes. One order, one destination: the oSOLA account has a single
                  delegate, so this choice replaces the other rather than adding to it. ── */}
              <div className="mt-4 grid grid-cols-2 gap-2">
                {([
                  ["vote", "Voting power", "hiSOLA — votes, fees, bribes"],
                  ["lp", "Liquidity", "LP in a pool you choose"],
                ] as const).map(([key, title, hint]) => (
                  <button
                    key={key}
                    onClick={() => setDest(key)}
                    disabled={key === "lp" && lpChoices.length === 0}
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-40 ${
                      dest === key
                        ? "border-brand-green/60 bg-brand-green/10"
                        : "border-brand-border hover:border-brand-green/30"
                    }`}
                  >
                    <span className={`block text-sm font-bold ${dest === key ? "text-brand-green" : "text-gray-200"}`}>
                      {title}
                    </span>
                    <span className="block text-[11px] text-gray-500">{hint}</span>
                  </button>
                ))}
              </div>
              {dest === "lp" && (
                <label className="mt-3 block">
                  <span className="text-[11px] text-gray-500">Into</span>
                  <select
                    value={chosenTarget}
                    onChange={(e) => setTarget(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-brand-border bg-brand-dark px-3 py-2 text-sm text-white focus:border-brand-green focus:outline-none"
                  >
                    {lpChoices.map((c) => (
                      <option key={c.address} value={c.address}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="text-[11px] text-gray-500">Compound</span>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      value={chunk}
                      onChange={(e) => num(e.target.value, setChunk)}
                      inputMode="decimal"
                      className="w-full rounded-lg border border-brand-border bg-brand-dark px-3 py-2 text-sm text-white focus:border-brand-green focus:outline-none"
                    />
                    <span className="shrink-0 text-[11px] text-gray-600">oSOLA</span>
                  </div>
                  {suggestedRound > 0 && (
                    <button
                      onClick={useMyBalance}
                      className="mt-1 text-[11px] text-brand-green/80 transition-colors hover:text-brand-green"
                    >
                      Use what I hold — {suggestedRound.toLocaleString("en-US")} × {suggestedRounds}
                    </button>
                  )}
                </label>
                <label className="block">
                  <span className="text-[11px] text-gray-500">How often, at most</span>
                  <select
                    value={interval}
                    onChange={(e) => setIntervalSecs(Number(e.target.value))}
                    className="mt-1 w-full rounded-lg border border-brand-border bg-brand-dark px-3 py-2 text-sm text-white focus:border-brand-green focus:outline-none"
                  >
                    {INTERVALS.map((i) => (
                      <option key={i.secs} value={i.secs}>
                        once a {i.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[11px] text-gray-500">For how many rounds</span>
                  <input
                    value={rounds}
                    onChange={(e) => num(e.target.value, setRounds)}
                    inputMode="numeric"
                    className="mt-1 w-full rounded-lg border border-brand-border bg-brand-dark px-3 py-2 text-sm text-white focus:border-brand-green focus:outline-none"
                  />
                </label>
              </div>

              {/* ── The sentence. This is the thing being agreed to. ──── */}
              {dest === "lp" ? (
                <p className="mt-4 rounded-xl border border-brand-green/30 bg-brand-green/5 px-4 py-3 text-sm leading-relaxed text-gray-200">
                  {everyLabel(interval)}, when you hold at least{" "}
                  <strong className="text-white">
                    {(parseFloat(chunk) || 0).toLocaleString("en-US")} oSOLA
                  </strong>
                  , sell them — never below{" "}
                  <strong className="text-white">
                    {(minIntrinsicBps / 100).toFixed(0)}% of their exercise value
                  </strong>{" "}
                  — and add the proceeds to{" "}
                  <strong className="text-white">{poolLabel(chosenTarget)}</strong>, up to{" "}
                  <strong className="text-white">{roundsN} times</strong>. It spends no USDC.
                </p>
              ) : (
              <>
              <p className="mt-4 rounded-xl border border-brand-green/30 bg-brand-green/5 px-4 py-3 text-sm leading-relaxed text-gray-200">
                {everyLabel(interval)}, when you hold at least{" "}
                <strong className="text-white">
                  {(parseFloat(chunk) || 0).toLocaleString("en-US")} oSOLA
                </strong>
                , compound them into hiSOLA — up to{" "}
                <strong className="text-white">{roundsN} times</strong>, never giving up more than{" "}
                <strong className="text-white">{(maxFeeBps / 100).toFixed(0)}% of the gain</strong>.
                That is at most{" "}
                <strong className="text-white">
                  {budget.toLocaleString("en-US", { maximumFractionDigits: 0 })} USDC
                </strong>{" "}
                in total, and not one cent more.
              </p>

              {/* What the sentence above leaves implicit: how far the budget actually goes at
                  today's price, and — the part that used to be missing entirely — that a price
                  move no longer ends the order. */}
              <p className="mt-2 px-1 text-[11px] leading-relaxed text-gray-500">
                At today&apos;s price a round costs{" "}
                <span className="text-gray-300">
                  {(chunkN * costPerUnit).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC
                </span>
                , so the budget covers{" "}
                <span className="text-gray-300">
                  {chunkN > 0 && costPerUnit > 0
                    ? Math.min(roundsN, Math.floor(budget / (chunkN * costPerUnit)))
                    : 0}{" "}
                  of your {roundsN}
                </span>
                . A rising SOLA price spends it faster and does not stop the order — SOLA is{" "}
                {solaPrice.toFixed(2)} USDC now.
              </p>

              </>
              )}

              {dest === "vote" && budgetTooSmall && (
                <p className="mt-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-3 py-2 text-[11px] leading-relaxed text-yellow-200/90">
                  ⚠️ A budget of {budget.toLocaleString("en-US")} USDC cannot pay even one round&apos;s
                  strike, which is {chunkN.toLocaleString("en-US")} USDC before any fee. The order
                  would be armed and never fire.
                </p>
              )}

              {tooBig && (
                <p className="mt-3 rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-3 py-2 text-[11px] leading-relaxed text-yellow-200/90">
                  You hold {heldOSola.toLocaleString("en-US", { maximumFractionDigits: 2 })} oSOLA,
                  so a round of {wanted.toLocaleString("en-US")} waits until you have that much.
                  ⚠️ And it will not get there on its own: this automation exercises and stakes,
                  it does not claim. Pending LP rewards only reach your wallet when you run
                  “Compound once”.
                </p>
              )}

              <button
                onClick={() => setAdvanced((a) => !a)}
                className="mt-3 text-[11px] text-gray-500 transition-colors hover:text-gray-300"
              >
                {advanced ? "▾" : "▸"} Limits
              </button>
              {advanced && dest === "lp" && (
                <div className="mt-2 space-y-3 rounded-lg border border-brand-border bg-brand-dark p-3">
                  <div className="flex items-center gap-2">
                    <input
                      value={minPctText}
                      onChange={(e) => num(e.target.value, setMinPctText)}
                      placeholder={(DEFAULT_MIN_INTRINSIC_BPS / 100).toFixed(0)}
                      inputMode="decimal"
                      className="w-24 rounded-lg border border-brand-border bg-black/30 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-brand-green focus:outline-none"
                    />
                    <span className="text-[11px] text-gray-600">% of the exercise value, at least</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-gray-600">
                    An oSOLA is worth what exercising it would net: the curve price above the 1 USDC
                    strike, less the fee. That figure is read from the curve, which no trade can push
                    down — so someone who crushes the pool price just before a round cannot make the
                    order sell cheap. When the pool pays less than this share, the order waits.
                  </p>
                </div>
              )}
              {advanced && dest === "vote" && (
                <div className="mt-2 space-y-3 rounded-lg border border-brand-border bg-brand-dark p-3">
                  {/* ── 1. The rate: the bound that does not expire against the market. ── */}
                  <div className="flex items-center gap-2">
                    <input
                      value={feeText}
                      onChange={(e) => num(e.target.value, setFeeText)}
                      placeholder={(suggestedFeeBps / 100).toFixed(0)}
                      inputMode="decimal"
                      className="w-24 rounded-lg border border-brand-border bg-black/30 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-brand-green focus:outline-none"
                    />
                    <span className="text-[11px] text-gray-600">% of the gain, at most</span>
                    <span className="text-[11px] text-gray-600">
                      · it is {(feeBps / 100).toFixed(1)}% today
                    </span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-gray-600">
                    A round costs the 1 USDC strike plus this share of the gain above the floor,
                    priced when the round fires rather than when you sign. Because it is a rate and
                    not an amount, the order keeps running at any SOLA price — it refuses only if
                    the protocol raises the fee past what you accepted here, which is the one thing
                    about this arrangement that was never yours to decide.
                  </p>
                  {maxFeeBps > 0 && maxFeeBps < feeBps && (
                    <p className="text-[11px] leading-relaxed text-yellow-200/90">
                      ⚠️ Below today&apos;s {(feeBps / 100).toFixed(1)}%, so the order would be armed
                      and wait rather than fire.
                    </p>
                  )}

                  {/* ── 2. The budget: the spending bound, enforced by SPL Token itself. ──
                      ☢️ It used to be derived as chunk × rounds × ceiling, which fused the price
                      bound and the spending bound into one number — so loosening the first to stop
                      the order stalling against a rising market silently authorised more of the
                      second. They answer different questions and are now two fields. */}
                  <div className="border-t border-brand-border pt-3">
                    <div className="flex items-center gap-2">
                      <input
                        value={budgetText}
                        onChange={(e) => num(e.target.value, setBudgetText)}
                        placeholder={suggestedBudget.toLocaleString("en-US")}
                        inputMode="decimal"
                        className="w-32 rounded-lg border border-brand-border bg-black/30 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-brand-green focus:outline-none"
                      />
                      <span className="text-[11px] text-gray-600">USDC in total, at most</span>
                    </div>
                    {voters > 0 && (
                      <p className="mt-2 text-[11px] leading-relaxed text-yellow-200/90">
                        ⚠️ Your {voters} voting position{voters === 1 ? "" : "s"} pay their strikes
                        from this same allowance. The amount here replaces the budget they share,
                        it does not add to it.
                      </p>
                    )}
                    <p className="mt-2 text-[11px] leading-relaxed text-gray-600">
                      This is the allowance you grant, to the cent, and SPL Token enforces it — not
                      this protocol. Revoking it from your wallet ends the arrangement whether or
                      not anything here still works. Rounds cost{" "}
                      {(chunkN * costPerUnit).toLocaleString("en-US", { maximumFractionDigits: 2 })}{" "}
                      USDC each today; a higher SOLA price spends the budget faster, which is how a
                      rising market ends an order now — by exhausting it, not by refusing it.
                    </p>
                  </div>
                </div>
              )}

              <div className="mt-4 flex gap-2">
                <button onClick={arm} disabled={busy} className="btn-primary flex-1 disabled:opacity-40">
                  {busy ? "Sending…" : "Arm it — one signature"}
                </button>
                {order && (
                  <button
                    onClick={() => setSetting(false)}
                    className="rounded-lg border border-brand-border px-4 text-xs font-semibold text-gray-400 hover:text-gray-200"
                  >
                    Cancel
                  </button>
                )}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-gray-600">
                {dest === "lp"
                  ? "One transaction records the order, points it at the pool and grants one capped allowance: the oSOLA to sell. The LP lands in your own account. Nothing is escrowed."
                  : "One transaction records the order and grants two capped allowances, oSOLA to burn and USDC to pay with. Nothing is escrowed: your tokens stay in your own accounts until a round fires."}
              </p>
            </>
          )}
        </>
      )}

      <StatusBanner message={status} />
    </div>
  );
}
