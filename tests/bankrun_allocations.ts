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
  ///
  /// The slot bump is not cosmetic. Bankrun does not advance the slot between transactions, so
  /// the blockhash never moves and two byte-identical calls — `claimPartnerAllocation()` twice,
  /// which takes no arguments — collide in the status cache and the second is rejected as
  /// already processed rather than reaching the program. Warping first, then re-applying the
  /// clock so the override wins, keeps time and slot moving together.
  async function forwardSeconds(seconds: number) {
    const before = await context.banksClient.getClock();
    const target = before.unixTimestamp + BigInt(seconds);
    const slot = await context.banksClient.getSlot();
    context.warpToSlot(slot + BigInt(1));
    const after = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        after.slot,
        after.epochStartTimestamp,
        after.epoch,
        after.leaderScheduleEpoch,
        target
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
  const partnerPda = (o: PublicKey) =>
    pda([Buffer.from("partner"), o.toBuffer()]);

  const le8 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };

  async function lamportsOf(key: PublicKey): Promise<bigint> {
    const raw = await context.banksClient.getAccount(key);
    return raw ? BigInt(raw.lamports) : BigInt(0);
  }

  async function accountExists(key: PublicKey): Promise<boolean> {
    const raw = await context.banksClient.getAccount(key);
    // A closed Anchor account is defunded and reassigned to the System Program; bankrun
    // reports it as absent. Either shape means "gone" — never trust `data.length` alone.
    return raw !== null && raw.lamports > 0;
  }

  /// A funded wallet with nothing but lamports — every partner test starts from one.
  async function fundedWallet(): Promise<Keypair> {
    const kp = Keypair.generate();
    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: kp.publicKey,
        lamports: 5_000_000_000,
      }),
    ]);
    return kp;
  }

  /// `scheduleEpochs` is the rhythm, fixed at registration: fund_partner_bribe_stream refuses
  /// any other length, and refuses a schedule too small to deliver `cap`. The tests below use
  /// 4 epochs and size their streams to reach the cap exactly.
  async function registerPartnerFor(
    wallet: PublicKey,
    base: BN,
    cap: BN,
    scheduleEpochs = 4
  ): Promise<void> {
    await program.methods
      .registerPartner(
        usdcMint, // committed bribe mint
        new BN(1), // rate 1:1 — one bribe unit buys one hiSOLA, up to the cap
        new BN(1),
        cap,
        base,
        new BN(MIN_LOCK_DURATION),
        new BN(scheduleEpochs)
      )
      .accounts({
        authority: payer.publicKey,
        protocolState: statePda,
        partnerWallet: wallet,
        partnerAllocation: partnerPda(wallet),
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
  }

  function closePartner(wallet: PublicKey, authority: PublicKey) {
    return program.methods
      .closePartnerAllocation()
      .accounts({
        authority,
        protocolState: statePda,
        partnerWallet: wallet,
        partnerAllocation: partnerPda(wallet),
      } as any);
  }

  /// Give the partner USDC and route it through `partner_deposit_bribe`, which is the ONLY
  /// way `total_bribed_credited` ever moves — credit is atomic with a real transfer.
  async function partnerBribes(partner: Keypair, amount: BN): Promise<void> {
    const ata = getAssociatedTokenAddressSync(usdcMint, partner.publicKey);
    if (!(await accountExists(ata))) {
      await send([
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          ata,
          partner.publicKey,
          usdcMint
        ),
      ]);
    }
    await send([
      createMintToInstruction(
        usdcMint,
        ata,
        payer.publicKey,
        BigInt(amount.toString())
      ),
    ]);

    const epoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    const poolId = bribePool.publicKey;
    await program.methods
      .partnerDepositBribe(new BN(epoch), amount)
      .accounts({
        partner: partner.publicKey,
        protocolState: statePda,
        partnerAllocation: partnerPda(partner.publicKey),
        poolId,
        rewardMint: usdcMint,
        partnerToken: ata,
        bribeVault: pda([
          Buffer.from("bribe_vault"),
          poolId.toBuffer(),
          usdcMint.toBuffer(),
          le8(epoch),
        ]),
        bribeTokenVault: pda([
          Buffer.from("bribe_tokens"),
          poolId.toBuffer(),
          usdcMint.toBuffer(),
          le8(epoch),
        ]),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([partner])
      .rpc();
  }

  function claimPartner(partner: Keypair) {
    return program.methods
      .claimPartnerAllocation()
      .accounts({
        partner: partner.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        solaVault,
        marketVault: marketV,
        partnerAllocation: partnerPda(partner.publicKey),
        lockPosition: velockPda(partner.publicKey),
        partnerPosition: positionPda(partner.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([partner]);
  }

  /// A label, not a real pool — `pool_id` is an UncheckedAccount on the bribe path.
  const bribePool = Keypair.generate();

  const streamPda = (o: PublicKey) =>
    pda([Buffer.from("bribe_stream"), o.toBuffer()]);
  const streamVaultPda = (o: PublicKey) =>
    pda([Buffer.from("stream_tokens"), o.toBuffer()]);

  /// `bribes_enabled` is off at initialize. Read before writing: calling set_phase_flags
  /// twice with identical arguments would be a byte-identical transaction, and bankrun does
  /// not advance the blockhash between calls, so the second is rejected as already processed.
  async function ensureBribesEnabled() {
    const st: any = await program.account.protocolState.fetch(statePda);
    if (st.bribesEnabled) return;
    await program.methods
      .setPhaseFlags(null, true, null, null, null, null)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();
  }

  async function fundUsdc(owner: PublicKey, amount: BN) {
    const ata = getAssociatedTokenAddressSync(usdcMint, owner);
    if (!(await accountExists(ata))) {
      await send([
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          ata,
          owner,
          usdcMint
        ),
      ]);
    }
    await send([
      createMintToInstruction(
        usdcMint,
        ata,
        payer.publicKey,
        BigInt(amount.toString())
      ),
    ]);
    return ata;
  }

  /// Escrow a whole schedule in one signature. This is also what opens the welcome bag —
  /// `stream_start_ts` is stamped here and `base_hi_sola` vests from it, so most of the
  /// partner tests above now have to call this before a claim mints anything at all.
  async function fundStream(
    partner: Keypair,
    epochs: number,
    perEpoch: BN
  ): Promise<void> {
    await ensureBribesEnabled();
    const ata = await fundUsdc(partner.publicKey, perEpoch.muln(epochs));
    await program.methods
      .fundPartnerBribeStream(new BN(epochs), perEpoch)
      .accounts({
        partner: partner.publicKey,
        protocolState: statePda,
        partnerAllocation: partnerPda(partner.publicKey),
        poolId: bribePool.publicKey,
        bribeMint: usdcMint,
        partnerToken: ata,
        bribeStream: streamPda(partner.publicKey),
        streamVault: streamVaultPda(partner.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([partner])
      .rpc();
  }

  /// Crank one tranche. `caller` defaults to the payer — passing a different one both proves
  /// the instruction is permissionless and keeps an otherwise byte-identical retry distinct.
  async function releaseTranche(partner: PublicKey, caller?: Keypair) {
    const epoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    const poolId = bribePool.publicKey;
    return program.methods
      .releasePartnerBribe(new BN(epoch))
      .accounts({
        caller: caller ? caller.publicKey : payer.publicKey,
        protocolState: statePda,
        partner,
        bribeStream: streamPda(partner),
        partnerAllocation: partnerPda(partner),
        streamVault: streamVaultPda(partner),
        poolId,
        rewardMint: usdcMint,
        bribeVault: pda([
          Buffer.from("bribe_vault"),
          poolId.toBuffer(),
          usdcMint.toBuffer(),
          le8(epoch),
        ]),
        bribeTokenVault: pda([
          Buffer.from("bribe_tokens"),
          poolId.toBuffer(),
          usdcMint.toBuffer(),
          le8(epoch),
        ]),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .signers(caller ? [caller] : [])
      .rpc();
  }

  const bribeTokenVaultAt = (epoch: number) =>
    pda([
      Buffer.from("bribe_tokens"),
      bribePool.publicKey.toBuffer(),
      usdcMint.toBuffer(),
      le8(epoch),
    ]);



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
        new BN(MIN_LOCK_DURATION),
        new BN(4) // the bribe rhythm, now a term of the deal rather than the partner's pick
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

    // ☢️ The bag no longer vests from registration — it vests from the moment the partner
    // escrows a bribe schedule. Without this call `base_vested` stays 0 and the claim below
    // fails with NothingToClaim. The gift is now the consideration for the commitment.
    await fundStream(partner, 4, ONE.divn(4));

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

  // ── close_partner_allocation ──────────────────────────────────────────────
  //
  // The instruction reclaims 168 bytes of rent, so the temptation is to read it as
  // housekeeping and test only the happy path. The part worth proving is the refusal:
  // `close = authority` deletes an account that carries a partner's still-claimable
  // entitlement, and the two terminal states are the entire thing standing between
  // "reclaim rent on a finished deal" and "the authority can revoke what a partner
  // earned". The four refusal tests below are the load-bearing ones.

  const ONE = new BN(1_000_000);
  const settling = Keypair.generate();

  it("[partner] a half-claimed allocation refuses to close — earned entitlement outlives the authority", async () => {
    const partner = await fundedWallet();
    const alloc = partnerPda(partner.publicKey);
    await registerPartnerFor(partner.publicKey, ONE, ONE);
    await fundStream(partner, 4, ONE.divn(4));

    // Take a slice of the bag, then stop. `hi_sola_claimed > 0` disqualifies the
    // never-activated path, and the bribe cap was never reached so the settled path is
    // out too — the partner is mid-deal and stays that way.
    await forwardSeconds(BASE_BAG_VEST_SECS / 2);
    await claimPartner(partner).rpc();

    const pa: any = await program.account.partnerAllocation.fetch(alloc);
    assert.isTrue(
      pa.hiSolaClaimed.toNumber() > 0,
      "the partner must actually have taken something for this test to mean anything"
    );
    assert.isTrue(
      pa.hiSolaClaimed.lt(ONE.add(ONE)),
      "and must be short of base + cap, or it would be legitimately settled"
    );

    await expectFailure(
      () => closePartner(partner.publicKey, payer.publicKey).rpc(),
      "PartnerAllocationNotSettled"
    );
    assert.isTrue(
      await accountExists(alloc),
      "the refused close took nothing — the allocation is still there to be claimed against"
    );
  });

  it("[partner] an unmet bribe commitment keeps the account open even with the bag fully claimed", async () => {
    // The other half of the settled test, and the case that decides the design: a partner
    // who took the whole welcome bag but never delivered the bribes they committed to.
    // `bribe_earned` never reaches `cap_hi_sola`, so hiSOLA is still owed and the authority
    // cannot tidy the account away. A dead partnership leaves 168 bytes on-chain — that is
    // the price of the guarantee, and it is the right way round.
    const partner = await fundedWallet();
    const alloc = partnerPda(partner.publicKey);
    await registerPartnerFor(partner.publicKey, ONE, ONE);
    await fundStream(partner, 4, ONE.divn(4));

    await forwardSeconds(BASE_BAG_VEST_SECS + DAY);
    await claimPartner(partner).rpc();

    const pa: any = await program.account.partnerAllocation.fetch(alloc);
    assert.equal(
      pa.hiSolaClaimed.toString(),
      ONE.toString(),
      "the whole bag is claimed, and nothing more — the partner never bribed"
    );
    await expectFailure(
      () => closePartner(partner.publicKey, payer.publicKey).rpc(),
      "PartnerAllocationNotSettled"
    );
    assert.isTrue(await accountExists(alloc));
  });

  it("[partner] a registration nobody ever activated is cancellable, rent back to the authority", async () => {
    const partner = await fundedWallet();
    const alloc = partnerPda(partner.publicKey);
    await registerPartnerFor(partner.publicKey, ONE, ONE);

    // Time passes and the bag accrues — but accrual is not activation. Nothing has been
    // claimed and nothing has been bribed, so there is no earned position to protect.
    await forwardSeconds(90 * DAY);
    const pa: any = await program.account.partnerAllocation.fetch(alloc);
    assert.equal(pa.hiSolaClaimed.toString(), "0");
    assert.equal(pa.totalBribedCredited.toString(), "0");

    const rentHeld = await lamportsOf(alloc);
    assert.isTrue(rentHeld > BigInt(0), "the PDA holds rent worth reclaiming");
    const authorityBefore = await lamportsOf(payer.publicKey);

    await closePartner(partner.publicKey, payer.publicKey).rpc();

    assert.isFalse(await accountExists(alloc), "the allocation is gone");
    const gained =
      (await lamportsOf(payer.publicKey)) - authorityBefore;
    // Exactly the rent, less this transaction's fee — the authority paid it at
    // register_partner and is the only account that gets it back.
    assert.isTrue(
      gained > rentHeld - BigInt(100_000) && gained <= rentHeld,
      `authority should recover ~${rentHeld} lamports, got ${gained}`
    );

    // And the partner keeps nothing they never had: no lock was ever opened for them.
    assert.isFalse(
      await accountExists(velockPda(partner.publicKey)),
      "a partner who never claimed has no ve position to lose"
    );
  });

  it("[partner] the authority signature is the whole gate — the partner cannot close their own", async () => {
    const partner = await fundedWallet();
    const alloc = partnerPda(partner.publicKey);
    await registerPartnerFor(partner.publicKey, ONE, ONE);

    // This allocation IS in a closable state (never activated). The only thing wrong with
    // the call below is who signs it, which is what makes the refusal meaningful.
    await expectFailure(
      () =>
        closePartner(partner.publicKey, partner.publicKey)
          .signers([partner])
          .rpc(),
      "Unauthorized"
    );
    assert.isTrue(await accountExists(alloc));

    await closePartner(partner.publicKey, payer.publicKey).rpc();
    assert.isFalse(
      await accountExists(alloc),
      "same account, same state, authority signature — now it closes"
    );
  });

  it("[partner] one bribe is enough to take the cancellation away", async () => {
    await program.methods
      .setPhaseFlags(null, true, null, null, null, null)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: settling.publicKey,
        lamports: 5_000_000_000,
      }),
    ]);
    await registerPartnerFor(settling.publicKey, ONE, ONE);
    await fundStream(settling, 4, ONE.divn(4));

    // A quarter of the committed bribe. The partner has now performed — real tokens left
    // their wallet into the bribe vault and are already payable to voters — so the "never
    // activated" escape closes here, permanently, on `total_bribed_credited` alone.
    await partnerBribes(settling, ONE.divn(4));

    const pa: any = await program.account.partnerAllocation.fetch(
      partnerPda(settling.publicKey)
    );
    assert.equal(
      pa.hiSolaClaimed.toString(),
      "0",
      "nothing claimed — the refusal must come from the bribe half of the guard"
    );
    assert.equal(pa.totalBribedCredited.toString(), ONE.divn(4).toString());

    await expectFailure(
      () => closePartner(settling.publicKey, payer.publicKey).rpc(),
      "PartnerAllocationNotSettled"
    );
  });

  it("[partner] a fully settled deal closes — bag vested, bribe cap reached, everything claimed", async () => {
    const alloc = partnerPda(settling.publicKey);

    // Complete the commitment: at rate 1:1 the remaining three quarters put bribe_earned
    // at the cap, where further deposits would buy nothing (`min(cap, …)`).
    await partnerBribes(settling, ONE.divn(4).muln(3));
    await forwardSeconds(BASE_BAG_VEST_SECS + DAY);
    await claimPartner(settling).rpc();

    const pa: any = await program.account.partnerAllocation.fetch(alloc);
    assert.equal(
      pa.hiSolaClaimed.toString(),
      ONE.add(ONE).toString(),
      "base + cap, both delivered — the deal owes nothing more"
    );

    const rentHeld = await lamportsOf(alloc);
    const authorityBefore = await lamportsOf(payer.publicKey);
    await closePartner(settling.publicKey, payer.publicKey).rpc();
    assert.isFalse(await accountExists(alloc));
    assert.isTrue(
      (await lamportsOf(payer.publicKey)) - authorityBefore >
        rentHeld - BigInt(100_000)
    );

    // Closing is bookkeeping: the hiSOLA already minted stays exactly where it was.
    const lock: any = await program.account.veLockPosition.fetch(
      velockPda(settling.publicKey)
    );
    assert.equal(
      lock.amountLocked.toString(),
      ONE.add(ONE).toString(),
      "the ve lock is a separate PDA — closing the allocation burns nothing"
    );
    assert.equal(
      lock.permanentAmount.toString(),
      ONE.toString(),
      "and the welcome bag is still permanent, still unsellable"
    );
  });

  it("[partner] re-registering a closed wallet is a FRESH deal, bag and all", async () => {
    // The documented consequence of freeing the seeds, asserted rather than assumed: this
    // is the one path that hands the same wallet a second welcome bag. It costs a second
    // authority signature and both instructions are on-chain — but nothing in the program
    // remembers the first deal, so nobody should expect it to.
    const alloc = partnerPda(settling.publicKey);
    assert.isFalse(await accountExists(alloc), "closed by the previous test");

    // Renewed on new terms — a doubled bribe cap for the second term.
    await registerPartnerFor(settling.publicKey, ONE, ONE.muln(2));
    const pa: any = await program.account.partnerAllocation.fetch(alloc);
    assert.equal(
      pa.hiSolaClaimed.toString(),
      "0",
      "counters are zeroed — the 2 000 000 already locked is invisible to the new deal"
    );
    assert.equal(
      pa.totalBribedCredited.toString(),
      "0",
      "and last term's delivered bribes do not carry over toward the new cap"
    );
    assert.equal(pa.capHiSola.toString(), ONE.muln(2).toString());
    assert.equal(
      pa.startTs.toNumber(),
      await nowSeconds(),
      "the 6-month bag stream restarts from now — this is the second welcome bag"
    );

    // The already-locked hiSOLA from the first term is untouched by any of it.
    const lock: any = await program.account.veLockPosition.fetch(
      velockPda(settling.publicKey)
    );
    assert.equal(lock.amountLocked.toString(), ONE.add(ONE).toString());
  });

  // ── Partner bribe stream ──────────────────────────────────────────────────
  //
  // The instrument the partnership actually needed. partner_deposit_bribe can only credit the
  // epoch it is called in, so "300 a week for a year" was 52 signatures with a hole every time
  // one was missed — and the lock reset on every claim made honouring the schedule strictly
  // worse than dumping everything in week one. These cases pin the three properties that fix
  // that: the bag is earned rather than given, the payout is one tranche per epoch and cannot
  // be batched, and the lock term no longer moves.

  it("[stream] the welcome bag vests nothing until a schedule is escrowed", async () => {
    const partner = await fundedWallet();
    await registerPartnerFor(partner.publicKey, ONE, ONE);

    // Six months pass on the registration clock. Under the old rule this alone vested the
    // entire bag — permanent voting power for a partner who had committed nothing.
    await forwardSeconds(BASE_BAG_VEST_SECS + DAY);
    await expectFailure(
      () => claimPartner(partner).rpc(),
      "NothingToClaim"
    );
    const before: any = await program.account.partnerAllocation.fetch(
      partnerPda(partner.publicKey)
    );
    assert.equal(
      before.streamStartTs.toString(),
      "0",
      "no stream, no stamp — and the stamp is the gate"
    );

    // Escrowing the schedule opens it, and the 6 months just elapsed do NOT count: vesting
    // starts here, not at registration. Half the window later, half the bag.
    await fundStream(partner, 4, ONE.divn(4));
    await forwardSeconds(BASE_BAG_VEST_SECS / 2);
    await claimPartner(partner).rpc();

    const lock: any = await program.account.veLockPosition.fetch(
      velockPda(partner.publicKey)
    );
    const locked = BigInt(lock.amountLocked.toString());
    const half = BigInt(ONE.toString()) / BigInt(2);
    assert.isTrue(
      locked > (half * BigInt(95)) / BigInt(100) && locked <= half,
      `half the window must vest about half the bag, got ${locked}`
    );
    assert.equal(
      lock.permanentAmount.toString(),
      lock.amountLocked.toString(),
      "and all of it is the permanent bag — nothing was bribed yet"
    );
  });

  it("[stream] pays one tranche per epoch, cranked by anyone, into that epoch's bribe vault", async () => {
    const partner = await fundedWallet();
    const stranger = await fundedWallet();
    await registerPartnerFor(partner.publicKey, ONE, ONE);
    await fundStream(partner, 4, ONE.divn(4));

    const epoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    await releaseTranche(partner.publicKey);

    assert.equal(
      (await tokenBalance(bribeTokenVaultAt(epoch))).toString(),
      "250000",
      "the tranche must actually reach the vault this epoch's voters claim from"
    );
    const pa: any = await program.account.partnerAllocation.fetch(
      partnerPda(partner.publicKey)
    );
    assert.equal(
      pa.totalBribedCredited.toString(),
      "250000",
      "and credit the allocation exactly as a manual bribe would"
    );

    // Same epoch, different caller. The different signer is what makes this a distinct
    // transaction rather than a replay, so the refusal comes from the program.
    await expectFailure(
      () => releaseTranche(partner.publicKey, stranger),
      "BribeStreamAlreadyReleased"
    );

    // Next epoch, and a caller with no stake in the stream at all — that is the point of a
    // permissionless crank: the voters owed the money are never behind the partner's goodwill.
    await forwardSeconds(EPOCH_DURATION);
    await releaseTranche(partner.publicKey, stranger);
    const s2: any = await program.account.partnerBribeStream.fetch(
      streamPda(partner.publicKey)
    );
    assert.equal(s2.epochsReleased.toString(), "2");
  });

  it("[stream] a skipped epoch makes the schedule slip, never batch", async () => {
    const partner = await fundedWallet();
    await registerPartnerFor(partner.publicKey, ONE, ONE);
    await fundStream(partner, 4, ONE.divn(4));

    // Nobody cranks for three epochs. The whole point of the guard is that this backlog is
    // NOT paid out at once — batching it would re-concentrate the bribes into one epoch,
    // which is the failure the stream exists to prevent.
    await forwardSeconds(3 * EPOCH_DURATION);
    const epoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    await releaseTranche(partner.publicKey);

    assert.equal(
      (await tokenBalance(bribeTokenVaultAt(epoch))).toString(),
      "250000",
      "exactly one tranche moved, not the three that were owed"
    );
    const st: any = await program.account.partnerBribeStream.fetch(
      streamPda(partner.publicKey)
    );
    assert.equal(st.epochsReleased.toString(), "1");
    assert.equal(
      st.epochsTotal.toString(),
      "4",
      "nothing is lost either — the stream simply runs three epochs longer"
    );
  });

  it("[stream] the escrow cannot be redirected to another gauge", async () => {
    const partner = await fundedWallet();
    await registerPartnerFor(partner.publicKey, ONE, ONE);
    await fundStream(partner, 4, ONE.divn(4));

    // A permissionless crank means an attacker can call it. The pool is pinned at funding
    // time precisely so they cannot aim someone else's escrowed bribes at their own pool.
    const otherPool = Keypair.generate().publicKey;
    const epoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    await expectFailure(
      () =>
        program.methods
          .releasePartnerBribe(new BN(epoch))
          .accounts({
            caller: payer.publicKey,
            protocolState: statePda,
            partner: partner.publicKey,
            bribeStream: streamPda(partner.publicKey),
            partnerAllocation: partnerPda(partner.publicKey),
            streamVault: streamVaultPda(partner.publicKey),
            poolId: otherPool,
            rewardMint: usdcMint,
            bribeVault: pda([
              Buffer.from("bribe_vault"),
              otherPool.toBuffer(),
              usdcMint.toBuffer(),
              le8(epoch),
            ]),
            bribeTokenVault: pda([
              Buffer.from("bribe_tokens"),
              otherPool.toBuffer(),
              usdcMint.toBuffer(),
              le8(epoch),
            ]),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          } as any)
          .rpc(),
      "Unauthorized"
    );
  });

  it("[stream] runs dry after its funded tranches, and only then may be replaced", async () => {
    const partner = await fundedWallet();
    await registerPartnerFor(partner.publicKey, ONE, ONE);
    await fundStream(partner, 4, ONE.divn(4));

    // A running stream cannot be topped up: re-stamping stream_start_ts would restart the
    // welcome bag's 6-month clock and, now that the ve lock is anchored on that stamp, let the
    // partner move their own unlock date.
    // Different figures on purpose: an identical re-funding call would be a byte-identical
    // transaction and bankrun would reject the replay before the program ever ran, so the
    // refusal has to come from a genuinely distinct top-up attempt.
    await expectFailure(
      () => fundStream(partner, 4, ONE.divn(4).addn(1)),
      "BribeStreamStillRunning"
    );

    // Drain all four tranches the schedule was funded for, one epoch apart.
    for (let i = 0; i < 4; i++) {
      await releaseTranche(partner.publicKey);
      await forwardSeconds(EPOCH_DURATION);
    }

    await expectFailure(
      () => releaseTranche(partner.publicKey),
      "BribeStreamExhausted"
    );
    assert.equal(
      (await tokenBalance(streamVaultPda(partner.publicKey))).toString(),
      "0",
      "a spent stream holds nothing — every funded tranche was paid out"
    );

    // Spent, so a new term may now be escrowed. This is the path a renewed partnership takes.
    await fundStream(partner, 4, ONE.divn(4));
    const st: any = await program.account.partnerBribeStream.fetch(
      streamPda(partner.publicKey)
    );
    assert.equal(st.epochsTotal.toString(), "4");
    assert.equal(st.epochsReleased.toString(), "0", "the new term starts at zero");
  });

  it("[stream] the lock term is fixed at commitment — claiming again never pushes it", async () => {
    // The behaviour that made the schedule worse than dumping. lock_end_ts was `now +
    // lock_duration`, reassigned on every claim, so a partner claiming weekly pushed their own
    // unlock out weekly while one who dumped everything in week one walked away 52 epochs
    // earlier. It is now anchored on the moment the schedule was escrowed.
    const partner = await fundedWallet();
    await registerPartnerFor(partner.publicKey, ONE, ONE);
    await fundStream(partner, 4, ONE.divn(4));
    const streamedAt = (
      await program.account.partnerAllocation.fetch(partnerPda(partner.publicKey))
    ).streamStartTs.toNumber();

    await forwardSeconds(EPOCH_DURATION);
    await claimPartner(partner).rpc();
    const first: any = await program.account.veLockPosition.fetch(
      velockPda(partner.publicKey)
    );
    assert.equal(
      first.lockEndTs.toNumber(),
      streamedAt + MIN_LOCK_DURATION,
      "the term runs from the commitment, not from the claim"
    );

    // Claim again, later. Under the old rule this alone moved the unlock a full epoch out.
    await forwardSeconds(EPOCH_DURATION);
    await claimPartner(partner).rpc();
    const second: any = await program.account.veLockPosition.fetch(
      velockPda(partner.publicKey)
    );
    assert.equal(
      second.lockEndTs.toNumber(),
      first.lockEndTs.toNumber(),
      "a second claim must not push the unlock date — that was the perverse incentive"
    );
    assert.isTrue(
      BigInt(second.amountLocked.toString()) >
        BigInt(first.amountLocked.toString()),
      "while still locking the newly vested slice"
    );
  });
});
