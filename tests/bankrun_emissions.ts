// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// # Bankrun harness — the per-epoch LP emission cycle
//
// This is the coverage gap flagged in July as the gate before arming
// `osola_emission_initial > 0` on mainnet: Finding A. The emission cycle spans epoch
// boundaries by construction —
//
//   checkpoint_lp (inside epoch N)  →  emit_pool_rewards (only once N has ENDED)
//                                   →  claim_lp_emissions (mints oSOLA)
//
// — and `emit_pool_rewards` refuses to run before `(epoch + 1) * 604_800`. On a validator
// that means waiting a week per epoch, so the cycle had never been executed end to end and
// the arithmetic that decides how much oSOLA gets minted was, in practice, unverified.
//
// What actually matters here is a mint authority: `claim_lp_emissions` calls `mint_to` on
// oSOLA. Every property below is about the ceiling on that mint.
//
//   E-1. The epoch pot equals the decayed schedule, split by gauge votes.
//   E-2. A (pool, epoch) is finalised exactly once — no second allocation.
//   E-3. Claims can never mint more than the pot, and a claim cannot be replayed.
//   E-4. Decay is real across epochs.
//   E-5. The master switch and the epoch-end guard both hold.

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { startAnchor, Clock, ProgramTestContext } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import * as fs from "fs";

const EPOCH_DURATION = 604_800;

// Chosen so the schedule is checkable by hand: 1 000 oSOLA, halving each epoch, floor 10%.
const EMISSION_INITIAL = 1_000_000_000;
const DECAY_BPS = 5_000;
const FLOOR_BPS = 1_000;

describe("soladrome — bankrun (LP emission cycle)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: anchor.Program<any>;
  let payer: Keypair;
  let idlJson: any;

  let usdcMint: PublicKey;
  let tknMint: PublicKey;
  let mintA: PublicKey;
  let mintB: PublicKey;

  let statePda: PublicKey;
  let solaM: PublicKey;
  let hiSolaM: PublicKey;
  let oSolaM: PublicKey;
  let floorV: PublicKey;
  let marketV: PublicKey;
  let solaVault: PublicKey;
  let voteEscrowVault: PublicKey;

  let poolPda: PublicKey;
  let lpMint: PublicKey;
  let vaultA: PublicKey;
  let vaultB: PublicKey;

  let userUsdc: PublicKey;
  let userTkn: PublicKey;
  let userSola: PublicKey;
  let userHiSola: PublicKey;
  let userOSola: PublicKey;
  let userLp: PublicKey;
  let userPosition: PublicKey;

  let emissionEpoch: number;
  let votedWeight: bigint;

  // ── helpers ───────────────────────────────────────────────────────────────

  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  const epochLE = (e: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(e));
    return b;
  };

  /// hiSOLA balance of a position — the ledger field that replaced the token account.
  async function positionHiSola(position: PublicKey): Promise<bigint> {
    const pos = await program.account.userPosition.fetch(position);
    return BigInt(pos.hiSola.toString());
  }

  async function tokenBalance(account: PublicKey): Promise<bigint> {
    const raw = await context.banksClient.getAccount(account);
    if (!raw) return BigInt(0);
    return AccountLayout.decode(Buffer.from(raw.data)).amount;
  }

  async function send(ixs: any[], signers: Keypair[] = []) {
    const tx = new Transaction();
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = payer.publicKey;
    ixs.forEach((ix) => tx.add(ix));
    tx.sign(payer, ...signers);
    return context.banksClient.processTransaction(tx);
  }

  async function nowSeconds(): Promise<number> {
    const clock = await context.banksClient.getClock();
    return Number(clock.unixTimestamp);
  }

  async function forwardSeconds(seconds: number) {
    const clock = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        clock.unixTimestamp + BigInt(seconds)
      )
    );
  }

  function errorCode(name: string): number {
    const entry = idlJson.errors.find((e: any) => e.name === name);
    assert.isDefined(entry, `no such error in the IDL: ${name}`);
    return entry.code;
  }

  async function expectFailure(fn: () => Promise<any>, name: string) {
    const code = errorCode(name);
    try {
      await fn();
      assert.fail(`expected ${name} (${code}), but the call succeeded`);
    } catch (e: any) {
      const msg = e.toString();
      if (/but the call succeeded/.test(msg)) throw e;
      assert.include(
        msg,
        `0x${code.toString(16)}`,
        `expected ${name} (0x${code.toString(16)}), got: ${msg}`
      );
    }
  }

  /// The reference schedule, recomputed here rather than read back from the program: a test
  /// that asks the program what it should have done proves nothing.
  function expectedEpochTotal(elapsed: number): bigint {
    let decayed = BigInt(EMISSION_INITIAL);
    for (let i = 0; i < elapsed; i++) {
      decayed = (decayed * BigInt(DECAY_BPS)) / BigInt(10_000);
    }
    const floor = (BigInt(EMISSION_INITIAL) * BigInt(FLOOR_BPS)) / BigInt(10_000);
    return decayed > floor ? decayed : floor;
  }

  async function createMint(): Promise<PublicKey> {
    const kp = Keypair.generate();
    const rent = await context.banksClient.getRent();
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: kp.publicKey,
          space: MINT_SIZE,
          lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(kp.publicKey, 6, payer.publicKey, null),
      ],
      [kp]
    );
    return kp.publicKey;
  }

  async function checkpoint(epoch: number, nonce: number) {
    const ix = await program.methods
      .checkpointLp(new BN(epoch))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        pool: poolPda,
        lpMint,
        userLp,
        lpUserInfo: pda([Buffer.from("lp_user"), poolPda.toBuffer(), payer.publicKey.toBuffer()]),
        lpUserCheckpoint: pda([Buffer.from("lp_ckpt"), poolPda.toBuffer(), payer.publicKey.toBuffer()]),
        poolEpochAccum: pda([Buffer.from("lp_pool_epoch"), poolPda.toBuffer(), epochLE(epoch)]),
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .instruction();
    return send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: nonce,
      }),
      ix,
    ]);
  }

  async function emit(epoch: number, nonce: number) {
    const ix = await program.methods
      .emitPoolRewards(new BN(epoch))
      .accounts({
        caller: payer.publicKey,
        protocolState: statePda,
        pool: poolPda,
        lpMint,
        gaugeState: pda([Buffer.from("gauge"), poolPda.toBuffer(), epochLE(epoch)]),
        globalEpochVotes: pda([Buffer.from("epoch_votes"), epochLE(epoch)]),
        poolEpochAccum: pda([Buffer.from("lp_pool_epoch"), poolPda.toBuffer(), epochLE(epoch)]),
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .instruction();
    return send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: nonce,
      }),
      ix,
    ]);
  }

  async function claim(epoch: number, nonce: number) {
    const ix = await program.methods
      .claimLpEmissions(new BN(epoch))
      .accounts({
        user: payer.publicKey,
        pool: poolPda,
        protocolState: statePda,
        oSolaMint: oSolaM,
        userOSola: userOSola,
        poolEpochAccum: pda([Buffer.from("lp_pool_epoch"), poolPda.toBuffer(), epochLE(epoch)]),
        lpUserCheckpoint: pda([Buffer.from("lp_ckpt"), poolPda.toBuffer(), payer.publicKey.toBuffer()]),
        lpEpochClaim: pda([
          Buffer.from("lp_claim"),
          payer.publicKey.toBuffer(),
          poolPda.toBuffer(),
          epochLE(epoch),
        ]),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .instruction();
    return send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: nonce,
      }),
      ix,
    ]);
  }

  async function voteForPool(epoch: number, weight: bigint) {
    await program.methods
      .voteGauge(new BN(epoch), new BN(weight.toString()))
      .accounts({
        user: payer.publicKey,
        poolId: poolPda, // the gauge is keyed on the real pool, not a label
        protocolState: statePda,
        marketVault: marketV,
        userPosition,
        lockPosition: SystemProgram.programId,
        gaugeState: pda([Buffer.from("gauge"), poolPda.toBuffer(), epochLE(epoch)]),
        userVoteReceipt: pda([
          Buffer.from("vote"),
          payer.publicKey.toBuffer(),
          poolPda.toBuffer(),
          epochLE(epoch),
        ]),
        userEpochVotes: pda([Buffer.from("uev"), payer.publicKey.toBuffer(), epochLE(epoch)]),
        globalEpochVotes: pda([Buffer.from("epoch_votes"), epochLE(epoch)]),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
  }

  before(async () => {
    context = await startAnchor(".", [], []);
    provider = new BankrunProvider(context);
    payer = context.payer;
    idlJson = JSON.parse(fs.readFileSync("target/idl/soladrome.json", "utf8"));
    program = new anchor.Program(idlJson, provider);

    statePda = pda([Buffer.from("state")]);
    solaM = pda([Buffer.from("sola_mint")]);
    hiSolaM = pda([Buffer.from("hi_sola_mint")]);
    oSolaM = pda([Buffer.from("o_sola_mint")]);
    floorV = pda([Buffer.from("floor_vault")]);
    marketV = pda([Buffer.from("market_vault")]);
    solaVault = pda([Buffer.from("sola_vault")]);
    voteEscrowVault = pda([Buffer.from("vote_escrow")]);
    userPosition = pda([Buffer.from("position"), payer.publicKey.toBuffer()]);

    usdcMint = await createMint();
    tknMint = await createMint();

    await program.methods
      .initialize(
        // The founder wallet is no longer baked into the binary — `initialize` records it.
        // A THROWAWAY key, deliberately not `payer`: the founder guards (no voting, no
        // unlock, no oSOLA burn) would otherwise fire on this harness's own actor.
        Keypair.generate().publicKey
      )
      .accounts({
        authority: payer.publicKey,
        protocolState: statePda,
        usdcMint,
        solaM,
        hiSolaM,
        oSolaM,
        floorVault: floorV,
        marketVault: marketV,
        solaVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    // lp + voting + curve + emissions. `emissions_enabled` is the master switch this cycle
    // hangs off; it is deliberately toggled off again in E-5.
    await program.methods
      .setPhaseFlags(true, null, true, null, true, true)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    await program.methods
      .configureEmissions(new BN(EMISSION_INITIAL), DECAY_BPS, FLOOR_BPS)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    // ── token accounts ──────────────────────────────────────────────────────
    userUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
    userTkn = getAssociatedTokenAddressSync(tknMint, payer.publicKey);
    userSola = getAssociatedTokenAddressSync(solaM, payer.publicKey);
    userHiSola = getAssociatedTokenAddressSync(hiSolaM, payer.publicKey);
    userOSola = getAssociatedTokenAddressSync(oSolaM, payer.publicKey);

    await send([
      createAssociatedTokenAccountInstruction(payer.publicKey, userUsdc, payer.publicKey, usdcMint),
      createAssociatedTokenAccountInstruction(payer.publicKey, userTkn, payer.publicKey, tknMint),
      createMintToInstruction(usdcMint, userUsdc, payer.publicKey, 2_000_000_000),
      createMintToInstruction(tknMint, userTkn, payer.publicKey, 2_000_000_000),
    ]);

    // ── pool (mints sorted lexicographically, as sort_mints does on-chain) ──
    const [a, b] =
      Buffer.compare(usdcMint.toBuffer(), tknMint.toBuffer()) <= 0
        ? [usdcMint, tknMint]
        : [tknMint, usdcMint];
    mintA = a;
    mintB = b;
    poolPda = pda([Buffer.from("amm_pool"), mintA.toBuffer(), mintB.toBuffer()]);
    lpMint = pda([Buffer.from("lp_mint"), poolPda.toBuffer()]);
    vaultA = pda([Buffer.from("vault_a"), poolPda.toBuffer()]);
    vaultB = pda([Buffer.from("vault_b"), poolPda.toBuffer()]);
    userLp = getAssociatedTokenAddressSync(lpMint, payer.publicKey);

    await program.methods
      .createPool(30, 1_000)
      .accounts({
        creator: payer.publicKey,
        protocolState: statePda,
        tokenAMint: mintA,
        tokenBMint: mintB,
        pool: poolPda,
        lpMint,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await program.methods
      .addLiquidity(new BN(500_000_000), new BN(500_000_000), new BN(1))
      .accounts({
        user: payer.publicKey,
        pool: poolPda,
        lpMint,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        userTokenA: mintA.equals(usdcMint) ? userUsdc : userTkn,
        userTokenB: mintA.equals(usdcMint) ? userTkn : userUsdc,
        userLp,
        lpDeadAta: getAssociatedTokenAddressSync(lpMint, SystemProgram.programId, true),
        lpDead: SystemProgram.programId,
        lpUserInfo: pda([Buffer.from("lp_user"), poolPda.toBuffer(), payer.publicKey.toBuffer()]),
        protocolState: statePda,
        oSolaMint: oSolaM,
        userOSola,
        rent: SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    assert.isAbove(
      Number(await tokenBalance(userLp)),
      0,
      "the LP must actually hold LP tokens"
    );

    // ── hiSOLA, to direct the gauge ─────────────────────────────────────────
    await program.methods
      .buySola(new BN(100_000_000), new BN(1))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        userUsdc,
        userSola,
        floorVault: floorV,
        marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const bought = await tokenBalance(userSola);
    await program.methods
      .stakeSola(new BN(bought.toString()))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        usdcMint,
        userUsdc,
        userSola,
        solaVault,
        marketVault: marketV,
        userPosition,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Park one hour into a fresh epoch, for the reason given in tests/bankrun.ts.
    const nowE = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    await forwardSeconds((nowE + 1) * EPOCH_DURATION + 3600 - (await nowSeconds()));
    emissionEpoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);

    // Sole staker ⇒ the 30% global cap binds against this wallet's own stake.
    const staked = await positionHiSola(userPosition);
    votedWeight = (staked * BigInt(3000)) / BigInt(10000);
    await voteForPool(emissionEpoch, votedWeight);
  });

  it("[emissions] emit_pool_rewards refuses to run before the epoch has ended", async () => {
    await expectFailure(() => emit(emissionEpoch, 1), "EpochNotEnded");
  });

  it("[emissions] the epoch pot equals the decayed schedule, directed by the gauge", async () => {
    // Two checkpoints inside the epoch: one early, one late, which is the usage the
    // instruction's own comment recommends.
    await checkpoint(emissionEpoch, 2);
    await forwardSeconds(EPOCH_DURATION / 2);
    await checkpoint(emissionEpoch, 3);

    // Cross into the next epoch — the whole reason this file exists.
    await forwardSeconds(EPOCH_DURATION);
    assert.isAbove(
      Math.floor((await nowSeconds()) / EPOCH_DURATION),
      emissionEpoch,
      "the clock must have left the emission epoch"
    );

    await emit(emissionEpoch, 4);

    const accum = await program.account.lpPoolEpochAccum.fetch(
      pda([Buffer.from("lp_pool_epoch"), poolPda.toBuffer(), epochLE(emissionEpoch)])
    );
    assert.isTrue(accum.finalized, "the epoch must be finalised after emission");

    // This pool holds every vote cast, so it receives the whole scheduled pot.
    const state: any = await program.account.protocolState.fetch(statePda);
    const elapsed = emissionEpoch - Number(state.osolaEmissionStartEpoch);
    const expected = expectedEpochTotal(elapsed);
    assert.equal(
      accum.osolaAllocated.toString(),
      expected.toString(),
      `sole gauge must receive the full scheduled pot for elapsed=${elapsed}`
    );
  });

  it("[emissions] a finalised epoch cannot be allocated a second time", async () => {
    await expectFailure(() => emit(emissionEpoch, 5), "AlreadyAllocated");
  });

  it("[emissions] checkpointing is closed once the epoch is over", async () => {
    // Weight must not be addable after the pot was sized, or Σ shares could pass the
    // allocation. What actually refuses it is the epoch-window guard (`now < epoch_end`),
    // which fires before the `!finalized` check further down.
    //
    // Worth recording: that `!finalized` guard is unreachable by construction —
    // `emit_pool_rewards` only runs once the epoch has ENDED, while `checkpoint_lp` only
    // runs while it is still RUNNING, so no call can ever see a finalised accumulator
    // inside its own window. It is defence in depth, not a live check, and it was raising
    // `EpochNotFinalized` — the opposite of its own condition — until that was corrected to
    // `EpochAlreadyFinalized` on 2026-08-12. Harmless, but not the thing doing the work.
    await expectFailure(() => checkpoint(emissionEpoch, 6), "EpochNotEnded");
  });

  it("[emissions] a claim mints at most the pot, and cannot be replayed", async () => {
    const key = pda([Buffer.from("lp_pool_epoch"), poolPda.toBuffer(), epochLE(emissionEpoch)]);
    const before: any = await program.account.lpPoolEpochAccum.fetch(key);
    const osolaBefore = await tokenBalance(userOSola);

    await claim(emissionEpoch, 7);

    const after: any = await program.account.lpPoolEpochAccum.fetch(key);
    const minted = (await tokenBalance(userOSola)) - osolaBefore;

    assert.isAbove(Number(minted), 0, "the sole LP must receive something");
    assert.equal(
      after.osolaClaimed.toString(),
      minted.toString(),
      "the pot's claimed counter must match what was actually minted"
    );
    assert.isTrue(
      BigInt(after.osolaClaimed.toString()) <= BigInt(before.osolaAllocated.toString()),
      `minted ${after.osolaClaimed} exceeds the allocation ${before.osolaAllocated} — ` +
        `the epoch pot is not a ceiling`
    );

    // The LpEpochClaim PDA is created with `init`, so a replay cannot even be built.
    let replayed = false;
    try {
      await claim(emissionEpoch, 8);
      replayed = true;
    } catch {
      /* expected */
    }
    assert.isFalse(replayed, "a second claim for the same (user, pool, epoch) must fail");
  });

  it("[emissions] the next epoch's pot is strictly smaller — decay is real", async () => {
    const nextEpoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    assert.isAbove(nextEpoch, emissionEpoch, "we must be in a later epoch");

    // Re-arm: vote in the new epoch, checkpoint, then close it.
    const standing: any = await program.account.userPosition.fetch(userPosition);
    await voteForPool(nextEpoch, BigInt(standing.voteLocked.toString()));
    await checkpoint(nextEpoch, 9);
    await forwardSeconds(EPOCH_DURATION);
    await emit(nextEpoch, 10);

    const first: any = await program.account.lpPoolEpochAccum.fetch(
      pda([Buffer.from("lp_pool_epoch"), poolPda.toBuffer(), epochLE(emissionEpoch)])
    );
    const second: any = await program.account.lpPoolEpochAccum.fetch(
      pda([Buffer.from("lp_pool_epoch"), poolPda.toBuffer(), epochLE(nextEpoch)])
    );

    const state: any = await program.account.protocolState.fetch(statePda);
    const expected = expectedEpochTotal(nextEpoch - Number(state.osolaEmissionStartEpoch));
    assert.equal(
      second.osolaAllocated.toString(),
      expected.toString(),
      "the later epoch must follow the same schedule"
    );
    assert.isTrue(
      BigInt(second.osolaAllocated.toString()) < BigInt(first.osolaAllocated.toString()),
      `emission did not decay: ${second.osolaAllocated} vs ${first.osolaAllocated}`
    );
  });

  it("[emissions] the master switch stops the epoch path dead", async () => {
    // The launch guarantee is "emissions dormant". Assert it explicitly rather than relying
    // on the transitive no-votes coupling.
    await program.methods
      .setPhaseFlags(null, null, null, null, null, false)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    const thirdEpoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    const standing: any = await program.account.userPosition.fetch(userPosition);
    await voteForPool(thirdEpoch, BigInt(standing.voteLocked.toString()));
    await forwardSeconds(EPOCH_DURATION);

    await expectFailure(() => emit(thirdEpoch, 11), "FeatureDisabled");

    const accumKey = pda([
      Buffer.from("lp_pool_epoch"),
      poolPda.toBuffer(),
      epochLE(thirdEpoch),
    ]);
    // `fetchNullable` throws under the bankrun connection proxy when the account is absent,
    // so read the raw account instead: absent is exactly the outcome we expect here.
    const raw = await context.banksClient.getAccount(accumKey);
    if (raw !== null) {
      const accum: any = await program.account.lpPoolEpochAccum.fetch(accumKey);
      assert.isFalse(accum.finalized, "no pot may be sized while emissions are off");
      assert.equal(
        accum.osolaAllocated.toString(),
        "0",
        "nothing may be allocated while emissions are off"
      );
    }
  });
});
