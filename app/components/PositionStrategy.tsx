// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
// What happens to ONE position's oSOLA rewards: compounded into liquidity, turned into voting
// power, or kept for a manual claim. Used on each row of the Rewards card and under "My position"
// in Manage LP — the same control in both places, so the choice reads the same wherever it is made.
//
// ☢️ Per position, and independent: the program harvests each position's rewards at the source
// (`crank_pool_strategy_*`), so changing this row never touches another position's rewards.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createApproveInstruction, createRevokeInstruction } from "@solana/spl-token";
import { sendTx, userAta } from "@/lib/program";
import { explainRpcRefusal } from "@/lib/txerror";
import { autoPda } from "@/lib/autocompound";
import { useSoladrome } from "@/lib/SoladromeContext";
import {
  STRATEGY_DEFAULTS, buildCloseStrategyInstruction, buildSetStrategyInstruction, canCompound,
  costPerOSola, dormantAllowance, recentVoteRounds, suggestedVoteBudget, voteAllowance,
  type PoolStrategy, type VoteRound,
} from "@/lib/strategies";

/// A pool as the strategy controls need it.
export type StrategyPool = { address: string; label: string; mintA: string; mintB: string };

/// A pool rewards may compound into, as the pool list names it.
export type LpChoice = { address: string; label: string };

/// The USDC budget offered the first time a position switches to voting power, if none is in place,
/// capped by what the wallet holds (`suggestedVoteBudget`). Shared by every voting strategy: one
/// delegate, one allowance.
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
/// single delegate. Without it, the first switch to voting power grants `VOTE_BUDGET_DEFAULT`, capped
/// by the wallet's balance, if less than 1 USDC is in place. A budget of 0 grants nothing: the
/// strategy is armed and waits for one, rather than leaving an allowance the wallet cannot cover.
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
    if (allowance === null || allowance < BigInt(1_000_000)) {
      const balance = await connection
        .getTokenAccountBalance(userAta(usdcMint, wallet.publicKey))
        .then((r) => r.value.uiAmount ?? 0)
        .catch(() => 0);
      budget = suggestedVoteBudget(balance, VOTE_BUDGET_DEFAULT);
    }
  }
  // ☢️ Never a revoke here: 0 means "grant nothing now", not "withdraw the other positions' budget".
  if (budget !== null && budget > 0) ixs.push(buildVoteBudgetInstruction(wallet.publicKey, usdcMint, budget));
  return { ixs, grantsBudget: budget };
}

/// Set the shared USDC budget for strikes to exactly `usdc` (0 withdraws it).
export function buildVoteBudgetInstruction(owner: PublicKey, usdcMint: PublicKey, usdc: number): TransactionInstruction {
  const ata = userAta(usdcMint, owner);
  if (usdc <= 0) return createRevokeInstruction(ata, owner);
  return createApproveInstruction(ata, autoPda(owner), owner, BigInt(Math.round(usdc * 1_000_000)));
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

// The explorer links follow the RPC, the way `lib/tokens.ts` tells devnet from mainnet.
const CLUSTER_QS = (process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com").includes("devnet") ? "?cluster=devnet" : "";

/// A warning in the strategy controls: amber, one paragraph, never a modal.
function Caution({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-3 py-2 text-[11px] leading-relaxed text-yellow-200/90">
      {children}
    </p>
  );
}

export function PositionStrategy({
  source,
  strategy,
  allStrategies,
  pending = 0,
  destinations,
  usdcMint,
  exerciseOpen,
  compact = false,
  onChanged,
}: {
  source: StrategyPool;
  strategy: PoolStrategy | undefined;
  /// Every strategy of this owner, keyed by source pool: what this position's choice interacts with.
  allStrategies?: Map<string, PoolStrategy>;
  /// oSOLA this position has accrued and not yet harvested.
  pending?: number;
  /// Every pool a strategy could compound into (pairs USDC or SOL, holds no oSOLA, has liquidity).
  destinations: StrategyPool[];
  usdcMint: PublicKey | null;
  exerciseOpen: boolean;
  compact?: boolean;
  onChanged: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { protocolState } = useSoladrome();
  const [draft, setDraft] = useState<Choice | null>(null);
  const [budgetText, setBudgetText] = useState(String(VOTE_BUDGET_DEFAULT));
  const [allowance, setAllowance] = useState<bigint | null | undefined>(undefined);
  const [walletUsdc, setWalletUsdc] = useState<number | null>(null);
  const [budgetTouched, setBudgetTouched] = useState(false);
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
    connection
      .getTokenAccountBalance(userAta(usdcMint, wallet.publicKey))
      .then((r) => setWalletUsdc(r.value.uiAmount ?? 0))
      .catch(() => setWalletUsdc(0));
  }, [switchingToVote, connection, wallet, usdcMint]);
  // The offered amount follows the wallet until the owner types their own.
  useEffect(() => {
    if (walletUsdc !== null && !budgetTouched) setBudgetText(String(suggestedVoteBudget(walletUsdc, VOTE_BUDGET_DEFAULT)));
  }, [walletUsdc, budgetTouched]);
  const needsBudget = switchingToVote && allowance !== undefined && (allowance === null || allowance < BigInt(1_000_000));
  const budget = parseFloat(budgetText) || 0;
  const unitCost = protocolState ? costPerOSola(protocolState) : 1;

  // ☢️ What this choice does to the owner's OTHER positions, and they to it. A deposit into a pool
  // settles the owner's position there and mints its accrual to the wallet (`credit_lp_deposit`),
  // so a pool that receives compounding cannot also run a strategy of its own on its rewards: the
  // devnet owner who sent everything into jitoSOL/SOL and voted jitoSOL/SOL's own rewards saw that
  // vote refused 337 times a day, and never knew why.
  const outgoing =
    choice.kind === "liquidity" && choice.target !== source.address ? allStrategies?.get(choice.target) : undefined;
  const incoming =
    choice.kind === "keep" || !allStrategies
      ? []
      : [...allStrategies.values()].filter(
          (s) => s.mode === "liquidity" && s.targetPool?.toBase58() === source.address && s.sourcePool.toBase58() !== source.address,
        );
  const modeWord = (m: PoolStrategy["mode"]) => (m === "vote" ? "into voting power" : "into liquidity");

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
      setStatus(
        grantsBudget === null
          ? "✅ Saved."
          : grantsBudget > 0
            ? `✅ Saved, with a ${grantsBudget} USDC budget for strikes.`
            : "✅ Saved, without a budget: the strategy waits until you set one below.",
      );
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
            onChange={(e) => {
              if (!/^\d*\.?\d*$/.test(e.target.value)) return;
              setBudgetTouched(true);
              setBudgetText(e.target.value);
            }}
            inputMode="decimal"
            className="w-20 rounded-lg border border-brand-border bg-black/30 px-2 py-1.5 text-[11px] text-white focus:border-brand-green focus:outline-none"
          />
          <span>USDC{walletUsdc !== null ? ` · ${fmt(walletUsdc)} in your wallet` : ""}</span>
        </div>
      )}
      {needsBudget && walletUsdc !== null && budget > walletUsdc && (
        <Caution>
          ⚠️ That is more than your wallet holds. The {fmt(budget - walletUsdc)} USDC above it do not stay unused:
          any USDC that reaches this wallet later can be spent on strikes, up to that amount.
        </Caution>
      )}
      {needsBudget && budget <= 0 && (
        <p className="text-[11px] leading-relaxed text-gray-500">
          No budget: the strategy is armed but skips every round until you set one.
        </p>
      )}

      {outgoing && (
        <Caution>
          ⚠️ {labelOf(choice.kind === "liquidity" ? choice.target : "")} has a strategy of its own (rewards{" "}
          {modeWord(outgoing.mode)}). Every round of this one deposits there, and a deposit first pays that
          position&apos;s pending oSOLA to your wallet, as plain oSOLA. Its own strategy then only gets what
          accrues between two of these rounds, and may never run. Pick another destination, or keep this
          one hourly and claim the oSOLA from your wallet with &quot;Right now, by hand&quot;.
        </Caution>
      )}
      {incoming.length > 0 && (
        <Caution>
          ⚠️ {incoming.length === 1 ? "One of your positions compounds" : `${incoming.length} of your positions compound`} into
          this pool ({incoming.map((s) => labelOf(s.sourcePool.toBase58())).join(", ")}). Each of their deposits pays
          this position&apos;s pending oSOLA to your wallet first, so the strategy chosen here only gets what accrues
          in between.
        </Caution>
      )}
      {choice.kind === "vote" && pending >= STRATEGY_DEFAULTS.minHarvest && (
        <p className="text-[11px] leading-relaxed text-gray-400">
          {fmt(pending)} oSOLA are already waiting on this position: the next round exercises them and spends
          about <span className="font-mono text-gray-200">{fmt(pending * unitCost)} USDC</span> of your budget
          at once, as soon as a keeper passes (within minutes), for as much hiSOLA.
        </p>
      )}

      {dirty && (
        <button
          onClick={save}
          disabled={busy}
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
            ` · ${strategy.rounds} round${strategy.rounds === 1 ? "" : "s"} so far, ${fmt(strategy.harvested)} ${
              strategy.mode === "vote" ? "hiSOLA added to your stake" : "oSOLA compounded"
            }.`}
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
  backlog = 0,
  refreshKey = 0,
}: {
  usdcMint: PublicKey | null;
  /// How many positions currently turn their rewards into voting power.
  voters: number;
  /// oSOLA already accrued on those positions: what the next rounds spend the budget on first.
  backlog?: number;
  refreshKey?: number;
}) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { protocolState } = useSoladrome();
  const [rounds, setRounds] = useState<VoteRound[] | null>(null);
  const [showRounds, setShowRounds] = useState(false);
  const [roundsError, setRoundsError] = useState("");
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

  // The history is read on demand only: one RPC call per round, for a list most never open.
  useEffect(() => {
    if (!showRounds || !wallet || !usdcMint) return;
    setRoundsError("");
    recentVoteRounds(connection, wallet.publicKey, usdcMint)
      .then(setRounds)
      .catch((e) => setRoundsError(String(e?.message ?? e).slice(0, 120)));
  }, [showRounds, connection, wallet, usdcMint, refreshKey]);

  if (!wallet || !usdcMint || voters === 0) return null;

  const leftUsdc = left ? Number(left) / 1_000_000 : 0;
  const value = text === "" ? null : parseFloat(text);
  const unitCost = protocolState ? costPerOSola(protocolState) : 1;
  const backlogUsdc = backlog * unitCost;
  // A round spends min(allowance, balance): the screen says which one is the real limit.
  const spendable = balance === null ? leftUsdc : Math.min(leftUsdc, balance);
  const dormant = balance === null || left === undefined ? 0 : dormantAllowance(leftUsdc, balance);
  const aboveBalance = value !== null && !Number.isNaN(value) && balance !== null ? dormantAllowance(value, balance) : 0;
  // What a new amount does at once: the backlog takes its share first, at the next keeper pass.
  const preview =
    value !== null && !Number.isNaN(value) && value > 0 && backlog >= STRATEGY_DEFAULTS.minHarvest
      ? (() => {
          const now = Math.min(value, balance ?? value, backlogUsdc);
          return { now, hiSola: now / unitCost, rest: Math.max(0, Math.min(value, balance ?? value) - now) };
        })()
      : null;

  async function apply(amount: number | null = value) {
    if (!wallet || !usdcMint || amount === null || Number.isNaN(amount)) return;
    setBusy(true);
    setStatus("");
    try {
      await sendTx(connection, wallet, [buildVoteBudgetInstruction(wallet.publicKey, usdcMint, amount)]);
      setStatus(amount > 0 ? `✅ Budget set to ${fmt(amount)} USDC.` : "✅ Budget withdrawn: voting rounds are paused.");
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
            placeholder={left ? fmt(leftUsdc) : String(suggestedVoteBudget(balance ?? 0, VOTE_BUDGET_DEFAULT))}
            inputMode="decimal"
            className="w-24 rounded-lg border border-brand-border bg-black/30 px-2 py-1.5 text-[11px] text-white placeholder:text-gray-600 focus:border-brand-green focus:outline-none"
          />
          <span className="text-[11px] text-gray-500">USDC</span>
          <button
            onClick={() => apply()}
            disabled={busy || value === null || Number.isNaN(value)}
            className="btn-secondary px-3 py-1.5 text-[11px] disabled:opacity-40"
          >
            {busy ? "Sending…" : "Set"}
          </button>
          {leftUsdc > 0 && (
            <button
              onClick={() => apply(0)}
              disabled={busy}
              title="Revokes the allowance: no voting round can spend anything until you set a new budget"
              className="rounded-lg border border-brand-border px-3 py-1.5 text-[11px] text-gray-400 transition-colors hover:border-red-400/40 hover:text-red-300 disabled:opacity-40"
            >
              Withdraw the rest
            </button>
          )}
        </div>
      </div>
      {backlog >= STRATEGY_DEFAULTS.minHarvest && (
        <p className="text-[11px] leading-relaxed text-gray-400">
          Waiting on your voting positions:{" "}
          <span className="font-mono text-gray-200">{fmt(backlog)} oSOLA</span>, about{" "}
          <span className="font-mono text-gray-200">{fmt(backlogUsdc)} USDC</span> of strikes.{" "}
          {spendable >= 1
            ? "The next rounds spend the budget on these first."
            : "They are exercised as soon as the budget covers them: within minutes of setting one."}
        </p>
      )}
      {preview && (
        <p className="rounded-lg border border-brand-border bg-black/20 px-3 py-2 text-[11px] leading-relaxed text-gray-300">
          With {fmt(value!)} USDC: about <span className="font-mono">{fmt(preview.now)} USDC</span> is spent within
          minutes on what is already waiting (≈ +{fmt(preview.hiSola)} hiSOLA)
          {preview.rest > 0
            ? `, and ${fmt(preview.rest)} USDC is left for rewards still to come.`
            : ". Nothing is left after that: rounds stop until you set a new budget."}
        </p>
      )}
      {aboveBalance >= 0.01 ? (
        <Caution>
          ⚠️ {fmt(value!)} USDC is more than your wallet holds ({fmt(balance!)}). The {fmt(aboveBalance)} USDC above it
          do not stay unused: any USDC that reaches this wallet later can be spent on strikes, up to that amount.
        </Caution>
      ) : (
        value === null &&
        dormant >= 1 && (
          <Caution>
            ⚠️ {fmt(leftUsdc)} USDC of budget is left, but your wallet holds {fmt(balance!)}. The other{" "}
            {fmt(dormant)} USDC are waiting: any USDC that reaches this wallet, for whatever reason, can be spent on
            strikes within minutes, up to that amount. &quot;Withdraw the rest&quot; stops it.
          </Caution>
        )
      )}
      <p className="text-[11px] leading-relaxed text-gray-600">
        {left !== undefined && leftUsdc < 1
          ? "⚠️ Nothing left to pay the strike with: your voting positions are armed but skip every round. "
          : ""}
        This is a spending cap, not a deposit: every round lowers it, and the USDC it spends becomes
        hiSOLA on your stake (credited to your position, so it does not show as a token in your
        wallet). A round never spends more than what is left: past it, the rest of your rewards
        stays accrued on the position until the budget covers it. The new amount replaces what is
        left, it does not add to it. Your USDC stays in your wallet until a round spends it, and
        revoking the allowance from your wallet stops every voting round.
      </p>
      <button
        onClick={() => setShowRounds((o) => !o)}
        className="text-[11px] text-gray-500 transition-colors hover:text-gray-300"
      >
        {showRounds ? "▾" : "▸"} Recent voting rounds
      </button>
      {showRounds && (
        <div className="space-y-1">
          {roundsError ? (
            <p className="text-[11px] text-gray-500">Could not read the history: {roundsError}</p>
          ) : rounds === null ? (
            <p className="text-[11px] text-gray-500">Reading…</p>
          ) : rounds.length === 0 ? (
            <p className="text-[11px] text-gray-500">No voting round yet.</p>
          ) : (
            rounds.map((r) => (
              <a
                key={r.signature}
                href={`https://explorer.solana.com/tx/${r.signature}${CLUSTER_QS}`}
                target="_blank"
                rel="noreferrer"
                className="flex justify-between gap-3 font-mono text-[11px] text-gray-400 hover:text-gray-200"
              >
                <span>{r.time ? new Date(r.time * 1000).toLocaleString() : "—"}</span>
                <span>
                  −{fmt(r.usdcSpent)} USDC → <span className="text-brand-green/90">+{fmt(r.hiSola)} hiSOLA</span>
                </span>
              </a>
            ))
          )}
        </div>
      )}
      {status && <p className="text-[11px] text-gray-400">{status}</p>}
    </div>
  );
}
