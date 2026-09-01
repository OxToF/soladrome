// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// # Bankrun harness — the AMM speaks Token-2022, and refuses exactly three extensions
//
// This file used to prove the opposite. Until the migration it asserted that `create_pool`
// REFUSED every Token-2022 mint, which was the audit package's stated reason for putting
// Token-2022 out of scope. That claim was true, load-bearing, and had never been executed —
// so the file was written to run it. It has now inverted, as its own closing note demanded,
// because the assets the project most wants to list are Token-2022 (verified against mainnet
// on 2026-08-30, mint owner `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`):
//
//   USDG   2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH
//   PYUSD  2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo
//   SPYx   XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W   (and the rest of the xStocks)
//
// What is proven here:
//
//   T-1. A plain Token-2022 mint is ACCEPTED, paired against a classic SPL mint. This is the
//        flagship shape — an xStock quoted in USDC — and it is why the pool carries two
//        separate token programs rather than one.
//   T-2. Acceptance is a property of the mint, not of which side of the sorted pair it lands on.
//   T-3. End to end across the program boundary: deposit, swap, withdraw on a mixed pool, with
//        the reserves and both vault balances agreeing at every step. This is the assertion
//        that actually exercises `transfer_checked` against two different token programs in
//        one instruction; everything above it only exercises admission.
//   T-4. A transfer-FEE mint is still refused. This is the extension that is an accounting bug
//        rather than a plumbing problem: the vault would receive less than the amount credited
//        to `reserve_a`, and the gap compounds silently (see `amm::apply_swap_reserves`).
//   T-5. An ARMED transfer hook is refused — its transfers would need accounts this program
//        does not pass, so the pool's `remove_liquidity` would revert and lock LP funds.
//   T-6. A default-FROZEN mint is refused: the vault would be born unable to move a token,
//        on `init` seeds that can never be reused.
//   T-7. Every refusal leaves no pool account behind. The seeds are `init`, so a half-created
//        pool would make that pair permanently unopenable — the 2026-07-19 devnet brick shape.
//   T-8. Control: two classic SPL mints still open a pool through the identical call.
//
// ☢️ NOT tested here, because it is not testable here: the xStocks ship with an UNARMED hook
// slot that the issuer can arm at any time. T-5 proves we refuse a mint that is already armed;
// nothing in this program can stop a mint from being armed after its pool exists. That residual
// risk is disclosed to LPs, not closed in code.

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { startAnchor, ProgramTestContext } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountState,
  ExtensionType,
  createInitializeMint2Instruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  createInitializeDefaultAccountStateInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import { assert } from "chai";
import fs from "fs";

const PROGRAM_ID = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");
const FEE_RATE = 30;
const PROTO_BPS = 2_000;

describe("soladrome — bankrun (the AMM speaks Token-2022)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: anchor.Program<any>;
  let payer: Keypair;

  let statePda: PublicKey;
  let usdcMint: PublicKey;
  let splMint: PublicKey;
  let t22Mint: PublicKey;
  let feeMint: PublicKey;
  let hookedMint: PublicKey;
  let frozenMint: PublicKey;

  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

  async function send(ixs: any[], signers: Keypair[] = []) {
    const tx = new Transaction();
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = payer.publicKey;
    ixs.forEach((i) => tx.add(i));
    tx.sign(payer, ...signers);
    return context.banksClient.processTransaction(tx);
  }

  /// A classic SPL mint, owned by Tokenkeg.
  async function createSplMint(): Promise<PublicKey> {
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

  /// A Token-2022 mint. `extensions` selects which extension slots are sized into the account;
  /// `initIxs` builds the matching initialise instructions, which MUST run before
  /// `InitializeMint2` — Token-2022 rejects extension initialisation on a live mint.
  /// `freezeAuthority` matters for exactly one fixture: Token-2022 refuses to initialise a mint
  /// with `DefaultAccountState = Frozen` unless it can actually freeze, which is a coherence
  /// rule of its own rather than anything to do with this program.
  async function createT22Mint(
    extensions: ExtensionType[],
    initIxs: (mint: PublicKey) => any[] = () => [],
    freezeAuthority: PublicKey | null = null
  ): Promise<PublicKey> {
    const kp = Keypair.generate();
    const len = getMintLen(extensions);
    const rent = await context.banksClient.getRent();
    await send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: kp.publicKey,
          space: len,
          lamports: Number(rent.minimumBalance(BigInt(len))),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        ...initIxs(kp.publicKey),
        createInitializeMint2Instruction(
          kp.publicKey,
          6,
          payer.publicKey,
          freezeAuthority,
          TOKEN_2022_PROGRAM_ID
        ),
      ],
      [kp]
    );
    return kp.publicKey;
  }

  /// Fund the payer with `amount` of `mint`, creating the ATA if needed.
  async function fund(mint: PublicKey, tokenProgram: PublicKey, amount: bigint) {
    const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, false, tokenProgram);
    await send([
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        ata,
        payer.publicKey,
        mint,
        tokenProgram
      ),
      createMintToInstruction(mint, ata, payer.publicKey, amount, [], tokenProgram),
    ]);
    return ata;
  }

  async function balanceOf(ata: PublicKey): Promise<bigint> {
    const acc = await context.banksClient.getAccount(ata);
    if (!acc) return BigInt(0);
    // SPL / Token-2022 share the first 165 bytes: mint(32) · owner(32) · amount(8) at 64.
    return Buffer.from(acc.data).readBigUInt64LE(64);
  }

  /// Mints sort lexicographically before seeding, exactly as `sort_mints` does on-chain.
  function sorted(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
    return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
  }

  /// Which program owns a mint, read from the chain rather than assumed.
  async function ownerOf(mint: PublicKey): Promise<PublicKey> {
    const acc = await context.banksClient.getAccount(mint);
    return new PublicKey(acc!.owner);
  }

  async function createPool(a: PublicKey, b: PublicKey) {
    const pool = pda([Buffer.from("amm_pool"), a.toBuffer(), b.toBuffer()]);
    return {
      pool,
      call: program.methods
        .createPool(FEE_RATE, PROTO_BPS)
        .accounts({
          creator: payer.publicKey,
          protocolState: statePda,
          tokenAMint: a,
          tokenBMint: b,
          pool,
          lpMint: pda([Buffer.from("lp_mint"), pool.toBuffer()]),
          tokenAVault: pda([Buffer.from("vault_a"), pool.toBuffer()]),
          tokenBVault: pda([Buffer.from("vault_b"), pool.toBuffer()]),
          tokenAProgram: await ownerOf(a),
          tokenBProgram: await ownerOf(b),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any),
    };
  }

  /// Assert that `call` is refused AND that it left no pool account behind (T-7).
  async function refused(a: PublicKey, b: PublicKey, why: string) {
    const { pool, call } = await createPool(a, b);
    let failed = false;
    try {
      await call.rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, why);
    const left = await context.banksClient.getAccount(pool);
    assert.isNull(left, "a refused create_pool must leave no pool account behind");
  }

  before(async () => {
    context = await startAnchor(".", [], []);
    provider = new BankrunProvider(context);
    payer = context.payer;
    program = new anchor.Program(
      JSON.parse(fs.readFileSync("target/idl/soladrome.json", "utf8")),
      provider
    );

    statePda = pda([Buffer.from("state")]);
    usdcMint = await createSplMint();
    splMint = await createSplMint();

    // The friendly case: Token-2022 with no extensions at all.
    t22Mint = await createT22Mint([]);

    // The accounting hazard: 1 % transfer fee, capped high enough to actually bite.
    feeMint = await createT22Mint([ExtensionType.TransferFeeConfig], (m) => [
      createInitializeTransferFeeConfigInstruction(
        m,
        payer.publicKey,
        payer.publicKey,
        100,
        BigInt(1_000_000_000),
        TOKEN_2022_PROGRAM_ID
      ),
    ]);

    // The plumbing hazard: a hook slot pointed at a real program id (armed).
    hookedMint = await createT22Mint([ExtensionType.TransferHook], (m) => [
      createInitializeTransferHookInstruction(
        m,
        payer.publicKey,
        PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID
      ),
    ]);

    // The brick hazard: every new account is born frozen, the pool vault included.
    frozenMint = await createT22Mint(
      [ExtensionType.DefaultAccountState],
      (m) => [
        createInitializeDefaultAccountStateInstruction(
          m,
          AccountState.Frozen,
          TOKEN_2022_PROGRAM_ID
        ),
      ],
      payer.publicKey
    );

    await program.methods
      .initialize(Keypair.generate().publicKey)
      .accounts({
        authority: payer.publicKey,
        protocolState: statePda,
        usdcMint,
        solaM: pda([Buffer.from("sola_mint")]),
        hiSolaM: pda([Buffer.from("hi_sola_mint")]),
        oSolaM: pda([Buffer.from("o_sola_mint")]),
        floorVault: pda([Buffer.from("floor_vault")]),
        marketVault: pda([Buffer.from("market_vault")]),
        solaVault: pda([Buffer.from("sola_vault")]),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await program.methods
      .setPhaseFlags(true, null, null, null, null, null)
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();
  });

  it("[t22] the fixtures are what they claim to be", async () => {
    for (const m of [t22Mint, feeMint, hookedMint, frozenMint]) {
      assert.equal(
        (await ownerOf(m)).toBase58(),
        TOKEN_2022_PROGRAM_ID.toBase58(),
        "the Token-2022 fixtures must be owned by the Token-2022 program"
      );
    }
    assert.equal(
      (await ownerOf(splMint)).toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      "the control fixture must be owned by Tokenkeg"
    );
  });

  // ── T-1 ──────────────────────────────────────────────────────────────────────
  it("☢️ [t22] create_pool ACCEPTS a Token-2022 mint paired with a classic SPL mint", async () => {
    const [a, b] = sorted(splMint, t22Mint);
    const { pool, call } = await createPool(a, b);
    await call.rpc();

    const created = await program.account.ammPool.fetch(pool);
    assert.equal(created.tokenAMint.toBase58(), a.toBase58());
    assert.equal(created.tokenBMint.toBase58(), b.toBase58());

    // The two vaults really do live in different programs — the whole reason the context
    // carries `token_a_program` and `token_b_program` separately.
    const vaultA = await context.banksClient.getAccount(
      pda([Buffer.from("vault_a"), pool.toBuffer()])
    );
    const vaultB = await context.banksClient.getAccount(
      pda([Buffer.from("vault_b"), pool.toBuffer()])
    );
    const owners = [new PublicKey(vaultA!.owner).toBase58(), new PublicKey(vaultB!.owner).toBase58()];
    assert.includeMembers(
      owners,
      [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()],
      "a mixed pair must produce one vault under each token program"
    );
  });

  // ── T-2 ──────────────────────────────────────────────────────────────────────
  it("[t22] acceptance is about the mint, not the side of the pair it sorts to", async () => {
    const [a, b] = sorted(usdcMint, t22Mint);
    const { pool, call } = await createPool(a, b);
    await call.rpc();
    const created = await program.account.ammPool.fetch(pool);
    assert.equal(created.tokenAMint.toBase58(), a.toBase58());
  });

  // ── T-3 ──────────────────────────────────────────────────────────────────────
  it("☢️ [t22] deposit and swap run end to end across the two token programs", async () => {
    const [a, b] = sorted(splMint, t22Mint);
    const pool = pda([Buffer.from("amm_pool"), a.toBuffer(), b.toBuffer()]);
    const lpMint = pda([Buffer.from("lp_mint"), pool.toBuffer()]);
    const vaultA = pda([Buffer.from("vault_a"), pool.toBuffer()]);
    const vaultB = pda([Buffer.from("vault_b"), pool.toBuffer()]);
    const progA = await ownerOf(a);
    const progB = await ownerOf(b);

    const DEP = BigInt(500_000_000);
    const userA = await fund(a, progA, DEP * BigInt(2));
    const userB = await fund(b, progB, DEP * BigInt(2));

    await program.methods
      .addLiquidity(new BN(DEP.toString()), new BN(DEP.toString()), new BN(1))
      .accounts({
        user: payer.publicKey,
        pool,
        lpMint,
        tokenAMint: a,
        tokenBMint: b,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        userTokenA: userA,
        userTokenB: userB,
        userLp: getAssociatedTokenAddressSync(lpMint, payer.publicKey),
        lpDeadAta: getAssociatedTokenAddressSync(lpMint, SystemProgram.programId, true),
        lpDead: SystemProgram.programId,
        lpUserInfo: pda([Buffer.from("lp_user"), pool.toBuffer(), payer.publicKey.toBuffer()]),
        protocolState: statePda,
        oSolaMint: pda([Buffer.from("o_sola_mint")]),
        userOSola: getAssociatedTokenAddressSync(pda([Buffer.from("o_sola_mint")]), payer.publicKey),
        rent: SYSVAR_RENT_PUBKEY,
        tokenAProgram: progA,
        tokenBProgram: progB,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    // Both vaults hold exactly what the reserves claim — the property a transfer fee would break.
    let p = await program.account.ammPool.fetch(pool);
    assert.equal(BigInt(p.reserveA.toString()).toString(), DEP.toString(), "reserve A");
    assert.equal(BigInt(p.reserveB.toString()).toString(), DEP.toString(), "reserve B");
    assert.equal((await balanceOf(vaultA)).toString(), DEP.toString(), "vault A matches reserve A");
    assert.equal((await balanceOf(vaultB)).toString(), DEP.toString(), "vault B matches reserve B");

    // Swap A → B: input moves under program A, output under program B, in one instruction.
    const IN = BigInt(10_000_000);
    const beforeB = await balanceOf(userB);
    await program.methods
      .ammSwap(new BN(IN.toString()), new BN(0), true)
      .accounts({
        user: payer.publicKey,
        pool,
        tokenAMint: a,
        tokenBMint: b,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        userTokenIn: userA,
        userTokenOut: userB,
        marketVault: pda([Buffer.from("market_vault")]),
        protocolState: statePda,
        tokenAProgram: progA,
        tokenBProgram: progB,
      } as any)
      .rpc();

    const afterB = await balanceOf(userB);
    assert.isTrue(afterB > beforeB, "the swap must deliver output across the program boundary");

    p = await program.account.ammPool.fetch(pool);
    assert.equal(
      (await balanceOf(vaultA)).toString(),
      BigInt(p.reserveA.toString()).toString(),
      "vault A and reserve A must still agree after the swap"
    );
    assert.equal(
      (await balanceOf(vaultB)).toString(),
      BigInt(p.reserveB.toString()).toString(),
      "vault B and reserve B must still agree after the swap"
    );

    // And back out again: `remove_liquidity` is the path a hook would break, so it is the one
    // worth exercising explicitly.
    await program.methods
      .removeLiquidity(new BN(1_000_000), new BN(0), new BN(0))
      .accounts({
        user: payer.publicKey,
        pool,
        lpMint,
        tokenAMint: a,
        tokenBMint: b,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        userLp: getAssociatedTokenAddressSync(lpMint, payer.publicKey),
        userTokenA: userA,
        userTokenB: userB,
        lpUserInfo: pda([Buffer.from("lp_user"), pool.toBuffer(), payer.publicKey.toBuffer()]),
        protocolState: statePda,
        oSolaMint: pda([Buffer.from("o_sola_mint")]),
        userOSola: getAssociatedTokenAddressSync(pda([Buffer.from("o_sola_mint")]), payer.publicKey),
        rent: SYSVAR_RENT_PUBKEY,
        tokenAProgram: progA,
        tokenBProgram: progB,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    p = await program.account.ammPool.fetch(pool);
    assert.equal(
      (await balanceOf(vaultB)).toString(),
      BigInt(p.reserveB.toString()).toString(),
      "vault B and reserve B must still agree after the withdrawal"
    );
  });

  // ── T-4 ──────────────────────────────────────────────────────────────────────
  it("☢️ [t22] a transfer-FEE mint is refused — the vault would never match the reserve", async () => {
    const [a, b] = sorted(usdcMint, feeMint);
    await refused(
      a,
      b,
      "create_pool accepted a transfer-fee mint: reserves would drift from the vaults on every trade"
    );
  });

  // ── T-5 ──────────────────────────────────────────────────────────────────────
  it("☢️ [t22] an ARMED transfer hook is refused — its pool could never be withdrawn from", async () => {
    const [a, b] = sorted(usdcMint, hookedMint);
    await refused(a, b, "create_pool accepted an armed transfer hook: remove_liquidity would revert");
  });

  // ── T-6 ──────────────────────────────────────────────────────────────────────
  it("☢️ [t22] a default-FROZEN mint is refused — its vault would be born unusable", async () => {
    const [a, b] = sorted(usdcMint, frozenMint);
    await refused(a, b, "create_pool accepted a default-frozen mint: the vault could never transfer");
  });

  // ── T-8 ──────────────────────────────────────────────────────────────────────
  it("[t22] control: two classic SPL mints still open a pool through the identical call", async () => {
    const [a, b] = sorted(usdcMint, splMint);
    const { pool, call } = await createPool(a, b);
    await call.rpc();

    const created = await program.account.ammPool.fetch(pool);
    assert.equal(created.tokenAMint.toBase58(), a.toBase58());
    assert.equal(created.tokenBMint.toBase58(), b.toBase58());
  });
});
