// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
import { useCallback, useEffect, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { sendTx } from "@/lib/program";
import { explainRpcRefusal } from "@/lib/txerror";
import { useSoladrome } from "@/lib/SoladromeContext";
import {
  buildArmInstructions, buildDisarmInstructions, readStandingOrder,
  type Allowances, type StandingOrder as Order,
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
//   · The cost ceiling is defaulted to ten percent above what a round costs today and shown in
//     the sentence. It is the feature's whole safety story, so it stays visible and editable —
//     just not as a field everyone must fill in before they can begin.

const UNIT = 1_000_000;

const INTERVALS = [
  { secs: 60, label: "minute", every: "Every minute" },
  { secs: 3600, label: "hour", every: "Every hour" },
  { secs: 86400, label: "day", every: "Every day" },
] as const;


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

export function StandingOrder() {
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
  const [maxCostText, setMaxCostText] = useState("");

  // What a round costs right now, priced exactly as `exercise_fee` prices it. No RPC: the
  // curve is already in the protocol state the context holds.
  const costPerUnit = (() => {
    if (!protocolState) return 1;
    const vu = Number(protocolState.virtualUsdc.toString());
    const vs = Number(protocolState.virtualSola.toString());
    const feeBps = Number(protocolState.exerciseFeeBps ?? 0);
    return 1 + (Math.max(0, vu / vs - 1) * feeBps) / 10_000;
  })();
  // Ten percent of headroom over today's cost, rounded up to the cent — enough that ordinary
  // movement in the curve does not stall the order, tight enough that it still bounds it.
  const suggestedMaxCost = Math.ceil(costPerUnit * 1.1 * 100) / 100;
  const maxCost = maxCostText === "" ? suggestedMaxCost : parseFloat(maxCostText) || suggestedMaxCost;

  const load = useCallback(async () => {
    if (!wallet || !usdcMint) return;
    try {
      const next = await readStandingOrder(connection, wallet, usdcMint);
      setOrder(next.order);
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
      const ixs = await buildArmInstructions(connection, wallet, usdcMint, {
        // The threshold IS the round size: "fire when there is a full round's worth".
        threshold: size,
        chunk: size,
        maxCostPerUnit: maxCost,
        minInterval: interval,
        rounds: parseInt(rounds, 10) || 1,
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
      const ixs = await buildDisarmInstructions(connection, wallet, usdcMint, true);
      const sig = await sendTx(connection, wallet, ixs);
      setStatus(`✅ Revoked — it can no longer touch anything. tx: ${sig.slice(0, 16)}…`);
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
    const cost = order.chunk * costPerUnit;
    const usdc = Number(balances.usdc) / UNIT;
    if (usdc < cost) {
      return `a round costs about ${cost.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC and you hold ${usdc.toLocaleString("en-US", { maximumFractionDigits: 2 })}.`;
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
          <h3 className="text-base font-bold text-white">Compound automatically</h3>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
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
            compound them into hiSOLA — never paying more than{" "}
            <strong className="text-white">{order.maxCostPerUnit.toFixed(2)} USDC</strong> each.
            {roundsLeft !== null ? (
              <> <strong className="text-white">{roundsLeft}</strong> round{roundsLeft === 1 ? "" : "s"} left.</>
            ) : spent ? (
              <> Its allowance is used up, which is how it was meant to end.</>
            ) : (
              <> No allowance granted yet.</>
            )}
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
            {order.rounds > 0 && `, ${order.usdcSpent.toFixed(2)} USDC spent`}. A round costs about{" "}
            {costPerUnit.toFixed(3)} USDC per oSOLA today.
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
              <p className="mt-4 rounded-xl border border-brand-green/30 bg-brand-green/5 px-4 py-3 text-sm leading-relaxed text-gray-200">
                {everyLabel(interval)}, when you hold at least{" "}
                <strong className="text-white">
                  {(parseFloat(chunk) || 0).toLocaleString("en-US")} oSOLA
                </strong>
                , compound them into hiSOLA — up to{" "}
                <strong className="text-white">{parseInt(rounds, 10) || 0} times</strong>, never
                paying more than <strong className="text-white">{maxCost.toFixed(2)} USDC</strong>{" "}
                each. That is at most{" "}
                <strong className="text-white">
                  {((parseFloat(chunk) || 0) * (parseInt(rounds, 10) || 0) * maxCost).toLocaleString(
                    "en-US",
                    { maximumFractionDigits: 0 },
                  )}{" "}
                  USDC
                </strong>{" "}
                in total, and not one cent more.
              </p>

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
                {advanced ? "▾" : "▸"} Cost ceiling
              </button>
              {advanced && (
                <div className="mt-2 rounded-lg border border-brand-border bg-brand-dark p-3">
                  <div className="flex items-center gap-2">
                    <input
                      value={maxCostText}
                      onChange={(e) => num(e.target.value, setMaxCostText)}
                      placeholder={suggestedMaxCost.toFixed(2)}
                      inputMode="decimal"
                      className="w-32 rounded-lg border border-brand-border bg-black/30 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-brand-green focus:outline-none"
                    />
                    <span className="text-[11px] text-gray-600">USDC per oSOLA</span>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-gray-600">
                    A round costs {costPerUnit.toFixed(4)} today: the strike of 1 USDC plus a share
                    of the gain above the floor. That share moves with the curve, and it is priced
                    when the round fires, not when you sign — so this ceiling is what stops anyone
                    from choosing an expensive moment. Set it too tight and the order simply waits.
                  </p>
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
                One transaction records the order and grants two capped allowances, oSOLA to burn
                and USDC to pay with. Nothing is escrowed: your tokens stay in your own accounts
                until a round fires.
              </p>
            </>
          )}
        </>
      )}

      <StatusBanner message={status} />
    </div>
  );
}
