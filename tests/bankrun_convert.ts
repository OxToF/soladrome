// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// # The hiSOLA conversion — the one path that touches live devnet state
//
// `convert_hi_sola` is migration code: it turns the SPL balances the token era left behind
// into the ledger position that replaced them. Everything else in this refactor is exercised
// by staking fresh, which never produces a legacy balance — so without this file the single
// instruction that will run against real user funds would ship with no coverage at all.
//
// The legacy state is FABRICATED with `setAccount`, because the program can no longer create
// it: nothing mints hiSOLA any more. We write the token account, the escrow vault, the mint
// supply and the position's `vote_escrowed` counter directly, exactly as the live devnet
// singleton carries them today, and then run the real instruction against them.
//
// The two halves matter for different reasons. Tokens in the WALLET are the visible case.
// Tokens in the global escrow VAULT are the dangerous one: `withdraw_vote_escrow` was their
// only exit and it no longer exists, so if this instruction did not sweep them they would be
// stranded under a PDA with nothing left that can sign for them.

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
  ACCOUNT_SIZE,
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

/// Byte offsets into UserPosition, discriminator included. Derived from the IDL field order;
/// Borsh writes fields back to back, so these are exact.
const OFF_VOTE_ESCROWED = 73;

describe("soladrome — bankrun (legacy hiSOLA conversion)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: anchor.Program<any>;
  let payer: Keypair;
  let idlJson: any;

  let usdcMint: PublicKey;
  let statePda: PublicKey;
  let solaM: PublicKey;
  let hiSolaM: PublicKey;
  let floorV: PublicKey;
  let marketV: PublicKey;
  let solaVault: PublicKey;
  let voteEscrowVault: PublicKey;

  let userUsdc: PublicKey;
  let userSola: PublicKey;
  let userHiSola: PublicKey;
  let userPosition: PublicKey;

  let financed: bigint; // staked the honest way, before any legacy is grafted on
  const IN_WALLET = BigInt(400_000); // 0.4 hiSOLA left in the old ATA
  const IN_ESCROW = BigInt(600_000); // 0.6 hiSOLA stuck in the old escrow vault

  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  async function tokenBalance(account: PublicKey): Promise<bigint> {
    const raw = await context.banksClient.getAccount(account);
    if (!raw) return BigInt(0);
    return AccountLayout.decode(Buffer.from(raw.data)).amount;
  }

  async function mintSupply(mint: PublicKey): Promise<bigint> {
    const raw = await context.banksClient.getAccount(mint);
    if (!raw) return BigInt(0);
    return MintLayout.decode(Buffer.from(raw.data)).supply;
  }

  async function send(ixs: any[], signers: Keypair[] = []) {
    const tx = new Transaction();
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = payer.publicKey;
    ixs.forEach((ix) => tx.add(ix));
    tx.sign(payer, ...signers);
    return context.banksClient.processTransaction(tx);
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
      // Anchor's `.rpc()` translates the failure and reports the code in decimal, while a raw
      // `banksClient` send surfaces it as `custom program error: 0x…`. Accept either, so the
      // assertion does not depend on which path the caller used.
      const hit =
        msg.includes(`0x${code.toString(16)}`) || msg.includes(`Error Number: ${code}`);
      assert.isTrue(hit, `expected ${name} (${code}), got: ${msg}`);
    }
  }

  /// Overwrite an SPL token account's `amount` in place.
  async function setTokenAmount(address: PublicKey, owner: PublicKey, amount: bigint) {
    const existing = await context.banksClient.getAccount(address);
    const data = Buffer.alloc(ACCOUNT_SIZE);
    if (existing) {
      Buffer.from(existing.data).copy(data);
    } else {
      AccountLayout.encode(
        {
          mint: hiSolaM,
          owner,
          amount: BigInt(0),
          delegateOption: 0,
          delegate: PublicKey.default,
          state: 1, // initialized
          isNativeOption: 0,
          isNative: BigInt(0),
          delegatedAmount: BigInt(0),
          closeAuthorityOption: 0,
          closeAuthority: PublicKey.default,
        },
        data
      );
    }
    data.writeBigUInt64LE(amount, 64); // `amount` sits at offset 64 in the SPL layout
    const rent = await context.banksClient.getRent();
    context.setAccount(address, {
      lamports: Number(rent.minimumBalance(BigInt(ACCOUNT_SIZE))),
      data,
      owner: TOKEN_PROGRAM_ID,
      executable: false,
    });
  }

  /// Overwrite a u64 field of the live UserPosition, leaving everything else untouched.
  async function setPositionU64(offset: number, value: bigint) {
    const raw = await context.banksClient.getAccount(userPosition);
    assert.isNotNull(raw, "the position must exist before it can be doctored");
    const data = Buffer.from(raw!.data);
    data.writeBigUInt64LE(value, offset);
    context.setAccount(userPosition, {
      lamports: raw!.lamports,
      data,
      owner: program.programId,
      executable: false,
    });
  }

  /// Send a `convert_hi_sola` attempt.
  ///
  /// The `nonce` is load-bearing. Two conversions by the same wallet are byte-identical —
  /// same accounts, no arguments — and bankrun's blockhash does not move on its own, so the
  /// second transaction hashes to the first and comes back as "already processed" instead of
  /// executing. That made the replay test pass or fail depending on the run. A self-transfer
  /// of `nonce` lamports makes each attempt distinct without touching protocol state.
  async function convert(nonce: number) {
    const ix = await program.methods
      .convertHiSola()
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        hiSolaMint: hiSolaM,
        userHiSola,
        voteEscrowVault,
        marketVault: marketV,
        userPosition,
        tokenProgram: TOKEN_PROGRAM_ID,
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

  before(async () => {
    context = await startAnchor(".", [], []);
    provider = new BankrunProvider(context);
    payer = context.payer;
    idlJson = JSON.parse(fs.readFileSync("target/idl/soladrome.json", "utf8"));
    program = new anchor.Program(idlJson, provider);

    statePda = pda([Buffer.from("state")]);
    solaM = pda([Buffer.from("sola_mint")]);
    hiSolaM = pda([Buffer.from("hi_sola_mint")]);
    floorV = pda([Buffer.from("floor_vault")]);
    marketV = pda([Buffer.from("market_vault")]);
    solaVault = pda([Buffer.from("sola_vault")]);
    voteEscrowVault = pda([Buffer.from("vote_escrow")]);
    userPosition = pda([Buffer.from("position"), payer.publicKey.toBuffer()]);

    const mintKp = Keypair.generate();
    const rent = await context.banksClient.getRent();
    usdcMint = mintKp.publicKey;
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: usdcMint,
          space: MINT_SIZE,
          lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))),
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
        hiSolaM,
        oSolaM: pda([Buffer.from("o_sola_mint")]),
        floorVault: floorV,
        marketVault: marketV,
        solaVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await program.methods
      .setPhaseFlags(null, null, true, null, true, null)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    userUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
    userSola = getAssociatedTokenAddressSync(solaM, payer.publicKey);
    userHiSola = getAssociatedTokenAddressSync(hiSolaM, payer.publicKey);

    await send([
      createAssociatedTokenAccountInstruction(payer.publicKey, userUsdc, payer.publicKey, usdcMint),
      createMintToInstruction(usdcMint, userUsdc, payer.publicKey, 1_000_000_000),
    ]);

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
        userSola,
        solaVault,
        marketVault: marketV,
        usdcMint,
        userUsdc,
        userPosition,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    financed = BigInt(
      (await program.account.userPosition.fetch(userPosition)).hiSola.toString()
    );
    assert.isTrue(financed > BigInt(0), "the honest stake must exist first");

    // ── graft the legacy state on ───────────────────────────────────────────
    await setTokenAmount(userHiSola, payer.publicKey, IN_WALLET);
    await setTokenAmount(voteEscrowVault, statePda, IN_ESCROW);
    await setPositionU64(OFF_VOTE_ESCROWED, IN_ESCROW);

    // The mint must show the matching supply, or the burns below would underflow it.
    const mintRaw = await context.banksClient.getAccount(hiSolaM);
    const mintData = Buffer.from(mintRaw!.data);
    mintData.writeBigUInt64LE(IN_WALLET + IN_ESCROW, 36); // `supply` offset in the SPL mint
    context.setAccount(hiSolaM, {
      lamports: mintRaw!.lamports,
      data: mintData,
      owner: TOKEN_PROGRAM_ID,
      executable: false,
    });
  });

  it("[convert] the fabricated legacy state is what a devnet wallet actually looks like", async () => {
    // Guard on the harness itself. Every assertion below is meaningless if the graft did not
    // take, and a silently empty fixture would make the conversion look correct for free.
    assert.equal((await tokenBalance(userHiSola)).toString(), IN_WALLET.toString());
    assert.equal((await tokenBalance(voteEscrowVault)).toString(), IN_ESCROW.toString());
    assert.equal(
      (await mintSupply(hiSolaM)).toString(),
      (IN_WALLET + IN_ESCROW).toString()
    );
    const pos = await program.account.userPosition.fetch(userPosition);
    assert.equal(pos.voteEscrowed.toString(), IN_ESCROW.toString());
    assert.equal(
      pos.hiSola.toString(),
      financed.toString(),
      "the ledger still knows only about the honest stake"
    );
  });

  it("[convert] both halves are swept and credited exactly once", async () => {
    await convert(1);

    const pos = await program.account.userPosition.fetch(userPosition);
    assert.equal(
      pos.hiSola.toString(),
      (financed + IN_WALLET + IN_ESCROW).toString(),
      "wallet and escrow are added to the balance already on the ledger"
    );
    assert.equal(
      (await tokenBalance(userHiSola)).toString(),
      "0",
      "the old token account is emptied"
    );
    assert.equal(
      (await tokenBalance(voteEscrowVault)).toString(),
      "0",
      "and so is the escrow vault, which has no other exit left"
    );
    assert.equal(
      (await mintSupply(hiSolaM)).toString(),
      "0",
      "the tokens are burned, not parked — the supply is the proof they cannot come back"
    );
    assert.equal(
      pos.voteEscrowed.toString(),
      "0",
      "the legacy counter is cleared in the same instruction that empties the vault"
    );
  });

  it("[convert] conversion moves no protocol aggregate", async () => {
    // The stake was already counted in `total_hi_sola` when it was staked, and its USDC is
    // already in the floor vault. Conversion re-expresses the same stake in a different unit,
    // so touching any aggregate here would double-count it — the failure mode would be a fee
    // denominator that no longer matches the sum of the positions.
    const s = await program.account.protocolState.fetch(statePda);
    assert.equal(
      s.totalHiSola.toString(),
      financed.toString(),
      "total_hi_sola still reflects what was staked, not what was converted"
    );
  });

  it("[convert] the credited balance is NOT treated as financed", async () => {
    // ☢️ The one way this instruction could quietly cost real money. `staked_amount` is the
    // 100% borrow channel; the converted tokens may have been acquired by transfer, so
    // crediting them here would hand a full-cap borrow against a floor vault they never paid
    // into. Only the honest stake may count.
    const pos = await program.account.userPosition.fetch(userPosition);
    assert.equal(
      pos.stakedAmount.toString(),
      financed.toString(),
      "conversion must not touch the financed figure"
    );
    assert.isTrue(
      BigInt(pos.hiSola.toString()) > BigInt(pos.stakedAmount.toString()),
      "the position now holds more than it financed, which is the case the min() is for"
    );
  });

  it("[convert] a second call has nothing to take", async () => {
    await expectFailure(() => convert(2), "NothingToConvert");
  });
});
