// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// LP emission coverage that the mocha/validator suite structurally cannot provide.
//
// `tests/soladrome.ts` runs against a live cluster (Anchor.toml pins devnet), so it is
// stuck with the real clock and can only exercise the *in-epoch* half of the LP reward
// system. The per-epoch half — `checkpoint_lp` → `emit_pool_rewards` →
// `claim_lp_emissions`, plus the `osola_claimed` ceiling — needs a 7-day boundary to be
// crossed, which is what this bankrun harness buys: `context.setClock()` moves the epoch
// on demand.
//
// That gap is the documented gate on arming mainnet emissions (`configure_emissions`
// with `initial > 0`). This file closes it, and covers three further paths around
// `LpUserInfo.lp_amount` that the 2026-07-21 fix introduced and nothing asserted:
// withdrawal shrinking the reward basis, the `min(lp_amount, wallet_lp)` floor when LP
// leaves the wallet, and a zero-`lp_amount` position still being able to withdraw.
//
// Run: yarn test:bankrun   (no validator, no airdrops, ~1 s)
//
// ⚠️ BUILD ARCH — bankrun cannot load an SBPFv3 binary. `cargo build-sbf --arch v3`, which
// CLAUDE.md requires for a DEVNET deploy, produces a .so this harness rejects with the
// misleading "Program is not deployed". Build plain (`anchor build` / `cargo build-sbf`)
// to run the tests, and re-add `--arch v3` when you deploy. Same source, different target.
//
// Verified load-bearing: putting `window_start` in checkpoint_lp back to `epoch_start`
// (the Finding A bug) makes the late-depositor test at the bottom of this file fail.
// Do not weaken that assertion — the other tests stay green on that mutation.

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { Clock, ProgramTestContext, BanksClient } from "solana-bankrun";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  AccountLayout,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import { Soladrome } from "../target/types/soladrome";

const {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  SYSVAR_RENT_PUBKEY,
} = anchor.web3;
type Kp = anchor.web3.Keypair;
type Pk = anchor.web3.PublicKey;

const DECIMALS = 6;
const ONE = new BN(1_000_000);
const EPOCH_DURATION = 604_800n; // 7 days, must match lib.rs
const LP_DEAD = SystemProgram.programId; // = LP_DEAD_PUBKEY
// One epoch's emission, deliberately round: with a single gauge taking every vote,
// `emit_pool_rewards` must allocate exactly this to the pool in the first epoch
// (decay elapsed = 0), which makes the allocation assertion exact rather than fuzzy.
const EMISSION_INITIAL = new BN(100_000_000); // 100 oSOLA

describe("lp-emissions (bankrun)", () => {
  let context: ProgramTestContext;
  let client: BanksClient;
  let provider: BankrunProvider;
  let program: Program<Soladrome>;
  let payer: Kp;

  let statePda: Pk, solaM: Pk, hiSolaM: Pk, oSolaM: Pk, floorV: Pk, marketV: Pk, solaVault: Pk;
  let usdcMint: Pk;
  let pool: Pk, lpMint: Pk, vaultA: Pk, vaultB: Pk, mintA: Pk, mintB: Pk;
  let epoch0: bigint;

  // ── bankrun plumbing ──────────────────────────────────────────────────────

  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const epochSeed = (e: bigint) => new BN(e.toString()).toArrayLike(Buffer, "le", 8);

  const lpUserInfoPda = (p: Pk, u: Pk) => pda([Buffer.from("lp_user"), p.toBuffer(), u.toBuffer()]);
  const lpCkptPda = (p: Pk, u: Pk) => pda([Buffer.from("lp_ckpt"), p.toBuffer(), u.toBuffer()]);
  const accumPda = (p: Pk, e: bigint) => pda([Buffer.from("lp_pool_epoch"), p.toBuffer(), epochSeed(e)]);
  const gaugePda = (p: Pk, e: bigint) => pda([Buffer.from("gauge"), p.toBuffer(), epochSeed(e)]);
  const globalVotesPda = (e: bigint) => pda([Buffer.from("epoch_votes"), epochSeed(e)]);
  const userVotePda = (u: Pk, p: Pk, e: bigint) =>
    pda([Buffer.from("vote"), u.toBuffer(), p.toBuffer(), epochSeed(e)]);
  const userEpochVotesPda = (u: Pk, e: bigint) => pda([Buffer.from("uev"), u.toBuffer(), epochSeed(e)]);
  const lpEpochClaimPda = (u: Pk, p: Pk, e: bigint) =>
    pda([Buffer.from("lp_claim"), u.toBuffer(), p.toBuffer(), epochSeed(e)]);
  const positionPda = (u: Pk) => pda([Buffer.from("position"), u.toBuffer()]);

  /** Token-account amount straight from the bank — no Connection in bankrun. */
  async function balance(ata: Pk): Promise<bigint> {
    const acc = await client.getAccount(ata);
    return acc ? AccountLayout.decode(Buffer.from(acc.data)).amount : 0n;
  }

  async function send(ixs: anchor.web3.TransactionInstruction[], signers: Kp[] = []) {
    const tx = new Transaction().add(...ixs);
    return provider.sendAndConfirm!(tx, signers);
  }

  /** SPL helpers rebuilt on raw instructions: the spl-token helpers all want a Connection. */
  async function createMint(authority: Pk): Promise<Pk> {
    const mint = Keypair.generate();
    const rent = await client.getRent();
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          space: MINT_SIZE,
          lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint.publicKey, DECIMALS, authority, null),
      ],
      [mint],
    );
    return mint.publicKey;
  }

  async function mintTo(mint: Pk, owner: Pk, amount: number | BN) {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    await send([
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint),
      createMintToInstruction(mint, ata, payer.publicKey, BigInt(amount.toString())),
    ]);
    return ata;
  }

  async function fundSol(to: Pk, lamports = 5_000_000_000) {
    await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports })]);
  }

  /**
   * Move the validator clock to an absolute unix timestamp.
   *
   * The slot is bumped alongside it: bankrun derives the blockhash from the slot, and two
   * transactions sent at the same slot with identical instructions would collide as
   * duplicates. Bumping also keeps `last_change_ts`/`last_update_ts` deltas honest.
   */
  async function warpTo(unixTs: bigint) {
    const c = await client.getClock();
    context.warpToSlot(c.slot + 100n);
    context.setClock(new Clock(c.slot + 100n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, unixTs));
  }

  const epochStart = (e: bigint) => e * EPOCH_DURATION;
  const epochEnd = (e: bigint) => (e + 1n) * EPOCH_DURATION;

  // ── protocol setup ────────────────────────────────────────────────────────

  before(async () => {
    context = await startAnchor(".", [], []);
    client = context.banksClient;
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    payer = context.payer;
    program = new Program<Soladrome>(require("../target/idl/soladrome.json"), provider);

    statePda = pda([Buffer.from("state")]);
    solaM = pda([Buffer.from("sola_mint")]);
    hiSolaM = pda([Buffer.from("hi_sola_mint")]);
    oSolaM = pda([Buffer.from("o_sola_mint")]);
    floorV = pda([Buffer.from("floor_vault")]);
    marketV = pda([Buffer.from("market_vault")]);
    solaVault = pda([Buffer.from("sola_vault")]);

    // Land early inside a fresh epoch so checkpoints have the whole epoch ahead of them.
    const genesis = await client.getClock();
    epoch0 = genesis.unixTimestamp / EPOCH_DURATION + 1n;
    await warpTo(epochStart(epoch0) + 60n);

    usdcMint = await createMint(payer.publicKey);

    await program.methods
      .initialize()
      .accounts({
        authority: payer.publicKey, protocolState: statePda, usdcMint,
        solaMint: solaM, hiSolaMint: hiSolaM, oSolaMint: oSolaM,
        floorVault: floorV, marketVault: marketV, solaVault,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await program.methods
      .setPhaseFlags(true, true, true, true, true)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    // Arm per-epoch emissions. start_epoch = current epoch → decay elapsed = 0 in epoch0,
    // so the first epoch allocates exactly EMISSION_INITIAL.
    await program.methods
      .configureEmissions(EMISSION_INITIAL, 9_900, 1_000)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    // Isolated pool on two throwaway mints — nothing here touches SOLA/USDC.
    const m1 = await createMint(payer.publicKey);
    const m2 = await createMint(payer.publicKey);
    [mintA, mintB] = Buffer.compare(m1.toBuffer(), m2.toBuffer()) < 0 ? [m1, m2] : [m2, m1];
    pool = pda([Buffer.from("amm_pool"), mintA.toBuffer(), mintB.toBuffer()]);
    lpMint = pda([Buffer.from("lp_mint"), pool.toBuffer()]);
    vaultA = pda([Buffer.from("vault_a"), pool.toBuffer()]);
    vaultB = pda([Buffer.from("vault_b"), pool.toBuffer()]);

    await program.methods
      .createPool(30, 2000)
      .accounts({
        creator: payer.publicKey, protocolState: statePda, tokenAMint: mintA, tokenBMint: mintB,
        pool, lpMint, tokenAVault: vaultA, tokenBVault: vaultB,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await mintTo(mintA, payer.publicKey, 1_000_000_000);
    await mintTo(mintB, payer.publicKey, 1_000_000_000);
    await addLiquidity(payer, ONE.muln(100), ONE.muln(100));

    await program.methods
      .setPoolRewards(true)
      .accounts({ authority: payer.publicKey, protocolState: statePda, pool } as any)
      .rpc();

    // Voting power: emit_pool_rewards divides by gauge votes, so the pool needs a vote.
    // USDC in → SOLA on the curve → hiSOLA staked → vote the gauge.
    await mintTo(usdcMint, payer.publicKey, 10_000_000_000);
    await program.methods
      .buySola(ONE.muln(1000), new BN(0))
      .accounts({
        user: payer.publicKey, protocolState: statePda, solaMint: solaM,
        userUsdc: getAssociatedTokenAddressSync(usdcMint, payer.publicKey),
        userSola: getAssociatedTokenAddressSync(solaM, payer.publicKey),
        floorVault: floorV, marketVault: marketV, tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    await program.methods
      .stakeSola(ONE.muln(100))
      .accounts({
        user: payer.publicKey, protocolState: statePda, solaMint: solaM, hiSolaMint: hiSolaM,
        userSola: getAssociatedTokenAddressSync(solaM, payer.publicKey),
        userHiSola: getAssociatedTokenAddressSync(hiSolaM, payer.publicKey),
        solaVault, marketVault: marketV, usdcMint,
        userUsdc: getAssociatedTokenAddressSync(usdcMint, payer.publicKey),
        userPosition: positionPda(payer.publicKey), tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // 25 hiSOLA, not 50: VOTE_WEIGHT_CAP_BPS caps any single address at 30% of
    // total_hi_sola, and this harness is the only staker. The exact figure is
    // irrelevant to the allocation — one gauge holding every vote takes the whole pot.
    await voteGauge(payer, epoch0, ONE.muln(25));
  });

  // ── instruction wrappers ──────────────────────────────────────────────────

  async function addLiquidity(user: Kp, a: BN, b: BN) {
    await program.methods
      .addLiquidity(a, b, new BN(0))
      .accounts({
        user: user.publicKey, pool, lpMint, tokenAVault: vaultA, tokenBVault: vaultB,
        userTokenA: getAssociatedTokenAddressSync(mintA, user.publicKey),
        userTokenB: getAssociatedTokenAddressSync(mintB, user.publicKey),
        userLp: getAssociatedTokenAddressSync(lpMint, user.publicKey),
        lpDeadAta: getAssociatedTokenAddressSync(lpMint, LP_DEAD, true), lpDead: LP_DEAD,
        lpUserInfo: lpUserInfoPda(pool, user.publicKey), protocolState: statePda, oSolaMint: oSolaM,
        userOSola: getAssociatedTokenAddressSync(oSolaM, user.publicKey),
        rent: SYSVAR_RENT_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      } as any)
      .signers(user.publicKey.equals(payer.publicKey) ? [] : [user])
      .rpc();
  }

  async function removeLiquidity(user: Kp, lp: BN) {
    await program.methods
      .removeLiquidity(lp, new BN(0), new BN(0))
      .accounts({
        user: user.publicKey, pool, lpMint, tokenAVault: vaultA, tokenBVault: vaultB,
        userLp: getAssociatedTokenAddressSync(lpMint, user.publicKey),
        userTokenA: getAssociatedTokenAddressSync(mintA, user.publicKey),
        userTokenB: getAssociatedTokenAddressSync(mintB, user.publicKey),
        lpUserInfo: lpUserInfoPda(pool, user.publicKey), protocolState: statePda, oSolaMint: oSolaM,
        userOSola: getAssociatedTokenAddressSync(oSolaM, user.publicKey),
        rent: SYSVAR_RENT_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      } as any)
      .signers(user.publicKey.equals(payer.publicKey) ? [] : [user])
      .rpc();
  }

  async function checkpoint(user: Kp, e: bigint) {
    await program.methods
      .checkpointLp(new BN(e.toString()))
      .accounts({
        user: user.publicKey, protocolState: statePda, pool, lpMint,
        userLp: getAssociatedTokenAddressSync(lpMint, user.publicKey),
        lpUserInfo: lpUserInfoPda(pool, user.publicKey),
        lpUserCheckpoint: lpCkptPda(pool, user.publicKey),
        poolEpochAccum: accumPda(pool, e),
        systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers(user.publicKey.equals(payer.publicKey) ? [] : [user])
      .rpc();
  }

  async function voteGauge(user: Kp, e: bigint, votes: BN) {
    await program.methods
      .voteGauge(new BN(e.toString()), votes)
      .accounts({
        user: user.publicKey, poolId: pool, protocolState: statePda, hiSolaMint: hiSolaM,
        userHiSola: getAssociatedTokenAddressSync(hiSolaM, user.publicKey),
        // UncheckedAccount: "pass any account when not using a ve lock" (lib.rs).
        lockPosition: SystemProgram.programId,
        gaugeState: gaugePda(pool, e),
        userVoteReceipt: userVotePda(user.publicKey, pool, e),
        userEpochVotes: userEpochVotesPda(user.publicKey, e),
        globalEpochVotes: globalVotesPda(e),
        systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers(user.publicKey.equals(payer.publicKey) ? [] : [user])
      .rpc();
  }

  async function emitRewards(e: bigint) {
    await program.methods
      .emitPoolRewards(new BN(e.toString()))
      .accounts({
        caller: payer.publicKey, protocolState: statePda, pool, lpMint,
        gaugeState: gaugePda(pool, e), globalEpochVotes: globalVotesPda(e),
        poolEpochAccum: accumPda(pool, e),
        systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
  }

  async function claimEmissions(user: Kp, e: bigint) {
    await program.methods
      .claimLpEmissions(new BN(e.toString()))
      .accounts({
        user: user.publicKey, pool, protocolState: statePda, oSolaMint: oSolaM,
        userOSola: getAssociatedTokenAddressSync(oSolaM, user.publicKey),
        poolEpochAccum: accumPda(pool, e),
        lpUserCheckpoint: lpCkptPda(pool, user.publicKey),
        lpEpochClaim: lpEpochClaimPda(user.publicKey, pool, e),
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers(user.publicKey.equals(payer.publicKey) ? [] : [user])
      .rpc();
  }

  // ── the gate: the full per-epoch cycle ────────────────────────────────────

  it("[lp-emission] runs the whole per-epoch cycle across a real epoch boundary", async () => {
    // Two checkpoints inside the epoch: weight accrues only between them (never back to
    // epoch_start), which is the Finding A fix.
    await checkpoint(payer, epoch0);
    await warpTo(epochStart(epoch0) + 3n * 86_400n);
    await checkpoint(payer, epoch0);

    const ckMid = await program.account.lpUserCheckpoint.fetch(lpCkptPda(pool, payer.publicKey));
    assert.isTrue(ckMid.weightedBalance.gt(new BN(0)), "holding across the epoch must bank weight");

    // Cross the boundary — the step no live-cluster suite can take.
    await warpTo(epochEnd(epoch0) + 60n);

    await emitRewards(epoch0);
    const pa = await program.account.lpPoolEpochAccum.fetch(accumPda(pool, epoch0));
    assert.isTrue(pa.finalized, "epoch must be finalized");
    assert.equal(
      pa.osolaAllocated.toString(), EMISSION_INITIAL.toString(),
      "sole gauge with every vote takes the whole epoch emission, undecayed in epoch 0",
    );

    const userOSola = getAssociatedTokenAddressSync(oSolaM, payer.publicKey);
    const before = await balance(userOSola);
    await claimEmissions(payer, epoch0);
    const gained = (await balance(userOSola)) - before;

    const after = await program.account.lpPoolEpochAccum.fetch(accumPda(pool, epoch0));
    assert.isTrue(gained > 0n, "the sole LP must receive oSOLA for the epoch");
    // A partial hold cannot draw the whole pot. Weak on its own — see the late-depositor
    // test at the end of this file for the assertion that actually discriminates against
    // the Finding A regression.
    assert.isTrue(
      gained < BigInt(EMISSION_INITIAL.toString()),
      `a partial hold cannot draw the whole allocation (got ${Number(gained) / 1e6})`,
    );
    assert.equal(after.osolaClaimed.toString(), gained.toString(), "osola_claimed tracks what was minted");
    assert.isTrue(
      after.osolaClaimed.lte(after.osolaAllocated),
      "claimed can never exceed the epoch allocation",
    );

    const ck = await program.account.lpUserCheckpoint.fetch(lpCkptPda(pool, payer.publicKey));
    assert.equal(ck.weightedBalance.toString(), "0", "weight is reset after a claim (M-01)");

    console.log(
      `✅ [lp-emission] epoch ${epoch0}: allocated ${pa.osolaAllocated.toNumber() / 1e6} oSOLA, ` +
      `claimed ${Number(gained) / 1e6}`,
    );
  });

  it("[lp-emission][security] the same epoch cannot be claimed twice", async () => {
    let reverted = false;
    try {
      await claimEmissions(payer, epoch0);
    } catch (e: any) {
      reverted = true;
      // Two guards stand in the way, and the order matters for anyone reading a failed
      // replay in the wild: `init` on LpEpochClaim is an ACCOUNT CONSTRAINT, so it runs
      // during validation and fires before the body is ever entered — the replay dies on
      // SystemProgram AccountAlreadyInUse (0x0), not on the body's NothingToClaim. The
      // weight reset (M-01) is the second line of defence, reached only if the PDA is
      // ever made non-`init`.
      assert.match(
        String(e), /custom program error: 0x0|already in use/i,
        `expected the LpEpochClaim collision on replay, got: ${e}`,
      );
    }
    assert.isTrue(reverted, "a second claim for the same (user, pool, epoch) MUST revert");
    console.log("✅ [lp-emission][security] replay rejected at validation by the LpEpochClaim PDA");
  });

  it("[lp-emission][security] two LPs together never mint more than the epoch allocation", async () => {
    // Guards the invariant the `osola_claimed` ceiling exists to hold: Σ claims ≤
    // allocation. Note the clamp itself does not bind here — with the fix in place two
    // honest LPs under-subscribe the pot (the denominator counts the whole epoch, they
    // only checkpoint part of it), which is the safe direction. This is a regression
    // guard on the invariant, not coverage of the clamp branch.
    const epoch1 = epoch0 + 1n;
    const lp2 = Keypair.generate();
    await fundSol(lp2.publicKey);
    await mintTo(mintA, lp2.publicKey, 500_000_000);
    await mintTo(mintB, lp2.publicKey, 500_000_000);

    await warpTo(epochStart(epoch1) + 60n);
    await voteGauge(payer, epoch1, ONE.muln(25)); // gauge needs votes in the new epoch too
    await addLiquidity(lp2, ONE.muln(100), ONE.muln(100));

    await checkpoint(payer, epoch1);
    await checkpoint(lp2, epoch1);
    await warpTo(epochStart(epoch1) + 5n * 86_400n);
    await checkpoint(payer, epoch1);
    await checkpoint(lp2, epoch1);

    await warpTo(epochEnd(epoch1) + 60n);
    await emitRewards(epoch1);

    const o1 = getAssociatedTokenAddressSync(oSolaM, payer.publicKey);
    const o2 = getAssociatedTokenAddressSync(oSolaM, lp2.publicKey);
    const b1 = await balance(o1);
    const b2 = await balance(o2);
    await claimEmissions(payer, epoch1);
    await claimEmissions(lp2, epoch1);
    const g1 = (await balance(o1)) - b1;
    const g2 = (await balance(o2)) - b2;

    const pa = await program.account.lpPoolEpochAccum.fetch(accumPda(pool, epoch1));
    // One epoch of decay has elapsed since start_epoch: 100 × 9_900/10_000 = 99 oSOLA.
    // Pins decayed_emission as well as the split, so a change to either breaks here.
    assert.equal(
      pa.osolaAllocated.toString(),
      EMISSION_INITIAL.muln(9_900).divn(10_000).toString(),
      "epoch 1 must allocate the once-decayed emission",
    );
    assert.isTrue(g1 > 0n && g2 > 0n, "both real LPs must be paid");
    assert.isTrue(
      pa.osolaClaimed.lte(pa.osolaAllocated),
      `Σ claims (${pa.osolaClaimed}) must stay under the allocation (${pa.osolaAllocated})`,
    );
    assert.equal(
      pa.osolaClaimed.toString(), (g1 + g2).toString(),
      "the running total must equal what was actually minted",
    );
    console.log(
      `✅ [lp-emission][security] epoch ${epoch1}: ${Number(g1) / 1e6} + ${Number(g2) / 1e6} ` +
      `= ${pa.osolaClaimed.toNumber() / 1e6} ≤ ${pa.osolaAllocated.toNumber() / 1e6} allocated`,
    );
  });

  // ── the reward basis around LpUserInfo.lp_amount ──────────────────────────

  it("[lp-reward] withdrawing shrinks the recorded deposit, so it shrinks the basis", async () => {
    // The migration path testers are told to walk (remove then add). Nothing asserted that
    // a withdrawal actually decrements lp_amount — the mirror image of Finding B, and the
    // difference between "stops earning" and "keeps earning on capital it no longer has".
    const info0 = await program.account.lpUserInfo.fetch(lpUserInfoPda(pool, payer.publicKey));
    const half = info0.lpAmount.divn(2);

    await removeLiquidity(payer, half);

    const info1 = await program.account.lpUserInfo.fetch(lpUserInfoPda(pool, payer.publicKey));
    assert.equal(
      info1.lpAmount.toString(), info0.lpAmount.sub(half).toString(),
      "lp_amount must fall by exactly what was withdrawn",
    );
    assert.equal(
      info1.lpAmount.toString(), (await balance(getAssociatedTokenAddressSync(lpMint, payer.publicKey))).toString(),
      "recorded deposit stays equal to the wallet balance for an honest LP",
    );
    console.log(`✅ [lp-reward] withdrawal cut lp_amount to ${info1.lpAmount.toNumber() / 1e6}`);
  });

  it("[lp-reward][security] LP leaving the wallet caps the basis at the wallet balance", async () => {
    // Finding B covers lp_amount = 0 with a positive balance. This is the reverse leg of
    // `reward_basis = min(lp_amount, wallet_lp)`: a real depositor keeps a large lp_amount
    // but moves the LP out. The basis must follow the balance DOWN, or the position earns
    // on capital it has handed to someone else.
    const epoch2 = epoch0 + 2n;
    await warpTo(epochStart(epoch2) + 60n);

    const sink = Keypair.generate();
    await fundSol(sink.publicKey);
    const myLp = getAssociatedTokenAddressSync(lpMint, payer.publicKey);
    const sinkLp = getAssociatedTokenAddressSync(lpMint, sink.publicKey);
    const held = await balance(myLp);

    const info = await program.account.lpUserInfo.fetch(lpUserInfoPda(pool, payer.publicKey));
    await send([
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, sinkLp, sink.publicKey, lpMint),
      createTransferInstruction(myLp, sinkLp, payer.publicKey, held), // move ALL of it out
    ]);
    assert.isTrue(info.lpAmount.gt(new BN(0)), "lp_amount is still recorded after the transfer");
    assert.equal((await balance(myLp)).toString(), "0", "wallet is empty");

    // Weight banked from here on must be zero: min(lp_amount > 0, balance = 0) = 0.
    await checkpoint(payer, epoch2);
    await warpTo(epochStart(epoch2) + 2n * 86_400n);
    await checkpoint(payer, epoch2);

    const ck = await program.account.lpUserCheckpoint.fetch(lpCkptPda(pool, payer.publicKey));
    assert.equal(
      ck.weightedBalance.toString(), "0",
      "a position whose LP left the wallet must bank zero weight, whatever lp_amount says",
    );
    console.log("✅ [lp-reward][security] basis followed the wallet balance down to zero");
  });

  it("[lp-reward] a position recorded at zero can still withdraw its LP", async () => {
    // Legacy positions (created before lp_amount existed) and transfer-acquired LP both
    // read lp_amount = 0. `remove_liquidity` uses saturating_sub, so withdrawal must still
    // work — otherwise the fix would have stranded every pre-fix LP.
    const holder = Keypair.generate();
    await fundSol(holder.publicKey);
    const holderLp = getAssociatedTokenAddressSync(lpMint, holder.publicKey);

    // Give it LP by transfer only: no add_liquidity, so lp_user_info lands on lp_amount = 0.
    const sinkLpOwner = holder.publicKey;
    await send([
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, holderLp, sinkLpOwner, lpMint),
    ]);
    const lp2Ata = getAssociatedTokenAddressSync(lpMint, payer.publicKey);
    // top the payer back up so there is LP to hand over
    await addLiquidity(payer, ONE.muln(10), ONE.muln(10));
    const give = (await balance(lp2Ata)) / 2n;
    await send([createTransferInstruction(lp2Ata, holderLp, payer.publicKey, give)]);

    await mintTo(mintA, holder.publicKey, 1); // ensure destination ATAs exist
    await mintTo(mintB, holder.publicKey, 1);

    await removeLiquidity(holder, new BN(give.toString()));

    const info = await program.account.lpUserInfo.fetch(lpUserInfoPda(pool, holder.publicKey));
    assert.equal(info.lpAmount.toString(), "0", "saturating_sub floors the recorded deposit at zero");
    assert.equal((await balance(holderLp)).toString(), "0", "the LP was actually burned on withdrawal");
    console.log("✅ [lp-reward] zero-recorded position withdrew without reverting");
  });
  it("[lp-emission][security] a late depositor cannot bank a full epoch of weight (Finding A)", async () => {
    // THE regression test for Finding A, and the one that earns its keep: it was verified
    // to FAIL when `window_start` in checkpoint_lp is put back to `epoch_start`.
    //
    // The bug is invisible to a long-standing position (back-crediting an LP that held all
    // epoch changes almost nothing). It only shows on the exploit shape: deposit at T−ε,
    // checkpoint, and bill the whole epoch. So compare weight PER LP UNIT between someone
    // who held ~7 days and someone who held ~0.9 — under the fix the early LP must be
    // multiples ahead; under the bug the two converge.
    const epochN = epoch0 + 5n;
    const early = Keypair.generate();
    const late = Keypair.generate();
    for (const kp of [early, late]) {
      await fundSol(kp.publicKey);
      await mintTo(mintA, kp.publicKey, 500_000_000);
      await mintTo(mintB, kp.publicKey, 500_000_000);
    }

    await warpTo(epochStart(epochN) + 60n);
    await addLiquidity(early, ONE.muln(50), ONE.muln(50));
    await checkpoint(early, epochN); // first checkpoint banks nothing: it opens the window

    await warpTo(epochStart(epochN) + 6n * 86_400n);
    await addLiquidity(late, ONE.muln(50), ONE.muln(50));
    await checkpoint(early, epochN);
    await checkpoint(late, epochN);

    await warpTo(epochStart(epochN) + 6n * 86_400n + 77_760n); // +0.9 d
    await checkpoint(early, epochN);
    await checkpoint(late, epochN);

    const ckE = await program.account.lpUserCheckpoint.fetch(lpCkptPda(pool, early.publicKey));
    const ckL = await program.account.lpUserCheckpoint.fetch(lpCkptPda(pool, late.publicKey));
    const lpE = await balance(getAssociatedTokenAddressSync(lpMint, early.publicKey));
    const lpL = await balance(getAssociatedTokenAddressSync(lpMint, late.publicKey));
    assert.isTrue(lpE > 0n && lpL > 0n, "both wallets hold LP");

    // Normalised so the comparison is time, not deposit size (LP minted differs slightly
    // as reserves move between the two deposits).
    const perLpE = BigInt(ckE.weightedBalance.toString()) / lpE;
    const perLpL = BigInt(ckL.weightedBalance.toString()) / lpL;
    assert.isTrue(
      perLpE > perLpL * 5n,
      `the ~7-day LP must bank multiples of the ~0.9-day LP (got ${perLpE} vs ${perLpL}) — ` +
      `equal weights mean checkpoint_lp is back-crediting to epoch_start`,
    );
    console.log(
      `✅ [lp-emission][security] weight/LP: early ${perLpE} vs late ${perLpL} ` +
      `(ratio ${Number(perLpE / (perLpL === 0n ? 1n : perLpL))}×) — no back-credit`,
    );
  });
});
