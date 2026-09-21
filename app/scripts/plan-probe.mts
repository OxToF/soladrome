// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// Plan a recipe for a wallet, from a terminal, against the live cluster.
//
// Planning needs no signature — the whole engine runs on `simulateTransaction` with
// `sigVerify: false` — so the exact code path the app takes can be exercised for ANY wallet,
// without holding its key. Two uses:
//
//   · developing a recipe without a browser and a funded extension in the loop;
//   · answering "is devnet in a filmable state right now" before a shoot, per wallet, instead
//     of discovering on camera that the pending oSOLA is zero.
//
// Run — ⚠️ NODE 24, from `app/`:
//   ~/.nvm/versions/node/v24.19.0/bin/node --import ./scripts/json-loader.mjs \
//       scripts/plan-probe.mts <owner-pubkey>
//   ... scripts/plan-probe.mts --list     # every LP holder, with the basis the program pays on
//
// ☢️ Node 22 does NOT work, for the reason CLAUDE.md already records for the test suites: its
// native type-stripping serves the `.ts` as ESM, and `@coral-xyz/anchor` is CommonJS, so the
// run dies on `SyntaxError: Named export 'BN' not found`. Node 24 resolves it the other way.
//
// The loader teaches Node three conventions of this app's webpack build that Node does not
// share: the IDL imported as JSON without an import attribute, extensionless relative imports,
// and the `@/` alias. Nothing in the app changes for it.
import { readFileSync } from "node:fs";
import { AnchorProvider } from "@coral-xyz/anchor";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getProgram } from "../lib/program.ts";
import { evaluateCompound, planCompound } from "../lib/recipes.ts";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const RPC = env.match(/^NEXT_PUBLIC_RPC_URL=(.+)$/m)?.[1]?.trim();
if (!RPC) throw new Error("NEXT_PUBLIC_RPC_URL missing from app/.env.local");

const connection = new Connection(RPC, "confirmed");

/// An `AnchorWallet` that can plan and cannot sign. The provider only needs `publicKey` to
/// build instructions and to simulate; anything that would actually send is a programming
/// error here, so it throws rather than silently doing nothing.
function readOnlyWallet(publicKey: PublicKey) {
  const refuse = (): never => {
    throw new Error("plan-probe never signs: planning is a read-only path, by design");
  };
  return {
    publicKey,
    signTransaction: refuse as unknown as (tx: Transaction) => Promise<Transaction>,
    signAllTransactions: refuse as unknown as (txs: Transaction[]) => Promise<Transaction[]>,
  };
}

const arg = process.argv[2];

if (!arg || arg === "--list") {
  // `LpUserInfo` is a PDA seeded by [b"lp_user", pool, user] and stores no owner, so the
  // holders are found the other way round: every LP token account of every pool's LP mint,
  // then the PDA derived back from its owner.
  const program = getProgram(
    new AnchorProvider(connection, readOnlyWallet(PublicKey.default) as any, {}),
  );
  const { lpMintPda, userAta } = await import("../lib/program.ts");
  const { lpUserInfoPda } = await import("../lib/lprewards.ts");
  const pools: any[] = await (program.account as any).ammPool.all();
  console.log(`${pools.length} pool(s)`);

  for (const pool of pools) {
    const lpMint = lpMintPda(pool.publicKey);
    const holders = await connection.getProgramAccounts(
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      { filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: lpMint.toBase58() } }] },
    );
    const live = holders
      .map((h) => ({
        owner: new PublicKey(h.account.data.subarray(32, 64)),
        balance: h.account.data.readBigUInt64LE(64),
      }))
      .filter((h) => h.balance > 0n && !h.owner.equals(PublicKey.default));
    if (live.length === 0) continue;

    const infos = await (program.account as any).lpUserInfo.fetchMultiple(
      live.map((h) => lpUserInfoPda(pool.publicKey, h.owner)),
    );
    console.log(`\npool ${pool.publicKey.toBase58()}  rewards_enabled=${!!pool.account.rewardsEnabled}`);
    live.forEach((h, i) => {
      const recorded = infos[i] ? BigInt(infos[i].lpAmount?.toString() ?? "0") : 0n;
      // ☢️ This is the figure the program pays on: `reward_basis` is min(lp_amount, balance),
      // NOT the wallet balance the Pools screen projects from.
      const basis = recorded < h.balance ? recorded : h.balance;
      console.log(
        `  ${h.owner.toBase58()}  wallet=${(Number(h.balance) / 1e6).toFixed(4)}` +
        `  recorded=${(Number(recorded) / 1e6).toFixed(4)}` +
        `  basis=${(Number(basis) / 1e6).toFixed(4)}${basis === 0n ? "   ← earns nothing" : ""}`,
      );
    });
  }
  process.exit(0);
}

const owner = new PublicKey(arg);
const wallet = readOnlyWallet(owner);
const program = getProgram(new AnchorProvider(connection, wallet as any, {}));

const state: any = await (program.account as any).protocolState.fetch(
  (await import("../lib/program.ts")).statePda,
);
const pools: any[] = await (program.account as any).ammPool.all();

console.log(`owner            ${owner.toBase58()}`);
console.log(`pools            ${pools.length}`);
console.log(`exercise_enabled ${state.exerciseEnabled}   paused ${state.paused}`);
console.log(`exercise_fee_bps ${state.exerciseFeeBps}`);
console.log("");

// The signal first: the same judgement the Farm watcher polls and a keeper will ask before
// cranking. Printed on its own so a discrepancy with the plan below is visible, not inferred.
const signal = await evaluateCompound(
  { connection, wallet: wallet as any, usdcMint: state.usdcMint, protocolState: state, pools },
  { budgetUsdc: null, includeWalletOSola: true, useFeesForStrike: true },
);
const u = (v: bigint) => (Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 4 });
console.log("── signal ──");
if (signal.blocked) {
  console.log(`  blocked: ${signal.blocked}`);
} else {
  console.log(`  pending ${u(signal.pendingOSola)} + wallet ${u(signal.walletOSola)} = available ${u(signal.availableOSola)} oSOLA`);
  console.log(`  usdc on hand ${u(signal.usdcOnHand)} (wallet ${u(signal.walletUsdc)} + fees ${u(signal.claimableFees)})`);
  console.log(`  cost/unit ${signal.costPerUnit.toFixed(6)} USDC → affordable ${u(signal.affordableOSola)}`);
  console.log(`  exercisable now: ${u(signal.exercisableOSola)} oSOLA`);
}
console.log("");

const plan = await planCompound(
  { connection, wallet: wallet as any, usdcMint: state.usdcMint, protocolState: state, pools },
  { budgetUsdc: null, includeWalletOSola: true, useFeesForStrike: true },
);

console.log(`── ${plan.title} ──`);
if (plan.blocked) {
  console.log(`BLOCKED: ${plan.blocked}`);
  process.exit(0);
}
console.log(
  `${plan.steps.length} instructions · ${plan.bytes}/1232 bytes · ` +
  `${plan.measuredUnits ?? "?"} CU measured → ${plan.computeUnits} CU budgeted`,
);
plan.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.label}`));
plan.deferred.forEach((s) => console.log(`  — deferred: ${s.label}`));
console.log("");
for (const row of plan.preview) console.log(`  ${row.delta.padStart(14)}  ${row.label}`);
for (const w of plan.warnings) console.log(`\n  ⚠️  ${w}`);
