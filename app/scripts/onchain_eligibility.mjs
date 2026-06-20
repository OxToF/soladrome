// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// Soladrome — snapshot eligibility from ON-CHAIN footprint (ground truth).
// The quest_completions table is forgeable (bots POST it directly). This script
// ignores it for eligibility and instead reads the chain: who actually holds
// hiSOLA, carries USDC debt, and has a vote receipt. A real "Genesis Tester" is
// staker ∩ borrower ∩ voter on-chain. Cross-referenced with the DB to show the gap.
//
//   node scripts/onchain_eligibility.mjs
//
// Writes onchain_eligible.json (the real, sybil-resistant eligible set).

import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const hiSolaMint = PublicKey.findProgramAddressSync([Buffer.from("hi_sola_mint")], PROGRAM_ID)[0];

const conn = new Connection(env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const idl = JSON.parse(readFileSync("lib/soladrome.json", "utf8"));
const dummy = { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t };
const program = new Program(idl, new AnchorProvider(conn, dummy, { commitment: "confirmed" }));

// ── 1. Stakers: owners of a hiSOLA token account with balance > 0 ───────────
const hiAccts = await conn.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
  filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: hiSolaMint.toBase58() } }],
});
const stakers = new Set();
for (const a of hiAccts) {
  const info = a.account.data.parsed?.info;
  if (info && BigInt(info.tokenAmount.amount) > 0n) stakers.add(info.owner);
}

// ── 2. Borrowers: UserPosition with usdc_borrowed > 0 ───────────────────────
const positions = await program.account.userPosition.all();
const borrowers = new Set();
for (const p of positions) {
  if (BigInt(p.account.usdcBorrowed.toString()) > 0n) borrowers.add(p.account.owner.toBase58());
}

// ── 3. Voters: anyone with a UserVoteReceipt ────────────────────────────────
const receipts = await program.account.userVoteReceipt.all();
const voters = new Set();
for (const r of receipts) voters.add(r.account.user.toBase58());

// ── 4. Ground-truth Genesis Tester = staker ∩ borrower ∩ voter ──────────────
const realGenesis = [...stakers].filter((w) => borrowers.has(w) && voters.has(w));

// ── 5. Compare against what the DB CLAIMS ───────────────────────────────────
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
let all = [], from = 0;
for (;;) {
  const { data, error } = await sb.from("quest_completions").select("wallet_address,quest_id").range(from, from + 999);
  if (error) throw new Error(error.message);
  all = all.concat(data); if (data.length < 1000) break; from += 1000;
}
const claimed = new Map();
for (const r of all) { (claimed.get(r.wallet_address) ?? claimed.set(r.wallet_address, new Set()).get(r.wallet_address)).add(r.quest_id); }
const core = ["connect", "faucet", "swap", "liquidity", "stake", "borrow", "repay", "vote"];
const claimedGenesis = [...claimed].filter(([, qs]) => core.every((q) => qs.has(q))).map(([w]) => w);

console.log("── On-chain footprint ──────────────────────────────");
console.log("hiSOLA holders (stakers)     :", stakers.size);
console.log("borrowers (usdc_borrowed>0)  :", borrowers.size);
console.log("voters (vote receipt)        :", voters.size);
console.log("\n── Eligibility ─────────────────────────────────────");
console.log("CLAIM Genesis Tester (DB)    :", claimedGenesis.length);
console.log("REAL Genesis Tester (chain)  :", realGenesis.length, "  ← staker ∩ borrower ∩ voter");
const fakes = claimedGenesis.filter((w) => !realGenesis.includes(w));
console.log("Claimed but NOT on-chain     :", fakes.length, `(${claimedGenesis.length ? Math.round((fakes.length / claimedGenesis.length) * 100) : 0}% forged)`);
const realButUnclaimed = realGenesis.filter((w) => !claimedGenesis.includes(w));
if (realButUnclaimed.length) console.log("On-chain real but not in DB  :", realButUnclaimed.length, "(did the work, tracking missed)");

writeFileSync("onchain_eligible.json", JSON.stringify(realGenesis, null, 2));
console.log("\n✅ wrote onchain_eligible.json (" + realGenesis.length + " ground-truth eligible wallets)");
