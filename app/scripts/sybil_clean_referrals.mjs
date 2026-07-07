// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// Removes tainted referral credits from the leaderboard: a "referral:<wallet>"
// row in quest_completions (worth +25, see supabase/quests.sql record_quest)
// is tainted if the referred wallet's sybil_scan.mjs verdict isn't HUMAN_LIKE
// (i.e. it looks like a scripted wallet that raced the 8 Genesis quests just
// to trigger the referrer's payout — see sybil_scan.mjs's cleanLeaderboard()
// for the same logic used to compute clean_leaderboard.json).
//
// Dry run by default. Writes a timestamped backup of every row it removes
// before touching the database, so the action is reversible by re-inserting
// from that file if something looks wrong afterwards.
//
//   node scripts/sybil_clean_referrals.mjs           # preview only, no writes
//   node scripts/sybil_clean_referrals.mjs --apply   # actually delete + update
//
// Requires sybil_report.json (run sybil_scan.mjs first).

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
const APPLY = process.argv.includes("--apply");

if (!existsSync("sybil_report.json")) {
  console.error("sybil_report.json not found — run `node scripts/sybil_scan.mjs` first.");
  process.exit(1);
}
const verdictOf = new Map(
  JSON.parse(readFileSync("sybil_report.json", "utf8")).map((w) => [w.addr, w.verdict])
);

async function pullRewardedReferrals() {
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from("referrals")
      .select("referrer_wallet,referred_wallet,rewarded").eq("rewarded", true).range(from, from + 999);
    if (error) throw new Error(error.message);
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

const referrals = await pullRewardedReferrals();
// Same "tainted" definition as sybil_scan.mjs's cleanLeaderboard(): anything
// that isn't a confirmed HUMAN_LIKE referred wallet, including wallets absent
// from the report entirely (shouldn't happen — a rewarded referral requires
// on-chain stake+borrow+vote — but default to tainted rather than trusting it).
const tainted = referrals.filter((r) => verdictOf.get(r.referred_wallet) !== "HUMAN_LIKE");

const byReferrer = new Map();
for (const t of tainted) byReferrer.set(t.referrer_wallet, (byReferrer.get(t.referrer_wallet) ?? 0) + 1);

console.log(`${referrals.length} rewarded referrals total · ${tainted.length} tainted (${byReferrer.size} referrer wallets affected)`);
console.log(`Points to remove: ${tainted.length * 25}`);

if (!APPLY) {
  writeFileSync("tainted_referrals_preview.json", JSON.stringify(tainted, null, 2));
  console.log(`\nDry run — wrote tainted_referrals_preview.json (${tainted.length} rows). Re-run with --apply to remove them.`);
  process.exit(0);
}

const backupFile = `tainted_referrals_removed_${Date.now()}.json`;
writeFileSync(backupFile, JSON.stringify(tainted, null, 2));
console.log(`\nBackup written: ${backupFile} (restore by re-inserting these rows if needed)`);

let removed = 0, failed = 0;
for (const r of tainted) {
  const questId = `referral:${r.referred_wallet}`;
  const { error: delErr } = await sb.from("quest_completions")
    .delete().eq("wallet_address", r.referrer_wallet).eq("quest_id", questId);
  const { error: updErr } = await sb.from("referrals")
    .update({ rewarded: false }).eq("referred_wallet", r.referred_wallet);
  if (delErr || updErr) {
    failed++;
    console.error(`  ✗ ${r.referrer_wallet.slice(0, 8)}… <- ${r.referred_wallet.slice(0, 8)}…: ${delErr?.message ?? updErr?.message}`);
  } else {
    removed++;
  }
}
console.log(`\n✅ Removed ${removed} tainted referral credits (${failed} failed) · ${byReferrer.size} referrer wallets affected.`);
