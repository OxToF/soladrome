// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs
//
// # Bankrun harness — standing LP orders (the order's second destination)
//
// `crank_auto_compound_lp` sells a user's oSOLA on the oSOLA/USDC pool, buys SOL on the SOL/USDC
// pool when the destination pairs SOL, and deposits that single side into the destination — all
// under a permissionless crank. The topology below is the launch plan (C1, see
// `scripts/launch_pools/`): oSOLA/USDC, SOL/USDC and an LST/SOL pool, and no pool holding SOLA.
//
// What must be true, and what each case proves:
//
//   1. a stranger's crank lands LP in the OWNER's account, pays the stranger nothing, and leaves
//      every pool's recorded reserves equal to what its vaults actually hold;
//   2. the destination is the owner's: neither crank can be fired against the other's order,
//      nor against a pool the order does not name;
//   3. the route is derived, not passed: a substituted hop or vault is refused;
//   4. ☢️ the sale honours the intrinsic floor, which a sandwich cannot move;
//   5. every leg is capped against its reserve;
//   6. ☢️ a deposit harvests, so a stranger's deposit obeys the partial-basis rule.

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

describe("soladrome — bankrun (standing LP orders)", () => {
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

  // ── 1. The feature ─────────────────────────────────────────────────────────

  it("a stranger compounds oSOLA into LST/SOL liquidity, and every token lands with the owner", async () => {
    const chunk = 500 * UNIT;
    const user = await makeUser(2_000 * UNIT, chunk, lstPool);

    const before = {
      oSola: await tokenBalance(user.oSola),
      lstSolVault: await tokenBalance(vaultOf(lstPool, NATIVE_MINT)),
      lstLstVault: await tokenBalance(vaultOf(lstPool, lstMint)),
      market: await tokenBalance(marketV),
      strangerLamports: (await context.banksClient.getAccount(
        stranger.publicKey
      ))!.lamports,
    };
    await crankLp(user, lstPool);

    const lp = await tokenBalance(ata(lstPool.lpMint, user.kp.publicKey));
    const info: any = await program.account.lpUserInfo.fetch(
      lpInfoOf(lstPool, user.kp.publicKey)
    );
    assert.equal(
      (before.oSola - (await tokenBalance(user.oSola))).toString(),
      chunk.toString(),
      "exactly one chunk of oSOLA sold"
    );
    assert.isTrue(lp > BigInt(0), "LP minted to the owner's own account");
    assert.equal(
      info.lpAmount.toString(),
      lp.toString(),
      "and recorded as a deposit, so it earns"
    );
    assert.isTrue(
      (await tokenBalance(vaultOf(lstPool, NATIVE_MINT))) > before.lstSolVault,
      "SOL reached the destination"
    );
    assert.equal(
      (await tokenBalance(vaultOf(lstPool, lstMint))).toString(),
      before.lstLstVault.toString(),
      "☢️ the LST side never moves — the deposit is single-sided"
    );
    assert.isTrue(
      (await tokenBalance(marketV)) > before.market,
      "the USDC-input hop routed its protocol fee"
    );
    const afterLamports = (await context.banksClient.getAccount(
      stranger.publicKey
    ))!.lamports;
    assert.isTrue(
      afterLamports <= before.strangerLamports,
      "the cranker gains nothing"
    );

    // Value check: the LP's share of the destination, priced in SOL, is close to what the SOL
    // leg delivered — a single-sided deposit costs about half a swap fee, not more. Only a LOWER
    // bound here: valuing the claim at the post-deposit spot price flatters it slightly (the
    // virtual swap moved that price), which is why the upper bound — no dilution, no free round
    // trip — is proven in `amm_math` against executable exits instead.
    const p: any = await program.account.ammPool.fetch(lstPool.key);
    const solReserve = BigInt(
      (lstPool.mintA.equals(NATIVE_MINT) ? p.reserveA : p.reserveB).toString()
    );
    const shareSol =
      (BigInt(2) * solReserve * lp) / BigInt(p.totalLp.toString());
    const delivered =
      (await tokenBalance(vaultOf(lstPool, NATIVE_MINT))) - before.lstSolVault;
    assert.isTrue(
      shareSol * BigInt(1000) >= delivered * BigInt(995),
      `share ${shareSol} is more than half a percent below the deposit ${delivered}`
    );

    const auto: any = await program.account.autoCompound.fetch(
      autoOf(user.kp.publicKey)
    );
    assert.equal(auto.rounds.toString(), "1");

    for (const [pool, label] of [
      [sellPool, "oSOLA/USDC"],
      [hopPool, "SOL/USDC"],
      [lstPool, "LST/SOL"],
    ] as [Pool, string][]) {
      await assertReservesMatchVaults(pool, label);
    }
  });

  it("a USDC-paired destination is reached without the SOL hop", async () => {
    const user = await makeUser(1_000 * UNIT, 500 * UNIT, tknPool);
    const hopBefore: any = await program.account.ammPool.fetch(hopPool.key);
    await crankLp(user, tknPool);

    assert.isTrue(
      (await tokenBalance(ata(tknPool.lpMint, user.kp.publicKey))) > BigInt(0)
    );
    const hopAfter: any = await program.account.ammPool.fetch(hopPool.key);
    assert.equal(
      hopAfter.reserveA.toString(),
      hopBefore.reserveA.toString(),
      "the SOL/USDC pool is untouched"
    );
    await assertReservesMatchVaults(sellPool, "oSOLA/USDC");
    await assertReservesMatchVaults(tknPool, "TKN/USDC");
  });

  // ── 2. The destination belongs to the owner ────────────────────────────────

  it("☢️ neither crank fires an order pointed at the other destination", async () => {
    const lpUser = await makeUser(1_000 * UNIT, 500 * UNIT, lstPool);
    // The staking crank takes the owner's USDC account; it must exist for the call to reach
    // the guard at all.
    await send([
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata(usdcMint, lpUser.kp.publicKey),
        lpUser.kp.publicKey,
        usdcMint
      ),
    ]);
    const stakeIx = await program.methods
      .crankAutoCompound()
      .accounts({
        cranker: stranger.publicKey,
        owner: lpUser.kp.publicKey,
        auto: autoOf(lpUser.kp.publicKey),
        protocolState: statePda,
        userPosition: positionOf(lpUser.kp.publicKey),
        solaMint: solaM,
        oSolaMint: oSolaM,
        usdcMint,
        userOSola: lpUser.oSola,
        userUsdc: ata(usdcMint, lpUser.kp.publicKey),
        floorVault: pda([Buffer.from("floor_vault")]),
        marketVault: marketV,
        solaVault: pda([Buffer.from("sola_vault")]),
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .instruction();
    await expectError(send([stakeIx], [stranger]), "AutoWrongDestination");

    // And the other way round: an order left on staking cannot be sent into a pool.
    const stakeUser = await makeUser(1_000 * UNIT, 500 * UNIT, null);
    // Pointing it at a pool and back creates the LP accounts, so the refusal below is the guard's
    // and not a missing account's.
    await send([await setLpIx(stakeUser, lstPool, 7_000)], [stakeUser.kp]);
    await send(
      [
        await program.methods
          .clearAutoCompoundLp()
          .accounts({
            user: stakeUser.kp.publicKey,
            auto: autoOf(stakeUser.kp.publicKey),
          } as any)
          .instruction(),
      ],
      [stakeUser.kp]
    );
    await expectError(crankLp(stakeUser, lstPool), "AutoWrongDestination");
  });

  it("☢️ the LP crank refuses a pool the order does not name", async () => {
    // Visiting the other pool first creates this owner's accounts there, so the crank below is
    // refused by the destination check and not by a missing account.
    const user = await makeUser(1_000 * UNIT, 500 * UNIT, tknPool);
    await send([await setLpIx(user, lstPool, 7_000)], [user.kp]);
    await expectError(
      crankLp(user, tknPool, {
        userLp: ata(tknPool.lpMint, user.kp.publicKey),
        lpUserInfo: lpInfoOf(tknPool, user.kp.publicKey),
      }),
      "AutoWrongDestination"
    );
  });

  // ── 3. The route is derived, not passed ────────────────────────────────────

  it("☢️ a cranker cannot steer the hop through another pool, or the proceeds into their own account", async () => {
    const user = await makeUser(1_000 * UNIT, 500 * UNIT, lstPool);

    // A genuine pool of this program, holding USDC — but not SOL/USDC.
    await expectError(
      crankLp(user, lstPool, {
        hopPool: tknPool.key,
        hopUsdcVault: vaultOf(tknPool, usdcMint),
        hopSolVault: vaultOf(tknPool, tknMint),
      }),
      "AutoInvalidRoute"
    );

    // The cranker's own wSOL account as the "destination vault".
    const theirs = ata(NATIVE_MINT, stranger.publicKey);
    await send([
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        theirs,
        stranger.publicKey,
        NATIVE_MINT
      ),
    ]);
    await expectError(
      crankLp(user, lstPool, { targetDepositVault: theirs }),
      "AutoInvalidRoute"
    );
    assert.equal(
      (await tokenBalance(theirs)).toString(),
      "0",
      "and nothing reached it"
    );

    // Omitting the hop for a SOL destination is refused, not silently skipped.
    await expectError(
      crankLp(user, lstPool, {
        hopPool: null,
        hopUsdcVault: null,
        hopSolVault: null,
      }),
      "AutoInvalidRoute"
    );
  });

  it("an LP destination must pair USDC or SOL, and must not hold oSOLA", async () => {
    const user = await makeUser(1_000 * UNIT, 500 * UNIT, null);
    await expectError(
      send([await setLpIx(user, sellPool, 7_000)], [user.kp]),
      "AutoInvalidRoute"
    );
    await expectError(
      send([await setLpIx(user, lstPool, 0)], [user.kp]),
      "InvalidAmount"
    );
    await expectError(
      send([await setLpIx(user, lstPool, 10_001)], [user.kp]),
      "InvalidAmount"
    );
  });

  // ── 4. The intrinsic floor ─────────────────────────────────────────────────

  it("☢️ the sale refuses a price a sandwich pushed below the owner's share of exercise value", async () => {
    const user = await makeUser(1_000 * UNIT, 500 * UNIT, tknPool);

    // Dump oSOLA into the pool: 0.38 → about 0.23 USDC, under 70 % of 0.396 (0.277).
    await swap(sellPool, oSolaM, 30_000 * UNIT);
    await expectError(crankLp(user, tknPool), "AutoBelowIntrinsic");

    // The same order, the same moment, a looser bound: it goes through. The refusal above is the
    // bound speaking, not something else about this state.
    await send([await setLpIx(user, tknPool, 5_000)], [user.kp]);
    await crankLp(user, tknPool);
    assert.isTrue(
      (await tokenBalance(ata(tknPool.lpMint, user.kp.publicKey))) > BigInt(0)
    );

    // Restore the market for the cases below.
    await swap(sellPool, usdcMint, 8_000 * UNIT);
  });

  // ── 5. Every leg is capped ─────────────────────────────────────────────────

  it("a chunk larger than 1 % of the pool it sells into is refused", async () => {
    const p: any = await program.account.ammPool.fetch(sellPool.key);
    const oSolaReserve = BigInt(
      (sellPool.mintA.equals(oSolaM) ? p.reserveA : p.reserveB).toString()
    );
    const tooBig = Number(oSolaReserve / BigInt(100)) + 1;
    const user = await makeUser(tooBig, tooBig, tknPool);
    await expectError(crankLp(user, tknPool), "AutoImpactTooHigh");
  });

  // ── 6. A stranger's deposit is a stranger's claim ──────────────────────────

  it("☢️ the deposit harvests to the owner — and a stranger may not deposit on a partial basis", async () => {
    // Emissions on the destination, so the position has something to lose.
    await program.methods
      .configureContinuousEmissions(new BN(1_000), new BN(50))
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();
    await program.methods
      .setPoolRewards(true)
      .accounts({
        authority: payer.publicKey,
        protocolState: statePda,
        pool: tknPool.key,
      } as any)
      .rpc();

    const user = await makeUser(2_000 * UNIT, 500 * UNIT, tknPool);
    await crankLp(user, tknPool);
    await forwardSeconds(3_600);

    // Round two harvests what round one's LP earned in the hour, into the owner's oSOLA.
    const oBefore = await tokenBalance(user.oSola);
    await crankLp(user, tknPool);
    const oAfter = await tokenBalance(user.oSola);
    assert.isTrue(
      oAfter > oBefore - BigInt(500 * UNIT),
      "the owner received the accrued oSOLA on top of the chunk sold"
    );

    // Park a third of the LP elsewhere. The wallet now holds less than the recorded position.
    const userLp = ata(tknPool.lpMint, user.kp.publicKey);
    const parked = ata(tknPool.lpMint, payer.publicKey);
    const third = (await tokenBalance(userLp)) / BigInt(3);
    await send(
      [createTransferInstruction(userLp, parked, user.kp.publicKey, third)],
      [user.kp]
    );
    await forwardSeconds(3_600);

    const infoBefore: any = await program.account.lpUserInfo.fetch(
      lpInfoOf(tknPool, user.kp.publicKey)
    );
    await expectError(crankLp(user, tknPool), "PartialBasisClaim");
    const infoAfter: any = await program.account.lpUserInfo.fetch(
      lpInfoOf(tknPool, user.kp.publicKey)
    );
    assert.equal(
      infoAfter.rewardDebt.toString(),
      infoBefore.rewardDebt.toString(),
      "the accrual on the parked LP is intact"
    );
    await assertReservesMatchVaults(tknPool, "TKN/USDC");
  });
});
