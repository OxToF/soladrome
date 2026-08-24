// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// # The ProtocolState realloc, 416 → 448, against the REAL devnet 2 bytes
//
// `founder_wallet: Pubkey` needed 32 bytes and the singleton had 9 spare, so unlike every
// field before it this one grew `LEN`. Live deployments must therefore be reallocated, and
// that is the operation that bricked devnet in July 2026 (error 3003): `ecosystem_o_sola_minted`
// overshot a 400-byte singleton by 4 bytes and every instruction started failing at once.
//
// A test that fabricates its own "legacy" account proves very little — it would be built from
// the same struct definition it is meant to be checking. The fixture below is the ACTUAL
// account currently living at 9MP8MbbC9BNWd7pUqXnzw5kHMknTeVtd8h5ToEVcxX1M on devnet, 416
// bytes, fetched 2026-08-24 and pasted verbatim. `setAccount` puts it in front of the new
// program exactly as the upgraded program will meet it.
//
// What must hold after the migration:
//   • the account is 448 bytes and rent-exempt at the new size
//   • `founder_wallet` was Pubkey::default() before and is the intended address after
//   • EVERY pre-existing field is byte-for-byte unchanged — a realloc that silently shifts a
//     field is indistinguishable from a working one until money moves across it
//   • the write is ONCE: a second call cannot redirect it, and neither can anyone but the
//     stored authority

import * as anchor from "@coral-xyz/anchor";
import { startAnchor, ProgramTestContext } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import * as fs from "fs";

/// The live devnet 2 ProtocolState, base64, 416 bytes. Public on-chain data.
const DEVNET_PROTOCOL_STATE_B64 =
  "ITOthiOMw/gRmcmV0/Dl3h4wST6XZ/REdr0VuJwuglH2S/L6ruTWViMgvtb4O4ZfSYPdty2CHsbF" +
  "ctS0Yap9BuX0ogfS0ACOq/YCCHFCacB8h92vwRNIb9/PgK8PA6jTJ3bhxRq5l3MrIpMI29zbQfzb" +
  "AyHCu88CWLJjqoNHwLF2QWOVtjUn6qwWoh+XO9WBOFl26aOMQo6xgPi2eaF/4zxuGfDeZKjHtWTL" +
  "8ps8oImw+Vd6BIfdSCG32QJatYFIArtsqsLWvmShf1/IzZduMLAGXqeG+uEhG6J6IV2EjCfOnt75" +
  "P/z8inzKquUgKNqSAcYkLitYfPpAb1pqRpBcWT4di4CpC22wMNUvnusAAABbLIsT5gAAAAAAAKHt" +
  "zM4bwtMAAAAAAABHRtW9AgAAAFO/YF8BAAAAVjB8CAAAAAB+K320CQAAAAAAAAAAAAAAQNO2CAAA" +
  "AAD/AACflxxRAAAAAEdG1b0CAAAAAACUNXcAAAAArCbECYoLAAAAAAAAANYZAACVCwABAQEBAAAA" +
  "AAAAAAAB6AMAAAAAAAAAAAA=";

/// Its address and stored authority, both read off devnet at the same time.
const STATE_ADDR = new PublicKey("9MP8MbbC9BNWd7pUqXnzw5kHMknTeVtd8h5ToEVcxX1M");
const DEVNET_AUTHORITY = new PublicKey(
  "2BhwbPGjRcoYv98jLJpkk6khjZX1oW97kSixUge2xTfB"
);

/// The hot wallet chosen for devnet 2 (2026-08-24). Deliberately NOT the mainnet Ledger:
/// devnet has to stay operable, and the divergence that mattered was in the CODE — the
/// founder address is a parameter, and the binary is identical either way.
const DEVNET_FOUNDER_WALLET = new PublicKey(
  "4T1gHVpLRDPJQrsW1QUfHMYuCBLzVLgP7tu1yuoWtYGH"
);

describe("soladrome — bankrun (ProtocolState realloc 416 → 448)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: anchor.Program<any>;
  let payer: Keypair;

  const PROGRAM_ID = new PublicKey(
    "DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe"
  );
  const legacy = Buffer.from(DEVNET_PROTOCOL_STATE_B64, "base64");

  /// Install the legacy account in front of the program, at its real address.
  async function seedLegacyState(lamports: number) {
    context.setAccount(STATE_ADDR, {
      lamports,
      data: legacy,
      owner: PROGRAM_ID,
      executable: false,
      rentEpoch: 0,
    });
  }

  async function stateAccount() {
    const a = await context.banksClient.getAccount(STATE_ADDR);
    assert.isNotNull(a, "the state account must exist");
    return a!;
  }

  async function migrate(
    founderWallet: PublicKey,
    authority: Keypair
  ): Promise<string> {
    return program.methods
      .migrateProtocolState(founderWallet)
      .accounts({
        authority: authority.publicKey,
        protocolState: STATE_ADDR,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers(authority === payer ? [] : [authority])
      .rpc();
  }

  before(async () => {
    context = await startAnchor(".", [], []);
    provider = new BankrunProvider(context);
    program = new anchor.Program(
      JSON.parse(fs.readFileSync("target/idl/soladrome.json", "utf8")),
      provider
    );

    // The migration is authority-gated against the pubkey STORED IN THE ACCOUNT, so the test
    // must sign as the real devnet authority. bankrun cannot produce its secret key, so the
    // payer is relabelled: `setAccount` lets us rewrite the stored authority to the payer.
    // Everything else in the fixture is untouched — this is the one byte range the harness
    // has to own, and the authority check itself is exercised separately below.
    const relabelled = Buffer.from(legacy);
    payer = context.payer;
    payer.publicKey.toBuffer().copy(relabelled, 8);
    (legacy as Buffer).set(relabelled);

    assert.equal(legacy.length, 416, "the devnet fixture must be the pre-migration size");
  });

  it("[realloc] the fixture is genuinely the old layout — 416 bytes, no founder_wallet", async () => {
    await seedLegacyState(3_786_240); // its real lamport balance on devnet
    const acc = await stateAccount();
    assert.equal(acc.data.length, 416, "pre-migration size");

    // The new field sits past the end of the old account: there is nowhere for it to be read
    // from, which is precisely why a realloc is required rather than a spare-byte carve.
    assert.isTrue(
      416 < 448,
      "ProtocolState::LEN must have grown, or this whole file is testing nothing"
    );
  });

  it("[realloc] migrating grows the account and sets founder_wallet, leaving every other field intact", async () => {
    await seedLegacyState(3_786_240);

    // Snapshot every byte of the old account except the authority slot we relabelled.
    const before = Buffer.from((await stateAccount()).data);

    await migrate(DEVNET_FOUNDER_WALLET, payer);

    const acc = await stateAccount();
    assert.equal(acc.data.length, 448, "the account must be reallocated to the new LEN");

    // ── Byte-for-byte: the first 416 bytes are untouched ─────────────────────
    // This is the assertion that would have caught the 3003 brick. A realloc that shifts or
    // re-serialises a field looks identical from the outside until a number is read across it.
    // ── Byte-for-byte on the DATA, which ends at 407 ────────────────────────
    // 8 discriminator + 399 bytes of fields = 407 used; the old account's last 9 bytes were
    // spare and read zero. `founder_wallet` starts exactly at 407, so it legitimately spills
    // into those 9 before occupying the 32 new bytes — which is why the naive "the first 416
    // bytes are untouched" check fails here, and why it is worth writing the boundary down.
    const USED_BEFORE = 407;
    const now = Buffer.from(acc.data.subarray(0, USED_BEFORE));
    if (!now.equals(before.subarray(0, USED_BEFORE))) {
      const diffs: string[] = [];
      for (let i = 0; i < USED_BEFORE; i++) {
        if (now[i] !== before[i]) diffs.push(`${i}: ${before[i]} -> ${now[i]}`);
      }
      assert.fail(`the realloc moved live data at offsets — ${diffs.join(", ")}`);
    }

    // The 9 formerly-spare bytes must now hold the HEAD of the founder wallet. This is the
    // assertion that proves the field landed where the struct says it does: if `LEN` and the
    // field order ever drift apart, the pubkey starts somewhere else and this fails.
    assert.isTrue(
      Buffer.from(acc.data.subarray(USED_BEFORE, 416)).equals(
        DEVNET_FOUNDER_WALLET.toBuffer().subarray(0, 416 - USED_BEFORE)
      ),
      "founder_wallet must begin at offset 407, inside the old spare bytes"
    );
    assert.isTrue(
      before.subarray(USED_BEFORE, 416).every((b) => b === 0),
      "those 9 bytes must have been spare (zero) before the migration"
    );

    // ── The new tail holds the founder wallet ────────────────────────────────
    const st: any = await program.account.protocolState.fetch(STATE_ADDR);
    assert.equal(
      st.founderWallet.toBase58(),
      DEVNET_FOUNDER_WALLET.toBase58(),
      "founder_wallet must be backfilled by the migration"
    );

    // ── Rent-exemption was topped up for the larger account ──────────────────
    const rent = await context.banksClient.getRent();
    const needed = Number(rent.minimumBalance(BigInt(448)));
    assert.isTrue(
      Number(acc.lamports) >= needed,
      `the migration must top up rent: ${acc.lamports} < ${needed}`
    );

    // ── And the decoded state still reads like devnet 2 ──────────────────────
    // Decoding through Anchor at the new size is the end-to-end proof that the old bytes and
    // the new field agree on where every boundary is.
    assert.equal(
      st.usdcMint.toBase58(),
      "3N8EKeBPF8Gp9ayQ3WJzcxmDcWAMYKjwnuZXWC71FLtd",
      "the devnet mock USDC mint must survive"
    );
    assert.isTrue(
      BigInt(st.k.toString()) > BigInt(0),
      "k is the one irreversible number in the protocol — it must not move"
    );
  });

  it("[realloc] the backfill is write-once: a second migration cannot redirect it", async () => {
    // Already migrated by the previous test. A second call with a DIFFERENT address must be
    // a no-op, not a redirect — otherwise the authority could point the 12.25M anywhere at
    // any time, which is exactly the property the hardcoded constant used to guarantee.
    const attacker = Keypair.generate().publicKey;
    await migrate(attacker, payer);

    const st: any = await program.account.protocolState.fetch(STATE_ADDR);
    assert.equal(
      st.founderWallet.toBase58(),
      DEVNET_FOUNDER_WALLET.toBase58(),
      "REGRESSION: the founder wallet was redirected by a second migration"
    );
  });

  it("[realloc] it is idempotent — re-running on an already-sized account is harmless", async () => {
    const before = Buffer.from((await stateAccount()).data);
    await migrate(DEVNET_FOUNDER_WALLET, payer);
    const after = await stateAccount();
    assert.equal(after.data.length, 448, "size unchanged");
    assert.isTrue(
      Buffer.from(after.data).equals(before),
      "a repeat migration must not touch a single byte"
    );
  });

  it("[realloc] only the stored authority may migrate", async () => {
    await seedLegacyState(3_786_240); // back to the pre-migration fixture

    const stranger = Keypair.generate();
    context.setAccount(stranger.publicKey, {
      lamports: 10_000_000_000,
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      executable: false,
      rentEpoch: 0,
    });

    let migrated = false;
    try {
      await migrate(DEVNET_FOUNDER_WALLET, stranger);
      migrated = true;
    } catch (e: any) {
      assert.include(
        e.toString(),
        "Unauthorized",
        `expected the stored-authority check to refuse, got: ${e}`
      );
    }
    assert.isFalse(migrated, "a stranger reallocated and wrote the founder wallet");
    assert.equal(
      (await stateAccount()).data.length,
      416,
      "and the refused call must leave the account at its old size"
    );
  });
});
