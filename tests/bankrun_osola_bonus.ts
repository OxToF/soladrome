// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// # What the oSOLA burn bonus actually buys
//
// `vote_gauge` documents the bonus as **"additive and uncapped"**:
//
//     // ── 30% per-address cap applies only to hiSOLA governance power ─────
//     // oSOLA burn bonus is additive and uncapped: burning oSOLA is a
//     // deflationary act (permanent value destruction) that earns extra
//     // influence for the current epoch only.
//
// It is neither, and this file pins what it is instead. Two limits are applied to a vote, in
// two different places, and only the first one knows about the bonus:
//
//   power cap  (vote_gauge)         new_total <= min(snapshot, 30% global) + o_sola_bonus
//   backing    (lock_vote_backing)  new_total - ve_power_snapshot <= hi_sola
//
// The second has no bonus term, so the real ceiling on a wallet's cumulative votes is
// `hi_sola + ve_power_snapshot` — exactly the power it had *before* burning anything. The
// bonus can therefore only ever reclaim ground the 30% global cap took away, and it does
// nothing at all once that cap stops binding.
//
// That matters because the burn is irreversible. A holder who burns oSOLA while the global
// cap is slack destroys the tokens and receives no vote for them, with no guard and no
// refund: `burn_o_sola_for_votes` accepts the burn without ever consulting the limit that
// will actually refuse the vote.
//
// The two tests below are ordered to isolate the variable. Test 1 runs with a single staker,
// where 30% of `total_hi_sola` is well under the staker's own balance and the cap bites.
// Test 2 adds a much larger second staker so the global cap stops binding, and re-runs the
// same sequence in a fresh epoch.

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
const VOTE_WEIGHT_CAP_BPS = 3_000n; // 30% — lib.rs

describe("soladrome — bankrun (oSOLA burn bonus)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: anchor.Program<any>;
  let payer: Keypair;
  let idlJson: any;

  let usdcMint: PublicKey;
  let statePda: PublicKey;
  let solaM: PublicKey;
  let oSolaM: PublicKey;
  let floorV: PublicKey;
  let marketV: PublicKey;
  let solaVault: PublicKey;

  let userUsdc: PublicKey;
  let userSola: PublicKey;
  let userOSola: PublicKey;
  let userPosition: PublicKey;

  /// The payer's hiSOLA balance — the figure the backing check compares against.
  let stake: bigint;

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

  /// Resolve an error code through the IDL rather than pinning a hex literal, so renumbering
  /// the enum cannot leave this test asserting the wrong guard while still passing.
  function errorCode(name: string): number {
    const entry = idlJson.errors.find((e: any) => e.name === name);
    assert.isDefined(entry, `no such error in the IDL: ${name}`);
    return entry.code;
  }

  /// Unlike the `banksClient` path in tests/bankrun.ts, these calls go through `.rpc()`, so
  /// Anchor translates the error and the message carries the NAME and the decimal code —
  /// never the raw `0x…`. Accept either form so the helper survives a call being switched
  /// between the two transports.
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
      assert.isTrue(
        hit,
        `expected ${name} (${code} / 0x${code.toString(16)}), got: ${msg}`
      );
    }
  }

  async function currentEpoch(): Promise<number> {
    return Math.floor((await nowSeconds()) / EPOCH_DURATION);
  }

  /// Fund a fresh wallet, buy SOLA, stake it, then ve-lock the WHOLE balance.
  ///
  /// Leaves `hi_sola == 0` and `ve_power > 0`, which is the shape that isolates the snapshot
  /// gap in test 3: every unit such a wallet votes has to come from the ve credit, so if that
  /// credit is missing the vote cannot be cast at all.
  async function makeLocker(usdcIn: number) {
    const kp = Keypair.generate();
    const usdc = getAssociatedTokenAddressSync(usdcMint, kp.publicKey);
    const sola = getAssociatedTokenAddressSync(solaM, kp.publicKey);
    const pos = pda([Buffer.from("position"), kp.publicKey.toBuffer()]);
    const lock = pda([Buffer.from("velock"), kp.publicKey.toBuffer()]);
    const oSola = getAssociatedTokenAddressSync(oSolaM, kp.publicKey);

    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: kp.publicKey,
        lamports: 2_000_000_000,
      }),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        usdc,
        kp.publicKey,
        usdcMint
      ),
      createMintToInstruction(usdcMint, usdc, payer.publicKey, usdcIn),
    ]);

    await program.methods
      .buySola(new BN(usdcIn), new BN(1))
      .accounts({
        user: kp.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        userUsdc: usdc,
        userSola: sola,
        floorVault: floorV,
        marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([kp])
      .rpc();

    const bought = await tokenBalance(sola);
    await program.methods
      .stakeSola(new BN(bought.toString()))
      .accounts({
        user: kp.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        usdcMint,
        userUsdc: usdc,
        userSola: sola,
        solaVault,
        marketVault: marketV,
        userPosition: pos,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([kp])
      .rpc();

    const staked = BigInt(
      (await program.account.userPosition.fetch(pos)).hiSola.toString()
    );

    // Lock the lot, for the maximum duration so ve power is at its 4× ceiling.
    await program.methods
      .lockHiSola(new BN(staked.toString()), new BN(104 * EPOCH_DURATION))
      .accounts({
        user: kp.publicKey,
        protocolState: statePda,
        lockPosition: lock,
        marketVault: marketV,
        userPosition: pos,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([kp])
      .rpc();

    const after: any = await program.account.userPosition.fetch(pos);
    assert.equal(
      after.hiSola.toString(),
      "0",
      "the locker must hold no spendable hiSOLA — the whole point of the shape"
    );

    return { kp, usdc, sola, oSola, pos, lock };
  }

  /// Mint oSOLA to the payer through the ecosystem budget, then burn it for vote bonus.
  /// Mint oSOLA to the payer through the ecosystem budget. Split out from the burn so a
  /// REFUSED burn can be observed: the tokens have to already be in the wallet for
  /// "nothing was destroyed" to mean anything.
  async function mintOSola(amount: bigint) {
    await program.methods
      .distributeOSola(new BN(amount.toString()))
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
  }

  /// Burn oSOLA the payer already holds, for vote bonus.
  async function burnOnly(amount: bigint, epoch: number) {
    return program.methods
      .burnOSolaForVotes(new BN(amount.toString()), new BN(epoch))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        oSolaMint: oSolaM,
        userOSola,
        userPosition,
        // No ve lock: SystemProgram is the documented "absent lock" placeholder.
        lockPosition: SystemProgram.programId,
        userEpochVotes: pda([
          Buffer.from("uev"),
          payer.publicKey.toBuffer(),
          epochLE(epoch),
        ]),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
  }

  /// Mint then burn — the happy path.
  async function burnForBonus(amount: bigint, epoch: number) {
    await mintOSola(amount);
    await burnOnly(amount, epoch);
  }

  /// Cast a gauge vote for a fresh pool label, so `UserVoteReceipt`'s one-shot `init` never
  /// gets in the way of asserting the cap.
  async function vote(poolId: PublicKey, epoch: number, weight: bigint) {
    return program.methods
      .voteGauge(new BN(epoch), new BN(weight.toString()))
      .accounts({
        user: payer.publicKey,
        poolId,
        protocolState: statePda,
        marketVault: marketV,
        userPosition,
        lockPosition: SystemProgram.programId,
        gaugeState: pda([
          Buffer.from("gauge"),
          poolId.toBuffer(),
          epochLE(epoch),
        ]),
        userVoteReceipt: pda([
          Buffer.from("vote"),
          payer.publicKey.toBuffer(),
          poolId.toBuffer(),
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

  /// Burn oSOLA on behalf of an arbitrary wallet holding a ve lock.
  async function burnForBonusAs(
    who: { kp: Keypair; oSola: PublicKey; pos: PublicKey; lock: PublicKey },
    amount: bigint,
    epoch: number
  ) {
    await program.methods
      .distributeOSola(new BN(amount.toString()))
      .accounts({
        authority: payer.publicKey,
        recipient: who.kp.publicKey,
        protocolState: statePda,
        oSolaMint: oSolaM,
        recipientOSola: who.oSola,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    await program.methods
      .burnOSolaForVotes(new BN(amount.toString()), new BN(epoch))
      .accounts({
        user: who.kp.publicKey,
        protocolState: statePda,
        oSolaMint: oSolaM,
        userOSola: who.oSola,
        userPosition: who.pos,
        lockPosition: who.lock,
        userEpochVotes: pda([
          Buffer.from("uev"),
          who.kp.publicKey.toBuffer(),
          epochLE(epoch),
        ]),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([who.kp])
      .rpc();
  }

  /// Cast a gauge vote on behalf of an arbitrary wallet holding a ve lock.
  async function voteAs(
    who: { kp: Keypair; pos: PublicKey; lock: PublicKey },
    poolId: PublicKey,
    epoch: number,
    weight: bigint
  ) {
    return program.methods
      .voteGauge(new BN(epoch), new BN(weight.toString()))
      .accounts({
        user: who.kp.publicKey,
        poolId,
        protocolState: statePda,
        marketVault: marketV,
        userPosition: who.pos,
        lockPosition: who.lock,
        gaugeState: pda([
          Buffer.from("gauge"),
          poolId.toBuffer(),
          epochLE(epoch),
        ]),
        userVoteReceipt: pda([
          Buffer.from("vote"),
          who.kp.publicKey.toBuffer(),
          poolId.toBuffer(),
          epochLE(epoch),
        ]),
        userEpochVotes: pda([
          Buffer.from("uev"),
          who.kp.publicKey.toBuffer(),
          epochLE(epoch),
        ]),
        globalEpochVotes: pda([Buffer.from("epoch_votes"), epochLE(epoch)]),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([who.kp])
      .rpc();
  }

  async function globalCap(): Promise<bigint> {
    const st: any = await program.account.protocolState.fetch(statePda);
    return (BigInt(st.totalHiSola.toString()) * VOTE_WEIGHT_CAP_BPS) / 10_000n;
  }

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

    // voting + curve; `burn_o_sola_for_votes` is gated on voting_enabled too.
    await program.methods
      .setPhaseFlags(null, null, true, null, true, null)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    userUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
    userSola = getAssociatedTokenAddressSync(solaM, payer.publicKey);
    userOSola = getAssociatedTokenAddressSync(oSolaM, payer.publicKey);

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

    // buy → stake, so the payer holds real, financed hiSOLA to back a vote with.
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

    stake = BigInt(
      (await program.account.userPosition.fetch(userPosition)).hiSola.toString()
    );
    assert.isAbove(Number(stake), 0, "the voter must hold real hiSOLA");

    // Park the clock one hour into a FRESH epoch, so neither test can straddle a boundary
    // depending on the day it is run.
    const target = ((await currentEpoch()) + 1) * EPOCH_DURATION + 3600;
    await forwardSeconds(target - (await nowSeconds()));
  });
  // ── 1. While the 30% global cap binds, the burn buys a real lift ───────────
  //
  // The half the old doc comment got right, and why the defect was easy to miss: on a young
  // protocol with few stakers the bonus visibly works. `total_hi_sola` is just this one
  // staker, so 30% of it sits far below their own balance and the cap is what refuses — the
  // burn lifts the vote off that cap, up to the backing ceiling and not one unit further.
  it("[bonus] the burn lifts a vote above the 30% global cap, up to the backing ceiling", async () => {
    const epoch = await currentEpoch();
    const cap = await globalCap();
    assert.isTrue(
      cap < stake,
      `the global cap (${cap}) must bite below the staker's own balance (${stake}) ` +
        `for this test to be about the bonus at all`
    );

    // The usable margin, computed exactly as `burn_o_sola_for_votes` does:
    //   usable = (hi_sola + ve_snapshot) - min(power_snapshot, global_cap)
    // No ve lock on this wallet, and no vote yet, so ve_snapshot = 0 and snapshot = stake.
    const usable = stake - cap;
    assert.isTrue(usable > 0n, "there must be ground for the burn to reclaim");

    await burnForBonus(usable, epoch);
    const uev: any = await program.account.userEpochVotes.fetch(
      pda([Buffer.from("uev"), payer.publicKey.toBuffer(), epochLE(epoch)])
    );
    assert.equal(
      uev.oSolaBonus.toString(),
      usable.toString(),
      "the whole usable margin was accepted"
    );

    // ── One unit past the margin is refused, and nothing is destroyed ────────
    // This is the guard: the burn is irreversible, and the limit that decides whether the
    // bonus is usable lives in a different instruction. Before it, this call succeeded and
    // the oSOLA was gone for votes that could never be cast.
    const oSolaBefore = await tokenBalance(userOSola);
    await mintOSola(1_000_000n);
    await expectFailure(
      () => burnOnly(1_000_000n, epoch),
      "BurnBuysNoVotes"
    );
    assert.equal(
      await tokenBalance(userOSola),
      oSolaBefore + 1_000_000n,
      "the refused burn destroyed nothing — the oSOLA is still in the wallet"
    );

    // And the lift is real: the wallet now votes its full balance, well past the 30% cap.
    await vote(Keypair.generate().publicKey, epoch, stake);
    const after: any = await program.account.userEpochVotes.fetch(
      pda([Buffer.from("uev"), payer.publicKey.toBuffer(), epochLE(epoch)])
    );
    assert.equal(after.allocated.toString(), stake.toString(), "the whole balance was cast");
    assert.isTrue(
      BigInt(after.allocated.toString()) > cap,
      "and it exceeded the 30% global cap — that lift is what the burn paid for"
    );

    // One more unit is refused. Note WHICH guard fires: burning exactly the usable margin
    // raises the power cap to `min(snapshot, cap) + bonus = cap + (stake - cap) = stake`,
    // which is precisely the backing ceiling too. The two coincide, and `vote_gauge` checks
    // its own cap first, so `VoteOverflow` wins the race. Buying MORE bonus could not change
    // that — which is the whole reason the burn beyond this point is refused outright.
    await expectFailure(
      () => vote(Keypair.generate().publicKey, epoch, 1n),
      "VoteOverflow"
    );
    const pos: any = await program.account.userPosition.fetch(userPosition);
    assert.equal(
      pos.voteLocked.toString(),
      stake.toString(),
      "every unit voted is backed by an immobilised unit of hiSOLA"
    );
  });

  // ── 2. A ve locker's burn records the ve half of the snapshot ──────────────
  //
  // `burn_o_sola_for_votes` was the only one of the three `UserEpochVotes` initialisers that
  // did not set `ve_power_snapshot`, and because it stamps `uev.epoch` it also disarmed the
  // `if epoch == 0` block in `vote_gauge` for the rest of the epoch. The snapshot stayed 0,
  // `lock_vote_backing` computed `required = new_total - 0`, and a locker who burned before
  // voting had to back the ve-funded part of their vote with liquid hiSOLA they did not have.
  // A wallet holding nothing but a lock could not vote at all — burning STRICTLY REDUCED its
  // capacity. Predates the ledger refactor; the same four write sites exist in the branch base.
  //
  // Runs before the whale joins, while the global cap is still tight enough to leave a usable
  // margin — otherwise the guard from test 1 refuses the burn and this path is unreachable.
  it("[bonus] a ve locker's burn records ve_power_snapshot, so the ve credit survives", async () => {
    const epoch = await currentEpoch();
    const locker = await makeLocker(60_000_000);

    const lockAcc: any = await program.account.veLockPosition.fetch(locker.lock);
    assert.isTrue(
      BigInt(lockAcc.amountLocked.toString()) > 0n,
      "the locker must hold real ve-locked hiSOLA"
    );

    // hi_sola = 0 and ve = P, so the burn's usable margin is `P - min(P, cap)`. Locking took
    // the balance out of `total_hi_sola`, so the cap is computed on the others' stake.
    const cap = await globalCap();
    await burnForBonusAs(locker, 1_000_000n, epoch);

    const uev: any = await program.account.userEpochVotes.fetch(
      pda([Buffer.from("uev"), locker.kp.publicKey.toBuffer(), epochLE(epoch)])
    );
    const veSnapshot = BigInt(uev.vePowerSnapshot.toString());
    assert.isTrue(
      veSnapshot > 0n,
      "THE FIX: the burn must record ve_power_snapshot. It used to leave it at 0 while " +
        "stamping `epoch`, which stopped vote_gauge filling it in later — so the locker's " +
        "entire ve credit vanished for the epoch."
    );
    assert.equal(
      uev.totalPowerSnapshot.toString(),
      veSnapshot.toString(),
      "with hi_sola = 0 the two snapshots coincide: all of this wallet's power is ve power"
    );

    // The consequence, end to end: a wallet with ZERO spendable hiSOLA votes on ve power
    // alone, after burning. Under the defect this call failed with InsufficientVoteBacking.
    const pos: any = await program.account.userPosition.fetch(locker.pos);
    assert.equal(pos.hiSola.toString(), "0", "no spendable balance to fall back on");
    await voteAs(locker, Keypair.generate().publicKey, epoch, 1_000n);
    const after: any = await program.account.userEpochVotes.fetch(
      pda([Buffer.from("uev"), locker.kp.publicKey.toBuffer(), epochLE(epoch)])
    );
    assert.equal(
      after.allocated.toString(),
      "1000",
      "the vote landed on ve power that the burn no longer throws away"
    );
    assert.isTrue(cap >= 0n, "cap read for the record");
  });

  // ── 3. Once the cap goes slack, every burn is refused ──────────────────────
  //
  // The steady state of any protocol with enough stakers: 30% of `total_hi_sola` exceeds one
  // wallet's balance, the global cap is slack, and there is no ground for the bonus to
  // reclaim. `usable` is 0 and the guard refuses every burn, whatever its size.
  //
  // Worth stating plainly rather than discovering later: this makes
  // `burn_o_sola_for_votes` an instruction that refuses almost every call in steady state.
  // That is the honest behaviour — it fails loudly instead of eating funds — but it is also
  // the strongest argument for removing the instruction outright once the audit scope is
  // settled. The guard makes the feature's deadness visible; it does not revive it.
  it("[bonus] with the global cap slack, every burn is refused and no oSOLA is destroyed", async () => {
    // A second, much larger staker: 30% of the new total must exceed the payer's balance.
    const whale = Keypair.generate();
    const whaleUsdc = getAssociatedTokenAddressSync(usdcMint, whale.publicKey);
    const whaleSola = getAssociatedTokenAddressSync(solaM, whale.publicKey);
    const whalePos = pda([Buffer.from("position"), whale.publicKey.toBuffer()]);

    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: whale.publicKey,
        lamports: 2_000_000_000,
      }),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        whaleUsdc,
        whale.publicKey,
        usdcMint
      ),
      createMintToInstruction(usdcMint, whaleUsdc, payer.publicKey, 900_000_000),
    ]);

    await program.methods
      .buySola(new BN(900_000_000), new BN(1))
      .accounts({
        user: whale.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        userUsdc: whaleUsdc,
        userSola: whaleSola,
        floorVault: floorV,
        marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([whale])
      .rpc();

    const whaleBought = await tokenBalance(whaleSola);
    await program.methods
      .stakeSola(new BN(whaleBought.toString()))
      .accounts({
        user: whale.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        usdcMint,
        userUsdc: whaleUsdc,
        userSola: whaleSola,
        solaVault,
        marketVault: marketV,
        userPosition: whalePos,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([whale])
      .rpc();

    // A fresh epoch, so `UserEpochVotes` (allocation AND bonus) starts clean.
    await forwardSeconds(EPOCH_DURATION);
    const epoch = await currentEpoch();

    const cap = await globalCap();
    assert.isTrue(
      cap > stake,
      `30% of total_hi_sola (${cap}) must now exceed the payer's balance (${stake}), ` +
        `otherwise this is a rerun of test 1`
    );

    // usable = stake - min(stake, cap) = 0. Size is irrelevant: try a huge one and one unit.
    const huge = stake * 5n;
    await mintOSola(huge);
    const held = await tokenBalance(userOSola);
    await expectFailure(() => burnOnly(huge, epoch), "BurnBuysNoVotes");
    await expectFailure(() => burnOnly(1n, epoch), "BurnBuysNoVotes");
    assert.equal(
      await tokenBalance(userOSola),
      held,
      "not one unit was destroyed — the whole point of refusing instead of accepting"
    );

    // No UserEpochVotes was opened either: the refusal rolls the whole transaction back.
    // Read through banksClient — Anchor's bankrun proxy throws on a missing account rather
    // than returning null, so `fetchNullable` is not usable for an absence assertion here.
    assert.isNull(
      await context.banksClient.getAccount(
        pda([Buffer.from("uev"), payer.publicKey.toBuffer(), epochLE(epoch)])
      ),
      "a refused burn leaves no epoch tracker behind"
    );

    // And the wallet still votes exactly its stake, as it always could — the bonus was never
    // going to add anything here, which is why buying it had to be refused.
    await vote(Keypair.generate().publicKey, epoch, stake);
    // Again `VoteOverflow` rather than `InsufficientVoteBacking`: with no bonus at all the
    // power cap is `min(stake, cap) = stake`, the same figure as the backing ceiling, and
    // `vote_gauge` tests its own cap first. The two guards agree on the number here — which
    // is exactly what "the bonus adds nothing in steady state" means.
    await expectFailure(
      () => vote(Keypair.generate().publicKey, epoch, 1n),
      "VoteOverflow"
    );
  });
});
