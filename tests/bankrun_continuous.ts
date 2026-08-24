// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// # Bankrun harness — the CONTINUOUS oSOLA emission stream
//
// The second, entirely separate emission path. Where `emit_pool_rewards` allocates a fixed
// pot once an epoch has closed, this one drips `continuous_rate_per_sec` every second into
// `pool.osola_reward_per_lp`, and `claim_lp_rewards` mints against it on demand. It shares
// no accounting with the per-epoch path — a different accumulator, a different claim
// instruction, a different set of guards — so covering one says nothing about the other.
//
// It is also the path that is time-dependent in the most literal way: accrual is
// `rate × elapsed_seconds`. On a validator you can only ever observe a few seconds of it,
// which is why it went untested.
//
// The properties that matter are all ceilings on a mint, plus one that is easy to get
// wrong and expensive when it is:
//
//   C-1. Accrual is rate × elapsed, split pro-rata over LP supply.
//   C-2. The stream stops dead at `continuous_end_epoch`.
//   C-3. The per-pool switch (`rewards_enabled`) gates accrual.
//   C-4. The master switch (`emissions_enabled`) gates accrual.
//   C-5. ☢️ No BACK-PAYMENT across a closed window. `advance_pool_rewards` moves
//        `last_reward_ts` even when nothing accrues, precisely so a pool re-enabled after a
//        long pause does not mint the whole gap in one claim. If that timestamp ever stopped
//        advancing, re-enabling a pool after a month would mint a month of emissions at once.

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
const RATE_PER_SEC = 1_000; // 0.001 oSOLA/s at 6 decimals — small enough to stay exact
const HOUR = 3_600;

describe("soladrome — bankrun (continuous emission stream)", () => {
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
  let oSolaM: PublicKey;
  let poolPda: PublicKey;
  let lpMint: PublicKey;
  let vaultA: PublicKey;
  let vaultB: PublicKey;

  let userUsdc: PublicKey;
  let userTkn: PublicKey;
  let userOSola: PublicKey;
  let userLp: PublicKey;
  let lpUserInfo: PublicKey;

  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];

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

  /// Claim the continuous stream and return what was actually minted.
  /// The nonce keeps otherwise-identical transactions distinct — bankrun caches by signature.
  async function claimStream(nonce: number): Promise<bigint> {
    const before = await tokenBalance(userOSola);
    const ix = await program.methods
      .claimLpRewards()
      .accounts({
        user: payer.publicKey,
        pool: poolPda,
        lpMint,
        userLp,
        lpUserInfo,
        protocolState: statePda,
        oSolaMint: oSolaM,
        userOSola,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .instruction();
    try {
      await send([
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: payer.publicKey,
          lamports: nonce,
        }),
        ix,
      ]);
    } catch (e: any) {
      // NothingToClaim is a legitimate result — it is what "the stream is closed" looks like.
      const code = idlJson.errors.find((x: any) => x.name === "NothingToClaim").code;
      if (!e.toString().includes(`0x${code.toString(16)}`)) throw e;
      return BigInt(0);
    }
    return (await tokenBalance(userOSola)) - before;
  }

  async function setPoolRewards(enabled: boolean) {
    await program.methods
      .setPoolRewards(enabled)
      .accounts({
        authority: payer.publicKey,
        protocolState: statePda,
        pool: poolPda,
      } as any)
      .rpc();
  }

  async function setEmissionsEnabled(enabled: boolean) {
    await program.methods
      .setPhaseFlags(null, null, null, null, null, enabled)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();
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

  before(async () => {
    context = await startAnchor(".", [], []);
    provider = new BankrunProvider(context);
    payer = context.payer;
    idlJson = JSON.parse(fs.readFileSync("target/idl/soladrome.json", "utf8"));
    program = new anchor.Program(idlJson, provider);

    statePda = pda([Buffer.from("state")]);
    oSolaM = pda([Buffer.from("o_sola_mint")]);

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
        solaM: pda([Buffer.from("sola_mint")]),
        hiSolaM: pda([Buffer.from("hi_sola_mint")]),
        oSolaM,
        floorVault: pda([Buffer.from("floor_vault")]),
        marketVault: pda([Buffer.from("market_vault")]),
        solaVault: pda([Buffer.from("sola_vault")]),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await program.methods
      .setPhaseFlags(true, null, null, null, true, true)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    userUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
    userTkn = getAssociatedTokenAddressSync(tknMint, payer.publicKey);
    userOSola = getAssociatedTokenAddressSync(oSolaM, payer.publicKey);

    await send([
      createAssociatedTokenAccountInstruction(payer.publicKey, userUsdc, payer.publicKey, usdcMint),
      createAssociatedTokenAccountInstruction(payer.publicKey, userTkn, payer.publicKey, tknMint),
      createMintToInstruction(usdcMint, userUsdc, payer.publicKey, 2_000_000_000),
      createMintToInstruction(tknMint, userTkn, payer.publicKey, 2_000_000_000),
    ]);

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
    lpUserInfo = pda([Buffer.from("lp_user"), poolPda.toBuffer(), payer.publicKey.toBuffer()]);

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
        lpUserInfo,
        protocolState: statePda,
        oSolaMint: oSolaM,
        userOSola,
        rent: SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    assert.isAbove(Number(await tokenBalance(userLp)), 0, "the LP must hold LP tokens");

    // Arm the stream for a long window, and approve this pool.
    await program.methods
      .configureContinuousEmissions(new BN(RATE_PER_SEC), new BN(50))
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();
    await setPoolRewards(true);

    // Prime `last_reward_ts` so the first measured interval starts from a known point.
    await claimStream(1);
  });

  it("[stream] accrual is rate × elapsed, shared pro-rata across LP supply", async () => {
    await forwardSeconds(HOUR);
    const minted = await claimStream(2);

    // This wallet is the only LP apart from the MINIMUM_LIQUIDITY burned to the dead address,
    // so it should receive essentially the whole hour of emissions. Assert a tight band
    // rather than equality: 1 000 LP units are permanently locked at the dead address and
    // dilute the share by a hair, and the accumulator floors on division.
    const pool: any = await program.account.ammPool.fetch(poolPda);
    const userLpBal = await tokenBalance(userLp);
    const expected =
      (BigInt(RATE_PER_SEC) * BigInt(HOUR) * userLpBal) / BigInt(pool.totalLp.toString());

    assert.isTrue(
      minted > (expected * BigInt(99)) / BigInt(100) && minted <= expected,
      `expected ~${expected} for one hour at ${RATE_PER_SEC}/s, got ${minted}`
    );
  });

  it("[stream] a claim with no elapsed time mints nothing", async () => {
    const minted = await claimStream(3);
    assert.equal(minted, BigInt(0), "claiming twice in the same instant must mint nothing");
  });

  it("[stream] the per-pool switch stops accrual", async () => {
    await setPoolRewards(false);
    await forwardSeconds(HOUR);
    const minted = await claimStream(4);
    assert.equal(minted, BigInt(0), "a pool with rewards_enabled=false must not accrue");
  });

  // ⚠️ Which copy of the accrual actually guards this path is not obvious. The logic exists
  // TWICE in amm.rs — once as the `update_pool_rewards!` macro (used by swap, add/remove
  // liquidity and claim_lp_rewards) and once as the `advance_pool_rewards` function (used by
  // `set_pool_rewards` and `flash_arbitrage`). This scenario is protected by the FUNCTION,
  // because `set_pool_rewards` advances the timestamp before flipping the flag. Mutating only
  // the macro leaves this test green; mutating the function makes it mint 61 minutes of
  // stream for 60 seconds of elapsed time. Two copies of one invariant is a maintenance
  // hazard: fixing one and not the other makes the protection silently path-dependent.
  it("[stream] ☢️ re-enabling after a pause does not back-pay the gap", async () => {
    // The pool has just sat through an hour with rewards off. Turn it back on and let a
    // short, known interval pass. If `last_reward_ts` had stalled while disabled, this claim
    // would mint the whole dark hour on top — the difference between 60 seconds and an hour
    // of emissions, minted in one call, on a switch flip.
    await setPoolRewards(true);
    await forwardSeconds(60);
    const minted = await claimStream(5);

    const pool: any = await program.account.ammPool.fetch(poolPda);
    const userLpBal = await tokenBalance(userLp);
    const oneMinute =
      (BigInt(RATE_PER_SEC) * BigInt(60) * userLpBal) / BigInt(pool.totalLp.toString());
    const oneHour = oneMinute * BigInt(60);

    assert.isTrue(
      minted <= oneMinute,
      `minted ${minted} for 60 s of stream — anything above ${oneMinute} means the paused ` +
        `hour was back-paid (a full hour would be ~${oneHour})`
    );
    assert.isTrue(minted > BigInt(0), "the stream must resume once re-enabled");
  });

  it("[stream] the master switch stops accrual too", async () => {
    await setEmissionsEnabled(false);
    await forwardSeconds(HOUR);
    const minted = await claimStream(6);
    assert.equal(minted, BigInt(0), "emissions_enabled=false must stop the stream");

    await setEmissionsEnabled(true);
  });

  it("[stream] the stream stops dead at continuous_end_epoch", async () => {
    const state: any = await program.account.protocolState.fetch(statePda);
    const endEpoch = Number(state.continuousEndEpoch);
    const nowEpoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    assert.isAbove(endEpoch, nowEpoch, "the window must still be open before we close it");

    // Jump past the configured end, then let a long stretch pass.
    await forwardSeconds((endEpoch - nowEpoch + 1) * EPOCH_DURATION);
    assert.isAtLeast(
      Math.floor((await nowSeconds()) / EPOCH_DURATION),
      endEpoch,
      "we must be at or past the end epoch"
    );

    // Prime once so `last_reward_ts` sits inside the closed window, then measure.
    await claimStream(7);
    await forwardSeconds(EPOCH_DURATION);
    const minted = await claimStream(8);
    assert.equal(
      minted,
      BigInt(0),
      "no oSOLA may be minted from the stream once the window has closed"
    );
  });
});
