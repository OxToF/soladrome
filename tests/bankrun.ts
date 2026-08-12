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

  /// Send a `withdraw_vote_escrow` attempt.
  ///
  /// The `nonce` is not decoration: bankrun caches by transaction signature and the blockhash
  /// does not move on its own here, so the refusal attempt and the successful one would be
  /// byte-identical and the second comes back as "already processed". A self-transfer of
  /// `nonce` lamports makes each attempt distinct without touching protocol state.
  async function attemptWithdraw(nonce: number) {
    const ix = await program.methods
      .withdrawVoteEscrow()
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        hiSolaMint: hiSolaM,
        userHiSola,
        voteEscrowVault,
        userPosition,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .instruction();
    const bump = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: nonce,
    });
    return send([bump, ix]);
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
        hiSolaMint: hiSolaM,
        usdcMint,
        userUsdc,
        userSola,
        userHiSola,
        solaVault,
        marketVault: marketV,
        userPosition,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    stakedAmount = await tokenBalance(userHiSola);
    assert.isAbove(Number(stakedAmount), 0, "the voter must hold real hiSOLA");

    // Park the clock one hour into a FRESH epoch. Without this the harness inherits whatever
    // point of the 7-day cycle the wall clock happens to sit at, and the "still inside the
    // epoch" test flips depending on the day it is run — it failed on the first attempt for
    // exactly that reason, a one-day step having crossed the boundary.
    const nowE = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    const target = (nowE + 1) * EPOCH_DURATION + 3600;
    await forwardSeconds(target - (await nowSeconds()));
  });

  it("[bankrun] a vote takes custody of the stake and locks it for the epoch", async () => {
    votedEpoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    // VOTE_WEIGHT_CAP_BPS caps any address at 30% of total_hi_sola. This wallet is the only
    // staker, so the global cap binds against its own stake: voting the full balance is
    // refused with VoteOverflow. Vote exactly the cap — the escrow then covers that share,
    // and the rest stays liquid in the wallet.
    votedWeight = (stakedAmount * BigInt(3000)) / BigInt(10000);
    assert.isAbove(Number(votedWeight), 0, "the capped weight must be non-zero");
    const epochLE = Buffer.alloc(8);
    epochLE.writeBigUInt64LE(BigInt(votedEpoch));
    const poolId = Keypair.generate().publicKey;

    await program.methods
      .voteGauge(new BN(votedEpoch), new BN(votedWeight.toString()))
      .accounts({
        user: payer.publicKey,
        poolId,
        protocolState: statePda,
        hiSolaMint: hiSolaM,
        marketVault: marketV,
        userHiSola,
        voteEscrowVault,
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

    assert.equal(
      await tokenBalance(userHiSola),
      stakedAmount - votedWeight,
      "exactly the voted weight leaves the wallet; the rest stays liquid"
    );
    const pos = await program.account.userPosition.fetch(userPosition);
    assert.equal(
      pos.voteEscrowed.toString(),
      votedWeight.toString(),
      "the voted weight is under program custody"
    );
    assert.equal(
      pos.escrowEpoch.toString(),
      votedEpoch.toString(),
      "the escrow is stamped with the epoch it backs"
    );
  });

  it("[bankrun] release is refused while the voted epoch is still running", async () => {
    // Move time forward, but stay inside the epoch: proves the guard keys on the epoch
    // boundary and not merely on "some time has passed".
    await forwardSeconds(60 * 60 * 24); // one day
    assert.equal(
      Math.floor((await nowSeconds()) / EPOCH_DURATION),
      votedEpoch,
      "a day later we must still be inside the voted epoch for this test to mean anything"
    );

    await expectFailure(() => attemptWithdraw(1), "VoteEscrowLocked");

    assert.equal(
      await tokenBalance(userHiSola),
      stakedAmount - votedWeight,
      "the refused withdrawal returned nothing"
    );
  });

  it("[bankrun] release succeeds once the epoch has ended — the path a validator cannot reach", async () => {
    // Cross the boundary. This is the assertion the main suite has never been able to make.
    await forwardSeconds(EPOCH_DURATION);
    const nowEpoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    assert.isAbove(
      nowEpoch,
      votedEpoch,
      "the clock must have crossed into a later epoch"
    );

    const vaultBefore = await tokenBalance(voteEscrowVault);
    assert.equal(
      vaultBefore,
      votedWeight,
      "the escrow vault still holds the voted weight"
    );

    await attemptWithdraw(2);

    assert.equal(
      await tokenBalance(userHiSola),
      stakedAmount,
      "the whole stake is back in the wallet"
    );
    assert.equal(
      await tokenBalance(voteEscrowVault),
      BigInt(0),
      "the escrow vault is drained of this user's stake"
    );

    const pos = await program.account.userPosition.fetch(userPosition);
    assert.equal(
      pos.voteEscrowed.toString(),
      "0",
      "the escrow counter is cleared, so a second withdrawal has nothing to take"
    );
  });

  it("[bankrun] a released escrow cannot be withdrawn twice", async () => {
    await expectFailure(() => attemptWithdraw(3), "NothingEscrowed");
  });

  it("[bankrun] releasing the collateral does not erase the votes it backed", async () => {
    // The instruction's own comment claims the tally is immutable once the epoch closes.
    // Worth asserting: if releasing collateral rolled back gauge weight, a voter could vote,
    // wait a week, withdraw, and quietly undo the emissions their vote directed.
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
