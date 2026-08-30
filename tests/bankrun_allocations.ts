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
  createBurnInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import * as fs from "fs";

const DAY = 24 * 3_600;
const EPOCH_DURATION = 7 * DAY; // 604 800 s — state.rs
const VESTING_CLIFF_SECS = 180 * DAY; // state.rs, mainnet value, now the only value
const MIN_LOCK_DURATION = EPOCH_DURATION; // state.rs
/// The LP the tests' partners commit to keep. An arbitrary unit count: the tier is negotiated
/// in dollars off-chain and frozen here as the number of LP tokens that matched it.
const LP_THRESHOLD = new BN(10_000_000);
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
  let lpMint: PublicKey;
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

  /// A deal in two money terms: `base` is the signature bag, `retainer` is what one qualified
  /// epoch pays. `scheduleEpochs` is the bribe rhythm, fixed here and refused at funding time if
  /// it differs; `minBribe` is the floor under each tranche, which is what stops a partner
  /// escrowing a token schedule to unlock the bag.
  async function registerPartnerFor(
    wallet: PublicKey,
    base: BN,
    retainer: BN,
    opts: { scheduleEpochs?: number; lpThreshold?: BN; minBribe?: BN } = {}
  ): Promise<void> {
    await program.methods
      .registerPartner(
        usdcMint, // committed bribe mint
        lpMint, // the LP token the retainer is conditioned on
        opts.lpThreshold ?? LP_THRESHOLD,
        retainer,
        base,
        new BN(MIN_LOCK_DURATION),
        new BN(opts.scheduleEpochs ?? 4),
        opts.minBribe ?? new BN(1)
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
        lpMint,
        partnerLpToken: getAssociatedTokenAddressSync(lpMint, wallet),
        bribeStream: streamPda(wallet),
      } as any);
  }

  /// The liquidity the retainer is bought against. Held by the partner, never by the protocol —
  /// the whole condition is a balance the program reads and does not touch.
  async function mintLp(owner: PublicKey, amount: BN): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(lpMint, owner);
    if (!(await accountExists(ata))) {
      await send([
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          ata,
          owner,
          lpMint
        ),
      ]);
    }
    if (!amount.isZero()) {
      await send([
        createMintToInstruction(
          lpMint,
          ata,
          payer.publicKey,
          BigInt(amount.toString())
        ),
      ]);
    }
    return ata;
  }

  /// Withdraw liquidity, the only way a partner ever stops qualifying.
  async function burnLp(owner: Keypair, amount: BN): Promise<void> {
    await send(
      [
        createBurnInstruction(
          getAssociatedTokenAddressSync(lpMint, owner.publicKey),
          lpMint,
          owner.publicKey,
          BigInt(amount.toString())
        ),
      ],
      [owner]
    );
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

  /// Run one epoch of a partner's deal: the bribe tranche and the retainer, in one call.
  /// `caller` defaults to the payer — passing a different one both proves the instruction is
  /// permissionless and keeps an otherwise byte-identical retry distinct.
  async function crankEpoch(
    partner: PublicKey,
    caller?: Keypair,
    poolOverride?: PublicKey
  ) {
    const epoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    const poolId = poolOverride ?? bribePool.publicKey;
    return program.methods
      .crankPartnerEpoch(new BN(epoch))
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
        lpMint,
        partnerLpToken: getAssociatedTokenAddressSync(lpMint, partner),
        solaMint: solaM,
        solaVault,
        marketVault: marketV,
        lockPosition: velockPda(partner),
        partnerPosition: positionPda(partner),
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

  /// One vault per (pool, mint, epoch), shared by every partner and every ordinary bribe — so
  /// two tests landing in the same epoch add to the same balance. Always measure the delta.
  async function bribeVaultDelta(
    epoch: number,
    fn: () => Promise<any>
  ): Promise<bigint> {
    const before = await tokenBalance(bribeTokenVaultAt(epoch));
    await fn();
    return (await tokenBalance(bribeTokenVaultAt(epoch))) - before;
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

    // ── Mock LP mint ────────────────────────────────────────────────────────
    // Stands in for an AmmPool's LP token. The retainer never reads the pool, only the
    // partner's balance of the mint their deal names, so a plain mint is the whole surface.
    const lpKp = Keypair.generate();
    lpMint = lpKp.publicKey;
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: lpMint,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(lpMint, 6, payer.publicKey, null),
      ],
      [lpKp]
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
  // ── Partner: a signature bag, then a retainer ─────────────────────────────
  //
  // The 1:1 bribe match is gone (2026-08-27) and with it every case that measured a promised
  // total. What replaces it is not a smaller vesting, it is a different instrument: each epoch
  // is bought separately against liquidity that is verified at that moment, so there is never a
  // remainder to forfeit, to revoke, or to cap. These cases pin the four properties that only
  // hold if that is true — the bag is unconditional but gated on the schedule, the retainer is
  // conditional and unbounded, a missed epoch is lost rather than owed, and closing an account
  // can never take away an epoch the partner has already earned.

  const ONE = new BN(1_000_000);
  const RETAINER = new BN(100_000);

  /// The standard setup: registered, liquidity in place, schedule escrowed.
  async function livePartner(
    opts: { base?: BN; retainer?: BN; lp?: BN; epochs?: number } = {}
  ): Promise<Keypair> {
    const partner = await fundedWallet();
    await registerPartnerFor(
      partner.publicKey,
      opts.base ?? ONE,
      opts.retainer ?? RETAINER,
      { scheduleEpochs: opts.epochs ?? 4 }
    );
    await mintLp(partner.publicKey, opts.lp ?? LP_THRESHOLD);
    await fundStream(partner, opts.epochs ?? 4, ONE.divn(4));
    return partner;
  }

  it("[partner] the bag arrives whole, permanent, and earning fees", async () => {
    const partner = await livePartner();
    const before: any = await program.account.protocolState.fetch(statePda);

    await claimPartner(partner).rpc();

    const lock: any = await program.account.veLockPosition.fetch(
      velockPda(partner.publicKey)
    );
    assert.equal(
      lock.amountLocked.toString(),
      ONE.toString(),
      "the whole bag lands at once — it stopped streaming over six months"
    );
    assert.equal(
      lock.permanentAmount.toString(),
      ONE.toString(),
      "and all of it is permanent: unfinanced hiSOLA must never become sellable"
    );

    const pos: any = await program.account.userPosition.fetch(
      positionPda(partner.publicKey)
    );
    assert.equal(pos.hiSola.toString(), "0", "none of it is a spendable balance");
    assert.equal(
      pos.feeShares.toString(),
      ONE.toString(),
      "☢️ but it earns fees — a locked-for-life bag with a zero fee basis was worth nothing"
    );

    const after: any = await program.account.protocolState.fetch(statePda);
    assert.equal(
      after.totalHiSola.sub(before.totalHiSola).toString(),
      ONE.toString(),
      "the share is real, not printed: the denominator grows by exactly what was granted"
    );
  });

  it("[partner] no escrowed schedule, no bag and no retainer", async () => {
    const partner = await fundedWallet();
    await registerPartnerFor(partner.publicKey, ONE, RETAINER);
    await mintLp(partner.publicKey, LP_THRESHOLD);

    // Registration alone used to start a six-month clock on the bag, so a partner who never
    // bribed a unit still collected permanent voting power the floor had funded nothing for.
    await expectFailure(
      () => claimPartner(partner).rpc(),
      "PartnerStreamNotFunded"
    );

    // The crank never even reaches that guard: with no escrow there is no `PartnerBribeStream`
    // account to pass, so Anchor refuses the instruction at 3012 (AccountNotInitialized). One
    // gate is the program's, the other is the account model's — both shut.
    try {
      await crankEpoch(partner.publicKey);
      assert.fail("cranking an unfunded deal must be impossible");
    } catch (e: any) {
      assert.include(e.toString(), "AccountNotInitialized");
    }
  });

  it("[partner] the bag is claimed once and only once", async () => {
    const partner = await livePartner();
    await claimPartner(partner).rpc();
    // A different epoch, so the retry is not a replay bankrun rejects before the program runs.
    await forwardSeconds(EPOCH_DURATION);
    await expectFailure(() => claimPartner(partner).rpc(), "VestingFullyClaimed");

    const lock: any = await program.account.veLockPosition.fetch(
      velockPda(partner.publicKey)
    );
    assert.equal(lock.amountLocked.toString(), ONE.toString());
  });

  it("[crank] one call runs the whole epoch: the bribe tranche and the retainer", async () => {
    const partner = await livePartner();
    const epoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    const before: any = await program.account.protocolState.fetch(statePda);

    const moved = await bribeVaultDelta(epoch, () =>
      crankEpoch(partner.publicKey)
    );
    assert.equal(
      moved.toString(),
      "250000",
      "the bribe reaches the vault this epoch's voters claim from"
    );
    const pa: any = await program.account.partnerAllocation.fetch(
      partnerPda(partner.publicKey)
    );
    assert.equal(pa.epochsQualified, 1, "and the epoch is bought");
    assert.equal(pa.lastCreditedEpoch.toNumber(), epoch);
    assert.equal(pa.hiSolaClaimed.toString(), RETAINER.toString());

    const pos: any = await program.account.userPosition.fetch(
      positionPda(partner.publicKey)
    );
    assert.equal(
      pos.feeShares.toString(),
      RETAINER.toString(),
      "the retainer earns fees the same way the bag does"
    );
    const lock: any = await program.account.veLockPosition.fetch(
      velockPda(partner.publicKey)
    );
    assert.equal(
      lock.permanentAmount.toString(),
      RETAINER.toString(),
      "and it is permanent too — nobody financed it through the curve"
    );
    const after: any = await program.account.protocolState.fetch(statePda);
    assert.equal(
      after.totalHiSola.sub(before.totalHiSola).toString(),
      RETAINER.toString()
    );
  });

  it("[crank] the same epoch twice does nothing at all", async () => {
    const partner = await livePartner();
    const stranger = await fundedWallet();
    await crankEpoch(partner.publicKey);

    // Both halves are spent for this epoch: the tranche is released and the retainer credited.
    // A different caller makes this a genuinely distinct transaction, so the refusal is the
    // program's and not the status cache's.
    await expectFailure(
      () => crankEpoch(partner.publicKey, stranger),
      "NothingToCrank"
    );
    const pa: any = await program.account.partnerAllocation.fetch(
      partnerPda(partner.publicKey)
    );
    assert.equal(pa.epochsQualified, 1, "the refused crank credited nothing");
  });

  it("☢️ [crank] liquidity gone: the escrowed bribe still pays, the retainer does not", async () => {
    // The asymmetry that decides the design. The bribe is money already escrowed and owed to
    // the epoch's voters — a partner who withdraws their LP does not get it back. The retainer
    // is bought fresh each epoch and simply stops.
    const partner = await livePartner();
    await burnLp(partner, new BN(1)); // one unit under the threshold is enough

    const epoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    const moved = await bribeVaultDelta(epoch, () =>
      crankEpoch(partner.publicKey)
    );
    assert.equal(
      moved.toString(),
      "250000",
      "the voters are paid regardless — the escrow was never conditional"
    );
    const pa: any = await program.account.partnerAllocation.fetch(
      partnerPda(partner.publicKey)
    );
    assert.equal(pa.epochsQualified, 0, "but the epoch bought nothing");
    assert.equal(pa.hiSolaClaimed.toString(), "0");
    // The position PDA is opened by `init_if_needed` whatever happens — the account model
    // creates it before the program decides anything — but it is granted nothing.
    const pos: any = await program.account.userPosition.fetch(
      positionPda(partner.publicKey)
    );
    assert.equal(
      pos.feeShares.toString(),
      "0",
      "an epoch that did not qualify buys no share of the fee stream"
    );
  });

  it("[crank] liquidity restored, the retainer resumes — and the lost epoch stays lost", async () => {
    const partner = await livePartner();
    await burnLp(partner, new BN(1));
    await crankEpoch(partner.publicKey); // epoch 1: bribe only

    await forwardSeconds(EPOCH_DURATION);
    await mintLp(partner.publicKey, new BN(1)); // back at the threshold
    await crankEpoch(partner.publicKey); // epoch 2: both halves

    const pa: any = await program.account.partnerAllocation.fetch(
      partnerPda(partner.publicKey)
    );
    assert.equal(
      pa.epochsQualified,
      1,
      "☢️ the skipped epoch is not made up later — the crank IS the attestation, and the " +
        "chain keeps no history of an SPL balance to establish it after the fact"
    );
    assert.equal(pa.hiSolaClaimed.toString(), RETAINER.toString());
  });

  it("[crank] the retainer outlives the bribe schedule — a retainer has no cap", async () => {
    // The gain over the 1:1 deal, which died at `cap_hi_sola`. Four epochs of schedule, five
    // epochs of liquidity: the fifth pays the retainer with no tranche left to release.
    const partner = await livePartner({ epochs: 4 });
    for (let i = 0; i < 4; i++) {
      await crankEpoch(partner.publicKey);
      await forwardSeconds(EPOCH_DURATION);
    }
    const spent: any = await program.account.partnerBribeStream.fetch(
      streamPda(partner.publicKey)
    );
    assert.equal(spent.epochsReleased.toString(), "4", "the escrow is empty");

    await crankEpoch(partner.publicKey);
    const pa: any = await program.account.partnerAllocation.fetch(
      partnerPda(partner.publicKey)
    );
    assert.equal(
      pa.epochsQualified,
      5,
      "the fifth epoch pays: they are still providing liquidity, so they are still paid"
    );
    assert.equal(pa.hiSolaClaimed.toString(), RETAINER.muln(5).toString());
  });

  it("[crank] and stops entirely once neither half has anything to do", async () => {
    const partner = await livePartner({ epochs: 4 });
    for (let i = 0; i < 4; i++) {
      await crankEpoch(partner.publicKey);
      await forwardSeconds(EPOCH_DURATION);
    }
    await burnLp(partner, LP_THRESHOLD); // withdraw everything
    await expectFailure(() => crankEpoch(partner.publicKey), "NothingToCrank");
  });

  it("[crank] the escrow cannot be redirected to another gauge", async () => {
    const partner = await livePartner();

    // A permissionless crank means an attacker can call it. The pool is pinned at funding time
    // precisely so they cannot aim someone else's escrowed bribes at a pool of their own.
    const otherPool = Keypair.generate().publicKey;
    await expectFailure(
      () => crankEpoch(partner.publicKey, undefined, otherPool),
      "Unauthorized"
    );
  });

  it("[crank] and cannot be pointed at some other token the partner happens to hold", async () => {
    const partner = await livePartner();
    const epoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    const poolId = bribePool.publicKey;
    const usdcAta = getAssociatedTokenAddressSync(usdcMint, partner.publicKey);

    // The partner's USDC balance is large (they just funded a schedule from it). Passing it as
    // the liquidity proof must fail on the mint, not quietly qualify the epoch.
    await expectFailure(
      () =>
        program.methods
          .crankPartnerEpoch(new BN(epoch))
          .accounts({
            caller: payer.publicKey,
            protocolState: statePda,
            partner: partner.publicKey,
            bribeStream: streamPda(partner.publicKey),
            partnerAllocation: partnerPda(partner.publicKey),
            streamVault: streamVaultPda(partner.publicKey),
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
            lpMint: usdcMint,
            partnerLpToken: usdcAta,
            solaMint: solaM,
            solaVault,
            marketVault: marketV,
            lockPosition: velockPda(partner.publicKey),
            partnerPosition: positionPda(partner.publicKey),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          } as any)
          .rpc(),
      "LpMintMismatch"
    );
  });

  // ── close_partner_allocation ──────────────────────────────────────────────
  //
  // Under a vesting, "terminal" meant a promised total was reached. A retainer has no total, so
  // the test had to change shape: what must be protected is not a remainder — there is none —
  // but an epoch the partner could still be credited for right now. These cases pin that line
  // from both sides.

  it("☢️ [close] a registration nobody ever activated is correctable", async () => {
    // Found on devnet, 2026-08-28, by registering a deal whose LP threshold was larger than the
    // pool's entire supply. Without this clause such an allocation can never be claimed (the bag
    // needs an escrowed schedule) and never be closed (an unclaimed bag reads as a debt), so the
    // authority cannot fix its own typo — ever. A bag is only owed once a schedule stands
    // against it, and here `stream_start_ts` is 0.
    const partner = await fundedWallet();
    await registerPartnerFor(partner.publicKey, ONE, RETAINER, {
      lpThreshold: LP_THRESHOLD.muln(1_000_000), // more LP than could ever exist
    });

    const pa: any = await program.account.partnerAllocation.fetch(
      partnerPda(partner.publicKey)
    );
    assert.equal(pa.streamStartTs.toString(), "0");
    assert.isFalse(pa.bagClaimed, "and the bag is sitting there unclaimed");

    // No LP account, no stream account: both are absent, and both must read as "nothing owed"
    // rather than failing the instruction at the account level.
    assert.isFalse(
      await accountExists(getAssociatedTokenAddressSync(lpMint, partner.publicKey))
    );
    await closePartner(partner.publicKey, payer.publicKey).rpc();
    assert.isFalse(await accountExists(partnerPda(partner.publicKey)));

    // And the seeds are free, so the corrected terms can be registered straight away.
    await registerPartnerFor(partner.publicKey, ONE, RETAINER);
    const fixed: any = await program.account.partnerAllocation.fetch(
      partnerPda(partner.publicKey)
    );
    assert.equal(fixed.lpThreshold.toString(), LP_THRESHOLD.toString());
  });

  it("☢️ [close] a live escrow blocks the close — the voters' money must not be stranded", async () => {
    // `crank_partner_epoch` needs the allocation, so closing while tranches remain would lock
    // them in the escrow forever: the gauge never receives money the partner already paid in,
    // and the partner cannot recover it either. Withdrawing LP stops the retainer; it does not
    // cancel a bribe commitment that is already funded.
    const partner = await livePartner();
    await claimPartner(partner).rpc();
    await crankEpoch(partner.publicKey);
    await burnLp(partner, LP_THRESHOLD); // they have left, and still owe three tranches

    await expectFailure(
      () => closePartner(partner.publicKey, payer.publicKey).rpc(),
      "PartnerAllocationNotSettled"
    );

    // Drain the schedule they committed to, and the account closes.
    for (let i = 0; i < 3; i++) {
      await forwardSeconds(EPOCH_DURATION);
      await crankEpoch(partner.publicKey);
    }
    assert.equal(
      (await tokenBalance(streamVaultPda(partner.publicKey))).toString(),
      "0",
      "every funded tranche reached the voters"
    );
    await closePartner(partner.publicKey, payer.publicKey).rpc();
    assert.isFalse(await accountExists(partnerPda(partner.publicKey)));
  });

  /// Run out whatever the partner escrowed, so the close is not blocked by tranches the gauge
  /// is still owed. A test that wants to close has to do this now — that is the point of the
  /// case above, and everything below assumes it.
  async function drainEscrow(partner: Keypair) {
    for (let i = 0; i < 8; i++) {
      const s: any = await program.account.partnerBribeStream.fetchNullable(
        streamPda(partner.publicKey)
      );
      if (!s || s.epochsReleased.gte(s.epochsTotal)) return;
      await forwardSeconds(EPOCH_DURATION);
      await crankEpoch(partner.publicKey);
    }
    assert.fail("the escrow should have drained within its funded tranches");
  }

  it("[close] a partner still providing liquidity cannot be closed out mid-epoch", async () => {
    const partner = await livePartner();
    await claimPartner(partner).rpc();
    await forwardSeconds(EPOCH_DURATION);

    // Nothing has been cranked this epoch and the LP is in place, so this epoch is still
    // theirs to earn. Closing here would take it from them.
    await expectFailure(
      () => closePartner(partner.publicKey, payer.publicKey).rpc(),
      "PartnerAllocationNotSettled"
    );
    assert.isTrue(await accountExists(partnerPda(partner.publicKey)));
  });

  it("[close] an unclaimed bag blocks the close outright", async () => {
    const partner = await livePartner();
    await burnLp(partner, LP_THRESHOLD); // no epoch can be earned any more
    await drainEscrow(partner); // and nothing is owed to the gauge either
    await expectFailure(
      () => closePartner(partner.publicKey, payer.publicKey).rpc(),
      "PartnerAllocationNotSettled"
    );

    // Claim it, and the same call now succeeds — the bag was the only thing outstanding.
    await claimPartner(partner).rpc();
    await closePartner(partner.publicKey, payer.publicKey).rpc();
    assert.isFalse(await accountExists(partnerPda(partner.publicKey)));
  });

  it("[close] a partner who has withdrawn closes immediately, rent back to the authority", async () => {
    // The other side of the retainer: a deal that stops owes nothing, so the account does not
    // have to sit open forever the way an unmet bribe commitment used to force it to.
    const partner = await livePartner();
    await claimPartner(partner).rpc();
    await crankEpoch(partner.publicKey);
    await burnLp(partner, LP_THRESHOLD);
    await drainEscrow(partner);

    const alloc = partnerPda(partner.publicKey);
    const rentHeld = await lamportsOf(alloc);
    const authorityBefore = await lamportsOf(payer.publicKey);
    await closePartner(partner.publicKey, payer.publicKey).rpc();

    assert.isFalse(await accountExists(alloc), "the allocation is gone");
    const gained = (await lamportsOf(payer.publicKey)) - authorityBefore;
    assert.isTrue(
      gained > rentHeld - BigInt(100_000) && gained <= rentHeld,
      `authority should recover ~${rentHeld} lamports, got ${gained}`
    );

    // Closing is bookkeeping: everything already credited stays exactly where it was.
    const lock: any = await program.account.veLockPosition.fetch(
      velockPda(partner.publicKey)
    );
    assert.equal(
      lock.amountLocked.toString(),
      ONE.add(RETAINER).toString(),
      "the ve lock is a separate PDA — closing the allocation burns nothing"
    );
    assert.equal(
      lock.permanentAmount.toString(),
      ONE.add(RETAINER).toString(),
      "and all of it is still permanent, still unsellable"
    );
  });

  it("[close] an epoch already credited is closable without waiting for the next", async () => {
    const partner = await livePartner({ epochs: 1 });
    await claimPartner(partner).rpc();
    await crankEpoch(partner.publicKey);
    // Same epoch, LP still in place. The retainer cannot pay again before the epoch turns and
    // the one-epoch schedule is spent, so there is nothing left to protect.
    await closePartner(partner.publicKey, payer.publicKey).rpc();
    assert.isFalse(await accountExists(partnerPda(partner.publicKey)));
  });

  it("[close] the authority signature is the whole gate", async () => {
    const partner = await livePartner();
    await burnLp(partner, LP_THRESHOLD);
    await claimPartner(partner).rpc();
    await drainEscrow(partner);

    // This allocation IS closable. The only thing wrong with the call below is who signs it.
    await expectFailure(
      () =>
        closePartner(partner.publicKey, partner.publicKey)
          .signers([partner])
          .rpc(),
      "Unauthorized"
    );
    assert.isTrue(await accountExists(partnerPda(partner.publicKey)));

    await closePartner(partner.publicKey, payer.publicKey).rpc();
    assert.isFalse(
      await accountExists(partnerPda(partner.publicKey)),
      "same account, same state, authority signature — now it closes"
    );
  });

  it("☢️ [close] the legacy escape refuses an account it could have read", async () => {
    // The instruction that stops a struct resize from bricking every allocation written before
    // it. Its whole safety property is the size check, not the authority signature: while the
    // layout stands, `register_partner` only ever writes accounts at exactly the current size,
    // so this must be inert on every one of them. A live, readable allocation offered to it is
    // the test that matters — if this ever passes, the authority can delete a partner's
    // entitlement without reading what they are owed, which is the one thing the partner path
    // refuses to allow.
    const partner = await livePartner();
    await claimPartner(partner).rpc();
    await crankEpoch(partner.publicKey);

    await expectFailure(
      () =>
        program.methods
          .closeLegacyPartnerAllocation()
          .accounts({
            authority: payer.publicKey,
            protocolState: statePda,
            partnerWallet: partner.publicKey,
            partnerAllocation: partnerPda(partner.publicKey),
          } as any)
          .rpc(),
      "PartnerAllocationNotLegacy"
    );
    assert.isTrue(
      await accountExists(partnerPda(partner.publicKey)),
      "the refused close took nothing"
    );

    // And the ordinary path still works on it, because it can read what is owed.
    await burnLp(partner, LP_THRESHOLD);
    await drainEscrow(partner);
    await closePartner(partner.publicKey, payer.publicKey).rpc();
    assert.isFalse(await accountExists(partnerPda(partner.publicKey)));
  });

  it("[close] re-registering a closed wallet is a FRESH deal, bag and all", async () => {
    // The documented consequence of freeing the seeds, asserted rather than assumed: this is
    // the one path that hands the same wallet a second bag, and it is also the migration path
    // for allocations written at the old 160-byte layout. It costs a second authority signature
    // and both instructions are on-chain.
    const partner = await livePartner({ epochs: 1 });
    await claimPartner(partner).rpc();
    await crankEpoch(partner.publicKey);
    await closePartner(partner.publicKey, payer.publicKey).rpc();

    const alloc = partnerPda(partner.publicKey);
    await registerPartnerFor(partner.publicKey, ONE, RETAINER.muln(2));
    const pa: any = await program.account.partnerAllocation.fetch(alloc);
    assert.equal(
      pa.hiSolaClaimed.toString(),
      "0",
      "counters are zeroed — what the first term credited is invisible to the new deal"
    );
    assert.equal(pa.epochsQualified, 0);
    assert.isFalse(pa.bagClaimed, "including the bag, which is why this is a second one");
    assert.equal(pa.retainerPerEpoch.toString(), RETAINER.muln(2).toString());

    // The hiSOLA from the first term is untouched by any of it.
    const lock: any = await program.account.veLockPosition.fetch(
      velockPda(partner.publicKey)
    );
    assert.equal(lock.amountLocked.toString(), ONE.add(RETAINER).toString());
  });

  // ── The escrowed schedule ─────────────────────────────────────────────────
  //
  // The stream changed role rather than shape: it is no longer the rail that pays the partner,
  // it is the commitment the bag is released against. Its own guarantees are unchanged and
  // still worth pinning.

  it("[stream] a schedule below the committed tranche size is refused", async () => {
    const partner = await fundedWallet();
    await registerPartnerFor(partner.publicKey, ONE, RETAINER, {
      minBribe: new BN(250_000),
    });
    await mintLp(partner.publicKey, LP_THRESHOLD);

    // This is what replaced the old "escrow enough to earn the whole cap" check. Without it,
    // 52 epochs of one lamport would satisfy every length rule and unlock the bag.
    await expectFailure(
      () => fundStream(partner, 4, new BN(249_999)),
      "ScheduleUnderfunded"
    );
    await expectFailure(
      () => fundStream(partner, 5, new BN(250_000)),
      "ScheduleLengthMismatch"
    );
    await fundStream(partner, 4, new BN(250_000));
    await claimPartner(partner).rpc();
  });

  it("[stream] a skipped epoch makes the schedule slip, never batch", async () => {
    const partner = await livePartner();

    // Nobody cranks for three epochs. The backlog is NOT paid out at once — batching it would
    // re-concentrate the bribes into one epoch, which is the failure the escrow prevents.
    await forwardSeconds(3 * EPOCH_DURATION);
    const epoch = Math.floor((await nowSeconds()) / EPOCH_DURATION);
    const moved = await bribeVaultDelta(epoch, () =>
      crankEpoch(partner.publicKey)
    );

    assert.equal(
      moved.toString(),
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
    // The retainer half is the opposite, and this is the asymmetry to keep in mind: three
    // epochs of liquidity went unattested and unpaid.
    const pa: any = await program.account.partnerAllocation.fetch(
      partnerPda(partner.publicKey)
    );
    assert.equal(pa.epochsQualified, 1);
  });

  it("[stream] runs dry after its funded tranches, and only then may be replaced", async () => {
    const partner = await livePartner();

    // A running stream cannot be topped up: `stream_start_ts` anchors the ve lock term, so
    // re-stamping it would let the partner move their own unlock date.
    // Different figures on purpose: an identical re-funding call would be a byte-identical
    // transaction and bankrun would reject the replay before the program ever ran.
    await expectFailure(
      () => fundStream(partner, 4, ONE.divn(4).addn(1)),
      "BribeStreamStillRunning"
    );

    for (let i = 0; i < 4; i++) {
      await crankEpoch(partner.publicKey);
      await forwardSeconds(EPOCH_DURATION);
    }
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

  it("[stream] the lock term is fixed at commitment, never pushed by a later credit", async () => {
    // The behaviour that made honouring a schedule worse than dumping. `lock_end_ts` was
    // `now + lock_duration`, reassigned on every claim, so a partner claiming weekly pushed
    // their own unlock out weekly while one who dumped everything in week one walked away
    // 52 epochs earlier. It is anchored on the moment the schedule was escrowed.
    const partner = await livePartner();
    const streamedAt = (
      await program.account.partnerAllocation.fetch(partnerPda(partner.publicKey))
    ).streamStartTs.toNumber();

    await claimPartner(partner).rpc();
    const first: any = await program.account.veLockPosition.fetch(
      velockPda(partner.publicKey)
    );
    assert.equal(
      first.lockEndTs.toNumber(),
      streamedAt + MIN_LOCK_DURATION,
      "the term runs from the commitment, not from the claim"
    );

    await forwardSeconds(EPOCH_DURATION);
    await crankEpoch(partner.publicKey);
    const second: any = await program.account.veLockPosition.fetch(
      velockPda(partner.publicKey)
    );
    assert.equal(
      second.lockEndTs.toNumber(),
      first.lockEndTs.toNumber(),
      "and a retainer epoch does not push it either"
    );
    assert.equal(
      second.amountLocked.toString(),
      ONE.add(RETAINER).toString(),
      "while still locking what the epoch bought"
    );
  });

  it("[partner] the permanent lock survives its own expiry, bag and retainer alike", async () => {
    const partner = await livePartner();
    await claimPartner(partner).rpc();
    await crankEpoch(partner.publicKey);

    // Wait out the lock so the ONLY thing between the position and a wallet is
    // `permanent_amount`. Both tranches are unfinanced; neither may ever be released.
    await forwardSeconds(3 * MIN_LOCK_DURATION);
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
      ONE.add(RETAINER).toString(),
      "the expired lock released nothing — permanent_amount overrides the timer forever"
    );
  });
});
