// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs
//
// # Bankrun harness — per-position reward strategies
//
// A `PoolStrategy` says what happens to ONE LP position's oSOLA: compounded into liquidity (in its
// own pool or any other that pairs USDC or SOL), or exercised into voting power. It harvests at
// the source — straight from the pool's per-position accumulator — so two positions' strategies
// never touch each other's rewards, which a wallet-based order cannot promise: once in a wallet,
// oSOLA no longer says which pool it came from.
//
// What must be true, and what each case proves:
//
//   1. a liquidity strategy compounds a position into its own pool, and nothing reaches the wallet;
//   2. …or into another pool, taking the SOL route when that pool pairs SOL;
//   3. ☢️ two strategies of one owner are independent: firing one leaves the other's accrual whole;
//   4. a voting strategy exercises the harvest into financed hiSOLA, without ever minting oSOLA;
//   5. the cranker chooses nothing: mode, destination, source and route are the owner's or derived;
//   6. ☢️ a harvest by a stranger obeys the partial-basis rule, and the price floor still holds;
//   7. a backlog larger than one leg goes to the owner as oSOLA instead of blocking the strategy.

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
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  MintLayout,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createApproveInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import * as fs from "fs";

const UNIT = 1_000_000; // 6 decimals: USDC, oSOLA, SOLA, the LST stand-in
const SOL = 1_000_000_000; // 9 decimals: wSOL

type Pool = {
  key: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  lpMint: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
};
type User = { kp: Keypair; oSola: PublicKey };

describe("soladrome — bankrun (per-position strategies)", () => {
  let context: ProgramTestContext;
  let program: anchor.Program<any>;
  let idlJson: any;
  let payer: Keypair;
  let stranger: Keypair;

  let usdcMint: PublicKey;
  let lstMint: PublicKey; // a jitoSOL stand-in
  let tknMint: PublicKey; // a stablecoin stand-in, for a USDC-paired destination
  let statePda: PublicKey;
  let solaM: PublicKey;
  let oSolaM: PublicKey;
  let marketV: PublicKey;

  let sellPool: Pool; // oSOLA / USDC
  let hopPool: Pool; // wSOL / USDC
  let lstPool: Pool; // LST / wSOL — the destination the feature exists for
  let tknPool: Pool; // TKN / USDC — a destination that needs no hop

  let nonce = 0;

  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const autoOf = (u: PublicKey) => pda([Buffer.from("auto"), u.toBuffer()]);
  const positionOf = (u: PublicKey) =>
    pda([Buffer.from("position"), u.toBuffer()]);
  const lpInfoOf = (pool: Pool, u: PublicKey) =>
    pda([Buffer.from("lp_user"), pool.key.toBuffer(), u.toBuffer()]);
  const ata = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, true);
  const vaultOf = (pool: Pool, mint: PublicKey) =>
    pool.mintA.equals(mint) ? pool.vaultA : pool.vaultB;

  async function tokenBalance(account: PublicKey): Promise<bigint> {
    const raw = await context.banksClient.getAccount(account);
    if (!raw) return BigInt(0);
    return AccountLayout.decode(Buffer.from(raw.data)).amount;
  }

  async function send(ixs: any[], signers: Keypair[] = []) {
    const tx = new Transaction();
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = payer.publicKey;
    // A no-op transfer with a rising lamport count, so two identical transactions never share a
    // signature inside one bankrun run.
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

  function errorCode(name: string): number {
    const entry = idlJson.errors.find((e: any) => e.name === name);
    assert.isDefined(entry, `no such error in the IDL: ${name}`);
    return entry.code;
  }

  /// Assert a refusal by error NAME, matched as the hex code the runtime prints.
  ///
  /// ☢️ The "it went through" failure is raised OUTSIDE the try. Its first version called
  /// `assert.fail` inside it, so the catch swallowed that failure, found the error's name in its
  /// own message, and passed — a transaction that succeeded was counted as refused. Three
  /// mutations survived on that alone before it was noticed.
  async function expectError(promise: Promise<any>, name: string) {
    const hex = `0x${errorCode(name).toString(16)}`;
    let refusal: any = null;
    try {
      await promise;
    } catch (e: any) {
      refusal = e;
    }
    assert.isNotNull(
      refusal,
      `expected ${name}, and the transaction went through`
    );
    const text = JSON.stringify(refusal?.logs ?? refusal?.message ?? refusal);
    assert.isTrue(
      text.includes(hex),
      `expected ${name} (${hex}), got ${text.slice(0, 500)}`
    );
  }

  async function forwardSeconds(seconds: number) {
    const before = await context.banksClient.getClock();
    const slot = await context.banksClient.getSlot();
    context.warpToSlot(slot + BigInt(1));
    const after = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        after.slot,
        after.epochStartTimestamp,
        after.epoch,
        after.leaderScheduleEpoch,
        before.unixTimestamp + BigInt(seconds)
      )
    );
  }

  async function newMint(decimals: number): Promise<PublicKey> {
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
          decimals,
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
      .createPool(30, 2_000)
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
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
    return pool;
  }

  /// Seed `pool` from the payer, with `amounts` keyed by mint.
  async function addLiquidity(pool: Pool, amounts: Map<string, number>) {
    const a = amounts.get(pool.mintA.toBase58())!;
    const b = amounts.get(pool.mintB.toBase58())!;
    await program.methods
      .addLiquidity(new BN(a), new BN(b), new BN(1))
      .accounts({
        user: payer.publicKey,
        pool: pool.key,
        lpMint: pool.lpMint,
        tokenAMint: pool.mintA,
        tokenBMint: pool.mintB,
        tokenAVault: pool.vaultA,
        tokenBVault: pool.vaultB,
        userTokenA: ata(pool.mintA, payer.publicKey),
        userTokenB: ata(pool.mintB, payer.publicKey),
        userLp: ata(pool.lpMint, payer.publicKey),
        lpDeadAta: ata(pool.lpMint, SystemProgram.programId),
        lpDead: SystemProgram.programId,
        lpUserInfo: lpInfoOf(pool, payer.publicKey),
        protocolState: statePda,
        oSolaMint: oSolaM,
        userOSola: ata(oSolaM, payer.publicKey),
        rent: SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
  }

  /// The payer swaps on `pool`, selling `amountIn` of `mintIn`. Used to move a price on purpose.
  async function swap(pool: Pool, mintIn: PublicKey, amountIn: number) {
    const mintOut = pool.mintA.equals(mintIn) ? pool.mintB : pool.mintA;
    await program.methods
      .ammSwap(new BN(amountIn), new BN(1), pool.mintA.equals(mintIn))
      .accounts({
        user: payer.publicKey,
        pool: pool.key,
        tokenAMint: pool.mintA,
        tokenBMint: pool.mintB,
        tokenAVault: pool.vaultA,
        tokenBVault: pool.vaultB,
        userTokenIn: ata(mintIn, payer.publicKey),
        userTokenOut: ata(mintOut, payer.publicKey),
        marketVault: marketV,
        protocolState: statePda,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
  }

  async function distributeOSola(recipient: PublicKey, amount: number) {
    await program.methods
      .distributeOSola(new BN(amount))
      .accounts({
        authority: payer.publicKey,
        recipient,
        protocolState: statePda,
        oSolaMint: oSolaM,
        recipientOSola: ata(oSolaM, recipient),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  /// A fresh user holding `oSolaAmount`, with a standing order of `chunk` per round and an oSOLA
  /// allowance to match — and, when `target` is given, pointed at that pool.
  async function makeUser(
    oSolaAmount: number,
    chunk: number,
    target: Pool | null,
    minIntrinsicBps = 7_000
  ): Promise<User> {
    const kp = Keypair.generate();
    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: kp.publicKey,
        lamports: 5 * LAMPORTS_PER_SOL,
      }),
    ]);
    await distributeOSola(kp.publicKey, oSolaAmount);
    const user = { kp, oSola: ata(oSolaM, kp.publicKey) };
    const auto = autoOf(kp.publicKey);
    const ixs: any[] = [
      await program.methods
        .configureAutoCompound(
          new BN(chunk),
          new BN(chunk),
          new BN(1.1 * UNIT),
          new BN(60),
          0
        )
        .accounts({
          user: kp.publicKey,
          auto,
          userPosition: positionOf(kp.publicKey),
          systemProgram: SystemProgram.programId,
        } as any)
        .instruction(),
      createApproveInstruction(user.oSola, auto, kp.publicKey, oSolaAmount),
    ];
    if (target) ixs.push(await setLpIx(user, target, minIntrinsicBps));
    await send(ixs, [kp]);
    return user;
  }

  async function setLpIx(user: User, target: Pool, minIntrinsicBps: number) {
    return program.methods
      .setAutoCompoundLp(minIntrinsicBps)
      .accounts({
        user: user.kp.publicKey,
        auto: autoOf(user.kp.publicKey),
        protocolState: statePda,
        targetPool: target.key,
        lpMint: target.lpMint,
        userLp: ata(target.lpMint, user.kp.publicKey),
        lpUserInfo: lpInfoOf(target, user.kp.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
  }

  /// The accounts a keeper would pass for `target`. `overrides` substitutes any of them, which
  /// is how the refusal cases play a cranker who tries to steer the route.
  function crankAccounts(
    user: User,
    target: Pool,
    overrides: Record<string, any> = {}
  ) {
    const needsHop =
      !target.mintA.equals(usdcMint) && !target.mintB.equals(usdcMint);
    const depositMint = needsHop ? NATIVE_MINT : usdcMint;
    return {
      cranker: stranger.publicKey,
      owner: user.kp.publicKey,
      auto: autoOf(user.kp.publicKey),
      protocolState: statePda,
      oSolaMint: oSolaM,
      userOSola: user.oSola,
      sellPool: sellPool.key,
      sellOSolaVault: vaultOf(sellPool, oSolaM),
      sellUsdcVault: vaultOf(sellPool, usdcMint),
      hopPool: needsHop ? hopPool.key : null,
      hopUsdcVault: needsHop ? vaultOf(hopPool, usdcMint) : null,
      hopSolVault: needsHop ? vaultOf(hopPool, NATIVE_MINT) : null,
      targetPool: target.key,
      targetDepositVault: vaultOf(target, depositMint),
      lpMint: target.lpMint,
      userLp: ata(target.lpMint, user.kp.publicKey),
      lpUserInfo: lpInfoOf(target, user.kp.publicKey),
      marketVault: marketV,
      tokenProgram: TOKEN_PROGRAM_ID,
      ...overrides,
    };
  }

  async function crankLp(
    user: User,
    target: Pool,
    overrides: Record<string, any> = {}
  ) {
    const ix = await program.methods
      .crankAutoCompoundLp()
      .accounts(crankAccounts(user, target, overrides) as any)
      .instruction();
    return send([ix], [stranger]);
  }

  /// ☢️ The invariant every path that moves a pool must keep: the reserve the program prices
  /// against is exactly what the vault holds. A drift here grows without bound and corrupts
  /// withdrawals, and it would not show in any single balance.
  async function assertReservesMatchVaults(pool: Pool, label: string) {
    const p: any = await program.account.ammPool.fetch(pool.key);
    assert.equal(
      p.reserveA.toString(),
      (await tokenBalance(pool.vaultA)).toString(),
      `${label}: reserve A drifted from its vault`
    );
    assert.equal(
      p.reserveB.toString(),
      (await tokenBalance(pool.vaultB)).toString(),
      `${label}: reserve B drifted from its vault`
    );
  }

  before(async () => {
    context = await startAnchor(".", [], []);
    const provider = new BankrunProvider(context);
    payer = context.payer;
    idlJson = JSON.parse(fs.readFileSync("target/idl/soladrome.json", "utf8"));
    program = new anchor.Program(idlJson, provider);

    statePda = pda([Buffer.from("state")]);
    solaM = pda([Buffer.from("sola_mint")]);
    oSolaM = pda([Buffer.from("o_sola_mint")]);
    marketV = pda([Buffer.from("market_vault")]);
    const floorV = pda([Buffer.from("floor_vault")]);

    usdcMint = await newMint(6);
    lstMint = await newMint(6);
    tknMint = await newMint(6);

    await program.methods
      .initialize(Keypair.generate().publicKey)
      .accounts({
        authority: payer.publicKey,
        protocolState: statePda,
        usdcMint,
        solaM,
        hiSolaM: pda([Buffer.from("hi_sola_mint")]),
        oSolaM,
        floorVault: floorV,
        marketVault: marketV,
        solaVault: pda([Buffer.from("sola_vault")]),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
    // lp (pools), exercise, curve and emissions on.
    await program.methods
      .setPhaseFlags(true, null, null, true, true, true)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    stranger = Keypair.generate();
    const payerWsol = ata(NATIVE_MINT, payer.publicKey);
    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: stranger.publicKey,
        lamports: 10 * LAMPORTS_PER_SOL,
      }),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata(usdcMint, payer.publicKey),
        payer.publicKey,
        usdcMint
      ),
      createMintToInstruction(
        usdcMint,
        ata(usdcMint, payer.publicKey),
        payer.publicKey,
        10_000_000 * UNIT
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata(lstMint, payer.publicKey),
        payer.publicKey,
        lstMint
      ),
      createMintToInstruction(
        lstMint,
        ata(lstMint, payer.publicKey),
        payer.publicKey,
        1_000_000 * UNIT
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata(tknMint, payer.publicKey),
        payer.publicKey,
        tknMint
      ),
      createMintToInstruction(
        tknMint,
        ata(tknMint, payer.publicKey),
        payer.publicKey,
        1_000_000 * UNIT
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        payerWsol,
        payer.publicKey,
        NATIVE_MINT
      ),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payerWsol,
        lamports: 20_000 * SOL,
      }),
      createSyncNativeInstruction(payerWsol),
    ]);

    // Put the curve in the money: 200k USDC through it takes P from 1.00 to 1.44, so an oSOLA's
    // exercise value is (1.44 − 1) × (1 − 10 %) = 0.396 USDC.
    await program.methods
      .buySola(new BN(200_000 * UNIT), new BN(1))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        userUsdc: ata(usdcMint, payer.publicKey),
        userSola: ata(solaM, payer.publicKey),
        floorVault: floorV,
        marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await distributeOSola(payer.publicKey, 500_000 * UNIT);

    sellPool = await createPool(oSolaM, usdcMint);
    hopPool = await createPool(NATIVE_MINT, usdcMint);
    lstPool = await createPool(lstMint, NATIVE_MINT);
    tknPool = await createPool(tknMint, usdcMint);

    const amounts = (entries: [PublicKey, number][]) =>
      new Map(entries.map(([m, n]) => [m.toBase58(), n]));
    // oSOLA at 0.38 USDC: 96 % of its exercise value, where a market with buyers would sit.
    await addLiquidity(
      sellPool,
      amounts([
        [oSolaM, 100_000 * UNIT],
        [usdcMint, 38_000 * UNIT],
      ])
    );
    // SOL at 150 USDC.
    await addLiquidity(
      hopPool,
      amounts([
        [NATIVE_MINT, 1_000 * SOL],
        [usdcMint, 150_000 * UNIT],
      ])
    );
    // LST at 1.1 SOL, the shape of jitoSOL.
    await addLiquidity(
      lstPool,
      amounts([
        [lstMint, 1_000 * UNIT],
        [NATIVE_MINT, 1_100 * SOL],
      ])
    );
    await addLiquidity(
      tknPool,
      amounts([
        [tknMint, 100_000 * UNIT],
        [usdcMint, 100_000 * UNIT],
      ])
    );
  });

  // ── Strategy helpers ──────────────────────────────────────────────────────

  const LIQUIDITY = 1;
  const VOTE = 2;
  const strategyOf = (owner: PublicKey, source: Pool) =>
    pda([Buffer.from("strategy"), owner.toBuffer(), source.key.toBuffer()]);

  /// A fresh wallet holding LP in each pool of `pools`, deposited through the program so it
  /// earns. Every case gets its own, so no case inherits another's accrual or timestamps.
  async function lpUser(pools: Pool[]): Promise<Keypair> {
    const kp = Keypair.generate();
    const wsol = ata(NATIVE_MINT, kp.publicKey);
    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: kp.publicKey,
        lamports: 30 * LAMPORTS_PER_SOL,
      }),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata(usdcMint, kp.publicKey),
        kp.publicKey,
        usdcMint
      ),
      createMintToInstruction(
        usdcMint,
        ata(usdcMint, kp.publicKey),
        payer.publicKey,
        20_000 * UNIT
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata(tknMint, kp.publicKey),
        kp.publicKey,
        tknMint
      ),
      createMintToInstruction(
        tknMint,
        ata(tknMint, kp.publicKey),
        payer.publicKey,
        20_000 * UNIT
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata(lstMint, kp.publicKey),
        kp.publicKey,
        lstMint
      ),
      createMintToInstruction(
        lstMint,
        ata(lstMint, kp.publicKey),
        payer.publicKey,
        100 * UNIT
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        wsol,
        kp.publicKey,
        NATIVE_MINT
      ),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: wsol,
        lamports: 20 * SOL,
      }),
      createSyncNativeInstruction(wsol),
    ]);
    for (const pool of pools) {
      const amount = (m: PublicKey) =>
        m.equals(NATIVE_MINT)
          ? 11 * SOL
          : m.equals(lstMint)
          ? 10 * UNIT
          : 10_000 * UNIT;
      const ix = await program.methods
        .addLiquidity(
          new BN(amount(pool.mintA)),
          new BN(amount(pool.mintB)),
          new BN(1)
        )
        .accounts({
          user: kp.publicKey,
          pool: pool.key,
          lpMint: pool.lpMint,
          tokenAMint: pool.mintA,
          tokenBMint: pool.mintB,
          tokenAVault: pool.vaultA,
          tokenBVault: pool.vaultB,
          userTokenA: ata(pool.mintA, kp.publicKey),
          userTokenB: ata(pool.mintB, kp.publicKey),
          userLp: ata(pool.lpMint, kp.publicKey),
          lpDeadAta: ata(pool.lpMint, SystemProgram.programId),
          lpDead: SystemProgram.programId,
          lpUserInfo: lpInfoOf(pool, kp.publicKey),
          protocolState: statePda,
          oSolaMint: oSolaM,
          userOSola: ata(oSolaM, kp.publicKey),
          rent: SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          tokenAProgram: TOKEN_PROGRAM_ID,
          tokenBProgram: TOKEN_PROGRAM_ID,
        } as any)
        .instruction();
      await send([ix], [kp]);
    }
    return kp;
  }

  async function setStrategyIx(
    owner: Keypair,
    source: Pool,
    target: Pool,
    mode: number,
    o: {
      minHarvest?: number;
      minInterval?: number;
      minBps?: number;
      maxFeeBps?: number;
    } = {}
  ) {
    return program.methods
      .setPoolStrategy(
        mode,
        new BN(o.minHarvest ?? UNIT / 100),
        new BN(o.minInterval ?? 60),
        o.minBps ?? 7_000,
        o.maxFeeBps ?? 2_000
      )
      .accounts({
        user: owner.publicKey,
        strategy: strategyOf(owner.publicKey, source),
        protocolState: statePda,
        sourcePool: source.key,
        targetPool: target.key,
        targetLpMint: target.lpMint,
        targetUserLp: ata(target.lpMint, owner.publicKey),
        targetLpUserInfo: lpInfoOf(target, owner.publicKey),
        oSolaMint: oSolaM,
        userOSola: ata(oSolaM, owner.publicKey),
        userPosition: positionOf(owner.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
  }

  async function setStrategy(
    owner: Keypair,
    source: Pool,
    target: Pool,
    mode: number,
    o = {}
  ) {
    return send([await setStrategyIx(owner, source, target, mode, o)], [owner]);
  }

  /// What a keeper passes for a liquidity strategy. The source accounts are present only when the
  /// source is not the destination — the same pool is never two accounts.
  function lpCrankAccounts(
    owner: PublicKey,
    source: Pool,
    target: Pool,
    overrides: Record<string, any> = {}
  ) {
    const needsHop =
      !target.mintA.equals(usdcMint) && !target.mintB.equals(usdcMint);
    const same = source.key.equals(target.key);
    return {
      cranker: stranger.publicKey,
      owner,
      strategy: strategyOf(owner, source),
      protocolState: statePda,
      oSolaMint: oSolaM,
      userOSola: ata(oSolaM, owner),
      sourcePool: same ? null : source.key,
      sourceLpUserInfo: same ? null : lpInfoOf(source, owner),
      sourceUserLp: same ? null : ata(source.lpMint, owner),
      sellPool: sellPool.key,
      sellOSolaVault: vaultOf(sellPool, oSolaM),
      sellUsdcVault: vaultOf(sellPool, usdcMint),
      hopPool: needsHop ? hopPool.key : null,
      hopUsdcVault: needsHop ? vaultOf(hopPool, usdcMint) : null,
      hopSolVault: needsHop ? vaultOf(hopPool, NATIVE_MINT) : null,
      targetPool: target.key,
      targetDepositVault: vaultOf(target, needsHop ? NATIVE_MINT : usdcMint),
      lpMint: target.lpMint,
      userLp: ata(target.lpMint, owner),
      targetLpUserInfo: lpInfoOf(target, owner),
      marketVault: marketV,
      tokenProgram: TOKEN_PROGRAM_ID,
      ...overrides,
    };
  }

  async function crankStrategyLp(
    owner: PublicKey,
    source: Pool,
    target: Pool,
    overrides: Record<string, any> = {}
  ) {
    const ix = await program.methods
      .crankPoolStrategyLp()
      .accounts(lpCrankAccounts(owner, source, target, overrides) as any)
      .instruction();
    return send([ix], [stranger]);
  }

  async function crankStrategyVote(
    owner: PublicKey,
    source: Pool,
    overrides: Record<string, any> = {}
  ) {
    const ix = await program.methods
      .crankPoolStrategyVote()
      .accounts({
        cranker: stranger.publicKey,
        owner,
        strategy: strategyOf(owner, source),
        protocolState: statePda,
        sourcePool: source.key,
        sourceLpMint: source.lpMint,
        sourceLpUserInfo: lpInfoOf(source, owner),
        sourceUserLp: ata(source.lpMint, owner),
        userPosition: positionOf(owner),
        userUsdc: ata(usdcMint, owner),
        usdcMint,
        autoDelegate: autoOf(owner),
        solaMint: solaM,
        floorVault: pda([Buffer.from("floor_vault")]),
        marketVault: marketV,
        solaVault: pda([Buffer.from("sola_vault")]),
        tokenProgram: TOKEN_PROGRAM_ID,
        ...overrides,
      } as any)
      .instruction();
    return send([ix], [stranger]);
  }

  const debtOf = async (pool: Pool, owner: PublicKey) =>
    (
      (await program.account.lpUserInfo.fetch(lpInfoOf(pool, owner))) as any
    ).rewardDebt.toString();

  // ── Emissions on the destinations, so positions have something to harvest ─

  it("setup: the continuous stream runs on the LST and TKN pools", async () => {
    await program.methods
      .configureContinuousEmissions(new BN(1_000), new BN(50))
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();
    for (const pool of [lstPool, tknPool]) {
      await program.methods
        .setPoolRewards(true)
        .accounts({
          authority: payer.publicKey,
          protocolState: statePda,
          pool: pool.key,
        } as any)
        .rpc();
    }
  });

  // ── 1-2. Liquidity ─────────────────────────────────────────────────────────

  it("a liquidity strategy compounds a position into its own pool, and nothing reaches the wallet", async () => {
    const kp = await lpUser([tknPool]);
    await setStrategy(kp, tknPool, tknPool, LIQUIDITY);
    await forwardSeconds(3_600);

    const lpBefore = await tokenBalance(ata(tknPool.lpMint, kp.publicKey));
    const oBefore = await tokenBalance(ata(oSolaM, kp.publicKey));
    await crankStrategyLp(kp.publicKey, tknPool, tknPool);

    const s: any = await program.account.poolStrategy.fetch(
      strategyOf(kp.publicKey, tknPool)
    );
    assert.equal(s.rounds.toString(), "1");
    assert.isTrue(
      BigInt(s.harvested.toString()) > BigInt(0),
      "the position's accrual was harvested"
    );
    assert.isTrue(
      (await tokenBalance(ata(tknPool.lpMint, kp.publicKey))) > lpBefore,
      "and compounded into the same pool"
    );
    assert.equal(
      (await tokenBalance(ata(oSolaM, kp.publicKey))).toString(),
      oBefore.toString(),
      "☢️ not one oSOLA reached the wallet: it was minted straight into the sale"
    );
    const info: any = await program.account.lpUserInfo.fetch(
      lpInfoOf(tknPool, kp.publicKey)
    );
    assert.equal(
      info.lpAmount.toString(),
      (await tokenBalance(ata(tknPool.lpMint, kp.publicKey))).toString(),
      "the compounded LP is recorded, so it earns in turn"
    );
    for (const pool of [sellPool, tknPool])
      await assertReservesMatchVaults(pool, "after a same-pool round");
  });

  it("…or into another pool, taking the SOL route when that pool pairs SOL", async () => {
    const kp = await lpUser([tknPool]);
    await setStrategy(kp, tknPool, lstPool, LIQUIDITY);
    await forwardSeconds(3_600);

    const tknLp = await tokenBalance(ata(tknPool.lpMint, kp.publicKey));
    await crankStrategyLp(kp.publicKey, tknPool, lstPool);
    assert.isTrue(
      (await tokenBalance(ata(lstPool.lpMint, kp.publicKey))) > BigInt(0),
      "LP in the destination"
    );
    assert.equal(
      (await tokenBalance(ata(tknPool.lpMint, kp.publicKey))).toString(),
      tknLp.toString(),
      "the source position is harvested, never touched"
    );
    for (const pool of [sellPool, hopPool, lstPool, tknPool])
      await assertReservesMatchVaults(pool, "after a cross-pool round");
  });

  // ── 3. Independence ────────────────────────────────────────────────────────

  it("☢️ two strategies of one owner are independent: firing one leaves the other's accrual whole", async () => {
    const kp = await lpUser([tknPool, lstPool]);
    await send(
      [
        await setStrategyIx(kp, lstPool, lstPool, LIQUIDITY),
        await setStrategyIx(kp, tknPool, tknPool, VOTE),
        createApproveInstruction(
          ata(usdcMint, kp.publicKey),
          autoOf(kp.publicKey),
          kp.publicKey,
          10_000 * UNIT
        ),
      ],
      [kp]
    );
    await forwardSeconds(3_600);

    const tknDebt = await debtOf(tknPool, kp.publicKey);
    await crankStrategyLp(kp.publicKey, lstPool, lstPool);
    assert.equal(
      await debtOf(tknPool, kp.publicKey),
      tknDebt,
      "the LST round did not touch the TKN position's accrual"
    );

    const lstDebt = await debtOf(lstPool, kp.publicKey);
    await crankStrategyVote(kp.publicKey, tknPool);
    assert.equal(
      await debtOf(lstPool, kp.publicKey),
      lstDebt,
      "and the TKN round did not touch the LST position's"
    );

    const pos: any = await program.account.userPosition.fetch(
      positionOf(kp.publicKey)
    );
    const vote: any = await program.account.poolStrategy.fetch(
      strategyOf(kp.publicKey, tknPool)
    );
    assert.equal(
      pos.hiSola.toString(),
      vote.harvested.toString(),
      "the TKN rewards became exactly that much hiSOLA"
    );
  });

  // ── 4. Voting ──────────────────────────────────────────────────────────────

  it("a voting strategy exercises the harvest into financed hiSOLA, without minting oSOLA", async () => {
    const kp = await lpUser([tknPool]);
    await send(
      [
        await setStrategyIx(kp, tknPool, tknPool, VOTE),
        createApproveInstruction(
          ata(usdcMint, kp.publicKey),
          autoOf(kp.publicKey),
          kp.publicKey,
          10_000 * UNIT
        ),
      ],
      [kp]
    );
    await forwardSeconds(3_600);
    const usdcBefore = await tokenBalance(ata(usdcMint, kp.publicKey));
    const oSupply = async () => {
      const raw = await context.banksClient.getAccount(oSolaM);
      return MintLayout.decode(Buffer.from(raw!.data)).supply.toString();
    };
    const supplyBefore = await oSupply();

    await crankStrategyVote(kp.publicKey, tknPool);
    const s: any = await program.account.poolStrategy.fetch(
      strategyOf(kp.publicKey, tknPool)
    );
    const harvested = BigInt(s.harvested.toString());
    const pos: any = await program.account.userPosition.fetch(
      positionOf(kp.publicKey)
    );
    assert.equal(pos.hiSola.toString(), harvested.toString());
    assert.equal(
      pos.stakedAmount.toString(),
      harvested.toString(),
      "recorded as FINANCED stake"
    );
    assert.isTrue(
      usdcBefore - (await tokenBalance(ata(usdcMint, kp.publicKey))) >=
        harvested,
      "the strike, paid in full"
    );
    assert.equal(
      await oSupply(),
      supplyBefore,
      "☢️ no oSOLA was ever minted for it"
    );
  });

  // ── 5. The cranker chooses nothing ─────────────────────────────────────────

  it("☢️ a cranker can neither change a strategy's mode, nor its destination, nor its source accounts", async () => {
    const kp = await lpUser([tknPool, lstPool]);
    await setStrategy(kp, tknPool, lstPool, LIQUIDITY);
    await forwardSeconds(3_600);

    await expectError(
      crankStrategyVote(kp.publicKey, tknPool),
      "StrategyWrongMode"
    );
    await expectError(
      crankStrategyLp(kp.publicKey, tknPool, tknPool, {
        sourcePool: tknPool.key,
        sourceLpUserInfo: lpInfoOf(tknPool, kp.publicKey),
        sourceUserLp: ata(tknPool.lpMint, kp.publicKey),
      }),
      "AutoWrongDestination"
    );
    // A decoy LP balance in place of the owner's associated account.
    await expectError(
      crankStrategyLp(kp.publicKey, tknPool, lstPool, {
        sourceUserLp: ata(tknPool.lpMint, payer.publicKey),
      }),
      "AutoInvalidRoute"
    );

    // Compounding into its own pool: the pool may be passed once only.
    const kp2 = await lpUser([tknPool]);
    await setStrategy(kp2, tknPool, tknPool, LIQUIDITY);
    await forwardSeconds(3_600);
    await expectError(
      crankStrategyLp(kp2.publicKey, tknPool, tknPool, {
        sourcePool: tknPool.key,
        sourceLpUserInfo: lpInfoOf(tknPool, kp2.publicKey),
        sourceUserLp: ata(tknPool.lpMint, kp2.publicKey),
      }),
      "StrategyRouteConflict"
    );
  });

  it("a position in a route pool cannot compound through it, and a strategy needs sane bounds", async () => {
    const kp = await lpUser([tknPool]);
    await expectError(
      setStrategy(kp, sellPool, lstPool, LIQUIDITY),
      "StrategyRouteConflict"
    );
    await expectError(
      setStrategy(kp, hopPool, lstPool, LIQUIDITY),
      "StrategyRouteConflict"
    );
    await expectError(
      setStrategy(kp, tknPool, tknPool, LIQUIDITY, { minInterval: 0 }),
      "InvalidAmount"
    );
    await expectError(
      setStrategy(kp, tknPool, tknPool, VOTE, { maxFeeBps: 0 }),
      "InvalidAmount"
    );
    await expectError(
      setStrategy(kp, tknPool, tknPool, 3),
      "StrategyWrongMode"
    );
  });

  // ── 6. The rules a stranger's harvest obeys ────────────────────────────────

  it("☢️ a stranger may not harvest a position whose LP is partly parked elsewhere", async () => {
    const kp = await lpUser([tknPool]);
    await setStrategy(kp, tknPool, tknPool, LIQUIDITY);
    await forwardSeconds(3_600);
    const lp = ata(tknPool.lpMint, kp.publicKey);
    await send(
      [
        createTransferInstruction(
          lp,
          ata(tknPool.lpMint, payer.publicKey),
          kp.publicKey,
          (await tokenBalance(lp)) / BigInt(3)
        ),
      ],
      [kp]
    );
    const debt = await debtOf(tknPool, kp.publicKey);
    await expectError(
      crankStrategyLp(kp.publicKey, tknPool, tknPool),
      "PartialBasisClaim"
    );
    assert.equal(
      await debtOf(tknPool, kp.publicKey),
      debt,
      "the parked LP's accrual is intact"
    );
  });

  it("☢️ …and the same holds for the SOURCE of a cross-pool strategy, which no deposit re-checks", async () => {
    // Compounding into another pool, the deposit guards the destination position only. The source
    // is guarded by the harvest alone — so this is the case that proves the harvest's own rule.
    const kp = await lpUser([tknPool, lstPool]);
    await setStrategy(kp, tknPool, lstPool, LIQUIDITY);
    await forwardSeconds(3_600);
    const lp = ata(tknPool.lpMint, kp.publicKey);
    await send(
      [
        createTransferInstruction(
          lp,
          ata(tknPool.lpMint, payer.publicKey),
          kp.publicKey,
          (await tokenBalance(lp)) / BigInt(3)
        ),
      ],
      [kp]
    );
    const debt = await debtOf(tknPool, kp.publicKey);
    await expectError(
      crankStrategyLp(kp.publicKey, tknPool, lstPool),
      "PartialBasisClaim"
    );
    assert.equal(
      await debtOf(tknPool, kp.publicKey),
      debt,
      "the source's parked accrual is intact"
    );
  });

  it("a round waits for its interval and its minimum harvest, and the price floor still holds", async () => {
    const kp = await lpUser([tknPool]);
    await setStrategy(kp, tknPool, tknPool, LIQUIDITY, {
      minHarvest: 1_000 * UNIT,
    });
    await forwardSeconds(3_600);
    await expectError(
      crankStrategyLp(kp.publicKey, tknPool, tknPool),
      "AutoNotReady"
    );

    await setStrategy(kp, tknPool, tknPool, LIQUIDITY);
    await crankStrategyLp(kp.publicKey, tknPool, tknPool);
    await expectError(
      crankStrategyLp(kp.publicKey, tknPool, tknPool),
      "AutoNotReady"
    );

    // 100 % of exercise value: the pool pays ~96 %, so the sale is refused.
    await setStrategy(kp, tknPool, tknPool, LIQUIDITY, { minBps: 10_000 });
    await forwardSeconds(3_600);
    await expectError(
      crankStrategyLp(kp.publicKey, tknPool, tknPool),
      "AutoBelowIntrinsic"
    );
  });

  it("a voting strategy refuses a fee above the owner's bound, and a stranger's partial-basis harvest", async () => {
    const kp = await lpUser([tknPool]);
    // The protocol takes 10 % of the gain; this owner accepts 5 %.
    await send(
      [
        await setStrategyIx(kp, tknPool, tknPool, VOTE, { maxFeeBps: 500 }),
        createApproveInstruction(
          ata(usdcMint, kp.publicKey),
          autoOf(kp.publicKey),
          kp.publicKey,
          10_000 * UNIT
        ),
      ],
      [kp]
    );
    await forwardSeconds(3_600);
    await expectError(
      crankStrategyVote(kp.publicKey, tknPool),
      "AutoCostTooHigh"
    );

    await setStrategy(kp, tknPool, tknPool, VOTE, { maxFeeBps: 2_000 });
    const lp = ata(tknPool.lpMint, kp.publicKey);
    await send(
      [
        createTransferInstruction(
          lp,
          ata(tknPool.lpMint, payer.publicKey),
          kp.publicKey,
          (await tokenBalance(lp)) / BigInt(3)
        ),
      ],
      [kp]
    );
    await expectError(
      crankStrategyVote(kp.publicKey, tknPool),
      "PartialBasisClaim"
    );
  });

  it("☢️ no pool may be passed twice: the sale pool as an unused hop is refused, and its reserves stay true", async () => {
    // Found in the 2026-09-24 review. Anchor writes every mutable copy of a program-owned account
    // back at exit, in field order, and does not refuse duplicates — so the sale pool passed again
    // as `hop_pool` (never read for a USDC destination) wrote its stale copy over the real one,
    // reverting the sale's reserve update. Repeatable by anyone; it would have drained the vault.
    const kp = await lpUser([tknPool]);
    await setStrategy(kp, tknPool, tknPool, LIQUIDITY);
    await forwardSeconds(3_600);
    await expectError(
      crankStrategyLp(kp.publicKey, tknPool, tknPool, {
        hopPool: sellPool.key,
        hopUsdcVault: vaultOf(sellPool, usdcMint),
        hopSolVault: vaultOf(sellPool, oSolaM),
      }),
      "AutoInvalidRoute"
    );
    // The same route serves the standing LP order: its crank refuses the duplicate too.
    const owner = Keypair.generate();
    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: owner.publicKey,
        lamports: 5 * LAMPORTS_PER_SOL,
      }),
    ]);
    await distributeOSola(owner.publicKey, 100 * UNIT);
    await send(
      [
        await program.methods
          .configureAutoCompound(
            new BN(10 * UNIT),
            new BN(10 * UNIT),
            new BN(1.1 * UNIT),
            new BN(60),
            0
          )
          .accounts({
            user: owner.publicKey,
            auto: autoOf(owner.publicKey),
            userPosition: positionOf(owner.publicKey),
            systemProgram: SystemProgram.programId,
          } as any)
          .instruction(),
        createApproveInstruction(
          ata(oSolaM, owner.publicKey),
          autoOf(owner.publicKey),
          owner.publicKey,
          100 * UNIT
        ),
        await setLpIx(
          { kp: owner, oSola: ata(oSolaM, owner.publicKey) },
          tknPool,
          7_000
        ),
      ],
      [owner]
    );
    await expectError(
      crankLp({ kp: owner, oSola: ata(oSolaM, owner.publicKey) }, tknPool, {
        hopPool: sellPool.key,
        hopUsdcVault: vaultOf(sellPool, usdcMint),
        hopSolVault: vaultOf(sellPool, oSolaM),
      }),
      "AutoInvalidRoute"
    );
    await assertReservesMatchVaults(sellPool, "after both refusals");
  });

  // ── 7. A backlog larger than one leg ───────────────────────────────────────

  it("a backlog larger than one leg compounds what it can and hands the rest to the owner", async () => {
    const kp = await lpUser([tknPool]);
    await setStrategy(kp, tknPool, tknPool, LIQUIDITY);
    // A stream fast enough that an hour accrues more than 1 % of the sale pool's oSOLA.
    await program.methods
      .configureContinuousEmissions(new BN(2_000_000), new BN(50))
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();
    await forwardSeconds(5 * 3_600);

    const oBefore = await tokenBalance(ata(oSolaM, kp.publicKey));
    const p: any = await program.account.ammPool.fetch(sellPool.key);
    const leg =
      BigInt(
        (sellPool.mintA.equals(oSolaM) ? p.reserveA : p.reserveB).toString()
      ) / BigInt(100);
    await crankStrategyLp(kp.publicKey, tknPool, tknPool);

    const s: any = await program.account.poolStrategy.fetch(
      strategyOf(kp.publicKey, tknPool)
    );
    const harvested = BigInt(s.harvested.toString());
    const toWallet = (await tokenBalance(ata(oSolaM, kp.publicKey))) - oBefore;
    assert.isTrue(harvested > leg, "the backlog exceeded one leg");
    assert.equal(
      toWallet.toString(),
      (harvested - leg).toString(),
      "exactly the excess went to the owner as oSOLA"
    );
    await assertReservesMatchVaults(sellPool, "after a capped round");
  });
});
