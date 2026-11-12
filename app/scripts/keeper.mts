// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// The keeper: it calls a permissionless instruction and holds nothing.
//
// ☢️ READ THIS BEFORE ASSUMING IT IS PRIVILEGED. This process has exactly one power — paying a
// transaction fee — and exactly one piece of knowledge, which is public: the list of standing
// orders on chain. It cannot redirect a compound (`token::authority = owner` refuses a
// substituted account), it cannot make one expensive (`max_cost_per_unit` is on chain), and it
// cannot fire one that is not due (`AutoCompound::ready`). If it stops, orders stop firing and
// nothing else happens; if a stranger runs their own copy, the orders fire anyway. That is the
// difference between a keeper and a custodian, and it is the whole point of the design.
//
// Run — ⚠️ NODE 24, from `app/`:
//   KEEPER_KEYPAIR=~/.config/solana/id.json \
//   ~/.nvm/versions/node/v24.19.0/bin/node --import ./scripts/json-loader.mjs \
//       scripts/keeper.mts            # one pass, then exit
//   ... scripts/keeper.mts --watch    # keep going, one pass every five minutes
//   ... scripts/keeper.mts --dry-run  # look, decide, send nothing
//   KEEPER_ONLY=<owner> ...            # serve one owner's order only (a rehearsal on devnet)
//   KEEPER_HEARTBEAT_URL=<url> ...     # ping after every pass, so a silence can alert
//   KEEPER_FEES_WINDOW_S=604800 ...    # collect pool fees at any time, not only the epoch's last 6 h
//
// On a server: `deploy/keeper/` — one bundled file (`yarn build:keeper`), a systemd unit.
//
// The keypair pays fees and signs nothing that moves a user's tokens. A funded throwaway is the
// right thing to give it; the deployer key is not.
import { readFileSync } from "node:fs";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, Transaction,
} from "@solana/web3.js";
import { statePda, getProgram, getMintProgram, PROGRAM_ID } from "../lib/program.ts";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import {
  buildClaimInstruction, buildCrankInstruction, buildLpCrankInstruction, listCrankableOrders,
} from "../lib/autocompound.ts";
import { evaluateCompound } from "../lib/recipes.ts";
import {
  buildStrategyLpCrankInstruction, buildStrategyVoteCrankInstruction, listCrankableStrategies,
} from "../lib/strategies.ts";
import { measureIxs, WIRE_LIMIT } from "../lib/recipe.ts";
import { CU_SIM_LIMIT, computeBudget, cuLimitFor, feeLamports } from "../lib/cubudget.ts";

const WATCH = process.argv.includes("--watch");
const DRY_RUN = process.argv.includes("--dry-run");
// Five minutes, not one: every pass reads every order and simulates the due ones, and at one a
// minute that alone emptied a shared Helius quota in two weeks (2026-10-21). The app arms
// strategies at one hour (`STRATEGY_DEFAULTS.minInterval`); the chain allows down to
// `MIN_CRANK_INTERVAL` (60 s), and an order that short now fires every five minutes instead.
const PASS_INTERVAL_MS = 300_000;

// `KEEPER_RPC_URL` wins, so the same keeper serves a localnet rehearsal and the live cluster
// without editing the app's own secret config to point somewhere else and forgetting to undo it.
// Optional: on a server (`deploy/keeper/`) there is no checkout and no `.env.local`, only the
// environment the service unit passes.
let env = "";
try {
  env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
} catch {}
// ☢️ `NEXT_PUBLIC_RPC_URL` is the BROWSER key: Next inlines it into the client bundle, so it is
// served to every visitor of the site. A keeper is not a browser, and the day that key is
// restricted to the domain a keeper still holding it simply stops — without a message saying so.
// `RPC_URL` is the server key; the NEXT_PUBLIC fallback is what keeps this running on a single
// key until a second one exists.
const RPC =
  process.env.KEEPER_RPC_URL?.trim() ||
  process.env.RPC_URL?.trim() ||
  env.match(/^RPC_URL=(.+)$/m)?.[1]?.trim() ||
  env.match(/^NEXT_PUBLIC_RPC_URL=(.+)$/m)?.[1]?.trim();
if (!RPC) throw new Error("set KEEPER_RPC_URL or RPC_URL, or NEXT_PUBLIC_RPC_URL in app/.env.local");

const connection = new Connection(RPC, "confirmed");

function loadKeypair(): Keypair {
  const path = process.env.KEEPER_KEYPAIR;
  if (!path) throw new Error("set KEEPER_KEYPAIR to a funded keypair file — it pays fees only");
  const resolved = path.startsWith("~") ? path.replace("~", process.env.HOME ?? "") : path;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolved, "utf8"))));
}

// ⚠️ Even a dry run needs a fee payer that EXISTS: `simulateTransaction` resolves the payer
// account, and a freshly generated key has none, so every simulation fails with
// `AccountNotFound` — a refusal that says nothing about the order being examined.
const keeper = process.env.KEEPER_KEYPAIR ? loadKeypair() : Keypair.generate();
if (DRY_RUN && !process.env.KEEPER_KEYPAIR) {
  console.log("⚠️ no KEEPER_KEYPAIR: simulations will fail on the fee payer, not on the orders");
}
const wallet = {
  publicKey: keeper.publicKey,
  signTransaction: async (tx: Transaction) => {
    tx.partialSign(keeper);
    return tx;
  },
  signAllTransactions: async (txs: Transaction[]) => {
    txs.forEach((tx) => tx.partialSign(keeper));
    return txs;
  },
};

const stamp = () => new Date().toISOString().slice(11, 19);

async function pass(): Promise<void> {
  const program = getProgram(new AnchorProvider(connection, wallet as any, {}));
  const state: any = await (program.account as any).protocolState.fetch(statePda);
  if (state.paused) {
    console.log(`${stamp()}  protocol paused — nothing to do`);
    return;
  }

  const pools: any[] = await (program.account as any).ammPool.all();
  // ☢️ Exercise gates the VOTING recipe only. A liquidity order sells its oSOLA and exercises
  // nothing, so a closed-launch "exercise off" must not silence it — which is exactly what
  // gating the whole pass on the flag used to do.
  const only = process.env.KEEPER_ONLY?.trim();
  const orders = (await listCrankableOrders(connection, wallet as any, state.usdcMint, state)).filter(
    (o) =>
      (state.exerciseEnabled || o.order.lpTarget !== null) &&
      // A rehearsal on a shared cluster should fire the order under test and nobody else's.
      (!only || o.owner.toBase58() === only),
  );

  // ☢️ AN ORDER SHORT OF oSOLA IS NOT NECESSARILY AN ORDER THAT CANNOT FIRE. Since
  // `claim_lp_rewards` became permissionless, the rewards that refill a wallet are one
  // instruction away and this process can call it. So "below threshold" is now a question
  // rather than a verdict: claim first, and ask again.
  //
  // That costs four reads per candidate, which is why it only runs for orders the cheap pass
  // already rejected on the oSOLA count — never for every order, every pass.
  const ready = orders.filter((o) => o.ready);
  const shortOfOSola = orders.filter((o) => o.why === "below threshold" || o.why === "not a full chunk");

  const claimsFor = new Map<string, any[]>();
  for (const o of shortOfOSola) {
    const owner = { publicKey: o.owner, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t };
    const sig = await evaluateCompound(
      { connection, wallet: owner as any, usdcMint: state.usdcMint, protocolState: state, pools },
      { budgetUsdc: null, includeWalletOSola: true, useFeesForStrike: false },
    );
    const chunk = BigInt(Math.floor(o.order.chunk * 1_000_000));
    if (sig.blocked || sig.availableOSola < chunk) continue;

    // ☢️ Never claim on a partial basis for somebody else. The chain refuses it
    // (`PartialBasisClaim`) because advancing `reward_debt` to the whole accumulator on a
    // smaller basis burns the difference — the owner's call to make, not a keeper's. Skipping
    // here rather than discovering the refusal in simulation keeps the log honest about why.
    const ixs: any[] = [];
    for (const c of sig.claimable) {
      if (c.partialBasis) {
        console.log(
          `${stamp()}  ${o.owner.toBase58().slice(0, 8)}…  skipping pool ` +
            `${c.pool.toBase58().slice(0, 4)}…: the wallet holds less LP than it deposited, ` +
            `so claiming for them would forfeit accrual`,
        );
        continue;
      }
      ixs.push(await buildClaimInstruction(connection, wallet as any, o.owner, c.pool));
    }
    claimsFor.set(o.owner.toBase58(), ixs);
    ready.push(o);
    console.log(
      `${stamp()}  ${o.owner.toBase58().slice(0, 8)}…  short by itself, but ${sig.claimable.length} ` +
        `claim(s) would bring it to ${(Number(sig.availableOSola) / 1e6).toFixed(2)} oSOLA`,
    );
  }
  console.log(
    `${stamp()}  ${orders.length} standing order(s), ${ready.length} ready` +
      (orders.length
        ? ` — ${orders.map((o) => `${o.owner.toBase58().slice(0, 4)}…:${o.why || "ready"}`).join(", ")}`
        : ""),
  );

  // Simulated at the full limit; sent at what the simulation measured (see `lib/cubudget.ts`).
  const budget = computeBudget(CU_SIM_LIMIT);

  for (const o of ready) {
    const who = o.owner.toBase58().slice(0, 8);
    try {
      // The destination is the owner's and it is on chain: the keeper only reads it.
      const crank = o.order.lpTarget
        ? await buildLpCrankInstruction(connection, wallet as any, state.usdcMint, o.owner, o.order.lpTarget)
        : await buildCrankInstruction(connection, wallet as any, state.usdcMint, o.owner);
      // Claims first, in the same transaction: the crank reads the wallet balance, so a claim
      // that lands in a LATER transaction is a round that does not fire this pass. Admitted
      // while they fit — the wire is 1232 bytes and the engine measures rather than guesses.
      const claims: any[] = [];
      for (const candidate of claimsFor.get(o.owner.toBase58()) ?? []) {
        const trial = [...budget, ...claims, candidate, crank];
        if (measureIxs(trial, keeper.publicKey) > WIRE_LIMIT) break;
        claims.push(candidate);
      }

      // ☢️ SIMULATE FIRST, ALWAYS. The chain is the authority on whether an order may fire, and
      // this process only holds a mirror of that judgement (`listCrankableOrders`). A mirror
      // goes stale between the read and the send — another keeper fires first, the curve moves
      // past the user's ceiling, an allowance runs out. Sending anyway would burn a fee to
      // watch the chain say no, once per order, once a pass, forever.
      const tx = new Transaction().add(...budget, ...claims, crank);
      tx.feePayer = keeper.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sim = await connection.simulateTransaction(tx);
      if (sim.value.err) {
        console.log(`${stamp()}  ${who}…  refused in simulation: ${JSON.stringify(sim.value.err)}`);
        continue;
      }
      if (DRY_RUN) {
        console.log(
          `${stamp()}  ${who}…  would fire — ${o.order.chunk} oSOLA` +
            `${claims.length ? ` after ${claims.length} claim(s)` : ""}, ${sim.value.unitsConsumed} CU used → ${cuLimitFor(sim.value.unitsConsumed)} requested`,
        );
        continue;
      }

      const units = cuLimitFor(sim.value.unitsConsumed);
      const sized = new Transaction().add(...computeBudget(units), ...claims, crank);
      sized.feePayer = keeper.publicKey;
      sized.recentBlockhash = tx.recentBlockhash;
      sized.sign(keeper);
      const sig = await connection.sendRawTransaction(sized.serialize(), { skipPreflight: true });
      await connection.confirmTransaction(sig, "confirmed");
      // The WHOLE signature: a truncated one cannot be looked up, which is exactly what you
      // want to do the first time an order fires somewhere that matters.
      console.log(
        `${stamp()}  ${who}…  fired ${o.order.chunk} oSOLA${o.order.lpTarget ? ` into ${o.order.lpTarget.toBase58().slice(0, 6)}…` : ""}` +
          `${claims.length ? ` (${claims.length} claim(s) first)` : ""}, ${units} CU / ${feeLamports(units)} lamports — ${sig}`,
      );
    } catch (e: any) {
      // One order's failure is not the pass's failure. A keeper that dies on the first bad
      // order stops serving every order behind it.
      console.log(`${stamp()}  ${who}…  ${String(e?.message ?? e).split("\n")[0].slice(0, 140)}`);
    }
  }
}

// ── Per-position strategies ─────────────────────────────────────────────────
//
// Each fires on its own: a strategy harvests ONE position at the source, so there is nothing to
// claim first and nothing shared between two of them. Same discipline as the orders above —
// simulate, then send; one failure is that strategy's, never the pass's.
async function strategyPass(): Promise<void> {
  const program = getProgram(new AnchorProvider(connection, wallet as any, {}));
  const state: any = await (program.account as any).protocolState.fetch(statePda);
  if (state.paused) return;
  const only = process.env.KEEPER_ONLY?.trim();
  const list = (await listCrankableStrategies(connection, wallet as any, state)).filter(
    (x) => !only || x.strategy.owner.toBase58() === only,
  );
  if (list.length) {
    console.log(
      `${stamp()}  ${list.length} strateg${list.length === 1 ? "y" : "ies"}, ${list.filter((x) => x.ready).length} ready — ` +
        list.map((x) => `${x.strategy.owner.toBase58().slice(0, 4)}…/${x.strategy.sourcePool.toBase58().slice(0, 4)}…:${x.why || "ready"}`).join(", "),
    );
  }
  for (const x of list.filter((y) => y.ready)) {
    const s = x.strategy;
    const who = `${s.owner.toBase58().slice(0, 8)}…/${s.sourcePool.toBase58().slice(0, 4)}…`;
    try {
      const ix = s.mode === "liquidity"
        ? await buildStrategyLpCrankInstruction(connection, wallet as any, state.usdcMint, s)
        : await buildStrategyVoteCrankInstruction(connection, wallet as any, state.usdcMint, s);
      const tx = new Transaction().add(...computeBudget(CU_SIM_LIMIT), ix);
      tx.feePayer = keeper.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const sim = await connection.simulateTransaction(tx);
      if (sim.value.err) {
        console.log(`${stamp()}  ${who}  refused in simulation: ${JSON.stringify(sim.value.err)}`);
        continue;
      }
      if (DRY_RUN) {
        console.log(`${stamp()}  ${who}  would harvest ~${x.pending.toFixed(4)} oSOLA → ${s.mode}, ${sim.value.unitsConsumed} CU used → ${cuLimitFor(sim.value.unitsConsumed)} requested`);
        continue;
      }
      const units = cuLimitFor(sim.value.unitsConsumed);
      const sized = new Transaction().add(...computeBudget(units), ix);
      sized.feePayer = keeper.publicKey;
      sized.recentBlockhash = tx.recentBlockhash;
      sized.sign(keeper);
      const sig = await connection.sendRawTransaction(sized.serialize(), { skipPreflight: true });
      await connection.confirmTransaction(sig, "confirmed");
      console.log(
        `${stamp()}  ${who}  harvested ~${x.pending.toFixed(4)} oSOLA → ${s.mode}, ${units} CU / ${feeLamports(units)} lamports — ${sig}`,
      );
    } catch (e: any) {
      console.log(`${stamp()}  ${who}  ${String(e?.message ?? e).split("\n")[0].slice(0, 140)}`);
    }
  }
}

// ── Pool protocol fees → the pool's voters ──────────────────────────────────
//
// Since 2026-11-11 a swap whose input is not USDC books the protocol's share in the pool
// (`protocol_fees_a/b`) instead of leaving it to the LPs, and `collect_pool_fees` pays it into the
// pool's bribe pot for the CURRENT epoch. Anyone may call it; this keeper does so that the fees
// reach voters without anyone having to remember.
//
// ☢️ WHEN, not just whether. A pot belongs to the epoch it is paid into, so fees collected after
// the epoch rolls over pay the NEXT epoch's voters. Collecting in the last hours of the epoch
// pays the voters whose votes attracted that flow. And only once per side per epoch: every first
// deposit into a (pool, mint, epoch) pot costs this fee payer the rent of two accounts (~0.004
// SOL), which nobody refunds — the pots are never closed.
//
// ☢️ And never into a pool nobody voted for this epoch: the pot could not be claimed, only rolled
// over, and the rent would be spent for nothing. The fees stay owed in the pool; they are not
// lost, they are collected the first epoch someone votes for it.
// `KEEPER_FEES_WINDOW_S` widens it for a rehearsal (e.g. 604800 = any time in the epoch).
const FEES_WINDOW_S = Number(process.env.KEEPER_FEES_WINDOW_S?.trim() || 6 * 3600);
const EPOCH_S = 604_800;
const collected = new Set<string>(); // `${pool}:${side}:${epoch}` — in memory; a restart may re-collect, harmlessly
const epochLE = (e: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(e));
  return b;
};
const pdaOf = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

async function feesPass(): Promise<void> {
  const program = getProgram(new AnchorProvider(connection, wallet as any, {}));
  const state: any = await (program.account as any).protocolState.fetch(statePda);
  if (state.paused || !state.bribesEnabled) return;

  // The chain's clock, not this machine's: the program checks `epoch == current_epoch(clock)`.
  const slot = await connection.getSlot();
  const now = (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  const epoch = Math.floor(now / EPOCH_S);
  const left = (epoch + 1) * EPOCH_S - now;
  if (left > FEES_WINDOW_S) return;

  const companyConfig = pdaOf([Buffer.from("company_config")]);
  const company: any = await (program.account as any).companyConfig.fetchNullable(companyConfig);
  const pools: any[] = await (program.account as any).ammPool.all();

  for (const { publicKey: pool, account: p } of pools) {
    for (const sideA of [true, false]) {
      const owed = BigInt((sideA ? p.protocolFeesA : p.protocolFeesB).toString());
      const key = `${pool.toBase58()}:${sideA ? "a" : "b"}:${epoch}`;
      if (owed === 0n || collected.has(key)) continue;
      const mint: PublicKey = sideA ? p.tokenAMint : p.tokenBMint;
      const tag = `${pool.toBase58().slice(0, 6)}…/${mint.toBase58().slice(0, 4)}…`;
      try {
        const gauge: any = await (program.account as any).gaugeState.fetchNullable(
          pdaOf([Buffer.from("gauge"), pool.toBuffer(), epochLE(epoch)]),
        );
        if (!gauge || BigInt(gauge.totalVotes.toString()) === 0n) {
          collected.add(key); // asked once this epoch; the answer will not change in the window
          console.log(`${stamp()}  fees ${tag}  ${owed} owed, but nobody voted for the pool this epoch — left owed`);
          continue;
        }
        const tokenProgram = await getMintProgram(connection, mint);
        // The company's share is due only while one is set; its account is then mandatory.
        const companyToken =
          company && company.feeBps > 0
            ? getAssociatedTokenAddressSync(mint, company.wallet, true, tokenProgram)
            : null;
        const ix = await (program.methods as any)
          .collectPoolFees(new BN(epoch), sideA)
          .accounts({
            payer: keeper.publicKey,
            protocolState: statePda,
            pool,
            mint,
            poolVault: sideA ? p.tokenAVault : p.tokenBVault,
            bribeVault: pdaOf([Buffer.from("bribe_vault"), pool.toBuffer(), mint.toBuffer(), epochLE(epoch)]),
            bribeTokenVault: pdaOf([Buffer.from("bribe_tokens"), pool.toBuffer(), mint.toBuffer(), epochLE(epoch)]),
            companyConfig,
            companyToken,
            tokenProgram,
            systemProgram: SystemProgram.programId,
          })
          .instruction();

        const tx = new Transaction().add(...computeBudget(CU_SIM_LIMIT), ix);
        tx.feePayer = keeper.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        const sim = await connection.simulateTransaction(tx);
        if (sim.value.err) {
          console.log(`${stamp()}  fees ${tag}  refused in simulation: ${JSON.stringify(sim.value.err)}`);
          continue;
        }
        if (DRY_RUN) {
          console.log(`${stamp()}  fees ${tag}  would collect ${owed} to epoch ${epoch}'s voters, ${sim.value.unitsConsumed} CU`);
          continue;
        }
        const units = cuLimitFor(sim.value.unitsConsumed);
        const sized = new Transaction().add(...computeBudget(units), ix);
        sized.feePayer = keeper.publicKey;
        sized.recentBlockhash = tx.recentBlockhash;
        sized.sign(keeper);
        const sig = await connection.sendRawTransaction(sized.serialize(), { skipPreflight: true });
        await connection.confirmTransaction(sig, "confirmed");
        collected.add(key);
        console.log(`${stamp()}  fees ${tag}  collected ${owed} to epoch ${epoch}'s voters — ${sig}`);
      } catch (e: any) {
        console.log(`${stamp()}  fees ${tag}  ${String(e?.message ?? e).split("\n")[0].slice(0, 140)}`);
      }
    }
  }
}

if (DRY_RUN) console.log(`dry run: nothing will be sent (fee payer ${keeper.publicKey.toBase58().slice(0, 8)}…, used only to simulate)`);
else console.log(`keeper ${keeper.publicKey.toBase58()} — pays fees, holds no authority`);

// ☢️ A keeper that stops says nothing — on 2026-09-26 one had been down for two days before
// anyone looked. `KEEPER_HEARTBEAT_URL` (a healthchecks.io check, or anything that alerts when
// pings stop) is pinged after every pass, and `<url>/fail` when a pass threw. The alert is the
// silence, so it also fires when the process, the machine or the network dies.
async function heartbeat(ok: boolean): Promise<void> {
  const url = process.env.KEEPER_HEARTBEAT_URL?.trim();
  if (!url || DRY_RUN) return;
  try {
    await fetch(ok ? url : `${url.replace(/\/$/, "")}/fail`, { signal: AbortSignal.timeout(10_000) });
  } catch (e: any) {
    console.log(`${stamp()}  heartbeat failed: ${String(e?.message ?? e).slice(0, 140)}`);
  }
}

// A network error inside a promise nobody awaits (web3.js races some of its own) must not end
// the process: on 2026-09-26 one ECONNRESET killed a keeper mid-watch. Log it, keep the
// schedule. A real fault still shows as failed passes, and in the heartbeat.
process.on("unhandledRejection", (e: any) => {
  console.log(`${stamp()}  unhandled rejection (kept running): ${String(e?.cause?.code ?? e?.message ?? e).slice(0, 140)}`);
});

async function fullPass(): Promise<void> {
  let ok = true;
  await pass().catch((e) => {
    ok = false;
    console.log(`${stamp()}  pass failed: ${String(e?.message ?? e).slice(0, 140)}`);
  });
  await strategyPass().catch((e) => {
    ok = false;
    console.log(`${stamp()}  strategy pass failed: ${String(e?.message ?? e).slice(0, 140)}`);
  });
  await feesPass().catch((e) => {
    ok = false;
    console.log(`${stamp()}  fees pass failed: ${String(e?.message ?? e).slice(0, 140)}`);
  });
  await heartbeat(ok);
}

await fullPass();
if (WATCH) setInterval(fullPass, PASS_INTERVAL_MS);
