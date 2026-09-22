// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs
//
// # Bankrun harness — standing compound orders
//
// `crank_auto_compound` is the first instruction in this program that ANY signer may call on
// behalf of someone else. That is the whole feature — a standing order needs a caller, and the
// only honest way to have one without holding a key is to let everyone be it — and it is also
// the reason this file exists. Three things have to be true and stay true:
//
//   1. a stranger cranking moves the OWNER's tokens into the OWNER's position, and nothing else;
//   2. a stranger cannot redirect any leg of it by substituting an account;
//   3. the user's ceiling on cost is enforced by the chain, not by whoever picks the moment.
//
// The third is the one that decided the design. The alternative considered first was a pile of
// pre-signed durable-nonce transactions, and it was dropped because `exercise_o_sola` has no
// bound on its fee: the fee is a share of the gain priced off the curve AT LANDING, so the same
// signed bytes cost one figure at a curve of 1.045 and twenty times that at a curve of 2.00,
// and whoever broadcast them chose which. `max_cost_per_unit` is the answer, and
// `☢️ the ceiling refuses a compound the curve made expensive` below is the proof that it works.

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
  TOKEN_PROGRAM_ID,
  AccountLayout,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createApproveInstruction,
  createRevokeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import * as fs from "fs";

const UNIT = 1_000_000;
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

describe("soladrome — bankrun (standing compound orders)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: anchor.Program<any>;
  let idlJson: any;

  let payer: Keypair; // the authority, and the wallet that funds everyone
  let stranger: Keypair; // cranks every order, and is owed nothing for doing so

  /// A user with a standing order, their token accounts, and nothing shared with any other
  /// test. ⚠️ These used to share one wallet, and two tests failed for it: the second crank
  /// inherited `last_crank_ts` from the first (bankrun does not advance the clock between
  /// transactions, so a 1-hour interval refused it), and a threshold chosen for a 5 000 balance
  /// met a balance two rounds smaller. Tests that depend on their own order are how a real
  /// regression later hides behind a rearrangement.
  type User = { kp: Keypair; usdc: PublicKey; oSola: PublicKey };

  let usdcMint: PublicKey;
  let statePda: PublicKey;
  let solaM: PublicKey;
  let hiSolaM: PublicKey;
  let oSolaM: PublicKey;
  let floorV: PublicKey;
  let marketV: PublicKey;
  let solaVault: PublicKey;

  let payerUsdc: PublicKey;
  let payerSola: PublicKey;

  let nonce = 0;

  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const positionOf = (user: PublicKey) => pda([Buffer.from("position"), user.toBuffer()]);
  const autoOf = (user: PublicKey) => pda([Buffer.from("auto"), user.toBuffer()]);

  async function tokenBalance(account: PublicKey): Promise<bigint> {
    const raw = await context.banksClient.getAccount(account);
    if (!raw) return BigInt(0);
    return AccountLayout.decode(Buffer.from(raw.data)).amount;
  }

  async function delegatedAmount(account: PublicKey): Promise<bigint> {
    const raw = await context.banksClient.getAccount(account);
    if (!raw) return BigInt(0);
    return AccountLayout.decode(Buffer.from(raw.data)).delegatedAmount;
  }

  async function send(ixs: any[], signers: Keypair[] = []) {
    const tx = new Transaction();
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = payer.publicKey;
    // A no-op transfer with a rising lamport count, so two otherwise identical transactions
    // never collide on the same signature inside one bankrun run.
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

  /// Push the clock forward, warping the slot first so the blockhash moves with it — without
  /// that, two byte-identical cranks collide in the status cache and the second is rejected as
  /// already processed instead of reaching the program.
  async function forwardSeconds(seconds: number) {
    const before = await context.banksClient.getClock();
    const target = before.unixTimestamp + BigInt(seconds);
    const slot = await context.banksClient.getSlot();
    context.warpToSlot(slot + BigInt(1));
    const after = await context.banksClient.getClock();
    context.setClock(
      new Clock(after.slot, after.epochStartTimestamp, after.epoch, after.leaderScheduleEpoch, target)
    );
  }

  /// Assert a refusal, matching a needle that may be a name, a decimal code, or the hex the
  /// runtime actually prints. ⚠️ bankrun surfaces `custom program error: 0x17ab`, so an
  /// assertion written against the decimal 6059 passes nothing — it looked, for one confusing
  /// minute, exactly like the guard not firing.
  async function expectFailure(promise: Promise<any>, ...needles: string[]) {
    try {
      await promise;
      assert.fail("expected this to be refused, and it was not");
    } catch (e: any) {
      const text = JSON.stringify(e?.logs ?? e?.message ?? e);
      const expanded = needles.flatMap((n) =>
        /^\d+$/.test(n) ? [n, `0x${Number(n).toString(16)}`] : [n]
      );
      assert.isTrue(
        expanded.some((n) => text.includes(n)),
        `refused, but for none of ${expanded.join(" / ")} — got ${text.slice(0, 400)}`
      );
    }
  }

  /// Configure a standing order for `owner`, and grant the two allowances in the same
  /// transaction — which is exactly what the frontend does, and the shape the design depends on.
  async function configure(
    user: User,
    opts: {
      threshold: number;
      chunk: number;
      maxCostPerUnit: number;
      minInterval: number;
      /// Defaults to 0 — UNSET — which is what every order armed before the field existed
      /// reads, and therefore the shape most of these cases should keep exercising.
      maxFeeBps?: number;
      allowanceOSola?: number;
      allowanceUsdc?: number;
    }
  ) {
    const owner = user.kp;
    const auto = autoOf(owner.publicKey);
    const ixs: any[] = [
      await program.methods
        .configureAutoCompound(
          new BN(opts.threshold),
          new BN(opts.chunk),
          new BN(opts.maxCostPerUnit),
          new BN(opts.minInterval),
          opts.maxFeeBps ?? 0
        )
        .accounts({
          user: owner.publicKey,
          auto,
          userPosition: positionOf(owner.publicKey),
          systemProgram: SystemProgram.programId,
        } as any)
        .instruction(),
    ];
    if (opts.allowanceOSola !== undefined) {
      ixs.push(
        createApproveInstruction(user.oSola, auto, owner.publicKey, opts.allowanceOSola)
      );
    }
    if (opts.allowanceUsdc !== undefined) {
      ixs.push(
        createApproveInstruction(user.usdc, auto, owner.publicKey, opts.allowanceUsdc)
      );
    }
    return send(ixs, [owner]);
  }

  /// Crank `owner`'s order as `caller`. Defaults to the stranger, because that is the case
  /// that matters: the instruction is worthless if only the owner can call it.
  async function crank(
    user: User,
    caller: Keypair = stranger,
    overrides: Record<string, PublicKey> = {}
  ) {
    const owner = user.kp;
    const ix = await program.methods
      .crankAutoCompound()
      .accounts({
        cranker: caller.publicKey,
        owner: owner.publicKey,
        auto: autoOf(owner.publicKey),
        protocolState: statePda,
        userPosition: positionOf(owner.publicKey),
        solaMint: solaM,
        oSolaMint: oSolaM,
        usdcMint,
        userOSola: user.oSola,
        userUsdc: user.usdc,
        floorVault: floorV,
        marketVault: marketV,
        solaVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        ...overrides,
      } as any)
      .instruction();
    return send([ix], [caller]);
  }

  /// Push the curve up by buying through it, so the exercise fee — a share of the gain — rises.
  async function moveCurve(usdcIn: number) {
    await program.methods
      .buySola(new BN(usdcIn), new BN(1))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        userUsdc: payerUsdc,
        userSola: payerSola,
        floorVault: floorV,
        marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ATA_PROGRAM,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
  }

  /// Mint a fresh user with their own oSOLA and USDC. Independent of every other test.
  async function makeUser(oSolaAmount: number, usdcAmount: number): Promise<User> {
    const kp = Keypair.generate();
    const usdc = getAssociatedTokenAddressSync(usdcMint, kp.publicKey);
    const oSola = getAssociatedTokenAddressSync(oSolaM, kp.publicKey);

    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: kp.publicKey,
        lamports: 5 * LAMPORTS_PER_SOL,
      }),
      createAssociatedTokenAccountInstruction(payer.publicKey, usdc, kp.publicKey, usdcMint),
      createMintToInstruction(usdcMint, usdc, payer.publicKey, usdcAmount),
    ]);

    // oSOLA can only come from the ecosystem channel — it is the one mint path that exists.
    await program.methods
      .distributeOSola(new BN(oSolaAmount))
      .accounts({
        authority: payer.publicKey,
        recipient: kp.publicKey,
        protocolState: statePda,
        oSolaMint: oSolaM,
        recipientOSola: oSola,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ATA_PROGRAM,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    return { kp, usdc, oSola };
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

    // ── USDC mint ───────────────────────────────────────────────────────────
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
    usdcMint = kp.publicKey;

    await program.methods
      .initialize(Keypair.generate().publicKey)
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

    // exercise (4th) and curve (5th) on — a standing order is an exercise pathway, and the
    // curve has to be usable so the last test can move the price and make the fee bite.
    await program.methods
      .setPhaseFlags(null, null, null, true, true, null)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    stranger = Keypair.generate();
    payerUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
    payerSola = getAssociatedTokenAddressSync(solaM, payer.publicKey);

    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: stranger.publicKey,
        lamports: 10 * LAMPORTS_PER_SOL,
      }),
      createAssociatedTokenAccountInstruction(payer.publicKey, payerUsdc, payer.publicKey, usdcMint),
      createMintToInstruction(usdcMint, payerUsdc, payer.publicKey, 5_000_000 * UNIT),
    ]);
  });

  // ── The feature itself ─────────────────────────────────────────────────────

  it("a stranger cranks the order, and every token lands where the owner's own exercise would put it", async () => {
    const user = await makeUser(2_000 * UNIT, 2_000 * UNIT);
    await configure(user, {
      threshold: 500 * UNIT,
      chunk: 500 * UNIT,
      // At the floor the gain is zero, so cost == strike. A ceiling of 1.10 leaves room.
      maxCostPerUnit: 1.1 * UNIT,
      minInterval: 60,
      allowanceOSola: 2_000 * UNIT,
      allowanceUsdc: 2_000 * UNIT,
    });

    const before = {
      oSola: await tokenBalance(user.oSola),
      floor: await tokenBalance(floorV),
      solaVault: await tokenBalance(solaVault),
      strangerLamports: (await context.banksClient.getAccount(stranger.publicKey))!.lamports,
    };
    const stateBefore: any = await program.account.protocolState.fetch(statePda);

    await crank(user, stranger);

    const after = {
      oSola: await tokenBalance(user.oSola),
      floor: await tokenBalance(floorV),
      solaVault: await tokenBalance(solaVault),
    };
    const position: any = await program.account.userPosition.fetch(positionOf(user.kp.publicKey));
    const stateAfter: any = await program.account.protocolState.fetch(statePda);
    const chunk = BigInt(500 * UNIT);

    assert.equal((before.oSola - after.oSola).toString(), chunk.toString(), "oSOLA burnt");
    assert.equal(
      (after.floor - before.floor).toString(),
      chunk.toString(),
      "☢️ the floor receives the strike IN FULL — never the strike minus the fee"
    );
    assert.equal(
      (after.solaVault - before.solaVault).toString(),
      chunk.toString(),
      "the SOLA is minted straight into the stake vault"
    );
    assert.equal(position.hiSola.toString(), chunk.toString(), "hiSOLA credited to the OWNER");
    assert.equal(
      position.stakedAmount.toString(),
      chunk.toString(),
      "and recorded as FINANCED stake, since the strike reached the floor"
    );
    assert.equal(position.owner.toBase58(), user.kp.publicKey.toBase58());
    assert.equal(
      (
        BigInt(stateAfter.totalPurchasedSola.toString()) -
        BigInt(stateBefore.totalPurchasedSola.toString())
      ).toString(),
      chunk.toString(),
      "floor-backed supply grows by exactly what the floor was paid for"
    );

    // The cranker is paid nothing — it spent lamports on fees and gained no token account.
    const strangerAfter = (await context.banksClient.getAccount(stranger.publicKey))!.lamports;
    assert.isAtMost(
      Number(strangerAfter),
      Number(before.strangerLamports),
      "a cranker must never come out ahead — this instruction pays nobody but its owner"
    );

    // And SPL Token itself debited the allowance.
    assert.equal(
      (await delegatedAmount(user.oSola)).toString(),
      BigInt(1_500 * UNIT).toString(),
      "the cap is the SPL allowance, and the token program is what keeps it"
    );
  });

  it("the minimum interval refuses a second crank in the same breath", async () => {
    const user = await makeUser(2_000 * UNIT, 2_000 * UNIT);
    await configure(user, {
      threshold: 500 * UNIT,
      chunk: 500 * UNIT,
      maxCostPerUnit: 1.1 * UNIT,
      minInterval: 3600,
      allowanceOSola: 2_000 * UNIT,
      allowanceUsdc: 2_000 * UNIT,
    });
    await crank(user, stranger);
    // A permissionless instruction with no clock can be called in a loop by anyone, and each
    // call is individually legitimate — so the protection is a rate, not a permission.
    await expectFailure(crank(user, stranger), String(errorCode("AutoNotReady")), "AutoNotReady");
  });

  it("☢️ an order cannot be configured with no interval at all", async () => {
    // `ready()` compares `now - last_crank_ts >= min_interval`, and `Clock` is frozen inside a
    // transaction. At zero that comparison is `0 >= 0` — so the test above, which is the whole
    // rate protection, would pass and then be bypassed by an order that simply asked for it.
    // The pacing has to be a rule of the chain, not a habit of our frontend.
    const user = await makeUser(2_000 * UNIT, 2_000 * UNIT);
    const armWith = (minInterval: number) =>
      configure(user, {
        threshold: 500 * UNIT,
        chunk: 500 * UNIT,
        maxCostPerUnit: 1.1 * UNIT,
        minInterval,
        allowanceOSola: 2_000 * UNIT,
        allowanceUsdc: 2_000 * UNIT,
      });

    await expectFailure(armWith(0), String(errorCode("InvalidAmount")), "InvalidAmount");
    await expectFailure(armWith(59), String(errorCode("InvalidAmount")), "InvalidAmount");

    // And the boundary itself is allowed, so the guard bounds the setting without removing the
    // shortest period the interface offers.
    await armWith(60);
    const auto = await program.account.autoCompound.fetch(autoOf(user.kp.publicKey));
    assert.equal(Number(auto.minInterval), 60);
  });

  it("below the threshold there is nothing to do, whoever asks", async () => {
    const user = await makeUser(100 * UNIT, 2_000 * UNIT);
    await configure(user, {
      threshold: 500 * UNIT, // the user holds 100
      chunk: 500 * UNIT,
      maxCostPerUnit: 1.1 * UNIT,
      minInterval: 60,
      allowanceOSola: 2_000 * UNIT,
      allowanceUsdc: 2_000 * UNIT,
    });
    await expectFailure(crank(user, stranger), String(errorCode("AutoNotReady")), "AutoNotReady");
  });

  it("a disabled order is inert without being closed", async () => {
    const user = await makeUser(2_000 * UNIT, 2_000 * UNIT);
    await configure(user, {
      threshold: 100 * UNIT,
      chunk: 100 * UNIT,
      maxCostPerUnit: 1.1 * UNIT,
      minInterval: 60,
      allowanceOSola: 2_000 * UNIT,
      allowanceUsdc: 2_000 * UNIT,
    });
    const ix = await program.methods
      .setAutoCompoundEnabled(false)
      .accounts({
        user: user.kp.publicKey,
        auto: autoOf(user.kp.publicKey),
        owner: user.kp.publicKey,
      } as any)
      .instruction();
    await send([ix], [user.kp]);

    await expectFailure(crank(user, stranger), String(errorCode("AutoNotReady")), "AutoNotReady");
  });

  // ── What a hostile cranker can try ────────────────────────────────────────

  it("a cranker cannot redirect the compound into their own accounts", async () => {
    const user = await makeUser(2_000 * UNIT, 2_000 * UNIT);
    await configure(user, {
      threshold: 100 * UNIT,
      chunk: 100 * UNIT,
      maxCostPerUnit: 10 * UNIT, // generous, so the refusal below is about the ACCOUNT
      minInterval: 60,
      allowanceOSola: 2_000 * UNIT,
      allowanceUsdc: 2_000 * UNIT,
    });

    const strangerOSola = getAssociatedTokenAddressSync(oSolaM, stranger.publicKey);
    await send([
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        strangerOSola,
        stranger.publicKey,
        oSolaM
      ),
    ]);

    // `token::authority = owner` is the constraint doing the work here.
    await expectFailure(
      crank(user, stranger, { userOSola: strangerOSola }),
      "ConstraintTokenOwner",
      "2015",
      "AnchorError"
    );
  });

  it("revoking the allowance ends the arrangement, with nothing asked of this program", async () => {
    const user = await makeUser(2_000 * UNIT, 2_000 * UNIT);
    await configure(user, {
      threshold: 100 * UNIT,
      chunk: 100 * UNIT,
      maxCostPerUnit: 10 * UNIT,
      minInterval: 60,
      allowanceOSola: 2_000 * UNIT,
      allowanceUsdc: 2_000 * UNIT,
    });

    // The user revokes from their own wallet — an ordinary SPL instruction this program neither
    // sees nor can refuse. That is the property the whole design is chosen for.
    await send([createRevokeInstruction(user.oSola, user.kp.publicKey)], [user.kp]);

    await expectFailure(crank(user, stranger), "OwnerMismatch", "owner does not match", "0x4");
  });

  // ── The reason this design beats a pre-signed transaction ──────────────────
  //
  // ⚠️ LAST ON PURPOSE. It moves the curve, and the curve is global: every test after it would
  // see a non-zero exercise fee it did not ask for.

  it("☢️ the ceiling refuses a compound the curve made expensive", async () => {
    const user = await makeUser(2_000 * UNIT, 2_000 * UNIT);
    // A ceiling barely above the strike: any fee at all breaks it.
    await configure(user, {
      threshold: 100 * UNIT,
      chunk: 100 * UNIT,
      maxCostPerUnit: UNIT + 1_000, // 1.001 USDC per oSOLA
      minInterval: 60,
      allowanceOSola: 2_000 * UNIT,
      allowanceUsdc: 2_000 * UNIT,
    });

    // At the floor there is no gain and therefore no fee: it fits.
    await crank(user, stranger);

    // Now move the curve. The fee is a share of the GAIN, so it rises with the price — the
    // exact lever that made a pre-signed transaction an unbounded cost.
    await moveCurve(2_000_000 * UNIT);

    // Past the rate gate, so what refuses below is the ceiling and nothing else.
    await forwardSeconds(120);

    await expectFailure(
      crank(user, stranger),
      String(errorCode("AutoCostTooHigh")),
      "AutoCostTooHigh"
    );
  });

  /// Set the protocol's exercise fee. The authority is `payer` here, so this is the same
  /// lever the real authority holds — which is the whole point of the bound being tested.
  async function setExerciseFee(bps: number) {
    await program.methods
      .setExerciseFee(bps)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();
  }

  describe("the rate bound — what an order accepts, rather than what it predicts", () => {
    // The absolute ceiling can only ever be reached by a price RISE, and a rise makes the round
    // more profitable, not less. These cases pin the bound that moves the other way.

    it("☢️ a price that runs far past the old ceiling no longer stops the order", async () => {
      const user = await makeUser(2_000 * UNIT, 20_000 * UNIT);
      await configure(user, {
        threshold: 100 * UNIT,
        chunk: 100 * UNIT,
        // Generous in absolute terms — a single round may cost up to 50 USDC per oSOLA — so the
        // absolute ceiling is deliberately not the thing under test here.
        maxCostPerUnit: 50 * UNIT,
        minInterval: 60,
        maxFeeBps: 1_000,
        allowanceOSola: 2_000 * UNIT,
        allowanceUsdc: 20_000 * UNIT,
      });

      // Move the curve hard. Under the previous design this is exactly where an order went
      // quiet: the cost rises with the price, and the ceiling was a bet on the price.
      await moveCurve(2_000_000 * UNIT);
      await forwardSeconds(120);

      const before = await tokenBalance(user.oSola);
      await crank(user, stranger);
      const after = await tokenBalance(user.oSola);
      assert.equal(
        before - after,
        BigInt(100 * UNIT),
        "the round should fire at the higher price, not refuse it"
      );
    });

    it("☢️ raising the protocol fee past the tolerance stops the order", async () => {
      const user = await makeUser(2_000 * UNIT, 20_000 * UNIT);
      await configure(user, {
        threshold: 100 * UNIT,
        chunk: 100 * UNIT,
        maxCostPerUnit: 50 * UNIT,
        minInterval: 60,
        maxFeeBps: 1_000, // "at most 10% of the gain"
        allowanceOSola: 2_000 * UNIT,
        allowanceUsdc: 20_000 * UNIT,
      });

      // At the tolerance exactly, it fires: the bound is `<=`, so an order armed at the rate
      // in force is not born refusing.
      await setExerciseFee(1_000);
      await crank(user, stranger);

      // The authority raises the rate. Nothing about the order changed, and nothing about the
      // price changed — the only moving part is the one the owner never agreed to.
      await setExerciseFee(1_001);
      await forwardSeconds(120);
      await expectFailure(
        crank(user, stranger),
        String(errorCode("AutoCostTooHigh")),
        "AutoCostTooHigh"
      );

      // And it resumes by itself if the rate comes back. The order was never consumed.
      await setExerciseFee(1_000);
      await forwardSeconds(120);
      await crank(user, stranger);
    });

    it("⚠️ an order armed before the field existed reads zero and still cranks", async () => {
      // The compatibility case, and the reason zero cannot mean "only at a zero fee". A live
      // order written by the previous program yields zero out of the account's spare bytes;
      // reading that as a bound would refuse every one of them on their next crank.
      const user = await makeUser(2_000 * UNIT, 20_000 * UNIT);
      await configure(user, {
        threshold: 100 * UNIT,
        chunk: 100 * UNIT,
        maxCostPerUnit: 50 * UNIT,
        minInterval: 60,
        maxFeeBps: 0, // UNSET — exactly what a pre-upgrade account deserializes to
        allowanceOSola: 2_000 * UNIT,
        allowanceUsdc: 20_000 * UNIT,
      });

      await setExerciseFee(5_000); // the protocol maximum, far above any sane tolerance
      const before = await tokenBalance(user.oSola);
      await crank(user, stranger);
      assert.equal(
        before - (await tokenBalance(user.oSola)),
        BigInt(100 * UNIT),
        "an unset tolerance must not behave like a tolerance of zero"
      );
      await setExerciseFee(1_000);
    });

    it("a tolerance above what the protocol may ever charge is refused at configure time", async () => {
      const user = await makeUser(2_000 * UNIT, 2_000 * UNIT);
      await expectFailure(
        configure(user, {
          threshold: 100 * UNIT,
          chunk: 100 * UNIT,
          maxCostPerUnit: 2 * UNIT,
          minInterval: 60,
          maxFeeBps: 5_001, // one past MAX_EXERCISE_FEE_BPS
        }),
        String(errorCode("InvalidAmount")),
        "InvalidAmount"
      );
    });
  });
});
