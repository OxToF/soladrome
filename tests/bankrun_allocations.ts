// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// # Founder and partner allocations, on the real mainnet clock
//
// These three cases used to live in tests/soladrome.ts and only passed because the `devnet`
// feature shortened the constants they depend on: a 6-month vesting cliff became 5 seconds,
// a 6-month partner bag became 6 hours, a 7-day minimum ve lock became 5 seconds. The test
// waited `setTimeout(6_000)` and moved on.
//
// That is what made devnet a different protocol from mainnet, on the numbers that gate
// 12 250 000 SOLA. The feature is gone (2026-08-23) and the constants now carry their mainnet
// values everywhere, so the paths that must cross a 180-day cliff are exercised here instead,
// against a clock we own. **The test moved; the constant did not.**
//
// The other half of that change is why a keypair can sign as the founder at all: the address
// is no longer compiled in, it is written to `ProtocolState.founder_wallet` by `initialize`.
// A hardcoded Ledger address is unsignable by any harness, bankrun included.

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

const DAY = 24 * 3_600;
const EPOCH_DURATION = 7 * DAY; // 604 800 s — state.rs
const VESTING_CLIFF_SECS = 180 * DAY; // state.rs, mainnet value, now the only value
const BASE_BAG_VEST_SECS = 180 * DAY; // state.rs, partner welcome bag stream
const MIN_LOCK_DURATION = EPOCH_DURATION; // state.rs
const TEAM_WALLET = new PublicKey("BVaJbgw3NF7Ng28sHorBnzJrHgvu7S3L5wpdB6923LjA");

describe("soladrome — bankrun (allocations on the mainnet clock)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: anchor.Program<any>;
  let payer: Keypair;
  let idlJson: any;

  /// The founder wallet this protocol is initialised with. A keypair the suite holds — which
  /// is only possible because the address lives in state rather than in the binary.
  const founder = Keypair.generate();

  let usdcMint: PublicKey;
  let statePda: PublicKey;
  let solaM: PublicKey;
  let oSolaM: PublicKey;
  let floorV: PublicKey;
  let marketV: PublicKey;
  let solaVault: PublicKey;

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

  /// The whole reason this file exists: 180 days in one call.
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
      if (/expected .* but the call succeeded/.test(msg)) throw e;
      const hit =
        msg.includes(name) ||
        msg.includes(`0x${code.toString(16)}`) ||
        msg.includes(`Error Number: ${code}`);
      assert.isTrue(hit, `expected ${name} (${code}), got: ${msg}`);
    }
  }

  const founderVestingPda = () => pda([Buffer.from("founder_vesting")]);
  const founderHiVestingPda = () => pda([Buffer.from("founder_hi_vesting")]);
  const velockPda = (o: PublicKey) => pda([Buffer.from("velock"), o.toBuffer()]);
  const positionPda = (o: PublicKey) =>
    pda([Buffer.from("position"), o.toBuffer()]);

  before(async () => {
    context = await startAnchor(".", [], []);
    provider = new BankrunProvider(context);
    payer = context.payer;

    idlJson = JSON.parse(fs.readFileSync("target/idl/soladrome.json", "utf8"));
    program = new anchor.Program(idlJson, provider);

    statePda = pda([Buffer.from("state")]);
    solaM = pda([Buffer.from("sola_mint")]);
    oSolaM = pda([Buffer.from("o_sola_mint")]);
    floorV = pda([Buffer.from("floor_vault")]);
    marketV = pda([Buffer.from("market_vault")]);
    solaVault = pda([Buffer.from("sola_vault")]);

    // ── USDC mock mint ──────────────────────────────────────────────────────
    const mintKp = Keypair.generate();
    const rent = await context.banksClient.getRent();
    const lamports = Number(rent.minimumBalance(BigInt(MINT_SIZE)));
    usdcMint = mintKp.publicKey;
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: usdcMint,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(usdcMint, 6, payer.publicKey, null),
      ],
      [mintKp]
    );

    await program.methods
      .initialize(founder.publicKey)
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

    // Fund the founder and the payer with lamports for rent on the PDAs they open.
    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: founder.publicKey,
        lamports: 5_000_000_000,
      }),
    ]);
  });

  it("[init] the founder wallet is recorded in state, not compiled in", async () => {
    // The single change that lets one binary serve every cluster. If this ever reverts to a
    // constant, the mainnet build becomes unsignable by any harness and the 12.25M path
    // silently loses all coverage again — which is exactly how it was until 2026-08-23.
    const st: any = await program.account.protocolState.fetch(statePda);
    assert.equal(
      st.founderWallet.toBase58(),
      founder.publicKey.toBase58(),
      "initialize must persist the founder wallet it was given"
    );
  });

  it("[founder] the 6-month cliff is real — claiming before it is refused", async () => {
    await program.methods
      .mintFounderAllocation()
      .accounts({
        authority: payer.publicKey,
        protocolState: statePda,
        founder: founder.publicKey,
        founderHiVesting: founderHiVestingPda(),
        founderVesting: founderVestingPda(),
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    // One day short of the cliff. Under the old `devnet` build this was 5 seconds and the
    // suite simply slept through it, so the cliff had no coverage on the shipped constant.
    await forwardSeconds(VESTING_CLIFF_SECS - DAY);
    await expectFailure(
      () =>
        program.methods
          .claimFounderHiSola()
          .accounts({
            protocolState: statePda,
            founder: founder.publicKey,
            solaMint: solaM,
            solaVault,
            marketVault: marketV,
            lockPosition: velockPda(founder.publicKey),
            founderPosition: positionPda(founder.publicKey),
            founderHiVesting: founderHiVestingPda(),
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([founder])
          .rpc(),
      "VestingCliffNotReached"
    );
  });

  it("[founder] past the cliff the tranche lands in the ve lock, never in the balance", async () => {
    const before: any = await program.account.protocolState.fetch(statePda);

    // Cross the cliff, then a little more so a slice has actually vested.
    await forwardSeconds(2 * DAY + 30 * DAY);

    await program.methods
      .claimFounderHiSola()
      .accounts({
        protocolState: statePda,
        founder: founder.publicKey,
        solaMint: solaM,
        solaVault,
        marketVault: marketV,
        lockPosition: velockPda(founder.publicKey),
        founderPosition: positionPda(founder.publicKey),
        founderHiVesting: founderHiVestingPda(),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([founder])
      .rpc();

    const lock: any = await program.account.veLockPosition.fetch(
      velockPda(founder.publicKey)
    );
    const locked = BigInt(lock.amountLocked.toString());
    assert.isTrue(locked > BigInt(0), "the vested slice must reach the ve lock");

    // The three guarantees the ve lock exists to provide, asserted where they live.
    const pos: any = await program.account.userPosition.fetch(
      positionPda(founder.publicKey)
    );
    assert.equal(
      pos.hiSola.toString(),
      "0",
      "the tranche must never become a spendable balance"
    );
    assert.equal(
      pos.stakedAmount.toString(),
      "0",
      "and it is unfinanced — no USDC ever entered the floor for it"
    );

    const after: any = await program.account.protocolState.fetch(statePda);
    assert.equal(
      after.totalHiSola.toString(),
      before.totalHiSola.toString(),
      "locked hiSOLA stays out of the fee denominator — the reserve earns nothing"
    );
  });

  it("[founder] unlock_hi_sola refuses the founder, expired or not", async () => {
    // Well past any lock end. The refusal is identity-based, not time-based: this is the
    // single `require!` that keeps the 7M out of `hi_sola` forever, and the reason the
    // vesting guard in `unstake_hi_sola` is a second line rather than the first.
    await forwardSeconds(5 * 365 * DAY);
    await expectFailure(
      () =>
        program.methods
          .unlockHiSola()
          .accounts({
            user: founder.publicKey,
            protocolState: statePda,
            lockPosition: velockPda(founder.publicKey),
            marketVault: marketV,
            userPosition: positionPda(founder.publicKey),
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([founder])
          .rpc(),
      "FounderVestingLocked"
    );

    const lock: any = await program.account.veLockPosition.fetch(
      velockPda(founder.publicKey)
    );
    assert.isTrue(
      BigInt(lock.amountLocked.toString()) > BigInt(0),
      "the refused unlock took nothing"
    );
  });

  it("[partner] the welcome bag streams over 6 months and can never be unlocked", async () => {
    const partner = Keypair.generate();
    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: partner.publicKey,
        lamports: 5_000_000_000,
      }),
    ]);

    const alloc = pda([Buffer.from("partner"), partner.publicKey.toBuffer()]);
    const ONE = new BN(1_000_000);

    // `lock_duration_secs` must now clear MIN_LOCK_DURATION = 7 days. The old test passed 5,
    // which only worked because the devnet build shortened the floor to 5 seconds.
    await program.methods
      .registerPartner(
        usdcMint,
        new BN(1),
        new BN(1),
        ONE,
        ONE,
        new BN(MIN_LOCK_DURATION)
      )
      .accounts({
        authority: payer.publicKey,
        protocolState: statePda,
        partnerWallet: partner.publicKey,
        partnerAllocation: alloc,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    // Let a real slice of the 6-month bag stream. Under the devnet build this window was
    // 6 hours, so "a slice vested" was a 6-second sleep and the stream was never exercised.
    await forwardSeconds(BASE_BAG_VEST_SECS / 2);

    await program.methods
      .claimPartnerAllocation()
      .accounts({
        partner: partner.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        solaVault,
        marketVault: marketV,
        partnerAllocation: alloc,
        lockPosition: velockPda(partner.publicKey),
        partnerPosition: positionPda(partner.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([partner])
      .rpc();

    const lock: any = await program.account.veLockPosition.fetch(
      velockPda(partner.publicKey)
    );
    assert.isTrue(
      lock.amountLocked.toNumber() > 0,
      "half the streaming window must have vested a real amount"
    );
    assert.equal(
      lock.permanentAmount.toString(),
      lock.amountLocked.toString(),
      "the whole bag is permanent — unfinanced, no USDC ever backed it"
    );
    const pPos: any = await program.account.userPosition.fetch(
      positionPda(partner.publicKey)
    );
    assert.equal(
      pPos.hiSola.toString(),
      "0",
      "and none of it is spendable"
    );

    // Wait out the lock so the ONLY thing between the bag and a wallet is permanent_amount.
    await forwardSeconds(2 * MIN_LOCK_DURATION);
    await expectFailure(
      () =>
        program.methods
          .unlockHiSola()
          .accounts({
            user: partner.publicKey,
            protocolState: statePda,
            lockPosition: velockPda(partner.publicKey),
            marketVault: marketV,
            userPosition: positionPda(partner.publicKey),
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([partner])
          .rpc(),
      "NothingToClaim"
    );

    const after: any = await program.account.veLockPosition.fetch(
      velockPda(partner.publicKey)
    );
    assert.equal(
      after.amountLocked.toString(),
      lock.amountLocked.toString(),
      "the expired lock released nothing — permanent_amount overrides the timer forever"
    );
  });
});
