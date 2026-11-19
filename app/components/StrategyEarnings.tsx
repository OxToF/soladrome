// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
// "My strategies" in the Portfolio: what each position's strategy has earned, what it earns now,
// and — for voting strategies — whether the USDC budget can keep paying the strikes.
//
// Read on wallet connect and on "soladrome:refresh" only, never on a timer: the history is one
// signature call plus one transaction batch per strategy (Helius quota, 2026-10-22).
import { useCallback, useEffect, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useSoladrome } from "@/lib/SoladromeContext";
import { solaM, oSolaM, userAta, WSOL_MINT_STR } from "@/lib/program";
import {
  readStrategies, pendingForPositions, voteAllowance, costPerOSola, type PoolStrategy,
} from "@/lib/strategies";
import {
  strategyRounds, sumRounds, lpPriceUsdc, budgetAlert, recentVoteRate, type StrategyRound, type BudgetAlert,
} from "@/lib/strategyEarnings";
import { symbolByMint, decimalsForMint } from "@/lib/tokens";

type Row = {
  s: PoolStrategy;
  pending: number;
  perDay: number;
  rounds: StrategyRound[];
  complete: boolean;
  historyError: string;
};

const nav = (page: string) => window.dispatchEvent(new CustomEvent("nav", { detail: page }));
const num = (n: number, d = 2) => n.toLocaleString(undefined, { maximumFractionDigits: d });
const usd = (n: number) =>
  `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function StrategyEarnings({ solaPrice, oSolaPrice }: { solaPrice: number; oSolaPrice: number }) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint, protocolState, ammPools } = useSoladrome();

  const [rows, setRows] = useState<Row[] | null>(null);
  const [budget, setBudget] = useState<{ allowance: number; balance: number } | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const poolOf = useCallback(
    (key: PublicKey | null) => (key ? ammPools.find((p: any) => p.publicKey.equals(key)) : undefined),
    [ammPools],
  );

  const load = useCallback(async () => {
    if (!wallet || !usdcMint || !protocolState) return;
    setError("");
    try {
      const strategies = [...(await readStrategies(connection, wallet)).values()];
      if (!strategies.length) { setRows([]); return; }
      const pend = await pendingForPositions(
        connection, wallet, wallet.publicKey, strategies.map((s) => s.sourcePool), protocolState,
      );
      const histories = await Promise.all(
        strategies.map(async (s) => {
          const lp = s.mode === "liquidity" ? poolOf(s.targetPool)?.account.lpMint?.toBase58() ?? null : null;
          try {
            const h = await strategyRounds(connection, s.address, wallet.publicKey, s.mode, {
              usdc: usdcMint.toBase58(), sola: solaM.toBase58(), oSola: oSolaM.toBase58(), lp,
            });
            return { ...h, historyError: "" };
          } catch (e: any) {
            return { rounds: [], complete: false, historyError: String(e?.message ?? e).slice(0, 100) };
          }
        }),
      );
      setRows(strategies.map((s, i) => {
        const p = pend.get(s.sourcePool.toBase58());
        return { s, pending: p?.pending ?? 0, perDay: p?.perDay ?? 0, ...histories[i] };
      }));
      if (strategies.some((s) => s.mode === "vote")) {
        const [allowance, balance] = await Promise.all([
          voteAllowance(connection, wallet.publicKey, usdcMint).catch(() => null),
          connection.getTokenAccountBalance(userAta(usdcMint, wallet.publicKey))
            .then((r) => r.value.uiAmount ?? 0).catch(() => 0),
        ]);
        setBudget({ allowance: allowance ? Number(allowance) / 1e6 : 0, balance });
      } else {
        setBudget(null);
      }
    } catch (e: any) {
      setError(String(e?.message ?? e).slice(0, 140));
    }
  }, [connection, wallet, usdcMint, protocolState, poolOf]);

  useEffect(() => {
    load();
    window.addEventListener("soladrome:refresh", load);
    return () => window.removeEventListener("soladrome:refresh", load);
  }, [load]);

  if (!wallet || !usdcMint) return null;

  const usdcStr = usdcMint.toBase58();
  // SOL priced off THE SOL/USDC pool, with each side's own decimals (wSOL has 9).
  const solPool = ammPools.find((p: any) => {
    const a = p.account.tokenAMint.toBase58(), b = p.account.tokenBMint.toBase58();
    return (a === WSOL_MINT_STR && b === usdcStr) || (a === usdcStr && b === WSOL_MINT_STR);
  });
  const solPrice = (() => {
    if (!solPool) return null;
    const a = solPool.account.tokenAMint.toBase58();
    const ra = Number(solPool.account.reserveA) / 10 ** decimalsForMint(a, usdcMint);
    const rb = Number(solPool.account.reserveB) / 10 ** decimalsForMint(solPool.account.tokenBMint.toBase58(), usdcMint);
    if (!(ra > 0 && rb > 0)) return null;
    return a === WSOL_MINT_STR ? rb / ra : ra / rb;
  })();
  const lpPrice = (key: PublicKey | null) => {
    const p = poolOf(key);
    if (!p) return null;
    return lpPriceUsdc(
      {
        tokenAMint: p.account.tokenAMint.toBase58(), tokenBMint: p.account.tokenBMint.toBase58(),
        reserveA: BigInt(p.account.reserveA.toString()), reserveB: BigInt(p.account.reserveB.toString()),
        totalLp: BigInt(p.account.totalLp.toString()),
      },
      usdcStr, solPrice, WSOL_MINT_STR,
    );
  };
  const label = (key: PublicKey | null) => {
    const p = poolOf(key);
    if (!p) return key ? `${key.toBase58().slice(0, 4)}…` : "—";
    return `${symbolByMint(p.account.tokenAMint.toBase58(), usdcMint)}/${symbolByMint(p.account.tokenBMint.toBase58(), usdcMint)}`;
  };

  // ── Per-strategy figures ──────────────────────────────────────────────────
  const unitCost = protocolState ? costPerOSola(protocolState) : 1;
  const figures = (rows ?? []).map((r) => {
    const loaded = sumRounds(r.rounds);
    if (r.s.mode === "vote") {
      // Lifetime hiSOLA is exact on chain: one staked SOLA per harvested oSOLA. The USDC is exact
      // for the rounds read; older rounds are counted at the 1 USDC strike, the least they paid.
      const hiSola = r.s.harvested;
      const older = Math.max(0, hiSola - loaded.hiSola);
      const paid = loaded.usdcSpent + older;
      const value = hiSola * solaPrice;
      return { r, earned: value - paid, value, paid, paidExact: r.complete || older < 1e-6, hiSola, lp: 0, lpValue: null };
    }
    // LP is only known for the rounds read. With the whole history, the LP minted (plus any
    // overflow oSOLA) is the earning; otherwise the lifetime oSOLA harvested, at today's price.
    const price = lpPrice(r.s.targetPool);
    const lpValue = price !== null ? loaded.lpMinted * price : null;
    const earned = lpValue !== null && r.complete
      ? lpValue + loaded.oSolaToWallet * oSolaPrice
      : r.s.harvested * oSolaPrice;
    return { r, earned, value: earned, paid: 0, paidExact: true, hiSola: 0, lp: loaded.lpMinted, lpValue };
  });
  const totalEarned = figures.reduce((a, f) => a + f.earned, 0);
  const perDayUsd = (rows ?? []).reduce((a, r) => a + r.perDay * oSolaPrice, 0);

  // ── The USDC alert ────────────────────────────────────────────────────────
  const voteRows = (rows ?? []).filter((r) => r.s.mode === "vote");
  const alert: BudgetAlert | null = budget && voteRows.length
    ? budgetAlert({
        allowance: budget.allowance,
        balance: budget.balance,
        backlog: voteRows.reduce((a, r) => a + r.pending, 0),
        // The accumulator's projection, or what the rounds actually converted lately if larger.
        perDay: voteRows.reduce(
          (a, r) => a + Math.max(r.perDay, recentVoteRate(r.rounds, Math.floor(Date.now() / 1000)) ?? 0),
          0,
        ),
        unitCost,
        minHarvest: Math.min(...voteRows.map((r) => r.s.minHarvest)),
      })
    : null;
  const tone = alert?.level === "critical"
    ? "border-red-500/40 bg-red-500/10 text-red-300"
    : alert?.level === "warn"
      ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-300"
      : "border-brand-border/60 bg-white/[0.02] text-gray-300";

  return (
    <div className="py-3 border-b border-brand-border/60 space-y-3">
      <div className="flex items-start justify-between">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-white">My strategies</p>
          <p className="text-xs text-gray-500">
            {rows === null
              ? "Loading…"
              : rows.length === 0
                ? "No position has a strategy yet."
                : `${rows.length} position${rows.length === 1 ? "" : "s"} · earning ≈ ${usd(perDayUsd)}/day now`}
          </p>
        </div>
        {rows && rows.length > 0 && (
          <div className="text-right">
            <p className={`font-bold text-sm ${totalEarned >= 0 ? "text-brand-green" : "text-red-400"}`}>
              {totalEarned >= 0 ? "+" : ""}{usd(totalEarned)}
            </p>
            <p className="text-xs text-gray-600">earned, at today&apos;s prices</p>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {rows && rows.length === 0 && (
        <button className="btn-secondary w-full text-sm" onClick={() => nav("pools")}>
          Send your LP rewards to liquidity or voting power →
        </button>
      )}

      {alert && (
        <div className={`rounded-xl border px-3 py-2.5 space-y-1.5 ${tone}`} role={alert.level === "ok" ? undefined : "alert"}>
          <p className="text-xs font-semibold">
            {alert.level === "critical" ? "⛔ " : alert.level === "warn" ? "⚠️ " : "✅ "}USDC for voting power · {alert.title}
          </p>
          <p className="text-xs opacity-90">{alert.detail}</p>
          <p className="text-[11px] opacity-75">
            Wallet {num(budget!.balance)} USDC · budget left {num(budget!.allowance)} USDC · {num(unitCost, 3)} USDC per oSOLA now
          </p>
          {alert.level !== "ok" && (
            <button
              className="w-full text-xs py-2 rounded-lg border border-current/40 hover:bg-white/5 transition-colors"
              onClick={() => nav("pools")}
            >
              {alert.topUpUsdc > 0 ? `Top up ~${num(alert.topUpUsdc)} USDC (waiting rewards + 30 days) →` : "Manage the voting budget →"}
            </button>
          )}
        </div>
      )}

      {figures.map((f) => {
        const r = f.r, s = r.s, key = s.address.toBase58();
        return (
          <div key={key} className="rounded-xl border border-brand-border/60 px-3 py-2.5 space-y-1">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-white">
                  {label(s.sourcePool)}{" "}
                  <span className="text-gray-500 font-normal">
                    → {s.mode === "vote" ? "voting power" : s.targetPool?.equals(s.sourcePool) ? "more LP (same pool)" : `LP in ${label(s.targetPool)}`}
                  </span>
                </p>
                <p className="text-[11px] text-gray-500">
                  {s.rounds} round{s.rounds === 1 ? "" : "s"} · {num(s.harvested, 4)} oSOLA harvested
                  {s.lastTs > 0 && ` · last ${new Date(s.lastTs * 1000).toLocaleDateString()}`}
                </p>
              </div>
              <p className={`text-xs font-bold ${f.earned >= 0 ? "text-brand-green" : "text-red-400"}`}>
                {f.earned >= 0 ? "+" : ""}{usd(f.earned)}
              </p>
            </div>

            {s.mode === "vote" ? (
              <p className="text-[11px] text-gray-400">
                {num(f.hiSola, 4)} hiSOLA staked ≈ {usd(f.value)} · net paid {f.paidExact ? "" : "≈ "}{num(f.paid)} USDC
              </p>
            ) : (
              <p className="text-[11px] text-gray-400">
                {r.rounds.length > 0
                  ? `${num(f.lp, 6)} LP added${f.lpValue !== null ? ` ≈ ${usd(f.lpValue)}` : ""}${r.complete ? "" : ` over the last ${r.rounds.length} rounds`}`
                  : "No round yet"}
                {!r.complete && " · total valued at the oSOLA harvested"}
              </p>
            )}

            <p className="text-[11px] text-gray-500">
              Waiting now {num(r.pending, 4)} oSOLA ≈ {usd(r.pending * oSolaPrice)} · accruing {num(r.perDay, 2)} oSOLA/day
            </p>

            {r.historyError && <p className="text-[11px] text-red-400">History unavailable: {r.historyError}</p>}

            {r.rounds.length > 0 && (
              <button
                className="text-[11px] text-gray-500 underline underline-offset-2 hover:text-gray-300"
                onClick={() => setOpen(open === key ? null : key)}
              >
                {open === key ? "Hide rounds" : `Show the last ${r.rounds.length} rounds`}
              </button>
            )}
            {open === key && (
              <ul className="text-[11px] text-gray-400 font-mono space-y-0.5 pt-1">
                {r.rounds.map((x) => (
                  <li key={x.signature} className="flex justify-between gap-2">
                    <span>{x.time ? new Date(x.time * 1000).toLocaleString() : "—"}</span>
                    <span>
                      {x.mode === "vote"
                        ? `+${num(x.hiSola, 4)} hiSOLA · −${num(x.usdcSpent)} USDC`
                        : `+${num(x.lpMinted, 6)} LP${x.oSolaToWallet > 0 ? ` · +${num(x.oSolaToWallet, 4)} oSOLA` : ""}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {rows && rows.length > 0 && (
        <p className="text-[10px] text-gray-600 leading-snug">
          Voting: hiSOLA valued at today&apos;s SOLA price, minus the USDC paid for strikes and fees.
          Liquidity: LP valued at today&apos;s pool reserves. Fees and bribes the extra stake earns are not counted here.
        </p>
      )}
    </div>
  );
}
