// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs
//
// # Bankrun harness — protocol-owned liquidity into SOLA/SOL and SOLA/LST
//
// Until 2026-10-08 `deploy_pol` was hardcoded to one target pool and paired SOLA with USDC only.
// The launch decided that day seeds SOLA/SOL (SOLA/LST with an LST partner), so the POL now:
//
//   - buys its counter-asset with `pol_swap`, on the CANONICAL pools only: USDC → SOL on THE
//     SOL/USDC pool, SOL → LST on THE LST/SOL pool, the latter only once approved;
//   - deposits into any SOLA pool whose other side is USDC, SOL or an approved LST, one LP vault
//     per pool;
//   - refuses a deposit that prices SOLA too far from the curve.
//
//   P-1. USDC → SOL on THE SOL/USDC pool; SOL → LST refused until its pool is approved.
//   P-2. A first deposit into SOLA/SOL at the curve's price lands, LP in that pool's own vault.
//   P-3. A deposit priced 20 % off the curve is refused; a tolerance above the cap is refused.
//   P-4. SOLA/LST: refused without THE LST/SOL pool as a price reference, accepted with it.
//   P-5. SOLA/USDC still works, the counter-asset taken from `pol_usdc_vault` itself.
//   P-6. A SOLA pool paired with anything else is refused.
//
// The expected prices are recomputed here from the reserves, never read back from the program.

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { startAnchor, ProgramTestContext } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import { Keypair, PublicKey, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import * as fs from "fs";

const UNIT = 1_000_000; // 6 decimals: USDC, SOLA
const SOL = 1_000_000_000; // 9 decimals: wSOL, the LST stand-in
const SCALE = BigInt(1_000_000_000_000); // POL_PRICE_SCALE

type Pool = { key: PublicKey; mintA: PublicKey; mintB: PublicKey; lpMint: PublicKey; vaultA: PublicKey; vaultB: PublicKey };

describe("soladrome — bankrun (protocol-owned liquidity)", () => {
  let context: ProgramTestContext;
  let program: anchor.Program<any>;
  let idlJson: any;
  let payer: Keypair;

  let usdcMint: PublicKey;
  let lstMint: PublicKey;
  let tknMint: PublicKey;
  let statePda: PublicKey;
  let solaM: PublicKey;
  let oSolaM: PublicKey;
  let floorV: PublicKey;
  let marketV: PublicKey;
  let reserveV: PublicKey;
  let polState: PublicKey;
  let polUsdc: PublicKey;
  let polSola: PublicKey;

  let hopPool: Pool; // wSOL / USDC
  let lstPool: Pool; // LST / wSOL
  let solaSol: Pool;
  let solaLst: Pool;
  let solaUsdc: Pool;
  let solaTkn: Pool;

  let nonce = 0;
  const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
  const polToken = (mint: PublicKey) => pda([Buffer.from("pol_token"), mint.toBuffer()]);
  const polLpVault = (pool: Pool) => pda([Buffer.from("pol_lp_vault"), pool.key.toBuffer()]);
  const vaultOf = (pool: Pool, mint: PublicKey) => (pool.mintA.equals(mint) ? pool.vaultA : pool.vaultB);

  async function bal(account: PublicKey): Promise<bigint> {
    const raw = await context.banksClient.getAccount(account);
    if (!raw) return BigInt(0);
    return AccountLayout.decode(Buffer.from(raw.data)).amount;
  }

  async function send(ixs: any[], signers: Keypair[] = []) {
    const tx = new Transaction();
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = payer.publicKey;
    tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: ++nonce }));
    ixs.forEach((ix) => tx.add(ix));
    tx.sign(payer, ...signers);
    return context.banksClient.processTransaction(tx);
  }

  async function expectError(promise: Promise<any>, name: string) {
    const entry = idlJson.errors.find((e: any) => e.name === name);
    assert.isDefined(entry, `no such error in the IDL: ${name}`);
    const hex = `0x${entry.code.toString(16)}`;
    let refusal: any = null;
    try {
      await promise;
    } catch (e: any) {
      refusal = e;
    }
    assert.isNotNull(refusal, `expected ${name}, and the transaction went through`);
    const text = JSON.stringify(refusal?.logs ?? refusal?.message ?? refusal);
    assert.isTrue(text.includes(hex) || text.includes(name), `expected ${name} (${hex}), got ${text.slice(0, 400)}`);
  }

  async function newMint(decimals: number): Promise<PublicKey> {
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
        createInitializeMint2Instruction(kp.publicKey, decimals, payer.publicKey, null),
      ],
      [kp]
    );
    return kp.publicKey;
  }

  async function createPool(one: PublicKey, two: PublicKey): Promise<Pool> {
    const [mintA, mintB] = Buffer.compare(one.toBuffer(), two.toBuffer()) <= 0 ? [one, two] : [two, one];
    const key = pda([Buffer.from("amm_pool"), mintA.toBuffer(), mintB.toBuffer()]);
    const pool: Pool = {
      key,
      mintA,
      mintB,
      lpMint: pda([Buffer.from("lp_mint"), key.toBuffer()]),
      vaultA: pda([Buffer.from("vault_a"), key.toBuffer()]),
      vaultB: pda([Buffer.from("vault_b"), key.toBuffer()]),
    };
    await program.methods
      .createPool(30, 2_000)
      .accounts({
        creator: payer.publicKey,
        protocolState: statePda,
        tokenAMint: pool.mintA,
        tokenBMint: pool.mintB,
        pool: pool.key,
        lpMint: pool.lpMint,
        tokenAVault: pool.vaultA,
        tokenBVault: pool.vaultB,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
    return pool;
  }

  async function addLiquidity(pool: Pool, amounts: Map<string, number>) {
    await program.methods
      .addLiquidity(new BN(amounts.get(pool.mintA.toBase58())!), new BN(amounts.get(pool.mintB.toBase58())!), new BN(1))
      .accounts({
        user: payer.publicKey,
        pool: pool.key,
        lpMint: pool.lpMint,
        tokenAMint: pool.mintA,
        tokenBMint: pool.mintB,
        tokenAVault: pool.vaultA,
        tokenBVault: pool.vaultB,
        userTokenA: ata(pool.mintA, payer.publicKey),
        userTokenB: ata(pool.mintB, payer.publicKey),
        userLp: ata(pool.lpMint, payer.publicKey),
        lpDeadAta: ata(pool.lpMint, SystemProgram.programId),
        lpDead: SystemProgram.programId,
        lpUserInfo: pda([Buffer.from("lp_user"), pool.key.toBuffer(), payer.publicKey.toBuffer()]),
        protocolState: statePda,
        oSolaMint: oSolaM,
        userOSola: ata(oSolaM, payer.publicKey),
        rent: SYSVAR_RENT_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
  }

  async function approve(pool: Pool) {
    await program.methods
      .setPoolRewards(true)
      .accounts({ authority: payer.publicKey, protocolState: statePda, pool: pool.key } as any)
      .rpc();
  }

  async function polSwap(pool: Pool, polIn: PublicKey, inMint: PublicKey, outMint: PublicKey, amountIn: bigint) {
    return program.methods
      .polSwap(new BN(amountIn.toString()), new BN(1))
      .accounts({
        authority: payer.publicKey,
        protocolState: statePda,
        polState,
        pool: pool.key,
        poolVaultIn: vaultOf(pool, inMint),
        poolVaultOut: vaultOf(pool, outMint),
        polIn,
        outMint,
        polOut: polToken(outMint),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  async function deployPol(
    pool: Pool,
    counter: PublicKey,
    args: { usdcForSola?: bigint; solaForLp?: bigint; counterForLp?: bigint; maxDevBps?: number; counterRef?: bigint },
    refs: { solUsdc?: PublicKey | null; lstSol?: PublicKey | null } = {}
  ) {
    return program.methods
      .deployPol(
        new BN((args.usdcForSola ?? BigInt(0)).toString()),
        new BN(0),
        new BN((args.solaForLp ?? BigInt(0)).toString()),
        new BN((args.counterForLp ?? BigInt(0)).toString()),
        new BN(1),
        args.maxDevBps ?? 100,
        new BN((args.counterRef ?? (await counterRef(counter))).toString())
      )
      .accounts({
        authority: payer.publicKey,
        protocolState: statePda,
        polState,
        polUsdcVault: polUsdc,
        polSolaAta: polSola,
        counterMint: counter,
        polCounter: counter.equals(usdcMint) ? polUsdc : polToken(counter),
        polLpVault: polLpVault(pool),
        solaMint: solaM,
        floorVault: floorV,
        marketReserve: reserveV,
        pool: pool.key,
        lpMint: pool.lpMint,
        poolTokenAVault: pool.vaultA,
        poolTokenBVault: pool.vaultB,
        solUsdcPool: refs.solUsdc === undefined ? hopPool.key : refs.solUsdc,
        lstSolPool: refs.lstSol === undefined ? null : refs.lstSol,
        lpDeadAta: ata(pool.lpMint, SystemProgram.programId),
        lpDead: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  async function reserves(pool: Pool, mint: PublicKey): Promise<bigint> {
    const p: any = await program.account.ammPool.fetch(pool.key);
    return BigInt((pool.mintA.equals(mint) ? p.reserveA : p.reserveB).toString());
  }

  /// Raw USDC per raw SOLA on the curve, in SCALE units.
  async function curvePrice(): Promise<bigint> {
    const s: any = await program.account.protocolState.fetch(statePda);
    return (BigInt(s.virtualUsdc.toString()) * SCALE) / BigInt(s.virtualSola.toString());
  }

  /// Raw USDC per raw SOL on THE SOL/USDC pool, in SCALE units.
  async function solPrice(): Promise<bigint> {
    return ((await reserves(hopPool, usdcMint)) * SCALE) / (await reserves(hopPool, NATIVE_MINT));
  }

  /// Raw SOL per raw LST on THE LST/SOL pool, in SCALE units.
  async function lstInSol(): Promise<bigint> {
    return ((await reserves(lstPool, NATIVE_MINT)) * SCALE) / (await reserves(lstPool, lstMint));
  }

  /// What the multisig would state for one whole counter token, in USDC base units: here, the
  /// on-chain reference itself (both SOL and the LST have 9 decimals).
  async function counterRef(counter: PublicKey): Promise<bigint> {
    if (counter.equals(usdcMint)) return BigInt(0);
    const sol = await solPrice();
    const px = counter.equals(NATIVE_MINT) ? sol : ((await lstInSol()) * sol) / SCALE;
    return (px * BigInt(SOL)) / SCALE;
  }

  before(async () => {
    context = await startAnchor(".", [], []);
    program = new anchor.Program(JSON.parse(fs.readFileSync("target/idl/soladrome.json", "utf8")), new BankrunProvider(context));
    idlJson = JSON.parse(fs.readFileSync("target/idl/soladrome.json", "utf8"));
    payer = context.payer;

    statePda = pda([Buffer.from("state")]);
    solaM = pda([Buffer.from("sola_mint")]);
    oSolaM = pda([Buffer.from("o_sola_mint")]);
    floorV = pda([Buffer.from("floor_vault")]);
    marketV = pda([Buffer.from("market_vault")]);
    reserveV = pda([Buffer.from("market_reserve")]);
    polState = pda([Buffer.from("pol")]);
    polUsdc = pda([Buffer.from("pol_usdc_vault")]);
    polSola = pda([Buffer.from("pol_sola_ata")]);

    usdcMint = await newMint(6);
    lstMint = await newMint(9);
    tknMint = await newMint(6);

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
      .setPhaseFlags(true, null, null, null, true, null) // lp + curve
      .accounts({ authority: payer.publicKey, protocolState: statePda } as any)
      .rpc();

    const payerWsol = ata(NATIVE_MINT, payer.publicKey);
    await send([
      createAssociatedTokenAccountInstruction(payer.publicKey, ata(usdcMint, payer.publicKey), payer.publicKey, usdcMint),
      createMintToInstruction(usdcMint, ata(usdcMint, payer.publicKey), payer.publicKey, 10_000_000 * UNIT),
      createAssociatedTokenAccountInstruction(payer.publicKey, ata(lstMint, payer.publicKey), payer.publicKey, lstMint),
      createMintToInstruction(lstMint, ata(lstMint, payer.publicKey), payer.publicKey, 100_000 * SOL),
      createAssociatedTokenAccountInstruction(payer.publicKey, ata(tknMint, payer.publicKey), payer.publicKey, tknMint),
      createMintToInstruction(tknMint, ata(tknMint, payer.publicKey), payer.publicKey, 1_000_000 * UNIT),
      createAssociatedTokenAccountInstruction(payer.publicKey, payerWsol, payer.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payerWsol, lamports: 20_000 * SOL }),
      createSyncNativeInstruction(payerWsol),
    ]);

    // Curve at ≈ 1.435: 200k USDC bought through it.
    await program.methods
      .buySola(new BN(200_000 * UNIT), new BN(1))
      .accounts({
        user: payer.publicKey,
        protocolState: statePda,
        solaMint: solaM,
        userUsdc: ata(usdcMint, payer.publicKey),
        userSola: ata(solaM, payer.publicKey),
        floorVault: floorV,
        marketVault: marketV,
        marketReserve: reserveV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();

    hopPool = await createPool(NATIVE_MINT, usdcMint);
    lstPool = await createPool(lstMint, NATIVE_MINT);
    solaSol = await createPool(solaM, NATIVE_MINT);
    solaLst = await createPool(solaM, lstMint);
    solaUsdc = await createPool(solaM, usdcMint);
    solaTkn = await createPool(solaM, tknMint);

    const amounts = (entries: [PublicKey, number][]) => new Map(entries.map(([m, n]) => [m.toBase58(), n]));
    // SOL at 150 USDC; LST at 1.1 SOL, the shape of jitoSOL.
    await addLiquidity(hopPool, amounts([[NATIVE_MINT, 1_000 * SOL], [usdcMint, 150_000 * UNIT]]));
    await addLiquidity(lstPool, amounts([[lstMint, 1_000 * SOL], [NATIVE_MINT, 1_100 * SOL]]));

    await program.methods
      .initializePol(5_000)
      .accounts({
        authority: payer.publicKey,
        protocolState: statePda,
        polState,
        polUsdcVault: polUsdc,
        polSolaAta: polSola,
        usdcMint,
        solaMint: solaM,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
    // POL funds: in production `collect_to_pol` skims fees into it; here they are paid in directly.
    await send([createTransferInstruction(ata(usdcMint, payer.publicKey), polUsdc, payer.publicKey, 500_000 * UNIT)]);
    context.warpToSlot((await context.banksClient.getSlot()) + BigInt(1));
  });

  it("P-1 USDC → SOL on THE SOL/USDC pool; SOL → LST only once its pool is approved", async () => {
    await polSwap(hopPool, polUsdc, usdcMint, NATIVE_MINT, BigInt(30_000 * UNIT));
    const sol = await bal(polToken(NATIVE_MINT));
    assert.isAbove(Number(sol), 150 * SOL, `bought ${sol} lamports of wSOL`);

    await expectError(polSwap(lstPool, polToken(NATIVE_MINT), NATIVE_MINT, lstMint, BigInt(50 * SOL)), "PolInvalidRoute");
    await approve(lstPool);
    await polSwap(lstPool, polToken(NATIVE_MINT), NATIVE_MINT, lstMint, BigInt(50 * SOL));
    assert.isAbove(Number(await bal(polToken(lstMint))), 40 * SOL);

    // Only the two buying legs: selling SOL back into USDC is not a route.
    await expectError(polSwap(hopPool, polToken(NATIVE_MINT), NATIVE_MINT, usdcMint, BigInt(1 * SOL)), "PolInvalidRoute");
  });

  it("P-2 a first deposit into SOLA/SOL at the curve's price lands, LP in that pool's own vault", async () => {
    await deployPol(solaSol, NATIVE_MINT, { usdcForSola: BigInt(20_000 * UNIT) });
    const sola = await bal(polSola);
    assert.isAbove(Number(sola), 10_000 * UNIT);

    const solaForLp = BigInt(5_000 * UNIT);
    // counter raw = SOLA raw × (USDC per SOLA) / (USDC per SOL), both in SCALE units.
    const counterForLp = (solaForLp * (await curvePrice())) / (await solPrice());
    await deployPol(solaSol, NATIVE_MINT, { solaForLp, counterForLp });

    assert.isAbove(Number(await bal(polLpVault(solaSol))), 0, "LP minted into the SOLA/SOL vault");
    assert.equal(await reserves(solaSol, solaM), solaForLp);
    assert.equal(await reserves(solaSol, NATIVE_MINT), counterForLp);
  });

  it("P-3 a pool pushed off the curve, or a first deposit at a wrong price, is refused", async () => {
    const solaForLp = BigInt(1_000 * UNIT);
    const fair = (solaForLp * (await curvePrice())) / (await solPrice());
    await expectError(deployPol(solaSol, NATIVE_MINT, { solaForLp, counterForLp: fair, maxDevBps: 1_001 }), "InvalidAmount");

    // Into an EMPTY pool the deposit sets the price — a wrong ratio there is the costliest mistake.
    await expectError(
      deployPol(solaLst, lstMint, { solaForLp, counterForLp: BigInt(1) }, { lstSol: lstPool.key }),
      "PolPriceDeviation"
    );

    // Into a live pool the deposit follows the pool's ratio, so what matters is where the pool
    // sits: someone sells SOLA into it just before the POL arrives.
    await program.methods
      .ammSwap(new BN(1_500 * UNIT), new BN(1), solaSol.mintA.equals(solaM))
      .accounts({
        user: payer.publicKey,
        pool: solaSol.key,
        tokenAMint: solaSol.mintA,
        tokenBMint: solaSol.mintB,
        tokenAVault: solaSol.vaultA,
        tokenBVault: solaSol.vaultB,
        userTokenIn: ata(solaM, payer.publicKey),
        userTokenOut: ata(NATIVE_MINT, payer.publicKey),
        marketVault: marketV,
        protocolState: statePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
    // 1 500 SOLA into 5 000: the pool now prices SOLA ~40 % under the curve.
    await expectError(deployPol(solaSol, NATIVE_MINT, { solaForLp, counterForLp: fair }), "PolPriceDeviation");
  });

  it("P-4 SOLA/LST needs THE approved LST/SOL pool as its price reference", async () => {
    const solaForLp = BigInt(2_000 * UNIT);
    const lstUsdc = ((await lstInSol()) * (await solPrice())) / SCALE;
    const counterForLp = (solaForLp * (await curvePrice())) / lstUsdc;
    await expectError(deployPol(solaLst, lstMint, { solaForLp, counterForLp }, { lstSol: null }), "PolInvalidRoute");
    // A lookalike reference — any pool other than THE LST/SOL pool — is refused too.
    await expectError(deployPol(solaLst, lstMint, { solaForLp, counterForLp }, { lstSol: solaSol.key }), "PolInvalidRoute");

    await deployPol(solaLst, lstMint, { solaForLp, counterForLp }, { lstSol: lstPool.key });
    assert.isAbove(Number(await bal(polLpVault(solaLst))), 0);
    assert.isAbove(Number(await bal(polLpVault(solaSol))), 0, "and SOLA/SOL keeps its own vault");
  });

  it("P-4b the multisig's stated price bounds the on-chain reference", async () => {
    const solaForLp = BigInt(500 * UNIT);
    const lstUsdc = ((await lstInSol()) * (await solPrice())) / SCALE;
    const counterForLp = (solaForLp * (await curvePrice())) / lstUsdc;
    const ref = await counterRef(lstMint);
    const lst = { lstSol: lstPool.key };
    await expectError(deployPol(solaLst, lstMint, { solaForLp, counterForLp, counterRef: BigInt(0) }, lst), "InvalidAmount");
    // The pools say X, the proposal said X × 1.2: someone moved them, or the proposal is stale.
    // Either way the deposit waits.
    await expectError(
      deployPol(solaLst, lstMint, { solaForLp, counterForLp, counterRef: (ref * BigInt(12)) / BigInt(10) }, lst),
      "PolPriceDeviation"
    );
    const before = await bal(polLpVault(solaLst));
    await deployPol(solaLst, lstMint, { solaForLp, counterForLp, counterRef: (ref * BigInt(1005)) / BigInt(1000) }, lst);
    assert.isAbove(Number(await bal(polLpVault(solaLst))), Number(before), "within 1 % of the stated price, it lands");
  });

  it("P-5 SOLA/USDC still works, paid from pol_usdc_vault itself", async () => {
    const solaForLp = BigInt(1_000 * UNIT);
    const counterForLp = (solaForLp * (await curvePrice())) / SCALE;
    await deployPol(solaUsdc, usdcMint, { solaForLp, counterForLp }, { solUsdc: null });
    assert.equal(await reserves(solaUsdc, usdcMint), counterForLp);
  });

  it("P-6 a SOLA pool paired with anything else is refused", async () => {
    await send([
      createAssociatedTokenAccountInstruction(payer.publicKey, ata(tknMint, polState), polState, tknMint),
    ]);
    await expectError(
      program.methods
        .deployPol(new BN(0), new BN(0), new BN(1_000 * UNIT), new BN(1_000 * UNIT), new BN(1), 100, new BN(1_000_000))
        .accounts({
          authority: payer.publicKey,
          protocolState: statePda,
          polState,
          polUsdcVault: polUsdc,
          polSolaAta: polSola,
          counterMint: tknMint,
          polCounter: ata(tknMint, polState),
          polLpVault: polLpVault(solaTkn),
          solaMint: solaM,
          floorVault: floorV,
          marketReserve: reserveV,
          pool: solaTkn.key,
          lpMint: solaTkn.lpMint,
          poolTokenAVault: solaTkn.vaultA,
          poolTokenBVault: solaTkn.vaultB,
          solUsdcPool: hopPool.key,
          lstSolPool: null,
          lpDeadAta: ata(solaTkn.lpMint, SystemProgram.programId),
          lpDead: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc(),
      "PolInvalidRoute"
    );
  });
});
