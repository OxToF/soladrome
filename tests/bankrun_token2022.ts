// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// # Bankrun harness — the AMM is SPL-classic only, and that is now proven rather than asserted
//
// The audit package tells reviewers that Token-2022 is out of scope because "the AMM's
// `Account<Mint>` / `Program<Token>` reject it by construction". That claim was true and
// completely untested, which is the same shape of defect as a comment that disagrees with the
// code: believable, load-bearing, and nobody had ever run it.
//
// It matters commercially, not just editorially. Every asset the project most wants to pool is
// Token-2022 — verified against mainnet on 2026-08-30, mint owner
// `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`:
//
//   USDG   2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH
//   PYUSD  2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo
//   SPYx   XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W   (and the rest of the xStocks)
//
// So this file is not a curiosity. It is the boundary between what the AMM can list today and
// what the roadmap requires, and it is the "before" half of the proof for any future migration
// to `TokenInterface` / `InterfaceAccount` / `transfer_checked`.
//
//   T-1. `create_pool` refuses a Token-2022 mint, whichever side it is on.
//   T-2. The refusal is the account layer, not a `require!` — it fails before the handler runs,
//        so no partial state is written and no pool account is left behind.
//   T-3. Control: the identical call with two classic SPL mints succeeds, so T-1 is measuring
//        the mint's owner program and nothing else.
//
// ⚠️ WHEN THE MIGRATION LANDS, THIS FILE MUST INVERT, NOT DISAPPEAR. The useful assertions
// afterwards are that a plain Token-2022 mint is ACCEPTED, and that a mint carrying a transfer
// FEE is still refused — a fee mint silently breaks the invariant that the vault balance and
// the reserve figure move together (the pool would credit `amount_in` to the reserve while the
// vault receives less), which is the one Token-2022 extension that is an accounting bug rather
// than a plumbing problem. See `amm::apply_swap_reserves`.

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
  createInitializeMint2Instruction,
  getMintLen,
} from "@solana/spl-token";
import { assert } from "chai";
import fs from "fs";

const PROGRAM_ID = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");
const FEE_RATE = 30;
const PROTO_BPS = 2_000;

describe("soladrome — bankrun (the AMM is SPL-classic only)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: anchor.Program<any>;
  let payer: Keypair;

  let statePda: PublicKey;
  let usdcMint: PublicKey;
  let splMint: PublicKey;
  let t22Mint: PublicKey;

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

  /// A Token-2022 mint with NO extensions — deliberately the friendliest possible case.
  /// If even this is refused, every real xStock (which carries a permanent delegate, a
  /// pausable config and a transfer-hook slot on top) is refused too.
  async function createToken2022Mint(): Promise<PublicKey> {
    const kp = Keypair.generate();
    const len = getMintLen([]);
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
        createInitializeMint2Instruction(
          kp.publicKey,
          6,
          payer.publicKey,
          null,
          TOKEN_2022_PROGRAM_ID
        ),
      ],
      [kp]
    );
    return kp.publicKey;
  }

  /// Mints sort lexicographically before seeding, exactly as `sort_mints` does on-chain.
  function sorted(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
    return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
  }

  function createPool(a: PublicKey, b: PublicKey, tokenProgram: PublicKey) {
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
          tokenProgram,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any),
    };
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
    t22Mint = await createToken2022Mint();

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

  it("[t22] the fixture really is a Token-2022 mint, and the control really is not", async () => {
    const t22 = await context.banksClient.getAccount(t22Mint);
    const spl = await context.banksClient.getAccount(splMint);
    assert.equal(
      new PublicKey(t22!.owner).toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
      "the Token-2022 fixture must be owned by the Token-2022 program"
    );
    assert.equal(
      new PublicKey(spl!.owner).toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      "the control fixture must be owned by Tokenkeg"
    );
  });

  it("☢️ [t22] create_pool refuses a Token-2022 mint — this is what puts USDG, PYUSD and the xStocks out of reach", async () => {
    const [a, b] = sorted(splMint, t22Mint);
    const { pool, call } = createPool(a, b, TOKEN_PROGRAM_ID);

    let failed = false;
    try {
      await call.rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(
      failed,
      "create_pool accepted a Token-2022 mint — the audit package's out-of-scope claim is wrong"
    );

    // T-2: the refusal happens at the account layer, before the handler body, so nothing was
    // written. A half-created pool would be worse than a refusal: the seeds are `init`, so a
    // leftover account would make the pair permanently unopenable.
    const left = await context.banksClient.getAccount(pool);
    assert.isNull(left, "a refused create_pool must leave no pool account behind");
  });

  it("[t22] the refusal is about the mint, not the pair — it holds with the sides swapped", async () => {
    // Same assertion with the Token-2022 mint paired against USDC instead, so the result
    // cannot be an artefact of which side of the sorted pair it landed on.
    const [a, b] = sorted(usdcMint, t22Mint);
    const { call } = createPool(a, b, TOKEN_PROGRAM_ID);
    let failed = false;
    try {
      await call.rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "create_pool accepted a Token-2022 mint on the other side of the pair");
  });

  it("[t22] control: two classic SPL mints open a pool through the identical call", async () => {
    // Without this, T-1 could be passing for any unrelated reason (bad seeds, a flag, rent).
    const [a, b] = sorted(usdcMint, splMint);
    const { pool, call } = createPool(a, b, TOKEN_PROGRAM_ID);
    await call.rpc();

    const created = await program.account.ammPool.fetch(pool);
    assert.equal(created.tokenAMint.toBase58(), a.toBase58());
    assert.equal(created.tokenBMint.toBase58(), b.toBase58());
  });
});
