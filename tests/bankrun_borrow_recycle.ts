// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// # Bankrun harness — borrow capacity cannot be walked from wallet to wallet
//
// The High from the 2026-08-12 review. `borrow_usdc` used to cap on a token BALANCE
// (`user_hi_sola.amount + vote_escrowed`). hiSOLA is a plain SPL mint with no freeze
// authority, so the same collateral could be handed to a fresh wallet that had never
// staked, and that wallet saw a full, untouched cap:
//
//   A stakes 1000 → borrows 1000 → transfers the 1000 hiSOLA to B
//   B borrows 1000 → transfers to C → …            N wallets, N × 1000 USDC, one stake
//
// Gating `unstake_hi_sola` on outstanding debt never stopped this: it gates the burn, not
// the transfer. The 75% floor buffer bounds the TOTAL drain, so the global invariant held —
// what broke was the PER-USER cap, letting one small holder consume the whole protocol's
// borrowing capacity, financed by everybody else's deposits.
//
// The fix records the deposit (`UserPosition::staked_amount`, maintained by stake/unstake)
// and caps on `staked_amount.min(balance + vote_escrowed)`. A borrow now needs BOTH a
// recorded deposit AND possession, and one set of tokens cannot satisfy both halves twice.
//
// This file exists because the original PoC lives in `tests/soladrome.ts`, which needs a
// live cluster — `anchor test` deploys to devnet. That is too heavy to re-run on demand, so
// the regression went unverified between sessions. Here it costs 200 ms and no deploy.

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
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import * as fs from "fs";

describe("soladrome — bankrun (borrow collateral recycling)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: anchor.Program<any>;
  let payer: Keypair; // wallet A — the honest staker
  let fresh: Keypair; // wallet B — never staked anything
  let idlJson: any;

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
  let payerHiSola: PublicKey;
  let freshUsdc: PublicKey;
  let freshHiSola: PublicKey;

  let nonce = 0;

  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  const positionOf = (user: PublicKey) =>
    pda([Buffer.from("position"), user.toBuffer()]);

  async function tokenBalance(account: PublicKey): Promise<bigint> {
    const raw = await context.banksClient.getAccount(account);
    if (!raw) return BigInt(0);
    return AccountLayout.decode(Buffer.from(raw.data)).amount;
  }

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

  function errorCode(name: string): number {
    const entry = idlJson.errors.find((e: any) => e.name === name);
    assert.isDefined(entry, `no such error in the IDL: ${name}`);
    return entry.code;
  }

  async function borrow(user: Keypair, amount: number) {
    const ix = await program.methods
      .borrowUsdc(new BN(amount))
      .accounts({
        user: user.publicKey,
        protocolState: statePda,
        hiSolaMint: hiSolaM,
        userHiSola: getAssociatedTokenAddressSync(hiSolaM, user.publicKey),
        floorVault: floorV,
        marketVault: marketV,
        userUsdc: getAssociatedTokenAddressSync(usdcMint, user.publicKey),
        userPosition: positionOf(user.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
    return send([ix], user.publicKey.equals(payer.publicKey) ? [] : [user]);
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
        createInitializeMint2Instruction(
          kp.publicKey,
          6,
          payer.publicKey,
          null
        ),
      ],
      [kp]
    );
    usdcMint = kp.publicKey;

    await program.methods
      .initialize()
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

    // curve on (buy_sola); borrowing is not behind a phase flag.
    await program.methods
      .setPhaseFlags(null, null, null, null, true, null)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    fresh = Keypair.generate();
    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: fresh.publicKey,
        lamports: 10 * LAMPORTS_PER_SOL,
      }),
    ]);

    payerUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
    payerSola = getAssociatedTokenAddressSync(solaM, payer.publicKey);
    payerHiSola = getAssociatedTokenAddressSync(hiSolaM, payer.publicKey);
    freshUsdc = getAssociatedTokenAddressSync(usdcMint, fresh.publicKey);
    freshHiSola = getAssociatedTokenAddressSync(hiSolaM, fresh.publicKey);

    await send([
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        payerUsdc,
        payer.publicKey,
        usdcMint
      ),
      createMintToInstruction(
        usdcMint,
        payerUsdc,
        payer.publicKey,
        1_000_000_000
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        freshUsdc,
        fresh.publicKey,
        usdcMint
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        freshHiSola,
        fresh.publicKey,
        hiSolaM
      ),
    ]);

    // ── A buys and stakes: this is the only financed deposit in the system ──
    await program.methods
      .buySola(new BN(500_000_000), new BN(1))
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
        hiSolaMint: hiSolaM,
        usdcMint,
        userUsdc: payerUsdc,
        userSola: payerSola,
        userHiSola: payerHiSola,
        solaVault,
        marketVault: marketV,
        userPosition: positionOf(payer.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  });

  it("[security] the honest staker can borrow against their own financed stake", async () => {
    // Establishes the baseline: without this the recycling test below could pass simply
    // because borrowing is broken for everyone.
    const staked = await tokenBalance(payerHiSola);
    assert.isTrue(staked > BigInt(0), "A must hold hiSOLA");

    const before = await tokenBalance(payerUsdc);
    await borrow(payer, 1_000_000);
    const received = (await tokenBalance(payerUsdc)) - before;

    // 2% origination fee is withheld from the gross borrow.
    assert.equal(received.toString(), "980000", "A must receive the net borrow");

    const pos: any = await program.account.userPosition.fetch(
      positionOf(payer.publicKey)
    );
    assert.equal(pos.usdcBorrowed.toString(), "1000000");
    assert.equal(
      pos.stakedAmount.toString(),
      staked.toString(),
      "the recorded deposit must match what was staked"
    );
  });

  it("[security] borrow capacity cannot be walked to a fresh wallet", async () => {
    // A hands the entire collateral to a wallet that has never staked. Nothing here is
    // blocked at the token layer: hiSOLA has no freeze authority, the transfer succeeds.
    const amount = await tokenBalance(payerHiSola);
    await send([
      createTransferInstruction(
        payerHiSola,
        freshHiSola,
        payer.publicKey,
        Number(amount)
      ),
    ]);
    assert.equal(
      (await tokenBalance(freshHiSola)).toString(),
      amount.toString(),
      "the collateral must really be in B's wallet"
    );

    // B now looks, to any balance-based cap, exactly like a fresh staker holding `amount`.
    const floorBefore = await tokenBalance(floorV);
    const code = errorCode("BorrowLimitExceeded");
    let drained = false;
    try {
      await borrow(fresh, 1_000_000);
      drained = true;
    } catch (e: any) {
      assert.include(
        e.toString(),
        `0x${code.toString(16)}`,
        `expected BorrowLimitExceeded, got: ${e.toString()}`
      );
    }
    assert.isFalse(
      drained,
      "a wallet that never staked borrowed against transferred collateral — " +
        "the per-user cap is a token balance again"
    );

    assert.equal(
      (await tokenBalance(floorV)).toString(),
      floorBefore.toString(),
      "not one lamport of USDC may leave the floor vault on a refused borrow"
    );
  });

  it("[security] possession alone is not enough, and neither is a stale deposit record", async () => {
    // The cap is a minimum of two quantities, so check the OTHER half too: A still has a
    // recorded `staked_amount`, but has given the tokens away. A must not be able to keep
    // borrowing on a deposit they no longer hold.
    const pos: any = await program.account.userPosition.fetch(
      positionOf(payer.publicKey)
    );
    assert.isTrue(
      BigInt(pos.stakedAmount.toString()) > BigInt(0),
      "A's recorded deposit is still on the books"
    );
    assert.equal(
      (await tokenBalance(payerHiSola)).toString(),
      "0",
      "A no longer holds the collateral"
    );

    const code = errorCode("BorrowLimitExceeded");
    let drained = false;
    try {
      await borrow(payer, 1_000_000);
      drained = true;
    } catch (e: any) {
      assert.include(
        e.toString(),
        `0x${code.toString(16)}`,
        `expected BorrowLimitExceeded, got: ${e.toString()}`
      );
    }
    assert.isFalse(
      drained,
      "A borrowed again after handing the collateral away — `staked_amount` is being " +
        "trusted on its own"
    );
  });
});
