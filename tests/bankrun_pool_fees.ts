// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs
//
// # Bankrun harness — every swap pays the protocol, and non-USDC fees pay the pool's voters
//
// Until 2026-11-11 only a USDC input paid the protocol: `swap` moved its share to `market_vault`
// and every other input left it in the reserves as LP revenue. On SOLA/SOL and the SOL/LST pools
// — the pools the protocol launches with — that is every swap, so they paid nothing. The share
// is now booked in the pool ledger (`protocol_fees_a/b`) and paid by `collect_pool_fees` as a
// bribe to the pool's own voters, less the operating company's share (0 until it exists).
//
// What is proven here:
//
//   P-1. A non-USDC input books the protocol share in the ledger, and the vault holds exactly
//        reserve + owed. `market_vault` does not move.
//   P-2. A USDC input still pays `market_vault` at swap time and books nothing.
//   P-3. The crank refuses a past or future epoch, and a side that owes nothing.
//   P-4. The crank moves what is owed into the pool's bribe pot for the current epoch and
//        zeroes the ledger; vault and reserve agree again.
//   P-5. The pool's voter claims that pot with the ordinary `claim_bribe` once the epoch ends.
//   P-6. The company share: authority-only, capped at 25 %, needs a wallet; once set, the crank
//        refuses to run without the company's token account (a permissionless caller cannot
//        route the company's share to the voters by omitting it), and splits exactly.

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
const FEE_RATE = 30;
const PROTO_BPS = 2_000;

describe("soladrome — bankrun (pool protocol fees to voters)", () => {
  let context: ProgramTestContext;
  let program: anchor.Program<any>;
  let payer: Keypair;
  let idlJson: any;

  let usdcMint: PublicKey;
  let tknMint: PublicKey;
  let mintA: PublicKey;
  let mintB: PublicKey;
  let tknIsA: boolean;

  let statePda: PublicKey;
  let solaM: PublicKey;
  let floorV: PublicKey;
  let marketV: PublicKey;
  let solaVault: PublicKey;
  let oSolaM: PublicKey;
  let companyConfig: PublicKey;

  let poolPda: PublicKey;
  let vaultA: PublicKey;
  let vaultB: PublicKey;
  let userUsdc: PublicKey;
  let userTkn: PublicKey;
  let userSola: PublicKey;
  let userPosition: PublicKey;

  let epoch: number;

  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const epochLE = (e: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(e));
    return b;
  };

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
    return Number((await context.banksClient.getClock()).unixTimestamp);
  }

  async function forwardSeconds(seconds: number) {
    const c = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        c.slot + BigInt(1),
        c.epochStartTimestamp,
        c.epoch,
        c.leaderScheduleEpoch,
        c.unixTimestamp + BigInt(seconds)
      )
    );
  }

  async function expectFailure(fn: () => Promise<any>, name: string) {
    const entry = idlJson.errors.find((e: any) => e.name === name);
    assert.isDefined(entry, `no such error in the IDL: ${name}`);
    const code = entry.code;
    try {
      await fn();
      assert.fail(`expected ${name} (${code}), but the call succeeded`);
    } catch (e: any) {
      const msg = e.toString();
      if (/but the call succeeded/.test(msg)) throw e;
      assert.isTrue(
        msg.includes(`0x${code.toString(16)}`) || msg.includes(`Error Number: ${code}`),
        `expected ${name}, got: ${msg}`
      );
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

  async function pool(): Promise<any> {
    return program.account.ammPool.fetch(poolPda);
  }

  /// Owed protocol fees on the TKN / USDC side.
  async function owed(): Promise<{ tkn: bigint; usdc: bigint }> {
    const p = await pool();
    const a = BigInt(p.protocolFeesA.toString());
    const b = BigInt(p.protocolFeesB.toString());
    return tknIsA ? { tkn: a, usdc: b } : { tkn: b, usdc: a };
  }

  /// ☢️ The invariant: each vault holds exactly reserve + owed protocol fees.
  async function assertVaultsHoldReservePlusOwed(label: string) {
    const p = await pool();
    for (const [side, vault] of [
      ["A", vaultA],
      ["B", vaultB],
    ] as const) {
      const reserve = BigInt(p[`reserve${side}`].toString());
      const fees = BigInt(p[`protocolFees${side}`].toString());
      assert.equal(
        (reserve + fees).toString(),
        (await tokenBalance(vault)).toString(),
        `${label}: vault ${side} ≠ reserve + owed fees`
      );
    }
  }

  async function swap(amountIn: bigint, tknIn: boolean) {
    const aToB = tknIn === tknIsA;
    await program.methods
      .ammSwap(new BN(amountIn.toString()), new BN(0), aToB)
      .accounts({
        user: payer.publicKey,
        pool: poolPda,
        tokenAMint: mintA,
        tokenBMint: mintB,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        userTokenIn: tknIn ? userTkn : userUsdc,
        userTokenOut: tknIn ? userUsdc : userTkn,
        marketVault: marketV,
        protocolState: statePda,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
  }

  const bribeVault = (mint: PublicKey, e: number) =>
    pda([Buffer.from("bribe_vault"), poolPda.toBuffer(), mint.toBuffer(), epochLE(e)]);
  const bribeTokens = (mint: PublicKey, e: number) =>
    pda([Buffer.from("bribe_tokens"), poolPda.toBuffer(), mint.toBuffer(), epochLE(e)]);

  async function collect(
    e: number,
    mint: PublicKey,
    companyToken: PublicKey | null = null,
    caller: Keypair = payer
  ) {
    const sideA = mint.equals(mintA);
    const ix = await program.methods
      .collectPoolFees(new BN(e), sideA)
      .accounts({
        payer: caller.publicKey,
        protocolState: statePda,
        pool: poolPda,
        mint,
        poolVault: sideA ? vaultA : vaultB,
        bribeVault: bribeVault(mint, e),
        bribeTokenVault: bribeTokens(mint, e),
        companyConfig,
        companyToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
    const tx = new Transaction();
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = caller.publicKey;
    tx.add(ix);
    tx.sign(caller);
    return context.banksClient.processTransaction(tx);
  }

  async function setCompanyFee(bps: number, wallet: PublicKey, signer: Keypair = payer) {
    const ix = await program.methods
      .setCompanyFee(bps, wallet)
      .accounts({
        authority: signer.publicKey,
        protocolState: statePda,
        companyConfig,
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
    const tx = new Transaction();
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = signer.publicKey;
    tx.add(ix);
    tx.sign(signer);
    return context.banksClient.processTransaction(tx);
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
    floorV = pda([Buffer.from("floor_vault")]);
    marketV = pda([Buffer.from("market_vault")]);
    solaVault = pda([Buffer.from("sola_vault")]);
    companyConfig = pda([Buffer.from("company_config")]);
    userPosition = pda([Buffer.from("position"), payer.publicKey.toBuffer()]);

    usdcMint = await createMint();
    tknMint = await createMint();

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
        solaVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    // lp + bribes + voting + curve.
    await program.methods
      .setPhaseFlags(true, true, true, null, true, null)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    userUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
    userTkn = getAssociatedTokenAddressSync(tknMint, payer.publicKey);
    userSola = getAssociatedTokenAddressSync(solaM, payer.publicKey);
    await send([
      createAssociatedTokenAccountInstruction(payer.publicKey, userUsdc, payer.publicKey, usdcMint),
      createAssociatedTokenAccountInstruction(payer.publicKey, userTkn, payer.publicKey, tknMint),
      createMintToInstruction(usdcMint, userUsdc, payer.publicKey, 5_000_000_000),
      createMintToInstruction(tknMint, userTkn, payer.publicKey, 5_000_000_000),
    ]);

    [mintA, mintB] =
      Buffer.compare(usdcMint.toBuffer(), tknMint.toBuffer()) <= 0
        ? [usdcMint, tknMint]
        : [tknMint, usdcMint];
    tknIsA = mintA.equals(tknMint);
    poolPda = pda([Buffer.from("amm_pool"), mintA.toBuffer(), mintB.toBuffer()]);
    const lpMint = pda([Buffer.from("lp_mint"), poolPda.toBuffer()]);
    vaultA = pda([Buffer.from("vault_a"), poolPda.toBuffer()]);
    vaultB = pda([Buffer.from("vault_b"), poolPda.toBuffer()]);

    await program.methods
      .createPool(FEE_RATE, PROTO_BPS)
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
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    await program.methods
      .addLiquidity(new BN(1_000_000_000), new BN(1_000_000_000), new BN(1))
      .accounts({
        user: payer.publicKey,
        pool: poolPda,
        lpMint,
        tokenAMint: mintA,
        tokenBMint: mintB,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        userTokenA: tknIsA ? userTkn : userUsdc,
        userTokenB: tknIsA ? userUsdc : userTkn,
        userLp: getAssociatedTokenAddressSync(lpMint, payer.publicKey),
        lpDeadAta: getAssociatedTokenAddressSync(lpMint, SystemProgram.programId, true),
        lpDead: SystemProgram.programId,
        lpUserInfo: pda([Buffer.from("lp_user"), poolPda.toBuffer(), payer.publicKey.toBuffer()]),
        protocolState: statePda,
        oSolaMint: oSolaM,
        userOSola: getAssociatedTokenAddressSync(oSolaM, payer.publicKey),
        rent: SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    // hiSOLA, to vote for the pool.
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
    await program.methods
      .stakeSola(new BN((await tokenBalance(userSola)).toString()))
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

    // One hour into a fresh epoch, then vote 30 % of the stake (the global cap) for the pool.
    const nowE = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    await forwardSeconds((nowE + 1) * EPOCH_DURATION + 3600 - (await nowSeconds()));
    epoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    const pos = await program.account.userPosition.fetch(userPosition);
    const weight = (BigInt(pos.hiSola.toString()) * BigInt(3000)) / BigInt(10000);
    await program.methods
      .voteGauge(new BN(epoch), new BN(weight.toString()))
      .accounts({
        user: payer.publicKey,
        poolId: poolPda,
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
  });

  const IN = BigInt(10_000_000);
  const expectedProtocol = (amt: bigint) =>
    (((amt * BigInt(FEE_RATE)) / BigInt(10_000)) * BigInt(PROTO_BPS)) / BigInt(10_000);

  // ── P-1 ────────────────────────────────────────────────────────────────────
  it("☢️ [fees] a non-USDC input books the protocol share instead of leaving it to LPs", async () => {
    const marketBefore = await tokenBalance(marketV);
    await swap(IN, true);

    const o = await owed();
    assert.equal(o.tkn.toString(), expectedProtocol(IN).toString(), "TKN fee owed");
    assert.equal(o.usdc.toString(), "0");
    assert.equal(
      (await tokenBalance(marketV)).toString(),
      marketBefore.toString(),
      "a TKN fee must not reach market_vault"
    );
    await assertVaultsHoldReservePlusOwed("after a TKN-in swap");
  });

  // ── P-2 ────────────────────────────────────────────────────────────────────
  it("[fees] a USDC input still pays market_vault at swap time and books nothing", async () => {
    const before = await owed();
    const marketBefore = await tokenBalance(marketV);
    await swap(IN + BigInt(1), false);

    const after = await owed();
    assert.equal(after.usdc.toString(), "0", "USDC is never booked");
    assert.equal(after.tkn.toString(), before.tkn.toString());
    assert.equal(
      ((await tokenBalance(marketV)) - marketBefore).toString(),
      expectedProtocol(IN + BigInt(1)).toString(),
      "the USDC protocol share goes to stakers"
    );
    await assertVaultsHoldReservePlusOwed("after a USDC-in swap");
  });

  // ── P-3 ────────────────────────────────────────────────────────────────────
  it("[fees] the crank refuses another epoch, and a side that owes nothing", async () => {
    await expectFailure(() => collect(epoch - 1, tknMint), "WrongEpoch");
    await expectFailure(() => collect(epoch + 1, tknMint), "WrongEpoch");
    await expectFailure(() => collect(epoch, usdcMint), "NothingToClaim");
  });

  // ── P-4 ────────────────────────────────────────────────────────────────────
  it("☢️ [fees] the crank pays what is owed into the pool's bribe pot, by anyone", async () => {
    const due = (await owed()).tkn;
    assert.isTrue(due > BigInt(0));

    // A stranger runs it: the crank is permissionless and pays the pot's rent.
    const stranger = Keypair.generate();
    context.setAccount(stranger.publicKey, {
      lamports: 1_000_000_000,
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      executable: false,
    });
    await collect(epoch, tknMint, null, stranger);

    assert.equal((await owed()).tkn.toString(), "0", "the ledger is zeroed");
    assert.equal(
      (await tokenBalance(bribeTokens(tknMint, epoch))).toString(),
      due.toString(),
      "the pot holds exactly what was owed"
    );
    const bv = await program.account.bribeVault.fetch(bribeVault(tknMint, epoch));
    assert.equal(bv.totalBribed.toString(), due.toString());
    assert.equal(bv.poolId.toBase58(), poolPda.toBase58());
    await assertVaultsHoldReservePlusOwed("after collection");

    // A second run has nothing to pay.
    await expectFailure(() => collect(epoch, tknMint), "NothingToClaim");
  });

  // ── P-6 ────────────────────────────────────────────────────────────────────
  it("☢️ [fees] the company share is capped, authority-only, and cannot be skipped", async () => {
    const company = Keypair.generate();
    const stranger = Keypair.generate();
    context.setAccount(stranger.publicKey, {
      lamports: 1_000_000_000,
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      executable: false,
    });

    await expectFailure(() => setCompanyFee(1_000, company.publicKey, stranger), "Unauthorized");
    await expectFailure(() => setCompanyFee(2_501, company.publicKey), "CompanyFeeInvalid");
    await expectFailure(() => setCompanyFee(1_000, PublicKey.default), "CompanyFeeInvalid");
    await setCompanyFee(1_000, company.publicKey);

    await swap(IN + BigInt(2), true);
    const due = (await owed()).tkn;
    const companyCut = (due * BigInt(1_000)) / BigInt(10_000);
    const potBefore = await tokenBalance(bribeTokens(tknMint, epoch));

    // Omitting the company account, or passing one the company does not own, is refused.
    // (A fresh slot first: P-4 already sent this exact transaction, refused, in this slot.)
    context.warpToSlot((await context.banksClient.getSlot()) + BigInt(1));
    await expectFailure(() => collect(epoch, tknMint, null), "CompanyAccountRequired");
    await expectFailure(() => collect(epoch, tknMint, userTkn), "CompanyAccountRequired");

    const companyTkn = getAssociatedTokenAddressSync(tknMint, company.publicKey);
    await send([
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        companyTkn,
        company.publicKey,
        tknMint
      ),
    ]);
    await collect(epoch, tknMint, companyTkn);

    assert.equal((await tokenBalance(companyTkn)).toString(), companyCut.toString(), "company 10 %");
    assert.equal(
      ((await tokenBalance(bribeTokens(tknMint, epoch))) - potBefore).toString(),
      (due - companyCut).toString(),
      "voters 90 %"
    );
    await assertVaultsHoldReservePlusOwed("after a split collection");

    // Back to 0 % for the claim below: the wallet is kept, the share stops.
    await setCompanyFee(0, company.publicKey);
  });

  // ── P-5 ────────────────────────────────────────────────────────────────────
  it("[fees] the pool's voter claims the pot with the ordinary claim_bribe", async () => {
    const pot = await tokenBalance(bribeTokens(tknMint, epoch));
    const claimIx = () =>
      program.methods
        .claimBribe(new BN(epoch))
        .accounts({
          user: payer.publicKey,
          poolId: poolPda,
          rewardMint: tknMint,
          bribeVault: bribeVault(tknMint, epoch),
          bribeTokenVault: bribeTokens(tknMint, epoch),
          userRewardAta: userTkn,
          gaugeState: pda([Buffer.from("gauge"), poolPda.toBuffer(), epochLE(epoch)]),
          userVoteReceipt: pda([
            Buffer.from("vote"),
            payer.publicKey.toBuffer(),
            poolPda.toBuffer(),
            epochLE(epoch),
          ]),
          userBribeClaim: pda([
            Buffer.from("bribe_claim"),
            payer.publicKey.toBuffer(),
            poolPda.toBuffer(),
            tknMint.toBuffer(),
            epochLE(epoch),
          ]),
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();

    await expectFailure(claimIx, "EpochNotEnded");
    await forwardSeconds(EPOCH_DURATION);
    context.warpToSlot((await context.banksClient.getSlot()) + BigInt(1));

    const before = await tokenBalance(userTkn);
    await claimIx();
    // Sole voter on the pool ⇒ the whole pot.
    assert.equal(((await tokenBalance(userTkn)) - before).toString(), pot.toString());
  });
});
