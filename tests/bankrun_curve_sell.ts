// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs
//
// # Bankrun harness — SOLA sells back down the curve, not at the floor
//
// Until 2026-10-07 `buy_sola` sent the whole premium above the floor to `market_vault`, where it
// was distributed to stakers, and `sell_sola` paid exactly 1 USDC per SOLA whatever the curve
// said: a SOLA bought at 1.5 — or at 5 — sold back for 1. Beradrome, which this protocol ports,
// keeps that premium in its market reserves and pays sellers the curve's price. This file pins
// the port back to it.
//
//   C-1. A buy splits three ways: 1 % to the stakers, 1 per SOLA to the floor, the premium to the
//        market reserve — and the reserve then holds exactly what the curve owes.
//   C-2. A SOLA bought high sells high: well above 1, at the curve's price less the fee.
//   C-3. Selling everything back returns the purchase less the two fees, and puts the curve, the
//        floor and the reserve back where they started.
//   C-4. `min_usdc_out` binds.
//   C-5. A reserve short of what the curve owes refuses the sale; paying the shortfall in through
//        `fund_market_reserve` (permissionless, inflow only) reopens it.
//
// The expected figures are recomputed here from the curve formula, never read back from the
// program: a test that asks the program what it should have done proves nothing.

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { startAnchor, ProgramTestContext } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import { Keypair, PublicKey, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
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

const FEE_BPS = BigInt(100); // CURVE_FEE_BPS
const N = BigInt(1_000_000_000_000); // INIT_VIRTUAL_USDC = INIT_VIRTUAL_SOLA
const K = N * N;
const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));

// ── The curve, recomputed ───────────────────────────────────────────────────

function quoteBuy(vu: bigint, vs: bigint, usdcIn: bigint) {
  const fee = (usdcIn * FEE_BPS) / BigInt(10_000);
  const net = usdcIn - fee;
  const newVu = vu + net;
  const newVs = K / newVu;
  const out = vs - newVs;
  return { fee, out, premium: net - out, newVu, newVs };
}

function quoteSell(vu: bigint, vs: bigint, sola: bigint) {
  const room = N - vs;
  const onCurve = sola < room ? sola : room;
  let proceeds = BigInt(0);
  let newVu = vu;
  let newVs = vs;
  if (onCurve > BigInt(0)) {
    newVs = vs + onCurve;
    const vuAfter = (K + newVs - BigInt(1)) / newVs;
    const raw = vu > vuAfter ? vu - vuAfter : BigInt(0);
    proceeds = raw > onCurve ? raw : onCurve;
    newVu = vu - proceeds;
  }
  const premium = proceeds - onCurve;
  const feeRaw = (proceeds * FEE_BPS) / BigInt(10_000);
  const fee = feeRaw < premium ? feeRaw : premium;
  return { out: sola + premium - fee, fee, reserveOut: premium, newVu, newVs };
}

describe("soladrome — bankrun (curve sell)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: anchor.Program<any>;
  let payer: Keypair;
  let idlJson: any;

  let usdcMint: PublicKey;
  let statePda: PublicKey;
  let solaM: PublicKey;
  let floorV: PublicKey;
  let marketV: PublicKey;
  let reserveV: PublicKey;
  let userUsdc: PublicKey;
  let userSola: PublicKey;

  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  async function send(ixs: any[], signers: Keypair[] = []) {
    const tx = new Transaction();
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = payer.publicKey;
    ixs.forEach((ix) => tx.add(ix));
    tx.sign(payer, ...signers);
    return context.banksClient.processTransaction(tx);
  }

  async function bal(account: PublicKey): Promise<bigint> {
    const raw = await context.banksClient.getAccount(account);
    if (!raw) return BigInt(0);
    return AccountLayout.decode(Buffer.from(raw.data)).amount;
  }

  async function curve() {
    const s: any = await program.account.protocolState.fetch(statePda);
    return { vu: BigInt(s.virtualUsdc.toString()), vs: BigInt(s.virtualSola.toString()) };
  }

  const required = (c: { vu: bigint; vs: bigint }) => c.vu + c.vs - BigInt(2) * N;

  async function expectFailure(fn: () => Promise<any>, name: string) {
    const entry = idlJson.errors.find((e: any) => e.name === name);
    assert.isDefined(entry, `no such error in the IDL: ${name}`);
    const code = entry.code;
    try {
      await fn();
      assert.fail(`expected ${name} (${code}), but the call succeeded`);
    } catch (e: any) {
      const msg = e.toString();
      if (/but the call succeeded/.test(msg)) throw e;
      const decoded = new RegExp(`Error Code: ${name}\\b`).test(msg);
      const raw = msg.includes(`0x${code.toString(16)}`) || msg.includes(`Custom: ${code}`);
      assert.isTrue(decoded || raw, `expected ${name}, got: ${msg}`);
    }
  }

  async function buy(usdcIn: bigint) {
    return program.methods
      .buySola(new BN(usdcIn.toString()), new BN(0))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        userUsdc,
        userSola,
        floorVault: floorV,
        marketVault: marketV,
        marketReserve: reserveV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  async function sell(sola: bigint, minOut: bigint = BigInt(0)) {
    return program.methods
      .sellSola(new BN(sola.toString()), new BN(minOut.toString()))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        userSola,
        floorVault: floorV,
        userUsdc,
        marketReserve: reserveV,
        marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
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
    floorV = pda([Buffer.from("floor_vault")]);
    marketV = pda([Buffer.from("market_vault")]);
    reserveV = pda([Buffer.from("market_reserve")]);

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
    usdcMint = kp.publicKey;

    await program.methods
      .initialize(Keypair.generate().publicKey)
      .accounts({
        authority: payer.publicKey,
        protocolState: statePda,
        usdcMint,
        floorVault: floorV,
        marketVault: marketV,
        marketReserve: reserveV,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
    await program.methods
      .setPhaseFlags(null, null, null, null, true, null) // curve only
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    userUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
    userSola = getAssociatedTokenAddressSync(solaM, payer.publicKey);
    await send([
      createAssociatedTokenAccountInstruction(payer.publicKey, userUsdc, payer.publicKey, usdcMint),
      createMintToInstruction(usdcMint, userUsdc, payer.publicKey, USDC(10_000_000)),
    ]);
  });

  it("C-1 a buy splits into the stakers' fee, the floor and the market reserve", async () => {
    const c0 = await curve();
    const usdcIn = USDC(500_000); // takes the price to ≈ 2.2
    const q = quoteBuy(c0.vu, c0.vs, usdcIn);
    const [floor0, market0, reserve0] = [await bal(floorV), await bal(marketV), await bal(reserveV)];

    await buy(usdcIn);

    assert.equal((await bal(userSola)).toString(), q.out.toString(), "SOLA minted");
    assert.equal((await bal(floorV)) - floor0, q.out, "1 per SOLA to the floor");
    assert.equal((await bal(marketV)) - market0, q.fee, "1 % to the stakers, nothing more");
    assert.equal((await bal(reserveV)) - reserve0, q.premium, "the premium to the reserve");
    assert.equal(q.fee, USDC(5_000));
    const c1 = await curve();
    assert.equal(await bal(reserveV), required(c1), "the reserve holds exactly what the curve owes");
  });

  it("C-2 a SOLA bought high sells high, not at the floor", async () => {
    const c = await curve();
    const sola = USDC(10_000);
    const q = quoteSell(c.vu, c.vs, sola);
    const [usdc0, market0] = [await bal(userUsdc), await bal(marketV)];

    await sell(sola);

    const received = (await bal(userUsdc)) - usdc0;
    assert.equal(received, q.out);
    assert.equal((await bal(marketV)) - market0, q.fee, "the sale fee goes to the stakers");
    // At ≈ 2.2 the old `sell_sola` paid 10 000 USDC for these. The curve pays more than twice that.
    assert.isAbove(Number(received), Number(USDC(21_000)), `paid ${received}`);
    assert.equal(await bal(reserveV), required(await curve()));
  });

  it("C-3 selling everything back returns the purchase less the two fees", async () => {
    const all = await bal(userSola);
    await sell(all);
    const c = await curve();
    assert.equal(c.vu, N, "curve back at its start");
    assert.equal(c.vs, N);
    assert.equal(await bal(reserveV), BigInt(0), "the reserve paid back every premium");
    assert.equal(await bal(floorV), BigInt(0), "the floor paid back every SOLA");
    // 500 000 in; out: 1 % on the way in, ≈ 1 % on the way out (capped at each sale's premium).
    const spent = USDC(10_000_000) - (await bal(userUsdc));
    assert.isAbove(Number(spent), Number(USDC(9_000)));
    assert.isBelow(Number(spent), Number(USDC(10_000)), `round trip cost ${spent}`);
  });

  it("C-4 min_usdc_out binds", async () => {
    await buy(USDC(100_000));
    const c = await curve();
    const sola = USDC(1_000);
    const q = quoteSell(c.vu, c.vs, sola);
    await expectFailure(() => sell(sola, q.out + BigInt(1)), "SlippageExceeded");
    await sell(sola, q.out);
  });

  it("C-5 a reserve short of what the curve owes refuses the sale until the shortfall is paid in", async () => {
    // Simulate a deployment whose premiums were distributed before the reserve existed (devnet).
    const raw = await context.banksClient.getAccount(reserveV);
    const decoded = AccountLayout.decode(Buffer.from(raw!.data));
    const shortfall = USDC(500);
    const held = decoded.amount;
    decoded.amount = held - shortfall;
    const data = Buffer.alloc(raw!.data.length);
    AccountLayout.encode(decoded, data);
    context.setAccount(reserveV, { ...raw!, data });

    await expectFailure(() => sell(USDC(1)), "InsufficientMarketReserve");

    // Anyone may pay in — here a stranger with their own USDC — and nobody may take out.
    const stranger = Keypair.generate();
    const strangerUsdc = getAssociatedTokenAddressSync(usdcMint, stranger.publicKey);
    await send([
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stranger.publicKey, lamports: 1_000_000_000 }),
      createAssociatedTokenAccountInstruction(payer.publicKey, strangerUsdc, stranger.publicKey, usdcMint),
      createMintToInstruction(usdcMint, strangerUsdc, payer.publicKey, shortfall),
    ]);
    await program.methods
      .fundMarketReserve(new BN(shortfall.toString()))
      .accounts({
        funder: stranger.publicKey,
        protocolState: statePda,
        usdcMint,
        marketReserve: reserveV,
        funderUsdc: strangerUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([stranger])
      .rpc();
    assert.equal(await bal(reserveV), held);

    await sell(USDC(1));
  });
});
