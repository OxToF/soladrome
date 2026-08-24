// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// # Bankrun harness — the emission cycle with more than one actor
//
// `tests/bankrun_emissions.ts` proves the cycle end to end for ONE pool holding ONE
// LP position. Every ceiling it checks is therefore trivially tight: the sole gauge
// receives the whole pot, and the sole claimer cannot take more than it because there is
// nobody to take it from.
//
// The mint authority is only actually at risk with several claimants. Two divisions decide
// how much oSOLA leaves the mint in an epoch, and neither is exercised above:
//
//   epoch_total ──(× pool_votes / total_votes)──▶ pool pot ──(× user_weight / total_weight)──▶ claim
//                  emit_pool_rewards, per pool                claim_lp_emissions, per LP
//
// Each is a floor division over a subset. If either denominator can be smaller than the sum
// of its numerators, the epoch mints more oSOLA than the schedule allows — silently, and
// permissionlessly, since `emit_pool_rewards` is callable by anyone.
//
//   M-1. Two gauges split one schedule: Σ pool allocations ≤ epoch_total.
//   M-2. Two LPs split one pot: Σ claims ≤ the pool allocation, pro rata to held weight.
//   M-3. Weight earned in a later epoch cannot be spent against an earlier pot.
//   M-4. The oSOLA supply added over the epoch ≤ the scheduled emission. (The property
//        that actually gates arming `osola_emission_initial > 0` on mainnet.)

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
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  MintLayout,
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

// Same hand-checkable schedule as the single-actor harness.
const EMISSION_INITIAL = 1_000_000_000;
const DECAY_BPS = 5_000;
const FLOOR_BPS = 1_000;

const VOTE_WEIGHT_CAP_BPS = 3_000;

interface Pool {
  key: PublicKey;
  lpMint: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
}

describe("soladrome — bankrun (emission cycle, several gauges and several LPs)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: anchor.Program<any>;
  let payer: Keypair;
  let lpTwo: Keypair;
  let idlJson: any;

  let usdcMint: PublicKey;
  let tknX: PublicKey;
  let tknY: PublicKey;

  let statePda: PublicKey;
  let solaM: PublicKey;
  let hiSolaM: PublicKey;
  let oSolaM: PublicKey;
  let floorV: PublicKey;
  let marketV: PublicKey;
  let solaVault: PublicKey;
  let voteEscrowVault: PublicKey;
  let userPosition: PublicKey;

  let poolX: Pool;
  let poolY: Pool;

  let payerUsdc: PublicKey;
  let payerX: PublicKey;
  let payerY: PublicKey;
  let payerSola: PublicKey;
  let payerHiSola: PublicKey;
  let payerOSola: PublicKey;
  let lpTwoUsdc: PublicKey;
  let lpTwoX: PublicKey;
  let lpTwoOSola: PublicKey;

  let emissionEpoch: number;
  let votesX: bigint;
  let votesY: bigint;

  let nonce = 0;

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

  async function mintSupply(mint: PublicKey): Promise<bigint> {
    const raw = await context.banksClient.getAccount(mint);
    assert.isNotNull(raw, "mint must exist");
    return MintLayout.decode(Buffer.from(raw!.data)).supply;
  }

  /// Every transaction carries a distinct self-transfer: bankrun reuses one blockhash, so
  /// two byte-identical transactions collide as a duplicate rather than executing twice.
  async function send(ixs: any[], signers: Keypair[] = []) {
    const tx = new Transaction();
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = payer.publicKey;
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: ++nonce,
      })
    );
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

  /// The reference schedule, recomputed here rather than read back from the program.
  function expectedEpochTotal(elapsed: number): bigint {
    let decayed = BigInt(EMISSION_INITIAL);
    for (let i = 0; i < elapsed; i++) {
      decayed = (decayed * BigInt(DECAY_BPS)) / BigInt(10_000);
    }
    const floor =
      (BigInt(EMISSION_INITIAL) * BigInt(FLOOR_BPS)) / BigInt(10_000);
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
        createInitializeMint2Instruction(
          kp.publicKey,
          6,
          payer.publicKey,
          null
        ),
      ],
      [kp]
    );
    return kp.publicKey;
  }

  async function createPool(one: PublicKey, two: PublicKey): Promise<Pool> {
    const [mintA, mintB] =
      Buffer.compare(one.toBuffer(), two.toBuffer()) <= 0
        ? [one, two]
        : [two, one];
    const key = pda([
      Buffer.from("amm_pool"),
      mintA.toBuffer(),
      mintB.toBuffer(),
    ]);
    const pool: Pool = {
      key,
      mintA,
      mintB,
      lpMint: pda([Buffer.from("lp_mint"), key.toBuffer()]),
      vaultA: pda([Buffer.from("vault_a"), key.toBuffer()]),
      vaultB: pda([Buffer.from("vault_b"), key.toBuffer()]),
    };
    await program.methods
      .createPool(30, 1_000)
      .accounts({
        creator: payer.publicKey,
        protocolState: statePda,
        tokenAMint: pool.mintA,
        tokenBMint: pool.mintB,
        pool: pool.key,
        lpMint: pool.lpMint,
        tokenAVault: pool.vaultA,
        tokenBVault: pool.vaultB,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
    return pool;
  }

  async function addLiquidity(
    pool: Pool,
    user: Keypair,
    amountA: number,
    amountB: number
  ) {
    const ix = await program.methods
      .addLiquidity(new BN(amountA), new BN(amountB), new BN(1))
      .accounts({
        user: user.publicKey,
        pool: pool.key,
        lpMint: pool.lpMint,
        tokenAVault: pool.vaultA,
        tokenBVault: pool.vaultB,
        userTokenA: getAssociatedTokenAddressSync(pool.mintA, user.publicKey),
        userTokenB: getAssociatedTokenAddressSync(pool.mintB, user.publicKey),
        userLp: getAssociatedTokenAddressSync(pool.lpMint, user.publicKey),
        lpDeadAta: getAssociatedTokenAddressSync(
          pool.lpMint,
          SystemProgram.programId,
          true
        ),
        lpDead: SystemProgram.programId,
        lpUserInfo: pda([
          Buffer.from("lp_user"),
          pool.key.toBuffer(),
          user.publicKey.toBuffer(),
        ]),
        protocolState: statePda,
        oSolaMint: oSolaM,
        userOSola: getAssociatedTokenAddressSync(oSolaM, user.publicKey),
        rent: SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
    // `payer = user` on the init_if_needed accounts: the LP funds its own rent.
    return send([ix], user.publicKey.equals(payer.publicKey) ? [] : [user]);
  }

  async function checkpoint(pool: Pool, user: Keypair, epoch: number) {
    const ix = await program.methods
      .checkpointLp(new BN(epoch))
      .accounts({
        user: user.publicKey,
        protocolState: statePda,
        pool: pool.key,
        lpMint: pool.lpMint,
        userLp: getAssociatedTokenAddressSync(pool.lpMint, user.publicKey),
        lpUserInfo: pda([
          Buffer.from("lp_user"),
          pool.key.toBuffer(),
          user.publicKey.toBuffer(),
        ]),
        lpUserCheckpoint: pda([
          Buffer.from("lp_ckpt"),
          pool.key.toBuffer(),
          user.publicKey.toBuffer(),
        ]),
        poolEpochAccum: pda([
          Buffer.from("lp_pool_epoch"),
          pool.key.toBuffer(),
          epochLE(epoch),
        ]),
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .instruction();
    return send([ix], user.publicKey.equals(payer.publicKey) ? [] : [user]);
  }

  async function emit(pool: Pool, epoch: number) {
    const ix = await program.methods
      .emitPoolRewards(new BN(epoch))
      .accounts({
        caller: payer.publicKey,
        protocolState: statePda,
        pool: pool.key,
        lpMint: pool.lpMint,
        gaugeState: pda([
          Buffer.from("gauge"),
          pool.key.toBuffer(),
          epochLE(epoch),
        ]),
        globalEpochVotes: pda([Buffer.from("epoch_votes"), epochLE(epoch)]),
        poolEpochAccum: pda([
          Buffer.from("lp_pool_epoch"),
          pool.key.toBuffer(),
          epochLE(epoch),
        ]),
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .instruction();
    return send([ix]);
  }

  async function claim(pool: Pool, user: Keypair, epoch: number) {
    const ix = await program.methods
      .claimLpEmissions(new BN(epoch))
      .accounts({
        user: user.publicKey,
        pool: pool.key,
        protocolState: statePda,
        oSolaMint: oSolaM,
        userOSola: getAssociatedTokenAddressSync(oSolaM, user.publicKey),
        poolEpochAccum: pda([
          Buffer.from("lp_pool_epoch"),
          pool.key.toBuffer(),
          epochLE(epoch),
        ]),
        lpUserCheckpoint: pda([
          Buffer.from("lp_ckpt"),
          pool.key.toBuffer(),
          user.publicKey.toBuffer(),
        ]),
        lpEpochClaim: pda([
          Buffer.from("lp_claim"),
          user.publicKey.toBuffer(),
          pool.key.toBuffer(),
          epochLE(epoch),
        ]),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .instruction();
    return send([ix], user.publicKey.equals(payer.publicKey) ? [] : [user]);
  }

  async function voteForPool(pool: Pool, epoch: number, weight: bigint) {
    await program.methods
      .voteGauge(new BN(epoch), new BN(weight.toString()))
      .accounts({
        user: payer.publicKey,
        poolId: pool.key,
        protocolState: statePda,
        marketVault: marketV,
        userPosition,
        lockPosition: SystemProgram.programId,
        gaugeState: pda([
          Buffer.from("gauge"),
          pool.key.toBuffer(),
          epochLE(epoch),
        ]),
        userVoteReceipt: pda([
          Buffer.from("vote"),
          payer.publicKey.toBuffer(),
          pool.key.toBuffer(),
          epochLE(epoch),
        ]),
        userEpochVotes: pda([
          Buffer.from("uev"),
          payer.publicKey.toBuffer(),
          epochLE(epoch),
        ]),
        globalEpochVotes: pda([Buffer.from("epoch_votes"), epochLE(epoch)]),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
  }

  const accumOf = (pool: Pool, epoch: number) =>
    program.account.lpPoolEpochAccum.fetch(
      pda([Buffer.from("lp_pool_epoch"), pool.key.toBuffer(), epochLE(epoch)])
    );

  const ckptOf = (pool: Pool, user: Keypair) =>
    program.account.lpUserCheckpoint.fetch(
      pda([
        Buffer.from("lp_ckpt"),
        pool.key.toBuffer(),
        user.publicKey.toBuffer(),
      ])
    );

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
    tknX = await createMint();
    tknY = await createMint();

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

    await program.methods
      .setPhaseFlags(true, null, true, null, true, true)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    await program.methods
      .configureEmissions(new BN(EMISSION_INITIAL), DECAY_BPS, FLOOR_BPS)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    // ── the two LPs ─────────────────────────────────────────────────────────
    lpTwo = Keypair.generate();
    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: lpTwo.publicKey,
        lamports: 10 * LAMPORTS_PER_SOL,
      }),
    ]);

    payerUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
    payerX = getAssociatedTokenAddressSync(tknX, payer.publicKey);
    payerY = getAssociatedTokenAddressSync(tknY, payer.publicKey);
    payerSola = getAssociatedTokenAddressSync(solaM, payer.publicKey);
    payerHiSola = getAssociatedTokenAddressSync(hiSolaM, payer.publicKey);
    payerOSola = getAssociatedTokenAddressSync(oSolaM, payer.publicKey);
    lpTwoUsdc = getAssociatedTokenAddressSync(usdcMint, lpTwo.publicKey);
    lpTwoX = getAssociatedTokenAddressSync(tknX, lpTwo.publicKey);
    lpTwoOSola = getAssociatedTokenAddressSync(oSolaM, lpTwo.publicKey);

    await send([
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        payerUsdc,
        payer.publicKey,
        usdcMint
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        payerX,
        payer.publicKey,
        tknX
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        payerY,
        payer.publicKey,
        tknY
      ),
      createMintToInstruction(
        usdcMint,
        payerUsdc,
        payer.publicKey,
        5_000_000_000
      ),
      createMintToInstruction(tknX, payerX, payer.publicKey, 5_000_000_000),
      createMintToInstruction(tknY, payerY, payer.publicKey, 5_000_000_000),
    ]);
    await send([
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        lpTwoUsdc,
        lpTwo.publicKey,
        usdcMint
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        lpTwoX,
        lpTwo.publicKey,
        tknX
      ),
      createMintToInstruction(
        usdcMint,
        lpTwoUsdc,
        payer.publicKey,
        5_000_000_000
      ),
      createMintToInstruction(tknX, lpTwoX, payer.publicKey, 5_000_000_000),
    ]);

    // ── two gauged pools ────────────────────────────────────────────────────
    poolX = await createPool(usdcMint, tknX);
    poolY = await createPool(usdcMint, tknY);

    // poolX carries both LPs, at a deliberate 3:1 size ratio.
    await addLiquidity(poolX, payer, 600_000_000, 600_000_000);
    await addLiquidity(poolX, lpTwo, 200_000_000, 200_000_000);
    await addLiquidity(poolY, payer, 400_000_000, 400_000_000);

    assert.isAbove(
      Number(
        await tokenBalance(
          getAssociatedTokenAddressSync(poolX.lpMint, lpTwo.publicKey)
        )
      ),
      0,
      "the second LP must actually hold LP tokens"
    );

    // ── voting power ────────────────────────────────────────────────────────
    await program.methods
      .buySola(new BN(100_000_000), new BN(1))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        userUsdc: payerUsdc,
        userSola: payerSola,
        floorVault: floorV,
        marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    const bought = await tokenBalance(payerSola);
    await program.methods
      .stakeSola(new BN(bought.toString()))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        usdcMint,
        userUsdc: payerUsdc,
        userSola: payerSola,
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
    await forwardSeconds(
      (nowE + 1) * EPOCH_DURATION + 3600 - (await nowSeconds())
    );
    emissionEpoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);

    // Sole staker ⇒ the 30% global cap is the whole vote budget. Split it 2:1 so the two
    // gauges must divide one schedule rather than each seeing a full pot.
    const staked = await positionHiSola(userPosition);
    const budget = (staked * BigInt(VOTE_WEIGHT_CAP_BPS)) / BigInt(10_000);
    votesX = (budget * BigInt(2)) / BigInt(3);
    votesY = budget - votesX;
    assert.isTrue(
      votesX > BigInt(0) && votesY > BigInt(0),
      "both gauges need real votes"
    );

    await voteForPool(poolX, emissionEpoch, votesX);
    await voteForPool(poolY, emissionEpoch, votesY);
  });

  it("[emissions/multi] two gauges divide one schedule, they do not each get one", async () => {
    // Weight for both LPs of poolX, and for poolY, inside the epoch.
    await checkpoint(poolX, payer, emissionEpoch);
    await checkpoint(poolX, lpTwo, emissionEpoch);
    await checkpoint(poolY, payer, emissionEpoch);

    // Mid-epoch, then again just before it closes. A checkpoint only banks the interval up
    // to its own timestamp, while `emit_pool_rewards` extends the POOL denominator all the
    // way to epoch end — so an LP that stops checkpointing early simply earns less, and the
    // difference is never minted. Checkpointing late is what makes a share whole.
    await forwardSeconds(EPOCH_DURATION / 2);
    await checkpoint(poolX, payer, emissionEpoch);
    await checkpoint(poolX, lpTwo, emissionEpoch);
    await checkpoint(poolY, payer, emissionEpoch);

    // One minute short of the boundary: `checkpoint_lp` requires `now < epoch_end` strictly,
    // and the epoch opened an hour before the first checkpoint.
    await forwardSeconds(EPOCH_DURATION / 2 - 3660);
    await checkpoint(poolX, payer, emissionEpoch);
    await checkpoint(poolX, lpTwo, emissionEpoch);
    await checkpoint(poolY, payer, emissionEpoch);

    await forwardSeconds(EPOCH_DURATION);
    await emit(poolX, emissionEpoch);
    await emit(poolY, emissionEpoch);

    const state: any = await program.account.protocolState.fetch(statePda);
    const epochTotal = expectedEpochTotal(
      emissionEpoch - Number(state.osolaEmissionStartEpoch)
    );
    const totalVotes = votesX + votesY;

    const ax = BigInt(
      (await accumOf(poolX, emissionEpoch)).osolaAllocated.toString()
    );
    const ay = BigInt(
      (await accumOf(poolY, emissionEpoch)).osolaAllocated.toString()
    );

    assert.equal(
      ax.toString(),
      ((epochTotal * votesX) / totalVotes).toString(),
      "poolX share"
    );
    assert.equal(
      ay.toString(),
      ((epochTotal * votesY) / totalVotes).toString(),
      "poolY share"
    );

    // The property that matters: the two gauges together cannot exceed the schedule.
    assert.isTrue(
      ax + ay <= epochTotal,
      `two gauges allocated ${ax + ay} against a schedule of ${epochTotal}`
    );
    // And they should not leave more than rounding on the table either.
    assert.isTrue(
      epochTotal - (ax + ay) <= BigInt(2),
      `unexplained shortfall: ${epochTotal - (ax + ay)}`
    );
  });

  it("[emissions/multi] two LPs divide one pot, pro rata, and cannot overdraw it", async () => {
    const allocated = BigInt(
      (await accumOf(poolX, emissionEpoch)).osolaAllocated.toString()
    );
    // Read the weights before claiming: a successful claim zeroes the checkpoint.
    const wPayer = BigInt(
      (await ckptOf(poolX, payer)).weightedBalance.toString()
    );
    const wTwo = BigInt(
      (await ckptOf(poolX, lpTwo)).weightedBalance.toString()
    );
    const totalWeight = BigInt(
      (await accumOf(poolX, emissionEpoch)).totalWeightedSupply.toString()
    );

    assert.isTrue(
      wPayer + wTwo <= totalWeight,
      `Σ user weight ${
        wPayer + wTwo
      } exceeds the pool denominator ${totalWeight} — ` +
        `the pro-rata formula is unsound and only the running cap is holding the mint back`
    );

    const beforePayer = await tokenBalance(payerOSola);
    const beforeTwo = await tokenBalance(lpTwoOSola);

    await claim(poolX, payer, emissionEpoch);
    await claim(poolX, lpTwo, emissionEpoch);

    const gotPayer = (await tokenBalance(payerOSola)) - beforePayer;
    const gotTwo = (await tokenBalance(lpTwoOSola)) - beforeTwo;

    assert.isTrue(
      gotPayer > BigInt(0) && gotTwo > BigInt(0),
      "both LPs must be paid"
    );
    assert.isTrue(
      gotPayer + gotTwo <= allocated,
      `two LPs minted ${gotPayer + gotTwo} out of a pot of ${allocated}`
    );

    // Each LP gets its own weight over the POOL denominator, not over the sum of the two
    // claimants — so the pot legitimately under-distributes when some weight never claims.
    assert.equal(
      gotPayer.toString(),
      ((allocated * wPayer) / totalWeight).toString(),
      "first LP is not pro rata"
    );
    assert.equal(
      gotTwo.toString(),
      ((allocated * wTwo) / totalWeight).toString(),
      "second LP is not pro rata"
    );

    // With a checkpoint an hour into the epoch and another a minute before it closes, the
    // two LPs between them draw essentially the whole pot. The residue is the hour before
    // the first checkpoint, which is never minted. This is the operational instruction for
    // mainnet LPs: checkpoint early AND late, or leave oSOLA in the pot for nobody.
    assert.isTrue(
      (gotPayer + gotTwo) * BigInt(100) >= allocated * BigInt(99),
      `late-checkpointing LPs recovered only ${
        gotPayer + gotTwo
      } of ${allocated}`
    );

    // The 3:1 deposit ratio must show up in the payouts, within rounding.
    assert.isTrue(
      gotPayer > gotTwo * BigInt(2) && gotPayer < gotTwo * BigInt(4),
      `payouts ignore position size: ${gotPayer} vs ${gotTwo}`
    );

    const after: any = await accumOf(poolX, emissionEpoch);
    assert.equal(
      after.osolaClaimed.toString(),
      (gotPayer + gotTwo).toString(),
      "the claimed counter must equal what was actually minted"
    );
  });

  it("[emissions/multi] weight earned later cannot be claimed against an earlier pot", async () => {
    // poolY's epoch pot was sized but never claimed. Checkpointing in the CURRENT epoch
    // resets the LP's weight and restamps it, so the old pot can no longer be drawn on:
    // the claim's `lp_user_checkpoint.last_epoch == epoch` constraint is what refuses it.
    // Without that constraint, a large late position could be pointed at any older
    // finalised pot it never earned weight in.
    const laterEpoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    assert.isAbove(
      laterEpoch,
      emissionEpoch,
      "we must have left the emission epoch"
    );

    await checkpoint(poolY, payer, laterEpoch);
    await expectFailure(
      () => claim(poolY, payer, emissionEpoch),
      "NothingToClaim"
    );

    const accum: any = await accumOf(poolY, emissionEpoch);
    assert.equal(
      accum.osolaClaimed.toString(),
      "0",
      "nothing may be drawn from the abandoned pot"
    );
  });

  it("[emissions/multi] the epoch mints no more oSOLA than the schedule allowed", async () => {
    // The whole point of the harness, stated as the chain of ceilings that ends on the mint:
    //
    //   oSOLA supply added  ==  Σ claimed  ≤  Σ allocated  ≤  epoch_total
    //
    // The last link is the one that can fail silently and permissionlessly, and it is NOT
    // implied by the first: LPs routinely under-claim (weight accrues from a checkpoint,
    // the denominator from epoch start), so an over-allocated epoch can still mint less
    // than the schedule TODAY and blow through it as soon as the pots are fully claimed.
    // Assert the authorisation, not only the withdrawal.
    const state: any = await program.account.protocolState.fetch(statePda);
    const epochTotal = expectedEpochTotal(
      emissionEpoch - Number(state.osolaEmissionStartEpoch)
    );

    const x: any = await accumOf(poolX, emissionEpoch);
    const y: any = await accumOf(poolY, emissionEpoch);
    const claimed =
      BigInt(x.osolaClaimed.toString()) + BigInt(y.osolaClaimed.toString());
    const allocated =
      BigInt(x.osolaAllocated.toString()) + BigInt(y.osolaAllocated.toString());

    assert.isTrue(
      claimed > BigInt(0),
      "the epoch must have paid something out"
    );
    assert.isTrue(
      claimed <= allocated,
      `epoch ${emissionEpoch} minted ${claimed} out of ${allocated} allocated`
    );
    assert.isTrue(
      allocated <= epochTotal,
      `epoch ${emissionEpoch} authorised ${allocated} against a schedule of ${epochTotal}`
    );

    // Cross-check against the mint: the only oSOLA in existence came from this cycle, since
    // permissionless pools are not approved for the continuous stream.
    const supply = await mintSupply(oSolaM);
    assert.equal(
      supply.toString(),
      claimed.toString(),
      "oSOLA supply does not match what the epoch cycle accounts for"
    );
  });

  it("[emissions/multi] adding liquidity forfeits weight that was not checkpointed first", async () => {
    // `add_liquidity` and `remove_liquidity` both stamp `LpUserInfo::last_change_ts = now`
    // WITHOUT banking the epoch weight accrued so far, and `checkpoint_lp` opens its window
    // at `max(last checkpoint, last_change_ts)`. So any interval between an LP's last
    // checkpoint and a change of position is dropped on the floor.
    //
    // That is the correct direction for safety — it is what stops a deposit-at-T−ε from
    // billing a full epoch — but it is a real cost to an honest LP, and it is not
    // discoverable from the UI. Hence the published instruction: CHECKPOINT BEFORE YOU
    // TOUCH YOUR POSITION. Asserted here so the docs are not describing wishful behaviour.
    const epochStart =
      (Math.floor((await nowSeconds()) / EPOCH_DURATION) + 1) * EPOCH_DURATION;
    await forwardSeconds(epochStart + 3600 - (await nowSeconds()));
    const epoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);

    await checkpoint(poolX, lpTwo, epoch); // window opens here
    await forwardSeconds(86_400); // a full day of holding, unbanked

    await addLiquidity(poolX, lpTwo, 50_000_000, 50_000_000);
    const changeTs = await nowSeconds();

    await forwardSeconds(3_600);
    await checkpoint(poolX, lpTwo, epoch);
    const bankedTs = await nowSeconds();

    const lpHeld = await tokenBalance(
      getAssociatedTokenAddressSync(poolX.lpMint, lpTwo.publicKey)
    );
    const weight = BigInt(
      (await ckptOf(poolX, lpTwo)).weightedBalance.toString()
    );

    // Only the hour since the deposit counts, at the new size. The preceding day is gone.
    assert.equal(
      weight.toString(),
      (lpHeld * BigInt(bankedTs - changeTs)).toString(),
      "weight must cover only the interval since the position last changed"
    );
    assert.isTrue(
      weight < lpHeld * BigInt(86_400),
      `the unbanked day was credited anyway: ${weight}`
    );
  });
});
