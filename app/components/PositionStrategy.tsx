// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
// What happens to ONE position's oSOLA rewards: compounded into liquidity, turned into voting
// power, or kept for a manual claim. Used on each row of the Rewards card and under "My position"
// in Manage LP — the same control in both places, so the choice reads the same wherever it is made.
//
// ☢️ Per position, and independent: the program harvests each position's rewards at the source
// (`crank_pool_strategy_*`), so changing this row never touches another position's rewards.
import { useMemo, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createApproveInstruction } from "@solana/spl-token";
import { sendTx, userAta } from "@/lib/program";
import { explainRpcRefusal } from "@/lib/txerror";
import { autoPda } from "@/lib/autocompound";
import {
  STRATEGY_DEFAULTS, buildCloseStrategyInstruction, buildSetStrategyInstruction, canCompound,
  voteAllowance, type PoolStrategy,
} from "@/lib/strategies";

/// A pool as the strategy controls need it.
export type StrategyPool = { address: string; label: string; mintA: string; mintB: string };

/// The USDC budget granted the first time a position switches to voting power, if none is in place.
/// Shared by every voting strategy (and the wallet order): one delegate, one allowance.
export const VOTE_BUDGET_DEFAULT = 100;

type Choice = { kind: "liquidity"; target: string } | { kind: "vote" } | { kind: "keep" };

function currentChoice(s: PoolStrategy | undefined): Choice {
  if (!s) return { kind: "keep" };
  if (s.mode === "vote") return { kind: "vote" };
  return { kind: "liquidity", target: s.targetPool!.toBase58() };
}

const same = (a: Choice, b: Choice) =>
  a.kind === b.kind && (a.kind !== "liquidity" || (b.kind === "liquidity" && a.target === b.target));

/// The instructions that take a position from its current strategy to `choice`.
export async function strategyChangeIxs(
  connection: ReturnType<typeof useConnection>["connection"],
  wallet: NonNullable<ReturnType<typeof useAnchorWallet>>,
  usdcMint: PublicKey,
  source: string,
  current: PoolStrategy | undefined,
  choice: Choice,
): Promise<{ ixs: TransactionInstruction[]; grantsBudget: boolean }> {
  const src = new PublicKey(source);
  if (choice.kind === "keep") {
    return { ixs: current ? [await buildCloseStrategyInstruction(connection, wallet, src)] : [], grantsBudget: false };
  }
  if (choice.kind === "liquidity") {
    return {
      ixs: [await buildSetStrategyInstruction(connection, wallet, src, { mode: "liquidity", target: new PublicKey(choice.target) })],
      grantsBudget: false,
    };
  }
  const ixs = [await buildSetStrategyInstruction(connection, wallet, src, { mode: "vote" })];
  // A voting strategy pays the strike in USDC through the order's delegate. Without an allowance it
  // would be armed and never fire, so the first switch grants a modest one, stated on screen.
  const allowance = await voteAllowance(connection, wallet.publicKey, usdcMint);
  const grantsBudget = allowance === null || allowance < BigInt(1_000_000);
  if (grantsBudget) {
    ixs.push(
      createApproveInstruction(
        userAta(usdcMint, wallet.publicKey),
        autoPda(wallet.publicKey),
        wallet.publicKey,
        BigInt(VOTE_BUDGET_DEFAULT * 1_000_000),
      ),
    );
  }
  return { ixs, grantsBudget };
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
  const dirty = !!draft && !same(draft, saved);
  const labelOf = (addr: string) => destinations.find((d) => d.address === addr)?.label ?? `${addr.slice(0, 4)}…`;

  async function save() {
    if (!wallet || !usdcMint || !draft) return;
    setBusy(true);
    setStatus("");
    try {
      const { ixs, grantsBudget } = await strategyChangeIxs(connection, wallet, usdcMint, source.address, strategy, draft);
      if (ixs.length) await sendTx(connection, wallet, ixs);
      setStatus(grantsBudget ? `✅ Saved — with a ${VOTE_BUDGET_DEFAULT} USDC budget for strikes.` : "✅ Saved.");
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

  return (
    <div className={compact ? "" : "space-y-2"}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1">
          <button
            className={chip(choice.kind === "liquidity", targets.length === 0)}
            disabled={targets.length === 0}
            title={targets.length === 0 ? "This position's pool is on the route its rewards would take" : undefined}
            onClick={() => setDraft({ kind: "liquidity", target: choice.kind === "liquidity" ? choice.target : defaultTarget! })}
          >
            Compound
          </button>
          {choice.kind === "liquidity" && (
            <select
              value={choice.target}
              onChange={(e) => setDraft({ kind: "liquidity", target: e.target.value })}
              className="rounded-lg border border-brand-border bg-brand-dark px-2 py-1.5 text-[11px] text-white focus:border-brand-green focus:outline-none"
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
          Voting power
        </button>
        <button className={chip(choice.kind === "keep")} onClick={() => setDraft({ kind: "keep" })}>
          Keep as oSOLA
        </button>
        {dirty && (
          <button onClick={save} disabled={busy} className="btn-primary px-3 py-1.5 text-[11px] disabled:opacity-40">
            {busy ? "Sending…" : "Save"}
          </button>
        )}
      </div>

      {!compact && (
        <p className="text-[11px] leading-relaxed text-gray-600">
          {choice.kind === "liquidity" &&
            `Each round sells this position's oSOLA — never below ${STRATEGY_DEFAULTS.minIntrinsicBps / 100}% of their exercise value — and adds the proceeds to ${
              choice.target === source.address ? "this pool" : labelOf(choice.target)
            }. At most hourly, from ${STRATEGY_DEFAULTS.minHarvest} oSOLA. Needs no allowance: the rewards never reach your wallet.`}
          {choice.kind === "vote" &&
            `Each round exercises this position's oSOLA into staked hiSOLA, paying the strike from a USDC budget shared by your voting strategies. At most hourly, from ${STRATEGY_DEFAULTS.minHarvest} oSOLA.`}
          {choice.kind === "keep" && "Nothing automatic: rewards accrue until you claim them."}
          {strategy && strategy.rounds > 0 &&
            ` · ${strategy.rounds} round${strategy.rounds === 1 ? "" : "s"}, ${strategy.harvested.toLocaleString("en-US", { maximumFractionDigits: 2 })} oSOLA so far.`}
        </p>
      )}
      {status && <p className="text-[11px] text-gray-400">{status}</p>}
    </div>
  );
}
