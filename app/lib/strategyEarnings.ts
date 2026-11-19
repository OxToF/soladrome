// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// What a holder's strategies have earned, and whether their voting rounds can keep running.
//
// Two sources, deliberately kept apart on screen:
//
//   · ON CHAIN, exact, lifetime: `PoolStrategy.harvested` and `rounds`. A voting round turns each
//     harvested oSOLA into exactly one staked SOLA, so a voting strategy's lifetime hiSOLA IS its
//     `harvested`, and its USDC cost is at least that much (the strike), never less.
//   · FROM TRANSACTIONS, exact per round but only as far back as we read: the USDC a voting round
//     really paid (strike plus the fee on the gain), the LP a liquidity round really minted. The
//     program keeps no lifetime counter for either, so the history is read on demand and labelled
//     with how many rounds it covers.
//
// The budget alert reads only on-chain state: the allowance to the `auto` delegate, the balance
// behind it, what is waiting on the positions, and the rate they accrue at. No address, email or
// subscription is stored anywhere.
import type { Connection, PublicKey } from "@solana/web3.js";
import { decimalsForMint } from "./tokens";

/// One strategy round as the owner lived it.
export type StrategyRound = {
  signature: string;
  time: number | null;
  mode: "vote" | "liquidity";
  /// Voting: net USDC that left the owner's account (strike + fee, less the protocol fees their
  /// stake was paid in the same instruction). Zero for a liquidity round, which costs no USDC.
  usdcSpent: number;
  /// Voting: SOLA minted and staked for the owner.
  hiSola: number;
  /// Liquidity: LP minted into the owner's account of the destination pool.
  lpMinted: number;
  /// Liquidity: oSOLA the round could not sell in one leg (or a target position's settled
  /// accrual), minted to the owner's wallet instead. Theirs, just not compounded.
  oSolaToWallet: number;
};

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { uiAmount: number | null } };
type ParsedTxLike = {
  blockTime?: number | null;
  meta: {
    err: unknown;
    logMessages?: string[] | null;
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
  } | null;
} | null;

const VOTE_LOG = "Program log: Instruction: CrankPoolStrategyVote";
const LP_LOG = "Program log: Instruction: CrankPoolStrategyLp";

/// Read a strategy round out of a parsed transaction, or null when it is not a successful one.
/// Pure, so the arithmetic is tested against real balances rather than a live RPC.
export function strategyRoundFromTx(
  tx: ParsedTxLike,
  signature: string,
  owner: string,
  mints: { usdc: string; sola: string; oSola: string; lp: string | null },
): StrategyRound | null {
  if (!tx?.meta || tx.meta.err) return null;
  const logs = tx.meta.logMessages ?? [];
  const mode = logs.includes(VOTE_LOG) ? "vote" : logs.includes(LP_LOG) ? "liquidity" : null;
  if (!mode) return null;
  const pre = new Map((tx.meta.preTokenBalances ?? []).map((b) => [b.accountIndex, b.uiTokenAmount.uiAmount ?? 0]));
  const r: StrategyRound = { signature, time: tx.blockTime ?? null, mode, usdcSpent: 0, hiSola: 0, lpMinted: 0, oSolaToWallet: 0 };
  for (const b of tx.meta.postTokenBalances ?? []) {
    const d = (b.uiTokenAmount.uiAmount ?? 0) - (pre.get(b.accountIndex) ?? 0);
    if (mode === "vote") {
      if (b.mint === mints.usdc && b.owner === owner) r.usdcSpent -= d;
      // The stake lands in the protocol's SOLA vault: every unit minted in this round is the owner's.
      if (b.mint === mints.sola && d > 0) r.hiSola += d;
    } else {
      if (mints.lp && b.mint === mints.lp && b.owner === owner && d > 0) r.lpMinted += d;
      if (b.mint === mints.oSola && b.owner === owner && d > 0) r.oSolaToWallet += d;
    }
  }
  return r;
}

/// A strategy's latest rounds, newest first. Every round writes the strategy account, so its
/// history is that account's. One RPC call for the signatures and one batch for the transactions;
/// read on load and on refresh only, never on a timer (Helius quota, 2026-10-22).
export async function strategyRounds(
  connection: Connection,
  strategy: PublicKey,
  owner: PublicKey,
  mode: StrategyRound["mode"],
  mints: { usdc: string; sola: string; oSola: string; lp: string | null },
  limit = 20,
): Promise<{ rounds: StrategyRound[]; complete: boolean }> {
  const sigs = await connection.getSignaturesForAddress(strategy, { limit });
  const ok = sigs.filter((s) => !s.err).map((s) => s.signature);
  if (!ok.length) return { rounds: [], complete: true };
  const txs = await connection.getParsedTransactions(ok, { maxSupportedTransactionVersion: 0 });
  const rounds: StrategyRound[] = [];
  txs.forEach((tx, i) => {
    const r = strategyRoundFromTx(tx as any, ok[i], owner.toBase58(), mints);
    // ☢️ Only rounds of the strategy's CURRENT mode. `set_pool_strategy` may switch a position
    // from liquidity to voting power on the same account, and its older rounds would otherwise be
    // summed as the new mode's (devnet 2Bhw, 2026-11-17: 804 rounds, the last 18 read were LP).
    if (r && r.mode === mode) rounds.push(r);
  });
  // Fewer signatures than asked means we reached the account's creation: the history is whole.
  return { rounds, complete: sigs.length < limit };
}

/// Sum of a list of rounds.
export function sumRounds(rounds: StrategyRound[]) {
  return rounds.reduce(
    (a, r) => ({
      usdcSpent: a.usdcSpent + r.usdcSpent,
      hiSola: a.hiSola + r.hiSola,
      lpMinted: a.lpMinted + r.lpMinted,
      oSolaToWallet: a.oSolaToWallet + r.oSolaToWallet,
    }),
    { usdcSpent: 0, hiSola: 0, lpMinted: 0, oSolaToWallet: 0 },
  );
}

/// oSOLA a voting strategy actually converted per day over the recent rounds — the fallback when
/// the accumulator says nothing accrues now. The continuous channel can end (devnet, 2026-11-17:
/// `continuous_end_epoch` 2965 < 2967) while per-epoch emissions still land in the accumulator at
/// each rollover, which a one-day projection of the continuous rate cannot see. Null with fewer
/// than two rounds in the window: one point is no rate.
export function recentVoteRate(rounds: StrategyRound[], nowSec: number, windowDays = 14): number | null {
  const from = nowSec - windowDays * 86_400;
  const inWindow = rounds.filter((r) => r.mode === "vote" && r.time !== null && r.time >= from);
  if (inWindow.length < 2) return null;
  const oldest = Math.min(...inWindow.map((r) => r.time!));
  const days = Math.max(1, (nowSec - oldest) / 86_400);
  return inWindow.reduce((a, r) => a + r.hiSola, 0) / days;
}

/// USDC value of one LP token of `pool`, from the protocol's own pools only — no external price.
/// A USDC side is worth its reserve; a SOL side is priced off THE SOL/USDC pool. Both sides of a
/// constant-product pool are worth the same, so the pool is twice one side. Null when neither side
/// can be priced (an LST/xStock pair with no USDC or SOL leg): the screen then shows LP units only.
export function lpPriceUsdc(
  pool: { tokenAMint: string; tokenBMint: string; reserveA: bigint; reserveB: bigint; totalLp: bigint },
  usdcMint: string,
  solPriceUsdc: number | null,
  wsolMint: string,
): number | null {
  if (pool.totalLp <= BigInt(0)) return null;
  const side = (mint: string, reserve: bigint) => Number(reserve) / 10 ** decimalsForMint(mint, null);
  const a = side(pool.tokenAMint, pool.reserveA);
  const b = side(pool.tokenBMint, pool.reserveB);
  let tvl: number | null = null;
  if (pool.tokenAMint === usdcMint) tvl = 2 * a;
  else if (pool.tokenBMint === usdcMint) tvl = 2 * b;
  else if (solPriceUsdc && pool.tokenAMint === wsolMint) tvl = 2 * a * solPriceUsdc;
  else if (solPriceUsdc && pool.tokenBMint === wsolMint) tvl = 2 * b * solPriceUsdc;
  if (tvl === null || !(tvl > 0)) return null;
  return tvl / (Number(pool.totalLp) / 1e6); // LP mints: 6 decimals
}

export type BudgetAlert = {
  level: "ok" | "warn" | "critical";
  title: string;
  detail: string;
  /// Days the spendable budget covers at today's accrual, or null when nothing accrues.
  runwayDays: number | null;
  /// USDC that would clear what is waiting now and cover `targetDays` more.
  topUpUsdc: number;
};

/// Below this many days of budget, the dashboard asks for a top-up.
export const RUNWAY_WARN_DAYS = 7;

/// Whether a holder's voting strategies can keep running, and what to add if not.
///
/// ☢️ A round spends `min(allowance, balance)`. The two shortfalls need different gestures and the
/// alert must not confuse them: an allowance above the balance is a DORMANT remainder that any USDC
/// reaching the wallet will fund at once (devnet, 2026-10-06), so the fix there is "add USDC to the
/// wallet", not "raise the budget" — raising it would only enlarge the dormant part.
export function budgetAlert(i: {
  /// USDC allowance left to the `auto` delegate.
  allowance: number;
  /// USDC in the owner's wallet.
  balance: number;
  /// oSOLA already accrued on voting positions, waiting for a round.
  backlog: number;
  /// oSOLA the voting positions accrue per day.
  perDay: number;
  /// USDC per oSOLA exercised now, strike and fee (`costPerOSola`).
  unitCost: number;
  /// Smallest round any voting strategy accepts (`min_harvest`), in oSOLA.
  minHarvest: number;
  targetDays?: number;
}): BudgetAlert {
  const target = i.targetDays ?? 30;
  const spendable = Math.max(0, Math.min(i.allowance, i.balance));
  const backlogUsdc = i.backlog * i.unitCost;
  const dailyUsdc = i.perDay * i.unitCost;
  const needed = backlogUsdc + dailyUsdc * target;
  const topUpUsdc = Math.max(0, Math.ceil((needed - spendable) * 100) / 100);
  const runwayDays = dailyUsdc > 0 ? Math.max(0, (spendable - backlogUsdc) / dailyUsdc) : null;
  const where = i.allowance > i.balance
    ? "add USDC to your wallet (the budget you set already covers it)"
    : i.balance > i.allowance
      ? "raise your voting budget — your wallet already holds the USDC"
      : "add USDC to your wallet and raise your voting budget";

  if (spendable < i.minHarvest * i.unitCost) {
    return {
      level: "critical",
      title: "Voting rounds are paused",
      detail: `${i.allowance <= 0 ? "No USDC budget is set" : i.balance <= 0 ? "Your wallet holds no USDC" : "The budget left cannot pay a single round"}. `
        + `Your rewards keep accruing on the positions and nothing is lost; they convert once you ${where}.`,
      runwayDays: 0,
      topUpUsdc,
    };
  }
  if (backlogUsdc > spendable) {
    return {
      level: "warn",
      title: `${fmt(i.backlog)} oSOLA are waiting for USDC`,
      detail: `The next round converts what ${fmt(spendable)} USDC pays for; the rest waits on the position. To clear it, ${where}.`,
      runwayDays,
      topUpUsdc,
    };
  }
  if (runwayDays !== null && runwayDays < RUNWAY_WARN_DAYS) {
    return {
      level: "warn",
      title: `About ${runwayDays < 1 ? "less than a day" : `${Math.floor(runwayDays)} day${Math.floor(runwayDays) === 1 ? "" : "s"}`} of budget left`,
      detail: `At today's rate your voting positions need ~${fmt(dailyUsdc)} USDC a day. To keep converting, ${where}.`,
      runwayDays,
      topUpUsdc,
    };
  }
  return {
    level: "ok",
    title: runwayDays === null ? "Budget in place" : `Budget covers ~${Math.floor(runwayDays)} days`,
    detail: runwayDays === null
      ? "Your voting positions are not accruing right now."
      : `~${fmt(dailyUsdc)} USDC a day at today's rate.`,
    runwayDays,
    topUpUsdc,
  };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 2 : 0 });
}
