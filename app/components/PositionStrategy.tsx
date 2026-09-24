// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
// What happens to ONE position's oSOLA rewards: compounded into liquidity, turned into voting
// power, or kept for a manual claim. Used on each row of the Rewards card and under "My position"
// in Manage LP — the same control in both places, so the choice reads the same wherever it is made.
//
// ☢️ Per position, and independent: the program harvests each position's rewards at the source
// (`crank_pool_strategy_*`), so changing this row never touches another position's rewards.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createApproveInstruction, createRevokeInstruction } from "@solana/spl-token";
import { sendTx, userAta } from "@/lib/program";
import { explainRpcRefusal } from "@/lib/txerror";
import { autoPda } from "@/lib/autocompound";
import {
  STRATEGY_DEFAULTS, buildCloseStrategyInstruction, buildSetStrategyInstruction, canCompound,
  voteAllowance, type PoolStrategy,
} from "@/lib/strategies";

/// A pool as the strategy controls need it.
export type StrategyPool = { address: string; label: string; mintA: string; mintB: string };

/// A pool rewards may compound into, as the pool list names it.
export type LpChoice = { address: string; label: string };

/// The USDC budget granted the first time a position switches to voting power, if none is in place.
/// Shared by every voting strategy: one delegate, one allowance.
export const VOTE_BUDGET_DEFAULT = 100;

type Choice = { kind: "liquidity"; target: string } | { kind: "vote" } | { kind: "keep" };

function currentChoice(s: PoolStrategy | undefined): Choice {
  if (!s) return { kind: "keep" };
  if (s.mode === "vote") return { kind: "vote" };
  return { kind: "liquidity", target: s.targetPool!.toBase58() };
}

const same = (a: Choice, b: Choice) =>
  a.kind === b.kind && (a.kind !== "liquidity" || (b.kind === "liquidity" && a.target === b.target));

/// How a strategy's interval reads on screen. Every strategy the app creates runs hourly at most
/// (`STRATEGY_DEFAULTS.minInterval`); older or hand-made ones may differ, and say so.
export const intervalWord = (secs: number) =>
  secs === 3_600 ? "hourly" : secs === 86_400 ? "daily" : `every ${Math.round(secs / 60)} min`;

/// The instructions that take a position from its current strategy to `choice`.
///
/// What the owner did not touch is carried over: the interval, and the mode's own bound
/// (`minIntrinsicBps` / `maxFeeBps`) when the mode stays the same. Re-saving a strategy never
/// resets it to defaults behind the owner's back.
///
/// `budgetUsdc`, when given, REPLACES the USDC allowance of the `auto` PDA. ☢️ That allowance is
/// one number shared by every voting strategy (and any wallet order left from before): an SPL token account has a
/// single delegate. Without it, the first switch to voting power grants `VOTE_BUDGET_DEFAULT` if
/// less than 1 USDC is in place, so a strategy is never armed with nothing to pay the strike.
export async function strategyChangeIxs(
  connection: ReturnType<typeof useConnection>["connection"],
  wallet: NonNullable<ReturnType<typeof useAnchorWallet>>,
  usdcMint: PublicKey,
  source: string,
  current: PoolStrategy | undefined,
  choice: Choice,
  opts: { minInterval?: number; budgetUsdc?: number } = {},
): Promise<{ ixs: TransactionInstruction[]; grantsBudget: number | null }> {
  const src = new PublicKey(source);
  if (choice.kind === "keep") {
    return { ixs: current ? [await buildCloseStrategyInstruction(connection, wallet, src)] : [], grantsBudget: null };
  }
  const minInterval = opts.minInterval ?? current?.minInterval ?? STRATEGY_DEFAULTS.minInterval;
  const minHarvest = current?.minHarvest ?? STRATEGY_DEFAULTS.minHarvest;
  if (choice.kind === "liquidity") {
    return {
      ixs: [
        await buildSetStrategyInstruction(connection, wallet, src, {
          mode: "liquidity",
          target: new PublicKey(choice.target),
          minHarvest,
          minInterval,
          minIntrinsicBps: current?.mode === "liquidity" ? current.minIntrinsicBps : undefined,
        }),
      ],
      grantsBudget: null,
    };
  }
  const ixs = [
    await buildSetStrategyInstruction(connection, wallet, src, {
      mode: "vote",
      minHarvest,
      minInterval,
      maxFeeBps: current?.mode === "vote" ? current.maxFeeBps : undefined,
    }),
  ];
  // A voting strategy pays the strike in USDC through the order's delegate. Without an allowance it
  // would be armed and never fire.
  let budget = opts.budgetUsdc ?? null;
  if (budget === null) {
    const allowance = await voteAllowance(connection, wallet.publicKey, usdcMint);
    if (allowance === null || allowance < BigInt(1_000_000)) budget = VOTE_BUDGET_DEFAULT;
  }
  if (budget !== null) ixs.push(buildVoteBudgetInstruction(wallet.publicKey, usdcMint, budget));
  return { ixs, grantsBudget: budget };
}

/// Set the shared USDC budget for strikes to exactly `usdc` (0 withdraws it).
export function buildVoteBudgetInstruction(owner: PublicKey, usdcMint: PublicKey, usdc: number): TransactionInstruction {
  const ata = userAta(usdcMint, owner);
  if (usdc <= 0) return createRevokeInstruction(ata, owner);
  return createApproveInstruction(ata, autoPda(owner), owner, BigInt(Math.round(usdc * 1_000_000)));
}

export function PositionStrategy({
  source,
  strategy,
  destinations,
  usdcMint,
  exerciseOpen,
  compact = false,
  onChanged,
}: {
  source: StrategyPool;
  strategy: PoolStrategy | undefined;
  /// Every pool a strategy could compound into (pairs USDC or SOL, holds no oSOLA, has liquidity).
  destinations: StrategyPool[];
  usdcMint: PublicKey | null;
  exerciseOpen: boolean;
  compact?: boolean;
  onChanged: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [draft, setDraft] = useState<Choice | null>(null);
  const [budgetText, setBudgetText] = useState(String(VOTE_BUDGET_DEFAULT));
  const [allowance, setAllowance] = useState<bigint | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const toKey = (p: StrategyPool) => ({
    key: new PublicKey(p.address), mintA: new PublicKey(p.mintA), mintB: new PublicKey(p.mintB),
  });
  // Only the destinations the program would accept for THIS source: a position in the sale or hop
  // pool cannot compound through it.
  const targets = useMemo(
    () => (usdcMint ? destinations.filter((d) => canCompound(toKey(source), toKey(d), usdcMint)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [destinations, source.address, usdcMint],
  );
  const defaultTarget = targets.find((t) => t.address === source.address)?.address ?? targets[0]?.address;

  const saved = currentChoice(strategy);
  const choice = draft ?? saved;
  const interval = strategy?.minInterval ?? STRATEGY_DEFAULTS.minInterval;
  const dirty = !!draft && !same(draft, saved);
  const labelOf = (addr: string) => destinations.find((d) => d.address === addr)?.label ?? `${addr.slice(0, 4)}…`;

  // Switching TO voting power asks for a budget only when none is in place: the allowance is shared,
  // and a position joining the others should not silently resize what they draw from.
  const switchingToVote = choice.kind === "vote" && saved.kind !== "vote";
  useEffect(() => {
    if (!switchingToVote || !wallet || !usdcMint) return;
    voteAllowance(connection, wallet.publicKey, usdcMint).then(setAllowance).catch(() => setAllowance(null));
  }, [switchingToVote, connection, wallet, usdcMint]);
  const needsBudget = switchingToVote && allowance !== undefined && (allowance === null || allowance < BigInt(1_000_000));
  const budget = parseFloat(budgetText) || 0;

  async function save() {
    if (!wallet || !usdcMint || !dirty) return;
    setBusy(true);
    setStatus("");
    try {
      const { ixs, grantsBudget } = await strategyChangeIxs(
        connection, wallet, usdcMint, source.address, strategy, choice,
        { budgetUsdc: needsBudget ? budget : undefined },
      );
      if (ixs.length) await sendTx(connection, wallet, ixs);
      setStatus(grantsBudget !== null ? `✅ Saved, with a ${grantsBudget} USDC budget for strikes.` : "✅ Saved.");
      setDraft(null);
      onChanged();
    } catch (e: any) {
      setStatus(`❌ ${explainRpcRefusal(e) ?? e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  const chip = (active: boolean, disabled = false) =>
    `rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-30 ${
      active
        ? "border-brand-green/60 bg-brand-green/10 text-brand-green"
        : "border-brand-border text-gray-400 hover:border-brand-green/30 hover:text-gray-200"
    }`;
  const select =
    "rounded-lg border border-brand-border bg-brand-dark px-2 py-1.5 text-[11px] text-white focus:border-brand-green focus:outline-none";

  return (
    <div className={compact ? "" : "space-y-2"}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-gray-500">Rewards go</span>
        <span className="flex items-center gap-1">
          <button
            className={chip(choice.kind === "liquidity", targets.length === 0)}
            disabled={targets.length === 0}
            title={targets.length === 0 ? "This position's pool is on the route its rewards would take" : undefined}
            onClick={() => setDraft({ kind: "liquidity", target: choice.kind === "liquidity" ? choice.target : defaultTarget! })}
          >
            Into liquidity
          </button>
          {choice.kind === "liquidity" && (
            <select
              value={choice.target}
              onChange={(e) => setDraft({ kind: "liquidity", target: e.target.value })}
              className={select}
            >
              {targets.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.address === source.address ? `→ this pool` : `→ ${t.label}`}
                </option>
              ))}
            </select>
          )}
        </span>
        <button
          className={chip(choice.kind === "vote", !exerciseOpen)}
          disabled={!exerciseOpen}
          title={!exerciseOpen ? "Exercise is not open yet" : undefined}
          onClick={() => setDraft({ kind: "vote" })}
        >
          Into voting power
        </button>
        <button className={chip(choice.kind === "keep")} onClick={() => setDraft({ kind: "keep" })}>
          Nowhere, I claim by hand
        </button>
      </div>

      {needsBudget && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
          <span>Budget for strikes, shared by your voting positions</span>
          <input
            value={budgetText}
            onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setBudgetText(e.target.value)}
            inputMode="decimal"
            className="w-20 rounded-lg border border-brand-border bg-black/30 px-2 py-1.5 text-[11px] text-white focus:border-brand-green focus:outline-none"
          />
          <span>USDC</span>
        </div>
      )}

      {dirty && (
        <button
          onClick={save}
          disabled={busy || (needsBudget && budget <= 0)}
          className="btn-primary px-3 py-1.5 text-[11px] disabled:opacity-40"
        >
          {busy ? "Sending…" : "Save"}
        </button>
      )}

      {!compact && (
        <p className="text-[11px] leading-relaxed text-gray-600">
          {choice.kind === "liquidity" &&
            `Each round sells this position's oSOLA (never below ${STRATEGY_DEFAULTS.minIntrinsicBps / 100}% of their exercise value) and adds the proceeds to ${
              choice.target === source.address ? "this pool" : labelOf(choice.target)
            }. Needs no USDC: the rewards never reach your wallet.`}
          {choice.kind === "vote" &&
            "Each round exercises this position's oSOLA into staked hiSOLA and pays the strike from your USDC budget for strikes, shared by all your voting positions. When the budget runs out, rounds stop until you top it up."}
          {choice.kind === "keep" && "Nothing automatic: rewards accrue until you claim them."}
          {choice.kind !== "keep" &&
            ` A round runs when a keeper calls it, ${intervalWord(interval)} at most, once ${STRATEGY_DEFAULTS.minHarvest} oSOLA has accrued.`}
          {strategy && strategy.rounds > 0 &&
            ` · ${strategy.rounds} round${strategy.rounds === 1 ? "" : "s"}, ${strategy.harvested.toLocaleString("en-US", { maximumFractionDigits: 2 })} oSOLA so far.`}
        </p>
      )}
      {status && <p className="text-[11px] text-gray-400">{status}</p>}
    </div>
  );
}

/// The USDC budget every voting strategy draws its strikes from, shown and set in one place.
///
/// ☢️ It is the SPL allowance of the `auto` PDA on the owner's USDC account: one number, spent by
/// every voting position (and by a pre-retirement wallet order, if one is left). Setting it replaces the
/// remainder, it does not add to it, and the screen says so.
export function VoteBudget({
  usdcMint,
  voters,
  refreshKey = 0,
}: {
  usdcMint: PublicKey | null;
  /// How many positions currently turn their rewards into voting power.
  voters: number;
  refreshKey?: number;
}) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [left, setLeft] = useState<bigint | null | undefined>(undefined);
  const [balance, setBalance] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    if (!wallet || !usdcMint) return;
    const ata = userAta(usdcMint, wallet.publicKey);
    const [a, b] = await Promise.all([
      voteAllowance(connection, wallet.publicKey, usdcMint).catch(() => null),
      connection.getTokenAccountBalance(ata).then((r) => r.value.uiAmount ?? 0).catch(() => 0),
    ]);
    setLeft(a);
    setBalance(b);
  }, [connection, wallet, usdcMint]);
  useEffect(() => { load(); }, [load, refreshKey]);

  if (!wallet || !usdcMint || voters === 0) return null;

  const leftUsdc = left ? Number(left) / 1_000_000 : 0;
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const value = text === "" ? null : parseFloat(text);

  async function apply() {
    if (!wallet || !usdcMint || value === null || Number.isNaN(value)) return;
    setBusy(true);
    setStatus("");
    try {
      await sendTx(connection, wallet, [buildVoteBudgetInstruction(wallet.publicKey, usdcMint, value)]);
      setStatus(value > 0 ? `✅ Budget set to ${fmt(value)} USDC.` : "✅ Budget withdrawn: voting rounds are paused.");
      setText("");
      setTimeout(load, 1500);
    } catch (e: any) {
      setStatus(`❌ ${explainRpcRefusal(e) ?? e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`space-y-2 rounded-lg border px-3 py-2.5 ${
        left === undefined || leftUsdc >= 1 ? "border-brand-border bg-brand-dark" : "border-yellow-500/30 bg-yellow-500/5"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-300">
          Budget for strikes:{" "}
          <span className="font-mono text-brand-green/90">{left === undefined ? "…" : `${fmt(leftUsdc)} USDC left`}</span>
          <span className="text-gray-500">
            {" "}· shared by {voters} voting position{voters === 1 ? "" : "s"}
            {balance !== null ? ` · ${fmt(balance)} USDC in your wallet` : ""}
          </span>
        </p>
        <div className="flex items-center gap-1.5">
          <input
            value={text}
            onChange={(e) => /^\d*\.?\d*$/.test(e.target.value) && setText(e.target.value)}
            placeholder={left ? fmt(leftUsdc) : String(VOTE_BUDGET_DEFAULT)}
            inputMode="decimal"
            className="w-24 rounded-lg border border-brand-border bg-black/30 px-2 py-1.5 text-[11px] text-white placeholder:text-gray-600 focus:border-brand-green focus:outline-none"
          />
          <span className="text-[11px] text-gray-500">USDC</span>
          <button
            onClick={apply}
            disabled={busy || value === null || Number.isNaN(value)}
            className="btn-secondary px-3 py-1.5 text-[11px] disabled:opacity-40"
          >
            {busy ? "Sending…" : "Set"}
          </button>
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-gray-600">
        {left !== undefined && leftUsdc < 1
          ? "⚠️ Nothing left to pay the strike with: your voting positions are armed but skip every round. "
          : ""}
        The new amount replaces what is left, it does not add to it. It is an SPL allowance: your
        USDC stays in your wallet, the token program enforces the cap, and revoking it from your
        wallet stops every voting round.
      </p>
      {status && <p className="text-[11px] text-gray-400">{status}</p>}
    </div>
  );
}
