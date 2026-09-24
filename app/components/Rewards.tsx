// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
import { useCallback, useEffect, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { sendTx } from "@/lib/program";
import { explainRpcRefusal } from "@/lib/txerror";
import { useSoladrome } from "@/lib/SoladromeContext";
import {
  evaluateCompound, planCompound,
  type CompoundOptions, type CompoundSignal,
} from "@/lib/recipes";
import type { Plan } from "@/lib/recipe";
import { StatusBanner } from "./ui/StatusBanner";
import { LegacyWalletOrder } from "./LegacyWalletOrder";
import { PositionStrategy, VoteBudget, strategyChangeIxs, type StrategyPool } from "./PositionStrategy";
import type { PoolStrategy } from "@/lib/strategies";
import { canCompound } from "@/lib/strategies";
import { measureIxs, WIRE_LIMIT } from "@/lib/recipe";
import { PublicKey } from "@solana/web3.js";
import { EmptyState } from "./ui/EmptyState";
import { trackQuest } from "@/lib/quests";

// ☢️ THIS WAS A PAGE OF ITS OWN ("Farm") UNTIL 2026-09-23, and it lives at the top of Pools now.
//
// Two reasons. The rewards it compounds come from LP positions, so the pools are where someone
// looks for them — and the page count was already high. And the page was hidden whenever
// exercise was switched off, which would have hidden the liquidity destination too, although
// that one exercises nothing and is precisely what a closed launch can still offer.
//
// ☢️ PER POSITION since 2026-09-24. Every pool pays its oSOLA into the same wallet account, where
// it stops saying which pool it came from — so the first version offered ONE destination for all
// of it, and a user compounding jitoSOL/SOL saw their USDC/SOLA rewards follow. Each position now
// has its own strategy, harvested at the source by the program, and they never touch each other.
// ☢️ THE WALLET ORDER IS GONE since the same day (see `LegacyWalletOrder`): a second automatic
// system with its own "how often" read as the pace of the positions. Wallet oSOLA (airdrop,
// partners, a harvest overflow) goes through "Right now, by hand", which includes it.
//
// ☢️ THIS SCREEN USED TO OFFER THREE WAYS TO DO ONE THING, and it read like it.
//
// A manual recipe, a watcher that told you when to run the manual recipe, and a standing order
// that did it for you — ten controls in one view, including two fields labelled "Fire at" and
// "Fires at" that meant different things. Once the standing order actually worked, the watcher
// was telling you to do by hand what the other one does on its own.
//
// So there are two now: **do it once** and **do it always** (per position). The watcher's judgement survives —
// `evaluateCompound` is still what prices the header line, and it is still the keeper's brain —
// but it has no toggle, no threshold of its own, no progress bar and no countdown. It is a
// sentence at the top of the card saying what is there to compound.

/// How often the header line re-reads the chain. No toggle: it is a status, not a subsystem.
const REFRESH_MS = 60_000;

function ToneDot({ tone }: { tone: "in" | "out" | "note" }) {
  const cls =
    tone === "in" ? "bg-brand-green" : tone === "out" ? "bg-amber-400" : "bg-gray-600";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} />;
}

function PlanView({ plan }: { plan: Plan }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-5 space-y-4">
      <div className="rounded-xl bg-brand-dark border border-brand-border divide-y divide-brand-border">
        {plan.preview.map((row) => (
          <div key={row.label} className="px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-xs text-gray-400">
                <ToneDot tone={row.tone} />
                {row.label}
              </span>
              <span
                className={`text-sm font-bold tabular-nums ${
                  row.tone === "in"
                    ? "text-brand-green"
                    : row.tone === "out"
                      ? "text-amber-300"
                      : "text-gray-300"
                }`}
              >
                {row.delta}
              </span>
            </div>
            {row.note && <p className="mt-1 text-[11px] leading-relaxed text-gray-600">{row.note}</p>}
          </div>
        ))}
      </div>

      {plan.warnings.map((w) => (
        <p
          key={w}
          className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-3 py-2 text-[11px] leading-relaxed text-yellow-200/90"
        >
          {w}
        </p>
      ))}

      <div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
        >
          {open ? "▾" : "▸"} {plan.steps.length} instruction{plan.steps.length > 1 ? "s" : ""},
          one signature · {plan.bytes}/1232 bytes
          {plan.measuredUnits
            ? ` · ${plan.measuredUnits.toLocaleString("en-US")} CU measured`
            : ""}
        </button>
        {open && (
          <ol className="mt-2 space-y-1 border-l border-brand-border pl-3">
            {plan.steps.map((s, i) => (
              <li key={s.id} className="text-[11px] text-gray-500">
                <span className="text-gray-600">{i + 1}.</span> {s.label}
              </li>
            ))}
            {plan.deferred.map((s) => (
              <li key={s.id} className="text-[11px] text-gray-700 line-through">
                {s.label}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

export function Rewards({
  pendingOSola = 0,
  positions = [],
  destinations = [],
  strategies = new Map(),
  onStrategiesChanged = () => {},
}: {
  /// oSOLA pending across the wallet's positions, as the pool list already computes it.
  pendingOSola?: number;
  /// The wallet's LP positions, with what each has pending.
  positions?: { pool: StrategyPool; pending: number }[];
  /// Every pool a strategy may compound into.
  destinations?: StrategyPool[];
  /// The wallet's strategies, keyed by source pool.
  strategies?: Map<string, PoolStrategy>;
  onStrategiesChanged?: () => void;
}) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint, protocolState, ammPools, vaultInfos, refresh } = useSoladrome();
  // Folded by default: the pool list is what this page is for, and one line says enough.
  const [open, setOpen] = useState(false);
  const exerciseOpen = !!protocolState?.exerciseEnabled;
  const [allInto, setAllInto] = useState("");
  const [allBusy, setAllBusy] = useState(false);
  const [allStatus, setAllStatus] = useState("");
  const activeCount = positions.filter((p) => strategies.has(p.pool.address)).length;
  const voters = [...strategies.values()].filter((s) => s.mode === "vote").length;
  // The shortcut's destination, defaulting to the first pool every position could reach.
  const allTarget = allInto || destinations[0]?.address || "";

  /// "Compound everything into one pool": the same strategy on every position that can reach it,
  /// in as few signatures as the wire allows.
  async function applyToAll() {
    if (!wallet || !usdcMint || !allTarget) return;
    setAllBusy(true);
    setAllStatus("");
    try {
      const target = destinations.find((d) => d.address === allTarget)!;
      const key = (p: StrategyPool) => ({ key: new PublicKey(p.address), mintA: new PublicKey(p.mintA), mintB: new PublicKey(p.mintB) });
      const eligible = positions.filter((p) => canCompound(key(p.pool), key(target), usdcMint));
      const skipped = positions.length - eligible.length;
      const all: any[] = [];
      for (const p of eligible) {
        const s = strategies.get(p.pool.address);
        if (s?.mode === "liquidity" && s.targetPool?.toBase58() === allTarget) continue;
        all.push(...(await strategyChangeIxs(connection, wallet, usdcMint, p.pool.address, s, { kind: "liquidity", target: allTarget })).ixs);
      }
      // Pack greedily: a transaction is 1232 bytes, and each strategy carries a dozen accounts.
      let batch: any[] = [];
      for (const ix of all) {
        if (batch.length && measureIxs([...batch, ix], wallet.publicKey) > WIRE_LIMIT) {
          await sendTx(connection, wallet, batch);
          batch = [];
        }
        batch.push(ix);
      }
      if (batch.length) await sendTx(connection, wallet, batch);
      setAllStatus(
        `✅ ${eligible.length} position${eligible.length === 1 ? "" : "s"} now compound into ${target.label}` +
          (skipped ? ` — ${skipped} skipped: their pool is on the route and cannot compound through it.` : "."),
      );
      onStrategiesChanged();
    } catch (e: any) {
      setAllStatus(`❌ ${explainRpcRefusal(e) ?? e?.message ?? e}`);
    } finally {
      setAllBusy(false);
    }
  }

  const [opts, setOpts] = useState<CompoundOptions>({
    budgetUsdc: null,
    includeWalletOSola: true,
    useFeesForStrike: true,
  });
  const [budgetText, setBudgetText] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [signal, setSignal] = useState<CompoundSignal | null>(null);
  const [planning, setPlanning] = useState(false);
  const [signing, setSigning] = useState(false);
  const [status, setStatus] = useState("");

  const ctx = { connection, wallet: wallet!, usdcMint: usdcMint!, protocolState, pools: ammPools, vaultInfos };

  // ── The header line ────────────────────────────────────────────────────────
  const readSignal = useCallback(async () => {
    if (!wallet || !usdcMint || !open) return;
    if (document.visibilityState !== "visible") return;
    try {
      setSignal(await evaluateCompound(ctx, opts));
    } catch {
      // A refused read leaves the last figure on screen rather than blanking it. The number is
      // a status, and a stale status beats no status.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, wallet, usdcMint, protocolState, ammPools, vaultInfos, opts, open]);

  useEffect(() => {
    readSignal();
    const id = setInterval(readSignal, REFRESH_MS);
    return () => clearInterval(id);
  }, [readSignal]);

  const build = useCallback(async () => {
    if (!wallet || !usdcMint) return;
    setPlanning(true);
    setStatus("");
    setPlan(null);
    try {
      setPlan(await planCompound(ctx, opts));
    } catch (e: any) {
      setStatus(`❌ ${explainRpcRefusal(e) ?? e?.message ?? e}`);
    } finally {
      setPlanning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, wallet, usdcMint, protocolState, ammPools, vaultInfos, opts]);

  async function sign() {
    if (!wallet || !plan || plan.blocked) return;
    setSigning(true);
    setStatus("");
    try {
      const sig = await sendTx(connection, wallet, plan.ixs, plan.computeUnits);
      setStatus(`✅ Compounded — tx: ${sig.slice(0, 16)}…`);
      trackQuest(wallet.publicKey.toBase58(), "stake");
      refresh();
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      setPlan(null);
      setTimeout(() => { readSignal(); build(); }, 2500);
    } catch (e: any) {
      setStatus(`❌ ${explainRpcRefusal(e) ?? e?.message ?? e}`);
    } finally {
      setSigning(false);
    }
  }

  function setBudget(v: string) {
    if (v !== "" && !/^\d*\.?\d*$/.test(v)) return;
    setBudgetText(v);
    setOpts((o) => ({ ...o, budgetUsdc: v === "" ? null : parseFloat(v) || 0 }));
    setPlan(null);
  }

  function toggle(key: "includeWalletOSola" | "useFeesForStrike") {
    setOpts((o) => ({ ...o, [key]: !o[key] }));
    setPlan(null);
  }

  // What the header line says, in one sentence rather than four numbers and a bar.
  const headline = (() => {
    if (!signal) return null;
    if (signal.blocked) return { text: signal.blocked, tone: "muted" as const };
    const available = Number(signal.availableOSola) / 1e6;
    const doable = Number(signal.exercisableOSola) / 1e6;
    if (available === 0) return { text: "Nothing to compound yet.", tone: "muted" as const };
    const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (doable < available) {
      return {
        text: `${fmt(available)} oSOLA ready, but your USDC covers ${fmt(doable)} of it.`,
        tone: "partial" as const,
      };
    }
    return {
      text: `${fmt(available)} oSOLA ready · about ${fmt(available * signal.costPerUnit)} USDC to compound it all.`,
      tone: "ready" as const,
    };
  })();

  if (!wallet) return null;

  return (
    <div className="space-y-4">
      <div className="card">
        <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-4 text-left">
          <div>
            <h2 className="text-base font-bold text-white">Rewards</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              <span className="font-mono text-brand-green/90">
                {pendingOSola.toLocaleString("en-US", { maximumFractionDigits: 2 })} oSOLA
              </span>{" "}
              pending across your pools
              {` · ${activeCount} of ${positions.length} position${positions.length === 1 ? "" : "s"} on a strategy`}
            </p>
          </div>
          <span className="shrink-0 text-xs font-semibold text-gray-400">{open ? "Close ▾" : "Manage ▸"}</span>
        </button>
        {open && (
          <p className="mt-3 text-xs leading-relaxed text-gray-500">
            Each position decides where its oSOLA goes: into liquidity (its own pool or another),
            into voting power, or nowhere until you claim it. Anyone may trigger a round, nobody can
            redirect it, and positions never touch each other&apos;s rewards. Nothing here ever
            holds a key.
          </p>
        )}
      </div>

      {open && (
      <>
      {/* ── One strategy per position ─────────────────────────────────── */}
      <div className="card space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-white">Your positions, automatically</h3>
            <p className="mt-0.5 text-[11px] text-gray-500">Set once, runs while you are away.</p>
          </div>
          {positions.length > 1 && destinations.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
              <span>Compound everything into</span>
              <select
                value={allTarget}
                onChange={(e) => setAllInto(e.target.value)}
                className="rounded-lg border border-brand-border bg-brand-dark px-2 py-1.5 text-[11px] text-white focus:border-brand-green focus:outline-none"
              >
                {destinations.map((d) => (
                  <option key={d.address} value={d.address}>{d.label}</option>
                ))}
              </select>
              <button onClick={applyToAll} disabled={allBusy} className="btn-secondary px-3 py-1.5 text-[11px] disabled:opacity-40">
                {allBusy ? "Sending…" : "Apply"}
              </button>
            </div>
          )}
        </div>
        {allStatus && <p className="text-[11px] text-gray-400">{allStatus}</p>}
        {positions.length === 0 ? (
          <p className="text-xs text-gray-500">No LP position yet. Deposit in a pool to earn oSOLA.</p>
        ) : (
          <div className="divide-y divide-brand-border">
            {positions.map((p) => (
              <div key={p.pool.address} className="space-y-2 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-semibold text-white">{p.pool.label}</span>
                  <span className="font-mono text-xs text-brand-green/90">
                    {p.pending.toLocaleString("en-US", { maximumFractionDigits: 4 })} oSOLA pending
                  </span>
                </div>
                <PositionStrategy
                  source={p.pool}
                  strategy={strategies.get(p.pool.address)}
                  destinations={destinations}
                  usdcMint={usdcMint ?? null}
                  exerciseOpen={exerciseOpen}
                  onChanged={onStrategiesChanged}
                />
              </div>
            ))}
          </div>
        )}
        <VoteBudget usdcMint={usdcMint ?? null} voters={voters} refreshKey={strategies.size + voters} />
      </div>

      <div className="card glow">
        <h3 className="text-base font-bold text-white">Right now, by hand, into voting power</h3>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">
          Claim what your positions have pending, add the oSOLA already in your wallet (airdrop,
          partner allocation, rewards claimed by hand), exercise it at the floor, stake the SOLA.
          One signature, once.
        </p>

        {!exerciseOpen ? (
          <p className="mt-4 rounded-lg border border-brand-border bg-brand-dark px-3 py-2.5 text-xs leading-relaxed text-gray-400">
            Exercise is not open yet, so oSOLA cannot become hiSOLA today. Sending a position&apos;s
            rewards into liquidity, above, does not need it.
          </p>
        ) : !wallet ? (
          <div className="mt-5">
            <EmptyState icon="🔌" title="Connect a wallet" hint="Plans are built against your own positions." />
          </div>
        ) : (
          <>
            {/* ── What there is to compound, as a sentence ──────────── */}
            <p
              className={`mt-4 rounded-lg border px-3 py-2.5 text-xs leading-relaxed ${
                headline?.tone === "ready"
                  ? "border-brand-green/30 bg-brand-green/5 text-brand-green"
                  : headline?.tone === "partial"
                    ? "border-yellow-500/30 bg-yellow-500/5 text-yellow-200/90"
                    : "border-brand-border bg-brand-dark text-gray-400"
              }`}
            >
              {headline?.text ?? "Reading your positions…"}
            </p>

            <button
              onClick={build}
              disabled={planning || signing}
              className="btn-primary mt-4 w-full disabled:opacity-40"
            >
              {planning ? "Simulating…" : plan ? "Recompute" : "Compound now"}
            </button>

            {/* ── Everything most people never need ─────────────────── */}
            <button
              onClick={() => setShowOptions((o) => !o)}
              className="mt-3 text-[11px] text-gray-500 transition-colors hover:text-gray-300"
            >
              {showOptions ? "▾" : "▸"} Options
            </button>
            {showOptions && (
              <div className="mt-3 space-y-3 rounded-lg border border-brand-border bg-brand-dark p-3">
                <label className="block">
                  <span className="text-[11px] text-gray-500">Spend at most</span>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      value={budgetText}
                      onChange={(e) => setBudget(e.target.value)}
                      placeholder="no limit"
                      inputMode="decimal"
                      className="w-full rounded-lg border border-brand-border bg-black/30 px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-brand-green focus:outline-none"
                    />
                    <span className="shrink-0 text-[11px] text-gray-600">USDC</span>
                  </div>
                </label>
                {(
                  [
                    ["includeWalletOSola", "Include the oSOLA already in my wallet"],
                    ["useFeesForStrike", "Pay with my claimable protocol fees first"],
                  ] as const
                ).map(([key, label]) => (
                  <button key={key} onClick={() => toggle(key)} className="flex w-full items-center gap-2.5 text-left">
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-black ${
                        opts[key] ? "border-brand-green bg-brand-green text-black" : "border-brand-border text-transparent"
                      }`}
                    >
                      ✓
                    </span>
                    <span className="text-xs text-gray-400">{label}</span>
                  </button>
                ))}
              </div>
            )}

            {plan?.blocked && (
              <p className="mt-4 rounded-lg border border-brand-border bg-brand-dark px-3 py-2.5 text-xs leading-relaxed text-gray-400">
                {plan.blocked}
              </p>
            )}

            {plan && !plan.blocked && (
              <>
                <PlanView plan={plan} />
                <button onClick={sign} disabled={signing} className="btn-primary mt-4 w-full disabled:opacity-40">
                  {signing ? "Sending…" : "Sign it"}
                </button>
              </>
            )}

            <StatusBanner message={status} />
          </>
        )}
      </div>

      <LegacyWalletOrder voters={voters} />
      </>
      )}
    </div>
  );
}
