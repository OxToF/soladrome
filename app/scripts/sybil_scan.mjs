// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
//
// Soladrome — snapshot-time sybil scanner.
// Read-only. Does NOT touch the app or alert bots. Run it to score every wallet
// and produce a clean vs flagged list for the airdrop snapshot.
//
//   node scripts/sybil_scan.mjs              # timing fingerprint only (instant)
//   node scripts/sybil_scan.mjs --funding    # + cluster by gas funder (RPC, slower)
//
// Outputs (written next to this script's cwd):
//   sybil_report.json        — every wallet with score + flags
//   eligible_candidates.json — wallets that pass (human-like)
//
// Tunables via env: SPAN_BOT_SEC (default 300), SPAN_SUSPECT_SEC (default 1800).

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
const RPC = env.NEXT_PUBLIC_RPC_URL || env.RPC_URL;

const CORE = ["connect", "faucet", "swap", "liquidity", "stake", "borrow", "repay", "vote"];
const ONCHAIN = ["swap", "liquidity", "stake", "borrow", "repay", "vote"];
const SPAN_BOT_SEC     = Number(env.SPAN_BOT_SEC     ?? 300);   // all-8 faster than this → bot
const SPAN_SUSPECT_SEC = Number(env.SPAN_SUSPECT_SEC ?? 1800);  // all-8 within this → suspect
const DO_FUNDING = process.argv.includes("--funding");

// ── 1. Pull all completions ────────────────────────────────────────────────
async function pullCompletions() {
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from("quest_completions")
      .select("wallet_address,quest_id,completed_at").range(from, from + 999);
    if (error) throw new Error(error.message);
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

// ── 2. Per-wallet timing fingerprint ───────────────────────────────────────
function fingerprint(all) {
  const byWallet = new Map();
  for (const r of all) {
    if (!byWallet.has(r.wallet_address)) byWallet.set(r.wallet_address, []);
    byWallet.get(r.wallet_address).push({ q: r.quest_id, t: Date.parse(r.completed_at) });
  }
  const wallets = [];
  for (const [addr, evs] of byWallet) {
    evs.sort((a, b) => a.t - b.t);
    const coreEvs = evs.filter((e) => CORE.includes(e.q));
    const nCore = new Set(coreEvs.map((e) => e.q)).size;
    const onchain = new Set(evs.filter((e) => ONCHAIN.includes(e.q)).map((e) => e.q)).size;
    const span = coreEvs.length > 1 ? (coreEvs.at(-1).t - coreEvs[0].t) / 1000 : 0; // sec
    // inter-event gaps + regularity (low CV = scripted cadence)
    const gaps = [];
    for (let i = 1; i < coreEvs.length; i++) gaps.push((coreEvs[i].t - coreEvs[i - 1].t) / 1000);
    const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    const variance = gaps.length ? gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length : 0;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0; // coefficient of variation
    wallets.push({ addr, nCore, onchain, all8: nCore === CORE.length, span_sec: Math.round(span), median_gap: median(gaps), cv: round2(cv) });
  }
  return wallets;
}

// ── 3. Classify ─────────────────────────────────────────────────────────────
function classify(w) {
  const flags = [];
  if (w.all8 && w.span_sec > 0 && w.span_sec < SPAN_BOT_SEC) flags.push("fast_full_run");
  if (w.all8 && w.cv > 0 && w.cv < 0.35 && w.span_sec < SPAN_SUSPECT_SEC) flags.push("regular_cadence");
  if (w.onchain === 0) flags.push("no_onchain"); // only connect/faucet — shallow

  let verdict;
  if (flags.includes("fast_full_run")) verdict = "LIKELY_BOT";
  else if (w.all8 && w.span_sec < SPAN_SUSPECT_SEC) verdict = "SUSPECT";
  else if (w.onchain === 0) verdict = "SHALLOW";
  else verdict = "HUMAN_LIKE";
  return { ...w, flags, verdict };
}

// ── 4. Optional: cluster by gas funder (RPC) ────────────────────────────────
async function fundingClusters(addrs) {
  if (!RPC) { console.warn("⚠ no RPC url in .env.local — skipping --funding pass"); return {}; }
  const funder = {};
  let done = 0;
  const CONC = 8;
  async function lookup(addr) {
    try {
      // oldest signature for the account = its first-ever tx (usually the funding transfer)
      const sigRes = await rpc("getSignaturesForAddress", [addr, { limit: 1000 }]);
      const sigs = sigRes?.result ?? [];
      if (!sigs.length) return;
      const oldest = sigs.at(-1).signature;
      const tx = await rpc("getTransaction", [oldest, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
      const keys = tx?.result?.transaction?.message?.accountKeys ?? [];
      // the fee payer / first signer of the first tx that funded this account
      const payer = keys.find((k) => k.signer)?.pubkey ?? keys[0]?.pubkey;
      if (payer && payer !== addr) funder[addr] = payer;
    } catch { /* ignore individual failures */ }
    finally { if (++done % 50 === 0) process.stderr.write(`  funding lookups: ${done}/${addrs.length}\r`); }
  }
  // simple concurrency pool
  const queue = [...addrs];
  await Promise.all(Array.from({ length: CONC }, async () => { while (queue.length) await lookup(queue.shift()); }));
  return funder;
}
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return r.json();
}

// ── helpers ──────────────────────────────────────────────────────────────
const round2 = (x) => Math.round(x * 100) / 100;
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); }
function pct(sorted, p) { if (!sorted.length) return 0; return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]; }

// ── main ────────────────────────────────────────────────────────────────
const all = await pullCompletions();
const scored = fingerprint(all).map(classify);

// span distribution for all-8 wallets (where the bot/human split lives)
const spans = scored.filter((w) => w.all8).map((w) => w.span_sec).sort((a, b) => a - b);
console.log(`\nDataset: ${all.length} completions · ${scored.length} wallets · ${spans.length} did all 8`);
console.log(`\nFull-run (all 8) span_sec distribution:`);
for (const p of [10, 25, 50, 75, 90, 99]) console.log(`  p${p}: ${pct(spans, p)}s`);
console.log(`  → bot threshold: < ${SPAN_BOT_SEC}s  |  suspect: < ${SPAN_SUSPECT_SEC}s`);

const tally = {};
for (const w of scored) tally[w.verdict] = (tally[w.verdict] || 0) + 1;
console.log(`\nVerdicts:`); for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(11)} ${v}`);

let funder = {};
if (DO_FUNDING) {
  console.log(`\nLooking up gas funders via RPC (${scored.length} wallets)…`);
  funder = await fundingClusters(scored.map((w) => w.addr));
  const clusters = {};
  for (const [addr, f] of Object.entries(funder)) (clusters[f] ??= []).push(addr);
  const big = Object.entries(clusters).filter(([, ws]) => ws.length >= 3).sort((a, b) => b[1].length - a[1].length);
  console.log(`\nTop shared gas funders (≥3 wallets → likely one operator):`);
  for (const [f, ws] of big.slice(0, 15)) console.log(`  ${f}  →  ${ws.length} wallets`);
  for (const w of scored) { w.funder = funder[w.addr] ?? null; if (w.funder && clusters[w.funder]?.length >= 3 && w.verdict === "HUMAN_LIKE") { w.verdict = "SUSPECT"; w.flags.push("shared_funder"); } }
}

const eligible = scored.filter((w) => w.verdict === "HUMAN_LIKE");
writeFileSync("sybil_report.json", JSON.stringify(scored, null, 2));
writeFileSync("eligible_candidates.json", JSON.stringify(eligible.map((w) => w.addr), null, 2));
console.log(`\n✅ wrote sybil_report.json (${scored.length}) + eligible_candidates.json (${eligible.length} human-like)`);
console.log(`   flagged out: ${scored.length - eligible.length} (${Math.round((1 - eligible.length / scored.length) * 100)}%)`);
