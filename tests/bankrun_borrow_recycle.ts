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
  MintLayout,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import * as fs from "fs";

// One epoch, mirroring MIN_LOCK_DURATION in state.rs.
const MIN_LOCK_DURATION = 604_800;

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

  /// hiSOLA balance of a position — the ledger field that replaced the token account.
  async function positionHiSola(position: PublicKey): Promise<bigint> {
    const pos = await program.account.userPosition.fetch(position);
    return BigInt(pos.hiSola.toString());
  }

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

  /// Total supply of a mint — used to assert hiSOLA has none.
  async function mintSupply(mint: PublicKey): Promise<bigint> {
    const raw = await context.banksClient.getAccount(mint);
    if (!raw) return BigInt(0);
    return MintLayout.decode(Buffer.from(raw.data)).supply;
  }

  /// Clear A's whole debt so the position can be locked.
  ///
  /// The slot warp is required, not cosmetic: `repay_usdc` enforces
  /// `current_slot > last_borrow_slot` to block a same-transaction flash borrow, and bankrun
  /// does not advance the slot on its own between transactions.
  async function repayAll() {
    const pos: any = await program.account.userPosition.fetch(
      positionOf(payer.publicKey)
    );
    const owed = BigInt(pos.usdcBorrowed.toString());
    if (owed === BigInt(0)) return;
    const slot = await context.banksClient.getSlot();
    context.warpToSlot(slot + BigInt(1));
    await program.methods
      .repayUsdc(new BN(owed.toString()))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        userPosition: positionOf(payer.publicKey),
        floorVault: floorV,
        userUsdc: payerUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
  }

  async function borrow(user: Keypair, amount: number) {
    const ix = await program.methods
      .borrowUsdc(new BN(amount))
      .accounts({
        user: user.publicKey,
        protocolState: statePda,
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
        usdcMint,
        userUsdc: payerUsdc,
        userSola: payerSola,
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
    // Establishes the baseline: without this the tests below could pass simply because
    // borrowing is broken for everyone.
    const staked = await positionHiSola(positionOf(payer.publicKey));
    assert.isTrue(staked > BigInt(0), "A must hold hiSOLA");

    const before = await tokenBalance(payerUsdc);
    await borrow(payer, 1_000_000);
    const received = (await tokenBalance(payerUsdc)) - before;

    // 2% origination fee is withheld from the gross borrow.
    assert.equal(
      received.toString(),
      "980000",
      "A must receive the net borrow"
    );

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

  it("[security] there is no collateral to walk to a fresh wallet", async () => {
    // What this file was originally written to catch: A hands the whole collateral to a
    // wallet that never staked, which then borrows against it, and repeats — each hop a
    // permanent floor withdrawal, since a borrow carries no interest and no liquidation.
    // The fix at the time was to cap on `staked_amount.min(balance)`.
    //
    // The attack is no longer constructible. It needed a transfer, and there is nothing left
    // to transfer: `stake_sola` mints no token, so the mint has no supply and A holds no
    // token account at all. This asserts the ABSENCE, which is the whole claim of the model —
    // if a mint ever comes back, this test fails and the cap becomes load-bearing again.
    assert.equal(
      (await mintSupply(hiSolaM)).toString(),
      "0",
      "hiSOLA has no supply, so no balance exists to hand over"
    );
    assert.equal(
      (await tokenBalance(payerHiSola)).toString(),
      "0",
      "A holds no hiSOLA token account"
    );

    // And the wallet that never staked cannot borrow, having no position to borrow against.
    const floorBefore = await tokenBalance(floorV);
    let drained = false;
    try {
      await borrow(fresh, 1_000_000);
      drained = true;
    } catch {
      /* expected — B has no recorded deposit and no balance */
    }
    assert.isFalse(drained, "a wallet that never staked must not borrow");
    assert.equal(
      (await tokenBalance(floorV)).toString(),
      floorBefore.toString(),
      "not one lamport of USDC may leave the floor vault on a refused borrow"
    );
  });

  it("[security] a stale deposit record alone does not sustain a borrow", async () => {
    // The cap is a minimum of two quantities, so check the half that CAN still come apart.
    // Locking moves the balance into the ve position while `staked_amount` deliberately
    // stays put (it records what was financed, which locking does not undo), so a locker has
    // `staked_amount > 0` and `hi_sola == 0` — the same shape the old transfer produced.
    // The 100% channel must shut, leaving `borrow_against_locked` at 20% as the only valve.
    await repayAll();

    const staked = await positionHiSola(positionOf(payer.publicKey));
    assert.isTrue(staked > BigInt(0), "A must still hold a balance to lock");
    await program.methods
      .lockHiSola(new BN(staked.toString()), new BN(MIN_LOCK_DURATION))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        lockPosition: pda([Buffer.from("velock"), payer.publicKey.toBuffer()]),
        marketVault: marketV,
        userPosition: positionOf(payer.publicKey),
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const pos: any = await program.account.userPosition.fetch(
      positionOf(payer.publicKey)
    );
    assert.isTrue(
      BigInt(pos.stakedAmount.toString()) > BigInt(0),
      "A's recorded deposit is still on the books"
    );
    assert.equal(
      pos.hiSola.toString(),
      "0",
      "but the balance itself has moved into the lock"
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
      "A borrowed at 100% against a locked position — `staked_amount` is being " +
        "trusted on its own"
    );
  });

  it("[security] an unfinanced allocation cannot reach the 100% borrow channel", async () => {
    // The rule the protocol publishes is "100% if the collateral is financed, 20% if it is
    // not". Until 2026-07-18 that rule lived in SEPARATE instructions with their own
    // constants (`founder_borrow_usdc` / `contributor_borrow_usdc`, capped by
    // `FOUNDER_BORROW_CAP_BPS` / `CONTRIBUTOR_BORROW_CAP_BPS`). Those were deleted, and the
    // rule now rests entirely on an emergent property: `staked_amount` is written in exactly
    // two places, `stake_sola` (+) and `unstake_hi_sola` (−), so an allocation that was
    // MINTED rather than bought can never open the 100% channel.
    //
    // Emergent properties are the ones that break silently — add one `staked_amount = …`
    // anywhere in a claim path and the 7M founder tranche becomes borrowable at 100% against
    // a floor vault it never paid into. Hence this test.
    //
    // The contributor path is used rather than the founder one on purpose: `FOUNDER_WALLET`
    // is feature-gated to a throwaway key under `tests/keys/`, which is GITIGNORED. A test
    // depending on it is dead for anyone who clones the repo — that is exactly how the three
    // `[founder]` tests died in the 2026-07-21 history purge. `claim_contributor_hi_sola`
    // needs nothing but the authority, and it is structurally identical: both mint hiSOLA
    // straight into a ve lock and neither touches `staked_amount`.
    const contributor = Keypair.generate();
    await send([
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: contributor.publicKey,
        lamports: 10 * LAMPORTS_PER_SOL,
      }),
    ]);
    const contributorUsdc = getAssociatedTokenAddressSync(
      usdcMint,
      contributor.publicKey
    );
    await send([
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        contributorUsdc,
        contributor.publicKey,
        usdcMint
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        getAssociatedTokenAddressSync(hiSolaM, contributor.publicKey),
        contributor.publicKey,
        hiSolaM
      ),
    ]);

    const vesting = pda([
      Buffer.from("contributor"),
      contributor.publicKey.toBuffer(),
    ]);
    // 50/50 is enforced on-chain since 2026-08-27 — the oSOLA side is irrelevant to this test
    // but no longer optional, and the cumulative cap is what it is registered against.
    await program.methods
      .registerContributor(new BN(100_000_000), new BN(100_000_000))
      .accounts({
        authority: payer.publicKey,
        protocolState: statePda,
        contributorWallet: contributor.publicKey,
        contributorVesting: vesting,
        contributorRegistry: pda([Buffer.from("contributor_registry")]),
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const lockPosition = pda([
      Buffer.from("velock"),
      contributor.publicKey.toBuffer(),
    ]);
    const veVault = pda([
      Buffer.from("ve_vault"),
      contributor.publicKey.toBuffer(),
    ]);
    const claimIx = await program.methods
      .claimContributorHiSola()
      .accounts({
        contributor: contributor.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        solaVault,
        marketVault: marketV,
        lockPosition,
        veLockVault: veVault,
        contributorPosition: positionOf(contributor.publicKey),
        contributorVesting: vesting,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
    await send([claimIx], [contributor]);

    // The allocation really exists and really is hiSOLA — the test would be hollow if the
    // claim had silently minted nothing.
    const locked: any = await program.account.veLockPosition.fetch(
      lockPosition
    );
    assert.isTrue(
      BigInt(locked.amountLocked.toString()) > BigInt(0),
      "the contributor must actually hold a funded ve lock"
    );
    // The lock entry IS the hiSOLA — the claim path mints no token, so there is no ve vault
    // holding a mirror balance any more. Asserting the absence keeps the guarantee honest:
    // if a mint ever reappears in a claim path, this allocation becomes transferable again.
    assert.equal(
      (await mintSupply(hiSolaM)).toString(),
      "0",
      "an allocation claim must not mint any hiSOLA token"
    );
    assert.equal(
      (
        await program.account.userPosition.fetch(positionOf(contributor.publicKey))
      ).hiSola.toString(),
      "0",
      "and it must not land in a spendable balance either — it goes straight into the lock"
    );

    // ── the property itself, asserted before its explanations ───────────────
    // Order matters. The two diagnostics below are each SUFFICIENT on their own to block
    // the borrow, so testing them first would mean the outcome is never actually observed:
    // a regression in one would fail on the proxy while the other silently kept the channel
    // shut. The refusal is the claim; the diagnostics say why it holds.
    const floorBefore = await tokenBalance(floorV);
    const code = errorCode("BorrowLimitExceeded");
    let drained = false;
    try {
      await borrow(contributor, 1_000_000);
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
      "an unfinanced allocation borrowed through borrow_usdc at 100% — the " +
        "financed/unfinanced split is no longer enforced anywhere"
    );

    assert.equal(
      (await tokenBalance(floorV)).toString(),
      floorBefore.toString(),
      "the floor vault must be untouched"
    );

    // ── why it holds: two independent guards, either one sufficient ─────────
    const pos: any = await program.account.userPosition.fetch(
      positionOf(contributor.publicKey)
    );
    assert.equal(
      pos.stakedAmount.toString(),
      "0",
      "a minted allocation must never be recorded as a financed deposit"
    );
    assert.equal(
      (
        await tokenBalance(
          getAssociatedTokenAddressSync(hiSolaM, contributor.publicKey)
        )
      ).toString(),
      "0",
      "claim_contributor_hi_sola must leave the wallet balance at 0 — the mint goes " +
        "straight to the ve vault"
    );

    // What remains open to them is the 20% valve, `borrow_against_locked`, which reads
    // `amount_locked` rather than `staked_amount`. Not exercised here — it has its own
    // coverage — but this is the channel the docs point at.
  });
});
