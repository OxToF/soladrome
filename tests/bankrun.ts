// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// # Bankrun harness — tests that need a clock the validator will not give us
//
// Epochs are 7 days (`EPOCH_DURATION = 604_800`) with **no devnet override**, so anything
// gated on "the epoch has ended" is untestable against a real validator: the main suite can
// only ever assert the refusal, never the release. `[escrow] voted hiSOLA cannot be
// forwarded to a second wallet` in tests/soladrome.ts says exactly that in its closing
// comment — the happy path of `withdraw_vote_escrow` had no coverage at all.
//
// Bankrun runs the program in-process against a SVM whose sysvars we own, so we can set the
// clock forward a week and execute the path for real. No validator, no airdrops, no waiting.
//
// Runs under the same `anchor test` command as the rest of the suite; it simply ignores the
// validator that command starts.
//
// Next target for this harness (not covered here): the per-epoch LP emission cycle, which
// remains the gate before arming `osola_emission_initial > 0` on mainnet.

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
  MintLayout,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import * as fs from "fs";

const EPOCH_DURATION = 604_800; // seconds — lib.rs, no devnet variant

describe("soladrome — bankrun (warped clock)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: anchor.Program<any>;
  let payer: Keypair;
  let idlJson: any;

  let usdcMint: PublicKey;
  let statePda: PublicKey;
  let solaM: PublicKey;
  let hiSolaM: PublicKey;
  let oSolaM: PublicKey;
  let floorV: PublicKey;
  let marketV: PublicKey;
  let solaVault: PublicKey;
  let voteEscrowVault: PublicKey;

  let userUsdc: PublicKey;
  let userSola: PublicKey;
  let userHiSola: PublicKey;
  let userPosition: PublicKey;

  let stakedAmount: bigint;
  let votedWeight: bigint;
  let votedEpoch: number;

  // ── helpers ───────────────────────────────────────────────────────────────

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

  /// Move the SVM clock forward. This is the whole reason the harness exists.
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

  /// Assert that a call fails with a named Soladrome error.
  ///
  /// Sending through `banksClient` bypasses Anchor's error translation, so failures arrive as
  /// a raw `custom program error: 0x…`. Resolve the name through the IDL rather than pinning
  /// a hex literal, so renumbering the error enum cannot leave this test asserting the wrong
  /// guard while still passing.
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
      assert.include(
        msg,
        `0x${code.toString(16)}`,
        `expected ${name} (0x${code.toString(16)}), got: ${msg}`
      );
    }
  }

  /// Total supply of a mint — used to assert that hiSOLA has none.
  async function mintSupply(mint: PublicKey): Promise<bigint> {
    const raw = await context.banksClient.getAccount(mint);
    if (!raw) return BigInt(0);
    return MintLayout.decode(Buffer.from(raw.data)).supply;
  }

  /// Send an `unstake_hi_sola` attempt.
  ///
  /// The `nonce` is not decoration: bankrun caches by transaction signature and the blockhash
  /// does not move on its own here, so a refused attempt and a later successful one could be
  /// byte-identical and the second would come back as "already processed". A self-transfer of
  /// `nonce` lamports makes each attempt distinct without touching protocol state.
  async function attemptUnstake(amount: bigint, nonce: number) {
    const ix = await program.methods
      .unstakeHiSola(new BN(amount.toString()))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        userSola,
        solaVault,
        marketVault: marketV,
        usdcMint,
        userUsdc,
        userPosition,
        // No founder vesting in this harness: the guard is `#[cfg(not(feature = "devnet"))]`
        // and the account is unchecked, so the program id is an accepted placeholder.
        founderHiVesting: program.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
    const bump = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: nonce,
    });
    return send([bump, ix]);
  }

  /// Cast a gauge vote for `poolId`.
  async function vote(poolId: PublicKey, epoch: number, weight: bigint) {
    const epochLE = Buffer.alloc(8);
    epochLE.writeBigUInt64LE(BigInt(epoch));
    return program.methods
      .voteGauge(new BN(epoch), new BN(weight.toString()))
      .accounts({
        user: payer.publicKey,
        poolId,
        protocolState: statePda,
        marketVault: marketV,
        userPosition,
        lockPosition: SystemProgram.programId,
        gaugeState: pda([Buffer.from("gauge"), poolId.toBuffer(), epochLE]),
        userVoteReceipt: pda([
          Buffer.from("vote"),
          payer.publicKey.toBuffer(),
          poolId.toBuffer(),
          epochLE,
        ]),
        userEpochVotes: pda([
          Buffer.from("uev"),
          payer.publicKey.toBuffer(),
          epochLE,
        ]),
        globalEpochVotes: pda([Buffer.from("epoch_votes"), epochLE]),
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

    // ── protocol ────────────────────────────────────────────────────────────
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

    // curve + voting are all this harness needs.
    await program.methods
      .setPhaseFlags(null, null, true, null, true, null)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    // ── user token accounts, funded ─────────────────────────────────────────
    userUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
    userSola = getAssociatedTokenAddressSync(solaM, payer.publicKey);
    userHiSola = getAssociatedTokenAddressSync(hiSolaM, payer.publicKey);

    await send([
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userUsdc,
        payer.publicKey,
        usdcMint
      ),
      createMintToInstruction(
        usdcMint,
        userUsdc,
        payer.publicKey,
        1_000_000_000
      ), // 1 000 USDC
    ]);

    // ── buy → stake, so there is real hiSOLA to vote with ───────────────────
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

    stakedAmount = BigInt(
      (
        await program.account.userPosition.fetch(userPosition)
      ).hiSola.toString()
    );
    assert.isAbove(Number(stakedAmount), 0, "the voter must hold real hiSOLA");

    // Park the clock one hour into a FRESH epoch. Without this the harness inherits whatever
    // point of the 7-day cycle the wall clock happens to sit at, and the "still inside the
    // epoch" test flips depending on the day it is run — it failed on the first attempt for
    // exactly that reason, a one-day step having crossed the boundary.
    const nowE = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    const target = (nowE + 1) * EPOCH_DURATION + 3600;
    await forwardSeconds(target - (await nowSeconds()));
  });

  it("[bankrun] staking credits the position and mints no token at all", async () => {
    // The premise of the whole model: there is nothing to transfer, so there is nothing to
    // intercept. If a mint ever reappears here, every guarantee below reverts to being a
    // `require!` that a raw SPL transfer walks straight past.
    const supply = await mintSupply(hiSolaM);
    assert.equal(supply, BigInt(0), "no hiSOLA token was ever minted");
    assert.equal(
      await tokenBalance(userHiSola),
      BigInt(0),
      "the staker holds no hiSOLA token account balance"
    );

    const pos = await program.account.userPosition.fetch(userPosition);
    assert.equal(
      pos.hiSola.toString(),
      stakedAmount.toString(),
      "the balance is the position"
    );
    assert.equal(
      pos.stakedAmount.toString(),
      stakedAmount.toString(),
      "and it is recorded as financed, since it was bought through the curve"
    );
  });

  it("[bankrun] a vote locks the backing balance without moving it", async () => {
    votedEpoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    // VOTE_WEIGHT_CAP_BPS caps any address at 30% of total_hi_sola. This wallet is the only
    // staker, so the global cap binds against its own stake: voting the full balance is
    // refused with VoteOverflow. Vote exactly the cap — that share becomes locked, the rest
    // stays free to withdraw.
    votedWeight = (stakedAmount * BigInt(3000)) / BigInt(10000);
    assert.isAbove(Number(votedWeight), 0, "the capped weight must be non-zero");
    const poolId = Keypair.generate().publicKey;
    await vote(poolId, votedEpoch, votedWeight);

    const pos = await program.account.userPosition.fetch(userPosition);
    assert.equal(
      pos.hiSola.toString(),
      stakedAmount.toString(),
      "voting moves nothing — the whole balance is still on the position"
    );
    assert.equal(
      pos.voteLocked.toString(),
      votedWeight.toString(),
      "exactly the voted weight is immobilised"
    );
    assert.equal(
      pos.voteLockEpoch.toString(),
      votedEpoch.toString(),
      "the lock is stamped with the epoch it backs"
    );
    // The property the escrow vault existed to buy, now held without custody.
    assert.equal(
      await mintSupply(hiSolaM),
      BigInt(0),
      "and still no token exists to be forwarded to a second wallet"
    );
  });

  it("[bankrun] the locked backing cannot be unstaked while the epoch runs", async () => {
    // Move time forward, but stay inside the epoch: proves the guard keys on the epoch
    // boundary and not merely on "some time has passed".
    await forwardSeconds(60 * 60 * 24); // one day
    assert.equal(
      Math.floor((await nowSeconds()) / EPOCH_DURATION),
      votedEpoch,
      "a day later we must still be inside the voted epoch for this test to mean anything"
    );

    // One base unit past the free portion is the whole test: the guard has to bind on the
    // voted weight itself, not on "has voted this epoch at all".
    const free = stakedAmount - votedWeight;
    await expectFailure(() => attemptUnstake(free + BigInt(1), 1), "VoteEscrowLocked");

    const pos = await program.account.userPosition.fetch(userPosition);
    assert.equal(
      pos.hiSola.toString(),
      stakedAmount.toString(),
      "the refused unstake took nothing"
    );
  });

  it("[bankrun] the unvoted remainder stays free to withdraw", async () => {
    // Escrow could only ever be all-or-nothing per top-up; the ledger is exact. A voter is
    // immobilised for what they voted and not one unit more.
    const free = stakedAmount - votedWeight;
    await attemptUnstake(free, 2);

    const pos = await program.account.userPosition.fetch(userPosition);
    assert.equal(
      pos.hiSola.toString(),
      votedWeight.toString(),
      "only the voted weight is left standing"
    );
    assert.equal(
      await tokenBalance(userSola),
      free,
      "and the SOLA came back to the wallet — SOLA is still a real token"
    );
  });

  it("[bankrun] the lock lapses once the epoch has ended", async () => {
    // Cross the boundary. This is the assertion the main suite has never been able to make.
    await forwardSeconds(EPOCH_DURATION);
    const nowEpoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    assert.isAbove(
      nowEpoch,
      votedEpoch,
      "the clock must have crossed into a later epoch"
    );

    await attemptUnstake(votedWeight, 3);

    const pos = await program.account.userPosition.fetch(userPosition);
    assert.equal(pos.hiSola.toString(), "0", "the whole stake is out");
    // Deliberately NOT cleared on exit: a stale stamp is inert because `vote_locked_now`
    // compares it against the running epoch. Asserting it stays put pins that reading — if a
    // later change ever starts trusting `vote_locked` without the epoch test, this breaks.
    assert.equal(
      pos.voteLocked.toString(),
      votedWeight.toString(),
      "the counter is left behind, and is inert because its epoch has passed"
    );
    assert.equal(
      await tokenBalance(userSola),
      stakedAmount,
      "every SOLA staked is back in the wallet"
    );
  });

  it("[bankrun] releasing the backing does not erase the votes it backed", async () => {
    // If unstaking rolled back gauge weight, a voter could vote, wait a week, unstake, and
    // quietly undo the emissions their vote directed.
    const epochLE = Buffer.alloc(8);
    epochLE.writeBigUInt64LE(BigInt(votedEpoch));
    const gev = await program.account.globalEpochVotes.fetch(
      pda([Buffer.from("epoch_votes"), epochLE])
    );
    assert.equal(
      gev.totalVotes.toString(),
      votedWeight.toString(),
      "the epoch tally still records the vote after the stake went home"
    );
  });
});
