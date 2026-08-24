// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// # Bankrun harness — the SOLA/USDC pool may not be left printing below the floor
//
// On 2026-08-24 a single 500 SOLA sell on devnet took the AMM pool to 0.951. The floor
// itself never moved: `sell_sola` pays exactly 1 USDC per SOLA out of `floor_vault`,
// unconditionally, without ever reading this pool, and the solvency invariant held
// throughout. What broke was the headline promise, because a holder reads a price, not an
// invariant. `amm::require_floor_respected` refuses to leave that pool below 1.00.
//
// The interesting half of this file is `flash_arbitrage`, and it is worth stating why,
// because the reasoning that motivated the guard was wrong about it in BOTH directions.
//
//   1. `flash_arbitrage` was first assumed to be the tool that CLOSES a below-floor gap. It
//      is not. It burns oSOLA, mints floor-backed SOLA and SELLS it into the pool, so it is
//      the tool for a gap on the UPSIDE, and it pushes the price DOWN.
//
//   2. It was then assumed the new guard would cover it, since it sells SOLA into the pool.
//      It would not have: `flash_arbitrage` does not call `amm::swap`. It inlines its own
//      `amm_math::swap_out` and its own reserve update, so a guard written only inside
//      `swap` would have been exactly the path-dependent protection the duplicated reward
//      accumulator taught this codebase to stop writing.
//
// Its own `require!(usdc_out > amount_osola)` cannot stand in for the guard either, and F-1
// is the test that pins that down: profitability constrains the AVERAGE price paid across
// the trade, never the price the pool is LEFT at, so it keeps accepting calls long after the
// pool has gone under.
//
// F-1 also refuses to overstate that. Profit peaks at almost exactly the floor-restoring
// size, so a rational arbitrageur already stops at the floor unaided — the guard turns
// "irrational" into "impossible" rather than closing a profit-motivated attack. F-1 asserts
// that coincidence explicitly, so that if it ever stops holding the test says so instead of
// quietly leaving the stronger claim unmade.
//
//   F-1. An oversized flash arb is refused — and refused for being below the floor, not for
//        being unprofitable, which is the whole point.
//   F-2. A right-sized flash arb still works, and lands at or above 1.00.
//   F-3. Buying SOLA is never refused.
//   F-4. The boundary is exact and inclusive: the largest legal sell passes, one base unit
//        more is refused.
//   F-5. At the floor the pool is buy-only, and the refused seller is better off — the same
//        SOLA fetches strictly more through `sell_sola`.
//   F-6. Every other pair is untouched, including well below 1.00.

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { startAnchor, ProgramTestContext } from "solana-bankrun";
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

const FEE_RATE = 30; // 0.30% — bps of amount_in, matches the live devnet pools
const PROTO_BPS = 1_000; // 10% of the fee to the protocol

describe("soladrome — bankrun (AMM floor guard)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: anchor.Program<any>;
  let payer: Keypair;
  let idlJson: any;

  let usdcMint: PublicKey;
  let tknMint: PublicKey;
  let statePda: PublicKey;
  let solaM: PublicKey;
  let hiSolaM: PublicKey;
  let oSolaM: PublicKey;
  let floorV: PublicKey;
  let marketV: PublicKey;
  let solaVault: PublicKey;

  let userUsdc: PublicKey;
  let userSola: PublicKey;
  let userOSola: PublicKey;
  let userTkn: PublicKey;

  // SOLA/USDC pool — the one the floor applies to.
  let poolPda: PublicKey;
  let mintA: PublicKey;
  let mintB: PublicKey;
  let vaultA: PublicKey;
  let vaultB: PublicKey;
  let solaIsA: boolean;

  // tkn/USDC pool — the control, which the guard must never touch.
  let ctlPool: PublicKey;
  let ctlA: PublicKey;
  let ctlB: PublicKey;
  let ctlVaultA: PublicKey;
  let ctlVaultB: PublicKey;

  const pda = (seeds: Buffer[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  async function send(ixs: any[], signers: Keypair[] = []) {
    const tx = new Transaction();
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = payer.publicKey;
    ixs.forEach((ix) => tx.add(ix));
    tx.sign(payer, ...signers);
    return context.banksClient.processTransaction(tx);
  }

  async function tokenBalance(account: PublicKey): Promise<bigint> {
    const raw = await context.banksClient.getAccount(account);
    if (!raw) return BigInt(0);
    return AccountLayout.decode(Buffer.from(raw.data)).amount;
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
      // Anchor surfaces the failure two different ways depending on the path: a decoded
      // `AnchorError ... Error Code: <name>` or a raw `Custom: 0x<hex>`. Accept either, and
      // pin the identity of the error in both — a test that merely asserted "it threw" would
      // pass on an unrelated refusal.
      const decoded = new RegExp(`Error Code: ${name}\\b`).test(msg);
      const raw = msg.includes(`0x${code.toString(16)}`) || msg.includes(`Custom: ${code}`);
      assert.isTrue(decoded || raw, `expected ${name} (${code} / 0x${code.toString(16)}), got: ${msg}`);
    }
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

  /// The pool's (SOLA, USDC) reserves, read back on-chain and put in floor order.
  async function reserves(): Promise<{ sola: bigint; usdc: bigint }> {
    const p = await program.account.ammPool.fetch(poolPda);
    const a = BigInt(p.reserveA.toString());
    const b = BigInt(p.reserveB.toString());
    return solaIsA ? { sola: a, usdc: b } : { sola: b, usdc: a };
  }

  // ── The reference math, recomputed here ────────────────────────────────────
  // Deliberately reimplemented rather than read back from the program: a test that asks the
  // program what it should have done proves nothing.

  const swapOut = (rin: bigint, rout: bigint, ain: bigint) => (rout * ain) / (rin + ain);

  /// Post-trade reserves for `amm_swap` selling `amt` SOLA into the pool.
  /// The protocol fee is NOT routed out here — routing only happens when the INPUT mint is
  /// USDC — so the reserve grows by the full `amt`, LP fee included.
  function afterSell(rs: bigint, ru: bigint, amt: bigint) {
    const net = amt - (amt * BigInt(FEE_RATE)) / BigInt(10_000);
    const out = swapOut(rs, ru, net);
    return { sola: rs + amt, usdc: ru - out, out };
  }

  /// Post-trade reserves for `flash_arbitrage` burning `amt` oSOLA.
  /// Only `amount_net` ever reaches the vault — the fee remainder is burned, not deposited.
  function afterArb(rs: bigint, ru: bigint, amt: bigint) {
    const net = amt - (amt * BigInt(FEE_RATE)) / BigInt(10_000);
    const out = swapOut(rs, ru, net);
    return { sola: rs + net, usdc: ru - out, out };
  }

  /// Largest `amt` that leaves the pool at or above the floor, by bisection on the predicate.
  function largestLegal(
    rs: bigint,
    ru: bigint,
    step: (rs: bigint, ru: bigint, amt: bigint) => { sola: bigint; usdc: bigint }
  ): bigint {
    let lo = BigInt(0);
    let hi = ru; // selling this much is far past the floor in every shape used here
    while (lo < hi) {
      const mid = (lo + hi + BigInt(1)) / BigInt(2);
      const r = step(rs, ru, mid);
      if (r.usdc >= r.sola) lo = mid;
      else hi = mid - BigInt(1);
    }
    return lo;
  }

  async function ammSwap(amountIn: bigint, aToB: boolean) {
    const inIsA = aToB;
    const mintIn = inIsA ? mintA : mintB;
    const mintOut = inIsA ? mintB : mintA;
    return program.methods
      .ammSwap(new BN(amountIn.toString()), new BN(0), aToB)
      .accounts({
        user: payer.publicKey,
        pool: poolPda,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        userTokenIn: getAssociatedTokenAddressSync(mintIn, payer.publicKey),
        userTokenOut: getAssociatedTokenAddressSync(mintOut, payer.publicKey),
        marketVault: marketV,
        protocolState: statePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
  }

  async function flashArb(amountOSola: bigint) {
    return program.methods
      .flashArbitrage(new BN(amountOSola.toString()), new BN(0))
      .accounts({
        caller: payer.publicKey,
        protocolState: statePda,
        oSolaMint: oSolaM,
        solaMint: solaM,
        callerOSola: userOSola,
        callerSola: userSola,
        callerUsdc: userUsdc,
        usdcMint,
        pool: poolPda,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        floorVault: floorV,
        marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
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

    usdcMint = await createMint();
    tknMint = await createMint();

    await program.methods
      // Throwaway founder key, deliberately not `payer`: the founder guards would otherwise
      // fire on this harness's own actor.
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

    // lp + voting + curve + exercise. `exercise_enabled` is what gates `flash_arbitrage`.
    await program.methods
      .setPhaseFlags(true, null, true, true, true, null)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    userUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
    userTkn = getAssociatedTokenAddressSync(tknMint, payer.publicKey);
    userSola = getAssociatedTokenAddressSync(solaM, payer.publicKey);
    userOSola = getAssociatedTokenAddressSync(oSolaM, payer.publicKey);

    await send([
      createAssociatedTokenAccountInstruction(payer.publicKey, userUsdc, payer.publicKey, usdcMint),
      createAssociatedTokenAccountInstruction(payer.publicKey, userTkn, payer.publicKey, tknMint),
      createMintToInstruction(usdcMint, userUsdc, payer.publicKey, 100_000_000_000),
      createMintToInstruction(tknMint, userTkn, payer.publicKey, 100_000_000_000),
    ]);

    // SOLA can only come from the curve — the mint authority is the protocol PDA.
    await program.methods
      .buySola(new BN(6_000_000_000), new BN(0))
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
    assert.isAbove(Number(await tokenBalance(userSola)), 5_000_000_000);

    // oSOLA for the flash-arb leg, out of the ecosystem budget.
    await program.methods
      .distributeOSola(new BN(3_000_000_000))
      .accounts({
        authority: payer.publicKey,
        recipient: payer.publicKey,
        protocolState: statePda,
        oSolaMint: oSolaM,
        recipientOSola: userOSola,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // ── SOLA/USDC pool, seeded at 4.00 ────────────────────────────────────────
    // Above the floor on purpose: a pool already AT the floor cannot demonstrate F-1, which
    // needs room for a trade that is profitable on average and still lands underneath.
    solaIsA = Buffer.compare(solaM.toBuffer(), usdcMint.toBuffer()) <= 0;
    [mintA, mintB] = solaIsA ? [solaM, usdcMint] : [usdcMint, solaM];
    poolPda = pda([Buffer.from("amm_pool"), mintA.toBuffer(), mintB.toBuffer()]);
    vaultA = pda([Buffer.from("vault_a"), poolPda.toBuffer()]);
    vaultB = pda([Buffer.from("vault_b"), poolPda.toBuffer()]);
    await createAndSeed(poolPda, mintA, mintB, vaultA, vaultB, solaIsA ? 1_000_000_000 : 4_000_000_000, solaIsA ? 4_000_000_000 : 1_000_000_000);

    const r0 = await reserves();
    assert.equal(r0.sola.toString(), "1000000000");
    assert.equal(r0.usdc.toString(), "4000000000");

    // ── control pool: tkn/USDC, seeded 1:1 ────────────────────────────────────
    const ctlSorted = Buffer.compare(tknMint.toBuffer(), usdcMint.toBuffer()) <= 0;
    [ctlA, ctlB] = ctlSorted ? [tknMint, usdcMint] : [usdcMint, tknMint];
    ctlPool = pda([Buffer.from("amm_pool"), ctlA.toBuffer(), ctlB.toBuffer()]);
    ctlVaultA = pda([Buffer.from("vault_a"), ctlPool.toBuffer()]);
    ctlVaultB = pda([Buffer.from("vault_b"), ctlPool.toBuffer()]);
    await createAndSeed(ctlPool, ctlA, ctlB, ctlVaultA, ctlVaultB, 1_000_000_000, 1_000_000_000);
  });

  async function createAndSeed(
    pool: PublicKey,
    a: PublicKey,
    b: PublicKey,
    va: PublicKey,
    vb: PublicKey,
    amtA: number,
    amtB: number
  ) {
    const lpMint = pda([Buffer.from("lp_mint"), pool.toBuffer()]);
    await program.methods
      .createPool(FEE_RATE, PROTO_BPS)
      .accounts({
        creator: payer.publicKey,
        protocolState: statePda,
        tokenAMint: a,
        tokenBMint: b,
        pool,
        lpMint,
        tokenAVault: va,
        tokenBVault: vb,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await program.methods
      .addLiquidity(new BN(amtA), new BN(amtB), new BN(1))
      .accounts({
        user: payer.publicKey,
        pool,
        lpMint,
        tokenAVault: va,
        tokenBVault: vb,
        userTokenA: getAssociatedTokenAddressSync(a, payer.publicKey),
        userTokenB: getAssociatedTokenAddressSync(b, payer.publicKey),
        userLp: getAssociatedTokenAddressSync(lpMint, payer.publicKey),
        lpDeadAta: getAssociatedTokenAddressSync(lpMint, SystemProgram.programId, true),
        lpDead: SystemProgram.programId,
        lpUserInfo: pda([Buffer.from("lp_user"), pool.toBuffer(), payer.publicKey.toBuffer()]),
        protocolState: statePda,
        oSolaMint: oSolaM,
        userOSola,
        rent: SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  // ── F-1 ────────────────────────────────────────────────────────────────────
  it("F-1 refuses a flash arb that is profitable but lands below the floor", async () => {
    const { sola, usdc } = await reserves();
    const maxLegal = largestLegal(sola, usdc, afterArb);

    // First, size the claim honestly. Profit peaks at almost exactly the floor-restoring
    // amount, so an oversized call is NOT the arbitrageur's best move — the tempting
    // overstatement is false and is not what this test shows.
    let bestSize = BigInt(0);
    let bestProfit = BigInt(0);
    for (let a = BigInt(1_000_000); a < usdc; a += BigInt(1_000_000)) {
      const p = afterArb(sola, usdc, a).out - a;
      if (p > bestProfit) [bestProfit, bestSize] = [p, a];
    }
    const atBest = afterArb(sola, usdc, bestSize);
    assert.isTrue(
      atBest.usdc >= atBest.sola,
      "the profit-maximising arb lands below the floor — the guard would then be blocking " +
        "the rational move, not merely an irrational one, and this comment needs rewriting"
    );

    // What the guard actually closes: past that peak, profit falls but never turns negative
    // fast enough to bind, so `require!(usdc_out > amount_osola)` keeps waving calls through
    // long after the pool has gone under. That is the finding — profitability constrains the
    // AVERAGE price paid, and the floor is a fact about the price the pool is LEFT at.
    const oversized = (maxLegal * BigInt(3)) / BigInt(2);
    const after = afterArb(sola, usdc, oversized);
    assert.isTrue(after.usdc < after.sola, "harness error: chosen size is not below the floor");
    assert.isTrue(
      after.out > oversized,
      "harness error: chosen size is not profitable, so it would fail for the wrong reason"
    );

    await expectFailure(() => flashArb(oversized), "AmmBelowFloor");

    // A failing `require!` reverts the whole instruction, CPI transfers included: no oSOLA
    // was burned, no SOLA minted, and the pool is exactly where it was.
    const rAfter = await reserves();
    assert.equal(rAfter.sola.toString(), sola.toString());
    assert.equal(rAfter.usdc.toString(), usdc.toString());
  });

  // ── F-2 ────────────────────────────────────────────────────────────────────
  it("F-2 still allows a right-sized flash arb, which lands at or above the floor", async () => {
    const { sola, usdc } = await reserves();
    const maxLegal = largestLegal(sola, usdc, afterArb);
    assert.isTrue(maxLegal > BigInt(0), "harness error: no legal arb size exists");

    const oSolaBefore = await tokenBalance(userOSola);
    await flashArb(maxLegal);
    assert.isTrue(await tokenBalance(userOSola) < oSolaBefore, "oSOLA was not burned");

    const r = await reserves();
    const expected = afterArb(sola, usdc, maxLegal);
    assert.equal(r.sola.toString(), expected.sola.toString());
    assert.equal(r.usdc.toString(), expected.usdc.toString());
    assert.isTrue(r.usdc >= r.sola, "the largest legal arb left the pool below the floor");
  });

  // ── F-3 ────────────────────────────────────────────────────────────────────
  it("F-3 never refuses a buy — USDC in, SOLA out, price rises", async () => {
    const before = await reserves();
    await ammSwap(BigInt(500_000_000), !solaIsA); // USDC is the input side
    const after = await reserves();
    assert.isTrue(after.usdc > before.usdc && after.sola < before.sola);
    assert.isTrue(after.usdc >= after.sola);
  });

  // ── F-4 ────────────────────────────────────────────────────────────────────
  it("F-4 puts the boundary exactly at parity: the largest legal sell passes, +1 does not", async () => {
    const { sola, usdc } = await reserves();
    const maxLegal = largestLegal(sola, usdc, afterSell);
    assert.isTrue(maxLegal > BigInt(0), "harness error: no legal sell size exists");

    // One base unit over. Order matters: the refusal reverts, so the state the legal sell
    // below is measured against is still the state read above.
    const over = afterSell(sola, usdc, maxLegal + BigInt(1));
    assert.isTrue(over.usdc < over.sola, "harness error: +1 is not actually below the floor");
    await expectFailure(() => ammSwap(maxLegal + BigInt(1), solaIsA), "AmmBelowFloor");

    // ...and the largest legal size goes through, landing at or above parity.
    await ammSwap(maxLegal, solaIsA);
    const r = await reserves();
    const expected = afterSell(sola, usdc, maxLegal);
    assert.equal(r.sola.toString(), expected.sola.toString());
    assert.equal(r.usdc.toString(), expected.usdc.toString());
    assert.isTrue(r.usdc >= r.sola);
  });

  // ── F-5 ────────────────────────────────────────────────────────────────────
  it("F-5 leaves the pool buy-only at the floor, and the refused seller is paid more by sell_sola", async () => {
    const before = await reserves();
    assert.isTrue(before.usdc >= before.sola, "precondition: pool must be sitting at the floor");

    // Any sell at all is now refused: F-4 consumed the entire remaining headroom.
    const amt = BigInt(1_000_000);
    const after = afterSell(before.sola, before.usdc, amt);
    assert.isTrue(after.usdc < after.sola, "precondition: pool has headroom left, F-4 did not bind");
    await expectFailure(() => ammSwap(amt, solaIsA), "AmmBelowFloor");

    // The refusal is not a trap. The same SOLA sold through the floor fetches 1.00 flat,
    // which is strictly more than the AMM would have paid on the trade just refused.
    const usdcBefore = await tokenBalance(userUsdc);
    await program.methods
      .sellSola(new BN(amt.toString()))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        userSola,
        floorVault: floorV,
        userUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const received = (await tokenBalance(userUsdc)) - usdcBefore;
    assert.equal(received.toString(), amt.toString(), "sell_sola did not pay exactly 1.00");
    assert.isTrue(
      received > after.out,
      `sell_sola paid ${received}, the refused AMM trade would have paid ${after.out}`
    );

    // Buying is untouched — the pool is narrowed on one side only.
    await ammSwap(BigInt(100_000_000), !solaIsA);
    const r = await reserves();
    assert.isTrue(r.usdc >= r.sola);
  });

  // ── F-6 ────────────────────────────────────────────────────────────────────
  it("F-6 leaves every other pair alone, including far below 1.00", async () => {
    const tknIsA = ctlA.equals(tknMint);
    // Dump tkn into the control pool until it prices well under 1 USDC. Nothing here is
    // "SOLA priced in USDC", so the floor has nothing to say about it.
    await program.methods
      .ammSwap(new BN(3_000_000_000), new BN(0), tknIsA)
      .accounts({
        user: payer.publicKey,
        pool: ctlPool,
        tokenAVault: ctlVaultA,
        tokenBVault: ctlVaultB,
        userTokenIn: getAssociatedTokenAddressSync(tknIsA ? ctlA : ctlB, payer.publicKey),
        userTokenOut: getAssociatedTokenAddressSync(tknIsA ? ctlB : ctlA, payer.publicKey),
        marketVault: marketV,
        protocolState: statePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const p = await program.account.ammPool.fetch(ctlPool);
    const rTkn = BigInt((tknIsA ? p.reserveA : p.reserveB).toString());
    const rUsdc = BigInt((tknIsA ? p.reserveB : p.reserveA).toString());
    assert.isTrue(
      rUsdc < rTkn,
      "harness error: the control pool never went below 1.00, so it proves nothing"
    );
  });
});
