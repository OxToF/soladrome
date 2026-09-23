// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// The recipes themselves. Each one composes instructions that already exist, in the audited
// binary, into a single transaction. No recipe adds a line of Rust, and none of them can do
// anything a user could not already do by hand across four screens — which is the point: the
// surface being added is a plan, not a power.
//
// The engine (wire measurement, amount chaining by simulation, the dry run) lives in
// `recipe.ts` and knows nothing about Soladrome. This file knows nothing about byte counts.
//
// ⚠️ A PLAN IS A READ BURST, AND THE PROVIDER METERS READS PER SECOND. Helius answers `401
// {"code":-32401}` to a burst, and that surfaced to a tester as a failure of the very thing
// they were about to sign. So every read here is either taken from `SoladromeContext`, which
// has already paid for it, or batched with another. Eleven calls became four; keep it honest
// when adding a step.
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import {
  getProgram, statePda, solaM, oSolaM, floorVault, marketVault, solaVaultAddr,
  positionPda, userAta, lpMintPda, commonAccounts, explainTxError,
} from "./program";
import { computePendingOsola, emissionCfgOf, lpUserInfoPda, rewardBasis } from "./lprewards";
import { jsAdvanceAccumulator, jsPendingFees } from "./claims";
import {
  budgetFor, budgetPreamble, decodeTokenAmount, dryRun, fitSteps, measureIxs, produced,
  WIRE_LIMIT, type Plan, type PreviewRow, type Step,
} from "./recipe";

/// Every mint a recipe touches is 6 decimals — SOLA, oSOLA and USDC, a protocol invariant.
/// A recipe that ever reaches an arbitrary mint (a bribe reward) must read its decimals
/// instead; see `getMintDecimals`.
const UNIT = 1_000_000;

const ui = (raw: bigint): number => Number(raw) / UNIT;
const fmt = (raw: bigint, digits = 4): string =>
  ui(raw).toLocaleString("en-US", { maximumFractionDigits: digits });

export type RecipeContext = {
  connection: Connection;
  wallet: AnchorWallet;
  usdcMint: PublicKey;
  /// Already fetched by `SoladromeContext` — recipes never re-read the singleton.
  protocolState: any;
  /// `AmmPool.all()` as the context already holds it. Passed in rather than re-fetched: the
  /// whole pool set is one of the heaviest reads in the app, and a recipe that re-issues it on
  /// every re-plan is a 429 waiting for a tester on a rate-limited RPC.
  pools?: any[];
  /// `[floorVault, marketVault]`, as the context already holds them. The market vault balance
  /// is one of the three inputs to claimable fees, so taking it from here rather than reading
  /// it again is one more call saved per plan.
  vaultInfos?: ({ data: Buffer | Uint8Array } | null)[];
};

function blocked(title: string, reason: string): Plan {
  return {
    title, blocked: reason, steps: [], deferred: [], preview: [],
    warnings: [], bytes: 0, ixs: [],
  };
}

// ── Compound ─────────────────────────────────────────────────────────────────

export type CompoundOptions = {
  /// Spend at most this much USDC on strike plus fee. `null` means "whatever the wallet allows".
  budgetUsdc: number | null;
  /// Also exercise the oSOLA already sitting in the wallet, not only what the claims produce.
  includeWalletOSola: boolean;
  /// Claim protocol fees first, so the strike is paid out of what the position already earned.
  useFeesForStrike: boolean;
};

/// One pool with something to claim, in plan order.
export type ClaimablePool = {
  pool: PublicKey;
  lpAta: PublicKey;
  infoPda: PublicKey;
  /// Pending oSOLA in UI units, computed on the basis the PROGRAM pays on.
  pending: number;
  /// ☢️ True when the wallet holds LESS LP than the program recorded as deposited.
  ///
  /// Claiming in that state pays on the smaller figure and advances `reward_debt` to the whole
  /// accumulator anyway, forfeiting the rest — so the chain now refuses a THIRD-PARTY claim
  /// here (`PartialBasisClaim`). The owner may still do it; it is their call. A keeper must
  /// skip these rather than discover the refusal in a simulation, once per pool, every pass.
  partialBasis: boolean;
};

/// What the chain says about a wallet's compound right now — the conditions, and nothing else.
///
/// This is deliberately separate from `planCompound`, and it is the piece with two futures.
/// Today the Rewards card (top of Pools) polls it to tell a user when their threshold is met. Tomorrow the same
/// function is what a keeper asks before cranking a standing order: "is it worth firing yet".
/// Building the watcher any other way would have meant writing that judgement twice and
/// watching the two copies drift, which is the mistake `lprewards.ts` exists to remember.
///
/// It reads and computes. It simulates nothing, signs nothing, and builds no instruction — so
/// it is cheap enough to put on a timer, which `planCompound` is not.
export type CompoundSignal = {
  /// Null when a compound could run. A sentence when it could not.
  blocked: string | null;
  claimable: ClaimablePool[];
  /// Sum of `claimable`, in base units.
  pendingOSola: bigint;
  walletOSola: bigint;
  /// Everything the recipe could exercise, before the budget bites.
  availableOSola: bigint;
  walletUsdc: bigint;
  claimableFees: bigint;
  /// What the strike can draw on, claimable fees included.
  usdcOnHand: bigint;
  /// USDC per oSOLA — strike plus the fee on the gain, cushion included.
  costPerUnit: number;
  /// What the USDC on hand can pay for.
  affordableOSola: bigint;
  /// `min(available, affordable)` — what a plan built right now would actually exercise.
  exercisableOSola: bigint;
  /// Plumbing `planCompound` needs and a watcher ignores.
  position: any | null;
  needsOSolaAta: boolean;
  needsSolaAta: boolean;
};

export async function evaluateCompound(
  ctx: RecipeContext,
  opts: CompoundOptions,
): Promise<CompoundSignal> {
  const user = ctx.wallet.publicKey;
  const state = ctx.protocolState;

  const empty = (reason: string | null): CompoundSignal => ({
    blocked: reason,
    claimable: [], pendingOSola: BigInt(0), walletOSola: BigInt(0), availableOSola: BigInt(0),
    walletUsdc: BigInt(0), claimableFees: BigInt(0), usdcOnHand: BigInt(0),
    costPerUnit: 1, affordableOSola: BigInt(0), exercisableOSola: BigInt(0),
    position: null, needsOSolaAta: false, needsSolaAta: false,
  });

  if (!state) return empty("Protocol state has not been read yet.");
  if (state.paused) return empty("The protocol is paused: no recipe can run.");
  if (!state.exerciseEnabled) {
    return empty(
      "oSOLA exercise is closed (exercise_enabled = false). Without it there is no SOLA to stake.",
    );
  }

  const provider = new AnchorProvider(ctx.connection, ctx.wallet, {});
  const program = getProgram(provider);

  const userOSola = userAta(oSolaM, user);
  const userSola = userAta(solaM, user);
  const userUsdc = userAta(ctx.usdcMint, user);

  const pools: any[] = ctx.pools ?? (await (program.account as any).ammPool.all());
  const cfg = emissionCfgOf(state);
  const now = Math.floor(Date.now() / 1000);

  const lpAtas = pools.map((p) => userAta(lpMintPda(p.publicKey), user));
  const infoPdas = pools.map((p) => lpUserInfoPda(p.publicKey, user));

  // Four reads, issued together: the LP balances, the recorded deposits, the position that
  // decides claimable fees, and the three ATAs this recipe writes into — whose EXISTENCE and
  // BALANCE both come out of that one call, instead of two `ensureAtaIx` and a `readBalances`.
  //
  // The market vault joins that last call only when the caller did not bring it. A caller that
  // omits it must still get the funding leg: skipping the leg silently, because an optional
  // field was absent, is how the probe lost a wallet's 3.29 USDC of claimable fees and nobody
  // could see why. Appending an address to a batch costs no extra round trip.
  const needVault = !ctx.vaultInfos;
  const ataQuery = needVault
    ? [userOSola, userSola, userUsdc, marketVault]
    : [userOSola, userSola, userUsdc];

  const [lpInfos, userInfos, position, ataInfos] = await Promise.all([
    ctx.connection.getMultipleAccountsInfo(lpAtas),
    (program.account as any).lpUserInfo.fetchMultiple(infoPdas),
    (program.account as any).userPosition.fetch(positionPda(user)).catch(() => null),
    ctx.connection.getMultipleAccountsInfo(ataQuery),
  ]);

  const [oSolaInfo, solaInfo, usdcInfo, marketInfo] = ataInfos;
  const marketBalance = decodeTokenAmount(
    needVault ? marketInfo?.data : ctx.vaultInfos?.[1]?.data,
  );
  const walletOSola = decodeTokenAmount(oSolaInfo?.data);
  const walletUsdc = decodeTokenAmount(usdcInfo?.data);

  // ── What is claimable, pool by pool ────────────────────────────────────────
  const claimable = pools
    .map((p, i) => {
      const walletLp = decodeTokenAmount(lpInfos[i]?.data);
      const info = userInfos[i];
      const debt = info ? BigInt(info.rewardDebt.toString()) : BigInt(0);
      // ☢️ The basis is min(recorded deposit, wallet balance) — `reward_basis` in amm.rs — and
      // a filter built on the wallet balance alone admits a pool where the chain pays nothing.
      // `claim_lp_rewards` then reverts on `require!(pending > 0)` and the whole recipe with it.
      const basis = rewardBasis(
        info ? BigInt(info.lpAmount?.toString() ?? "0") : BigInt(0),
        walletLp,
      );
      const pending = computePendingOsola(
        {
          totalLp: Number(p.account.totalLp) / UNIT,
          osolaRewardPerLp: BigInt(p.account.osolaRewardPerLp.toString()),
          lastRewardTs: Number(p.account.lastRewardTs),
          rewardsEnabled: !!p.account.rewardsEnabled,
        },
        debt, basis, now, cfg,
      );
      const recorded = info ? BigInt(info.lpAmount?.toString() ?? "0") : BigInt(0);
      return {
        pool: p.publicKey as PublicKey,
        lpAta: lpAtas[i],
        infoPda: infoPdas[i],
        pending,
        partialBasis: walletLp < recorded,
      };
    })
    .filter((c) => c.pending > 0)
    .sort((a, b) => b.pending - a.pending);

  // ☢️ `claim_fees` reverts with `NothingToClaim` when the pending share is zero — and a revert
  // anywhere takes the whole recipe with it. So the funding leg counts only when the chain would
  // actually pay it, computed with the SAME primitives the Claim screen uses, from state already
  // in hand rather than from three fresh reads.
  const claimableFees = opts.useFeesForStrike
    ? pendingFeesOf(state, position, marketBalance)
    : BigInt(0);

  const pendingOSola = claimable.reduce(
    (sum, c) => sum + BigInt(Math.floor(c.pending * UNIT)),
    BigInt(0),
  );
  const availableOSola = pendingOSola + (opts.includeWalletOSola ? walletOSola : BigInt(0));

  // Strike is 1 USDC per oSOLA, always. The fee is a share of the GAIN and is charged ON TOP of
  // the strike — never carved out of it, so the floor always receives the full USDC per SOLA.
  const curvePrice = Number(state.virtualUsdc.toString()) / Number(state.virtualSola.toString());
  const intrinsic = Math.max(0, curvePrice - 1);
  const feeBps = Number(state.exerciseFeeBps ?? 0);
  // ☢️ A 0.5% cushion, because the curve price — and therefore the fee on the gain — is
  // recomputed on chain at landing, not at simulation. Without it a plan sized to the last
  // cent reverts on a price that moved one buy upward between the dry run and the block.
  const costPerUnit = (1 + (intrinsic * feeBps) / 10_000) * 1.005;

  const usdcOnHand = walletUsdc + claimableFees;
  const budgetRaw =
    opts.budgetUsdc === null
      ? usdcOnHand
      : BigInt(Math.min(Number(usdcOnHand), Math.floor(opts.budgetUsdc * UNIT)));
  const affordableOSola = BigInt(Math.floor(Number(budgetRaw) / costPerUnit));

  return {
    blocked: null,
    claimable,
    pendingOSola,
    walletOSola,
    availableOSola,
    walletUsdc,
    claimableFees,
    usdcOnHand,
    costPerUnit,
    affordableOSola,
    exercisableOSola: availableOSola < affordableOSola ? availableOSola : affordableOSola,
    position,
    needsOSolaAta: !oSolaInfo,
    needsSolaAta: !solaInfo,
  };
}

/// Claim every pending oSOLA, exercise it into SOLA, and stake the result into hiSOLA.
///
/// The whole ve(3,3) loop, in one signature. It is also the recipe that exercises every part of
/// the engine: N claims whose amounts are unknown until they run, a tail sized from them, a
/// cost that depends on a price read at simulation time, and a budget the user sets.
///
/// ☢️ Only the CONTINUOUS stream (`claim_lp_rewards`) is claimed here. The gauge channel
/// (`claim_lp_emissions`) has never paid anything on devnet — there is not one `LpUserCheckpoint`
/// on chain — so including it would add an instruction that reverts and takes the batch with it.
/// When the gauge channel is first used, it belongs here as another optional step.
export async function planCompound(
  ctx: RecipeContext,
  opts: CompoundOptions,
): Promise<Plan> {
  const title = "Compound";
  const user = ctx.wallet.publicKey;
  const state = ctx.protocolState;

  // Every read and every condition lives in the signal, so the watcher on the Rewards card and
  // the plan the user signs can never disagree about what is claimable.
  const signal = await evaluateCompound(ctx, opts);
  if (signal.blocked) return blocked(title, signal.blocked);

  const provider = new AnchorProvider(ctx.connection, ctx.wallet, {});
  const program = getProgram(provider);

  const userOSola = userAta(oSolaM, user);
  const userSola = userAta(solaM, user);
  const userUsdc = userAta(ctx.usdcMint, user);

  const { claimable, claimableFees, walletOSola, walletUsdc, costPerUnit } = signal;

  // ── The head: make the ATAs exist, harvest, then claim ─────────────────────
  const head: Step[] = [];

  const atas: TransactionInstruction[] = [];
  if (signal.needsOSolaAta) atas.push(createAta(user, oSolaM, userOSola));
  if (signal.needsSolaAta) atas.push(createAta(user, solaM, userSola));
  if (atas.length) {
    head.push({ id: "atas", label: "Create the missing token accounts (oSOLA, SOLA)", ixs: atas });
  }

  if (claimableFees > BigInt(0)) {
    const feesIx = await (program.methods as any)
      .claimFees()
      .accounts({
        user, protocolState: statePda, marketVault, userUsdc,
        userPosition: positionPda(user), tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    head.push({
      id: "fees",
      label: `Claim ${fmt(claimableFees, 2)} USDC of protocol fees, to pay the strike`,
      ixs: [feesIx],
    });
  }

  for (const c of claimable) {
    const ix = await (program.methods as any)
      .claimLpRewards()
      .accounts({
        user, payer: user, pool: c.pool, lpMint: lpMintPda(c.pool), userLp: c.lpAta,
        lpUserInfo: c.infoPda, protocolState: statePda, oSolaMint: oSolaM,
        userOSola, ...commonAccounts,
      })
      .instruction();
    head.push({
      id: `claim-${c.pool.toBase58()}`,
      label:
        `Claim ${c.pending.toLocaleString("en-US", { maximumFractionDigits: 4 })} oSOLA` +
        ` — pool ${c.pool.toBase58().slice(0, 4)}…`,
      ixs: [ix],
      optional: true,
    });
  }

  // ── Fit, with the tail in place ────────────────────────────────────────────
  const probe = await buildCompoundTail(program, ctx, user, BigInt(1), BigInt(1));
  const fitted = fitSteps(head, user, {
    preamble: budgetPreamble(400_000),
    tail: probe.flatMap((s) => s.ixs),
  });
  if (fitted.bytes > WIRE_LIMIT) {
    return blocked(
      title,
      "The recipe does not fit in one transaction, even reduced to its minimum.",
    );
  }

  // ── Size the tail from what the head actually produces ─────────────────────
  const before = new Map([
    [userOSola.toBase58(), walletOSola],
    [userUsdc.toBase58(), walletUsdc],
  ]);
  const headIxs = fitted.included.flatMap((s) => s.ixs);

  let claimedOSola = BigInt(0);
  let claimedUsdc = BigInt(0);
  if (headIxs.length > 0) {
    const sim = await dryRun(
      ctx.connection, user, [...budgetPreamble(400_000), ...headIxs], [userOSola, userUsdc],
    );
    if (sim.err) {
      return blocked(
        title,
        `Simulation refuses the first half of the recipe: ${explainTxError(sim.err, headIxs)}`,
      );
    }
    claimedOSola = produced(before, sim.after, userOSola);
    claimedUsdc = produced(before, sim.after, userUsdc);
  }

  const available = claimedOSola + (opts.includeWalletOSola ? walletOSola : BigInt(0));

  if (available === BigInt(0)) {
    return blocked(
      title,
      opts.includeWalletOSola
        ? "Nothing to compound: no oSOLA pending and none in the wallet."
        : "Nothing to compound: no oSOLA pending. Tick the option to exercise the wallet's oSOLA too.",
    );
  }

  // ── What it costs ──────────────────────────────────────────────────────────
  //
  // `costPerUnit` comes from the signal, cushion included — one definition of what a unit costs,
  // shared with the watcher. Only the exact fee is recomputed here, because the preview quotes
  // it and the cushion must not appear in a figure shown as the price.
  const curvePrice = Number(state.virtualUsdc.toString()) / Number(state.virtualSola.toString());
  const intrinsic = Math.max(0, curvePrice - 1);
  const feeBps = Number(state.exerciseFeeBps ?? 0);

  // The SIMULATED claim, not the projected one: the dry run just told us what the head really
  // produced, which is a better figure than the signal's estimate for sizing the exercise.
  const usdcOnHand = walletUsdc + claimedUsdc;
  const budgetRaw =
    opts.budgetUsdc === null
      ? usdcOnHand
      : BigInt(Math.min(Number(usdcOnHand), Math.floor(opts.budgetUsdc * UNIT)));

  const affordable = BigInt(Math.floor(Number(budgetRaw) / costPerUnit));
  const amount = available < affordable ? available : affordable;

  if (amount === BigInt(0)) {
    return blocked(
      title,
      `Exercising costs USDC: ${fmt(available)} oSOLA would cost ` +
        `${(ui(available) * costPerUnit).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC, ` +
        `and the wallet holds ${fmt(usdcOnHand, 2)}.`,
    );
  }

  const tail = await buildCompoundTail(program, ctx, user, amount, amount);
  const steps = [...fitted.included, ...tail];
  const ixs = steps.flatMap((s) => s.ixs);
  const bytes = measureIxs([...budgetPreamble(400_000), ...ixs], user);
  if (bytes > WIRE_LIMIT) {
    return blocked(
      title,
      `The assembled recipe is ${bytes} bytes, past the ${WIRE_LIMIT} of the wire.`,
    );
  }

  // ── The dry run, as a gate ─────────────────────────────────────────────────
  const final = await dryRun(ctx.connection, user, [...budgetPreamble(1_400_000), ...ixs]);
  if (final.err) {
    return blocked(title, `The recipe would fail: ${explainTxError(final.err, ixs)}`);
  }

  const costRaw = BigInt(Math.ceil(Number(amount) * (1 + (intrinsic * feeBps) / 10_000)));
  const dust = available - amount;

  const preview: PreviewRow[] = [
    // A "+0 claimed" row is noise: when the recipe only exercises what the wallet already held,
    // say nothing rather than print a zero the user has to interpret.
    ...(claimedOSola > BigInt(0)
      ? [{
          label: "oSOLA claimed",
          delta: `+${fmt(claimedOSola)}`,
          tone: "in" as const,
          note: fitted.deferred.length > 0
            ? "The pools that did not fit in this transaction are in the second round."
            : undefined,
        }]
      : []),
    { label: "oSOLA exercised", delta: `−${fmt(amount)}`, tone: "out" },
    {
      label: "USDC spent",
      delta: `−${fmt(costRaw, 2)}`,
      tone: "out",
      note: feeBps > 0
        ? `Strike ${fmt(amount, 2)} USDC, plus ${(feeBps / 100).toFixed(2)}% of the gain — ` +
          `charged on top of the strike, never carved out of it.`
        : "Strike only: the exercise fee is zero on this configuration.",
    },
    ...(claimedUsdc > BigInt(0)
      ? [{
          label: "of which fees claimed",
          delta: `+${fmt(claimedUsdc, 2)} USDC`,
          tone: "in" as const,
          note: "Your share of protocol fees funds the strike instead of sitting idle.",
        }]
      : []),
    {
      label: "hiSOLA gained",
      delta: `+${fmt(amount)}`,
      tone: "in",
      note: "A non-transferable position: it votes, it earns fees, it cannot be sold.",
    },
    {
      label: "Floor reserve",
      delta: `+${fmt(amount, 2)} USDC`,
      tone: "note",
      note: "Every exercised oSOLA pays its whole strike into the floor vault.",
    },
  ];

  const warnings: string[] = [];
  if (fitted.deferred.length > 0) {
    warnings.push(
      `${fitted.deferred.length} pool(s) do not fit in this transaction. Sign this one and the ` +
        `recipe recomputes and offers the second round.`,
    );
  }
  if (dust > BigInt(0)) {
    warnings.push(`${fmt(dust)} oSOLA stay in the wallet: the USDC budget did not cover more.`);
  }
  if (intrinsic <= 0) {
    warnings.push(
      "SOLA is at the floor, so the option has no intrinsic value: you pay 1 USDC for 1 SOLA " +
        "worth 1. What you buy here is the vote and the fee share, not a discount.",
    );
  }

  return {
    title,
    blocked: null,
    steps,
    deferred: fitted.deferred,
    preview,
    warnings,
    bytes,
    computeUnits: budgetFor(final.unitsConsumed),
    measuredUnits: final.unitsConsumed,
    ixs,
  };
}

/// Claimable protocol fees, from state the context already holds plus the position.
///
/// The arithmetic is `claims.ts`'s, not a second copy of it — those two primitives are exported
/// for exactly this case, a caller that already has some of the inputs and should pay only for
/// the missing ones. Returns 0 on anything unreadable, which is the safe direction: the funding
/// leg is then simply not added, and the recipe still runs.
function pendingFeesOf(
  state: any,
  position: any | null,
  marketBalance: bigint,
): bigint {
  if (!position) return BigInt(0);
  try {
    // Mirror `math::fee_basis`: the financed part of the position, never the raw balance.
    const hiSola = BigInt(position.hiSola.toString());
    const staked = BigInt(position.stakedAmount.toString());
    const basis = hiSola < staked ? hiSola : staked;

    const acc = jsAdvanceAccumulator(
      BigInt(state.feesPerHiSola.toString()),
      marketBalance,
      BigInt(state.lastMarketVaultBalance.toString()),
      BigInt(state.totalHiSola.toString()),
    );
    return jsPendingFees(acc, BigInt(position.feesDebt.toString()), basis);
  } catch {
    return BigInt(0);
  }
}

function createAta(payer: PublicKey, mint: PublicKey, ata: PublicKey): TransactionInstruction {
  return createAssociatedTokenAccountInstruction(
    payer, ata, payer, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/// Exercise then stake — the half of Compound whose amounts are only known after the head ran.
///
/// Built twice per plan: once as a placeholder probe, to measure the room it needs, and once
/// for real. Same shapes both times, which is exactly why the probe is a valid measurement.
async function buildCompoundTail(
  program: any,
  ctx: RecipeContext,
  user: PublicKey,
  exerciseAmount: bigint,
  stakeAmount: bigint,
): Promise<Step[]> {
  const userOSola = userAta(oSolaM, user);
  const userSola = userAta(solaM, user);
  const userUsdc = userAta(ctx.usdcMint, user);

  const exercise = await program.methods
    .exerciseOSola(new BN(exerciseAmount.toString()))
    .accounts({
      user, protocolState: statePda, solaMint: solaM, oSolaMint: oSolaM,
      userOSola, userSola, floorVault, userUsdc, marketVault, ...commonAccounts,
    })
    .instruction();

  const stake = await program.methods
    .stakeSola(new BN(stakeAmount.toString()))
    .accounts({
      user, protocolState: statePda, solaMint: solaM, userSola,
      solaVault: solaVaultAddr, marketVault, usdcMint: ctx.usdcMint, userUsdc,
      userPosition: positionPda(user), ...commonAccounts,
    })
    .instruction();

  return [
    {
      id: "exercise",
      label: `Exercise ${fmt(exerciseAmount)} oSOLA → SOLA, at the floor`,
      ixs: [exercise],
    },
    { id: "stake", label: `Stake ${fmt(stakeAmount)} SOLA → hiSOLA`, ixs: [stake] },
  ];
}
