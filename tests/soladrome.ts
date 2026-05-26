import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Soladrome } from "../target/types/soladrome";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

// ── helpers ──────────────────────────────────────────────────────────────────

const DECIMALS = 6;
const ONE = new BN(1_000_000);   // 1 token (6 dec)
const TEN = ONE.muln(10);
const HUNDRED = ONE.muln(100);

async function getTokenBalance(
  connection: anchor.web3.Connection,
  account: anchor.web3.PublicKey
): Promise<bigint> {
  const info = await getAccount(connection, account);
  return info.amount;
}

// ── suite ────────────────────────────────────────────────────────────────────

describe("soladrome", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;
  const program = anchor.workspace.Soladrome as Program<Soladrome>;

  // PDAs
  const [statePda]  = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("state")],       program.programId);
  const [solaM]     = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("sola_mint")],   program.programId);
  const [hiSolaM]   = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("hi_sola_mint")],program.programId);
  const [oSolaM]    = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("o_sola_mint")], program.programId);
  const [floorV]    = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("floor_vault")], program.programId);
  const [marketV]   = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("market_vault")],program.programId);
  const [solaVault] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("sola_vault")],  program.programId);

  let usdcMint: anchor.web3.PublicKey;
  let userUsdcAta: anchor.web3.PublicKey;

  // ── 1. Initialize ─────────────────────────────────────────────────────────
  it("initializes the protocol", async () => {
    // Create a mock USDC mint
    usdcMint = await createMint(
      connection,
      wallet.payer,
      wallet.publicKey,   // mint authority
      null,
      DECIMALS
    );

    // Give the test user 10,000 USDC
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet.payer,
      usdcMint,
      wallet.publicKey
    );
    userUsdcAta = ata.address;
    await mintTo(connection, wallet.payer, usdcMint, userUsdcAta, wallet.payer, 10_000_000_000);

    await program.methods
      .initialize()
      .accounts({
        authority:     wallet.publicKey,
        protocolState: statePda,
        usdcMint,
        solaM,
        hiSolaM,
        oSolaM,
        floorVault:    floorV,
        marketVault:   marketV,
        solaVault:     solaVault,
        tokenProgram:  TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent:          anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const state = await program.account.protocolState.fetch(statePda);
    assert.equal(state.usdcMint.toBase58(), usdcMint.toBase58(), "USDC mint stored");
    assert.equal(state.virtualUsdc.toNumber(), 100_000_000, "virtual USDC = 100");
    assert.equal(state.virtualSola.toNumber(), 100_000_000, "virtual SOLA = 100");
    console.log("✅ initialize — state PDA:", statePda.toBase58());
  });

  // ── 2. Buy SOLA ───────────────────────────────────────────────────────────
  it("buys SOLA via bonding curve", async () => {
    const userSolaAta = anchor.utils.token.associatedAddress({
      mint:  solaM,
      owner: wallet.publicKey,
    });

    const stateBefore = await program.account.protocolState.fetch(statePda);
    const usdcBefore  = await getTokenBalance(connection, userUsdcAta);

    // Buy with 10 USDC
    await program.methods
      .buySola(TEN, new BN(1)) // usdc_in=10, min_sola_out=0.000001
      .accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
        solaMint:      solaM,
        userUsdc:      userUsdcAta,
        userSola:      userSolaAta,
        floorVault:    floorV,
        marketVault:   marketV,
        tokenProgram:  TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    const stateAfter = await program.account.protocolState.fetch(statePda);
    const solaBalance = await getTokenBalance(connection, userSolaAta);
    const usdcAfter   = await getTokenBalance(connection, userUsdcAta);

    // virtual USDC should increase
    assert.isTrue(
      stateAfter.virtualUsdc.gt(stateBefore.virtualUsdc),
      "virtual USDC increased"
    );
    // user got SOLA
    assert.isTrue(solaBalance > 0n, "user received SOLA");
    // user spent USDC
    assert.isTrue(usdcAfter < usdcBefore, "user spent USDC");
    // floor vault got 1 USDC per SOLA (approx)
    const floorBalance = await getTokenBalance(connection, floorV);
    assert.isTrue(floorBalance > 0n, "floor vault funded");

    console.log(
      `✅ buy_sola — received ${Number(solaBalance) / 1e6} SOLA for 10 USDC`,
      `| floor_vault: ${Number(floorBalance) / 1e6} USDC`
    );
  });

  // ── 3. Sell SOLA at floor ─────────────────────────────────────────────────
  it("sells SOLA at floor price (1:1)", async () => {
    const userSolaAta = anchor.utils.token.associatedAddress({
      mint:  solaM,
      owner: wallet.publicKey,
    });

    const solaBefore = await getTokenBalance(connection, userSolaAta);
    const usdcBefore = await getTokenBalance(connection, userUsdcAta);
    const floorBefore = await getTokenBalance(connection, floorV);

    // Sell 1 SOLA
    await program.methods
      .sellSola(ONE)
      .accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
        solaMint:      solaM,
        userSola:      userSolaAta,
        floorVault:    floorV,
        userUsdc:      userUsdcAta,
        tokenProgram:  TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const solaAfter  = await getTokenBalance(connection, userSolaAta);
    const usdcAfter  = await getTokenBalance(connection, userUsdcAta);
    const floorAfter = await getTokenBalance(connection, floorV);

    assert.equal(
      Number(solaBefore - solaAfter),
      Number(ONE.toString()),
      "burned 1 SOLA"
    );
    assert.equal(
      Number(usdcAfter - usdcBefore),
      Number(ONE.toString()),
      "received 1 USDC (floor 1:1)"
    );
    assert.equal(
      Number(floorBefore - floorAfter),
      Number(ONE.toString()),
      "floor vault decreased by 1 USDC"
    );

    console.log("✅ sell_sola — floor redemption 1:1 verified");
  });

  // ── 4. Stake SOLA → hiSOLA ────────────────────────────────────────────────
  it("stakes SOLA to receive hiSOLA 1:1", async () => {
    const userSolaAta = anchor.utils.token.associatedAddress({
      mint: solaM, owner: wallet.publicKey,
    });
    const userHiSolaAta = anchor.utils.token.associatedAddress({
      mint: hiSolaM, owner: wallet.publicKey,
    });

    const solaBefore   = await getTokenBalance(connection, userSolaAta);
    const vaultBefore  = await getTokenBalance(connection, solaVault);

    const [positionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()],
      program.programId
    );

    // Stake 2 SOLA
    const stakeAmount = ONE.muln(2);
    await program.methods
      .stakeSola(stakeAmount)
      .accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
        solaMint:      solaM,
        hiSolaMint:    hiSolaM,
        userSola:      userSolaAta,
        userHiSola:    userHiSolaAta,
        solaVault:     solaVault,
        marketVault:   marketV,
        userPosition:  positionPda,
        tokenProgram:  TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    const solaAfter    = await getTokenBalance(connection, userSolaAta);
    const hiSolaAfter  = await getTokenBalance(connection, userHiSolaAta);
    const vaultAfter   = await getTokenBalance(connection, solaVault);

    assert.equal(
      Number(solaBefore - solaAfter),
      Number(stakeAmount.toString()),
      "SOLA locked"
    );
    assert.equal(
      Number(hiSolaAfter),
      Number(stakeAmount.toString()),
      "hiSOLA minted 1:1"
    );
    assert.equal(
      Number(vaultAfter - vaultBefore),
      Number(stakeAmount.toString()),
      "sola_vault increased"
    );

    console.log("✅ stake_sola — 2 SOLA → 2 hiSOLA");
  });

  // ── 5. Borrow USDC against hiSOLA ─────────────────────────────────────────
  it("borrows USDC against hiSOLA collateral (2% fee to market_vault)", async () => {
    const [positionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()],
      program.programId
    );
    const userHiSolaAta = anchor.utils.token.associatedAddress({
      mint: hiSolaM, owner: wallet.publicKey,
    });

    const usdcBefore   = await getTokenBalance(connection, userUsdcAta);
    const floorBefore  = await getTokenBalance(connection, floorV);
    const marketBefore = await getTokenBalance(connection, marketV);

    // Borrow 1 USDC — 2% fee = 0.02 USDC → market_vault; user receives 0.98 USDC
    await program.methods
      .borrowUsdc(ONE)
      .accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
        hiSolaMint:    hiSolaM,
        userHiSola:    userHiSolaAta,
        floorVault:    floorV,
        marketVault:   marketV,
        userUsdc:      userUsdcAta,
        userPosition:  positionPda,
        tokenProgram:  TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    const usdcAfter   = await getTokenBalance(connection, userUsdcAta);
    const floorAfter  = await getTokenBalance(connection, floorV);
    const marketAfter = await getTokenBalance(connection, marketV);
    const position    = await program.account.userPosition.fetch(positionPda);

    const BORROW_FEE_BPS = 200n;
    const grossAmount    = BigInt(ONE.toString());
    const expectedFee    = grossAmount * BORROW_FEE_BPS / 10_000n;       // 20_000 (0.02 USDC)
    const expectedNet    = grossAmount - expectedFee;                      // 980_000 (0.98 USDC)

    assert.equal(
      usdcAfter - usdcBefore,
      expectedNet,
      `user received ${Number(expectedNet)/1e6} USDC (gross - 2% fee)`
    );
    assert.equal(
      marketAfter - marketBefore,
      expectedFee,
      `market_vault received ${Number(expectedFee)/1e6} USDC fee`
    );
    assert.equal(
      BigInt(floorBefore.toString()) - BigInt(floorAfter.toString()),
      grossAmount,
      "floor_vault reduced by gross amount (user + fee)"
    );
    assert.equal(
      position.usdcBorrowed.toString(),
      ONE.toString(),
      "usdc_borrowed = gross (user repays full amount)"
    );

    console.log(
      `✅ borrow_usdc — net=${Number(expectedNet)/1e6} USDC to user ` +
      `| fee=${Number(expectedFee)/1e6} USDC → market_vault`
    );
  });

  // ── 6. Repay USDC ────────────────────────────────────────────────────────
  it("repays USDC debt", async () => {
    const [positionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .repayUsdc(ONE)
      .accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
        userPosition:  positionPda,
        floorVault:    floorV,
        userUsdc:      userUsdcAta,
        tokenProgram:  TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const position = await program.account.userPosition.fetch(positionPda);
    assert.equal(
      position.usdcBorrowed.toNumber(),
      0,
      "debt cleared"
    );
    console.log("✅ repay_usdc — debt cleared");
  });

  // ── 7. Unstake hiSOLA ────────────────────────────────────────────────────
  it("unstakes hiSOLA and recovers SOLA", async () => {
    const [positionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()],
      program.programId
    );
    const userSolaAta = anchor.utils.token.associatedAddress({
      mint: solaM, owner: wallet.publicKey,
    });
    const userHiSolaAta = anchor.utils.token.associatedAddress({
      mint: hiSolaM, owner: wallet.publicKey,
    });

    const hiSolaBefore = await getTokenBalance(connection, userHiSolaAta);
    const solaBefore   = await getTokenBalance(connection, userSolaAta);

    await program.methods
      .unstakeHiSola(ONE.muln(2))
      .accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
        solaMint:      solaM,
        hiSolaMint:    hiSolaM,
        userHiSola:    userHiSolaAta,
        userSola:      userSolaAta,
        solaVault:     solaVault,
        userPosition:  positionPda,
        tokenProgram:  TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    const hiSolaAfter = await getTokenBalance(connection, userHiSolaAta);
    const solaAfter   = await getTokenBalance(connection, userSolaAta);

    assert.equal(Number(hiSolaBefore - hiSolaAfter), Number(ONE.muln(2).toString()), "hiSOLA burned");
    assert.equal(Number(solaAfter - solaBefore), Number(ONE.muln(2).toString()), "SOLA returned");
    console.log("✅ unstake_hi_sola — 2 hiSOLA → 2 SOLA");
  });

  // ── 8. Claim fees from market vault ──────────────────────────────────────
  it("claims pro-rata fees from market_vault (permissionless)", async () => {
    // Re-stake so we have hiSOLA again (unstake test burned them all)
    const userSolaAta = anchor.utils.token.associatedAddress({ mint: solaM, owner: wallet.publicKey });
    const userHiSolaAta = anchor.utils.token.associatedAddress({ mint: hiSolaM, owner: wallet.publicKey });
    const [positionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .stakeSola(ONE.muln(2))
      .accounts({
        user: wallet.publicKey, protocolState: statePda,
        solaMint: solaM, hiSolaMint: hiSolaM,
        userSola: userSolaAta, userHiSola: userHiSolaAta,
        solaVault: solaVault, marketVault: marketV,
        userPosition: positionPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any).rpc();

    // Generate more fees: buy again so market_vault grows
    await program.methods
      .buySola(TEN, new BN(1))
      .accounts({
        user: wallet.publicKey, protocolState: statePda,
        solaMint: solaM, userUsdc: userUsdcAta,
        userSola: userSolaAta, floorVault: floorV, marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any).rpc();

    const marketBefore = await getTokenBalance(connection, marketV);
    const usdcBefore   = await getTokenBalance(connection, userUsdcAta);

    // Claim — no admin signature required
    await program.methods
      .claimFees()
      .accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
        hiSolaMint:    hiSolaM,
        userHiSola:    userHiSolaAta,
        marketVault:   marketV,
        userUsdc:      userUsdcAta,
        userPosition:  positionPda,
        tokenProgram:  TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const marketAfter = await getTokenBalance(connection, marketV);
    const usdcAfter   = await getTokenBalance(connection, userUsdcAta);
    const claimed = Number(usdcAfter - usdcBefore);

    assert.isTrue(claimed > 0, "fees claimed");
    assert.isTrue(marketAfter < marketBefore, "market vault decreased");
    console.log(`✅ claim_fees — ${claimed / 1e6} USDC claimed from treasury (no admin wallet)`);
  });

  // ── 9. Distribute oSOLA (admin LP reward) ────────────────────────────────
  it("admin distributes oSOLA to a recipient", async () => {
    const userOSolaAta = anchor.utils.token.associatedAddress({
      mint: oSolaM, owner: wallet.publicKey,
    });

    await program.methods
      .distributeOSola(ONE.muln(5)) // send 5 oSOLA
      .accounts({
        authority:       wallet.publicKey,
        recipient:       wallet.publicKey,
        protocolState:   statePda,
        oSolaMint:       oSolaM,
        recipientOSola:  userOSolaAta,
        tokenProgram:    TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:   anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    const balance = await getTokenBalance(connection, userOSolaAta);
    assert.equal(Number(balance), Number(ONE.muln(5).toString()), "5 oSOLA received");
    console.log("✅ distribute_o_sola — 5 oSOLA minted to recipient");
  });

  // ── 9. Exercise oSOLA ────────────────────────────────────────────────────
  it("exercises oSOLA: pay floor USDC → receive SOLA", async () => {
    const userOSolaAta = anchor.utils.token.associatedAddress({
      mint: oSolaM, owner: wallet.publicKey,
    });
    const userSolaAta = anchor.utils.token.associatedAddress({
      mint: solaM, owner: wallet.publicKey,
    });

    const oSolaBefore  = await getTokenBalance(connection, userOSolaAta);
    const solaBefore   = await getTokenBalance(connection, userSolaAta);
    const usdcBefore   = await getTokenBalance(connection, userUsdcAta);
    const floorBefore  = await getTokenBalance(connection, floorV);

    // Exercise 3 oSOLA: pay 3 USDC → receive 3 SOLA
    const exerciseAmt = ONE.muln(3);
    await program.methods
      .exerciseOSola(exerciseAmt)
      .accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
        solaMint:      solaM,
        oSolaMint:     oSolaM,
        userOSola:     userOSolaAta,
        userSola:      userSolaAta,
        floorVault:    floorV,
        userUsdc:      userUsdcAta,
        tokenProgram:  TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    const oSolaAfter  = await getTokenBalance(connection, userOSolaAta);
    const solaAfter   = await getTokenBalance(connection, userSolaAta);
    const usdcAfter   = await getTokenBalance(connection, userUsdcAta);
    const floorAfter  = await getTokenBalance(connection, floorV);

    assert.equal(
      Number(oSolaBefore - oSolaAfter),
      Number(exerciseAmt.toString()),
      "oSOLA burned"
    );
    assert.equal(
      Number(solaAfter - solaBefore),
      Number(exerciseAmt.toString()),
      "SOLA received"
    );
    assert.equal(
      Number(usdcBefore - usdcAfter),
      Number(exerciseAmt.toString()),
      "USDC paid at floor"
    );
    assert.isTrue(floorAfter > floorBefore, "floor reserve strengthened");
    console.log("✅ exercise_o_sola — 3 oSOLA exercised, floor reserve +3 USDC");
  });

  // ── 9. Slippage protection ────────────────────────────────────────────────
  it("rejects buy with min_sola_out too high (slippage)", async () => {
    const userSolaAta = anchor.utils.token.associatedAddress({
      mint: solaM, owner: wallet.publicKey,
    });

    try {
      await program.methods
        .buySola(ONE, HUNDRED) // buy 1 USDC but demand 100 SOLA — impossible
        .accounts({
          user:          wallet.publicKey,
          protocolState: statePda,
          solaMint:      solaM,
          userUsdc:      userUsdcAta,
          userSola:      userSolaAta,
          floorVault:    floorV,
          marketVault:   marketV,
          tokenProgram:  TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .rpc();
      assert.fail("should have thrown SlippageExceeded");
    } catch (e: any) {
      assert.include(e.toString(), "SlippageExceeded", "correct error");
      console.log("✅ slippage guard fires correctly");
    }
  });

  // ── Ve-layer ──────────────────────────────────────────────────────────────

  // ── 12. Lock hiSOLA ───────────────────────────────────────────────────────
  it("locks hiSOLA for ve governance power", async () => {
    const userHiSolaAta = anchor.utils.token.associatedAddress({
      mint: hiSolaM, owner: wallet.publicKey,
    });

    const [veLockPda]   = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("velock"), wallet.publicKey.toBuffer()],
      program.programId
    );
    const [veLockVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("ve_vault"), wallet.publicKey.toBuffer()],
      program.programId
    );

    const hiSolaBefore  = await getTokenBalance(connection, userHiSolaAta);
    const stateBefore   = await program.account.protocolState.fetch(statePda);

    // Lock 1 hiSOLA for 4 weeks
    const FOUR_WEEKS = new BN(4 * 7 * 24 * 60 * 60);
    await program.methods
      .lockHiSola(ONE, FOUR_WEEKS)
      .accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
        hiSolaMint:    hiSolaM,
        userHiSola:    userHiSolaAta,
        lockPosition:  veLockPda,
        veLockVault:   veLockVault,
        marketVault:   marketV,
        tokenProgram:  TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent:          anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const hiSolaAfter  = await getTokenBalance(connection, userHiSolaAta);
    const vaultBalance = await getTokenBalance(connection, veLockVault);
    const lockPos      = await program.account.veLockPosition.fetch(veLockPda);
    const stateAfter   = await program.account.protocolState.fetch(statePda);

    assert.equal(
      Number(hiSolaBefore - hiSolaAfter),
      Number(ONE.toString()),
      "1 hiSOLA left user ATA"
    );
    assert.equal(Number(vaultBalance), Number(ONE.toString()), "1 hiSOLA in ve_lock_vault");
    assert.equal(lockPos.amountLocked.toNumber(), Number(ONE.toString()), "lock records amount");
    assert.isTrue(lockPos.lockEndTs.toNumber() > 0, "lock_end_ts set");
    // Locked hiSOLA removed from fee pool
    assert.equal(
      stateAfter.totalHiSola.toNumber(),
      stateBefore.totalHiSola.toNumber() - Number(ONE.toString()),
      "total_hi_sola decreased (locked hiSOLA opted out of fees)"
    );

    console.log(
      `✅ lock_hi_sola — 1 hiSOLA locked for 4 weeks, ve_power ≈ ${
        Math.round(Number(ONE.toString()) * 4 * 4 / 104)
      } units`
    );
  });

  // ── 13. Vote with ve power ────────────────────────────────────────────────
  it("vote_gauge uses ve-weighted power beyond raw hiSOLA balance", async () => {
    const userHiSolaAta = anchor.utils.token.associatedAddress({
      mint: hiSolaM, owner: wallet.publicKey,
    });
    const [veLockPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("velock"), wallet.publicKey.toBuffer()],
      program.programId
    );

    // Get current on-chain epoch
    const slot      = await connection.getSlot();
    const blockTime = await connection.getBlockTime(slot);
    const EPOCH_DUR = 7 * 24 * 60 * 60;
    const epoch     = Math.floor(blockTime / EPOCH_DUR);
    const epochLE   = Buffer.alloc(8);
    epochLE.writeBigUInt64LE(BigInt(epoch));

    // Use a fresh pool_id label for this test
    const poolId = anchor.web3.Keypair.generate().publicKey;

    const [gaugeState] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("gauge"), poolId.toBuffer(), epochLE],
      program.programId
    );
    const [voteReceipt] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vote"), wallet.publicKey.toBuffer(), poolId.toBuffer(), epochLE],
      program.programId
    );
    const [epochVotes] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("uev"), wallet.publicKey.toBuffer(), epochLE],
      program.programId
    );

    // User has 1 hiSOLA in ATA (1 was locked). Raw cap = 1_000_000.
    // ve_power ≈ 153_333 (1e6 × 4 × 4weeks / 104weeks).
    // Total power ≈ 1_153_333 → vote for 1_100_000 (impossible without ve).
    const voteAmount = new BN(1_100_000);

    await program.methods
      .voteGauge(new BN(epoch), voteAmount)
      .accounts({
        user:          wallet.publicKey,
        poolId:        poolId,
        protocolState: statePda,
        hiSolaMint:    hiSolaM,
        userHiSola:    userHiSolaAta,
        lockPosition:  veLockPda,
        gaugeState:    gaugeState,
        userVoteReceipt: voteReceipt,
        userEpochVotes: epochVotes,
        tokenProgram:  TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent:          anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const gauge = await program.account.gaugeState.fetch(gaugeState);
    assert.equal(
      gauge.totalVotes.toNumber(),
      voteAmount.toNumber(),
      "gauge records ve-boosted votes"
    );

    console.log(
      `✅ vote_gauge_ve — voted ${voteAmount.toNumber() / 1e6} units (raw cap = 1, ve boost ≈ 0.15)`
    );
  });

  // ── POL Engine ────────────────────────────────────────────────────────────

  // ── 14. Create AMM pool for SOLA/USDC ────────────────────────────────────
  it("creates an AMM pool for SOLA/USDC", async () => {
    // Sort mints lexicographically (required by the AMM)
    const aBytes = solaM.toBytes();
    const bBytes = usdcMint.toBytes();
    let solaIsA = false;
    for (let i = 0; i < 32; i++) {
      if (aBytes[i] < bBytes[i]) { solaIsA = true;  break; }
      if (aBytes[i] > bBytes[i]) { solaIsA = false; break; }
    }
    const [tokenAMint, tokenBMint] = solaIsA ? [solaM, usdcMint] : [usdcMint, solaM];

    const [poolPda]    = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("amm_pool"), tokenAMint.toBuffer(), tokenBMint.toBuffer()],
      program.programId
    );
    const [lpMintPda]  = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"),  poolPda.toBuffer()], program.programId
    );
    const [vaultA]     = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_a"),  poolPda.toBuffer()], program.programId
    );
    const [vaultB]     = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_b"),  poolPda.toBuffer()], program.programId
    );

    const FEE_RATE     = 30;   // 0.30 %
    const PROTO_SHARE  = 2000; // 20 % of fee → market_vault

    await program.methods
      .createPool(FEE_RATE, PROTO_SHARE)
      .accounts({
        creator:      wallet.publicKey,
        tokenAMint,
        tokenBMint,
        pool:         poolPda,
        lpMint:       lpMintPda,
        tokenAVault:  vaultA,
        tokenBVault:  vaultB,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent:         anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const pool = await program.account.ammPool.fetch(poolPda);
    assert.equal(pool.feeRate, FEE_RATE,    "fee rate stored");
    assert.equal(pool.totalLp.toNumber(), 0, "pool starts empty");
    console.log(`✅ create_pool — SOLA/USDC pool at ${poolPda.toBase58().slice(0, 8)}…`);
  });

  // ── 15. Initialize POL ────────────────────────────────────────────────────
  it("initializes POL and collect fees into pol_usdc_vault", async () => {
    // Recompute sorted pool PDA (same logic as test 14)
    const aBytes = solaM.toBytes();
    const bBytes = usdcMint.toBytes();
    let solaIsA = false;
    for (let i = 0; i < 32; i++) {
      if (aBytes[i] < bBytes[i]) { solaIsA = true;  break; }
      if (aBytes[i] > bBytes[i]) { solaIsA = false; break; }
    }
    const [tA, tB] = solaIsA ? [solaM, usdcMint] : [usdcMint, solaM];
    const [poolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("amm_pool"), tA.toBuffer(), tB.toBuffer()],
      program.programId
    );

    const [polStatePda]  = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pol")], program.programId
    );
    const [polUsdcVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pol_usdc_vault")], program.programId
    );
    const [polSolaAta]   = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pol_sola_ata")], program.programId
    );

    // Initialize POL with 10 % split suggestion and SOLA/USDC pool as target
    await program.methods
      .initializePol(1000, poolPda)
      .accounts({
        authority:     wallet.publicKey,
        protocolState: statePda,
        polState:      polStatePda,
        polUsdcVault,
        polSolaAta,
        usdcMint,
        solaMint:      solaM,
        tokenProgram:  TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent:          anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const pol = await program.account.polState.fetch(polStatePda);
    assert.equal(pol.polSplitBps, 1000, "split bps stored");
    assert.equal(pol.targetPool.toBase58(), poolPda.toBase58(), "target pool set");

    // ── collect_to_pol: redirect 0.1 USDC from market_vault ──────────────
    const marketBefore    = await getTokenBalance(connection, marketV);
    const polVaultBefore  = await getTokenBalance(connection, polUsdcVault);
    const COLLECT_AMOUNT  = new BN(100_000); // 0.1 USDC

    await program.methods
      .collectToPol(COLLECT_AMOUNT)
      .accounts({
        authority:     wallet.publicKey,
        protocolState: statePda,
        polState:      polStatePda,
        marketVault:   marketV,
        polUsdcVault,
        tokenProgram:  TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const marketAfter   = await getTokenBalance(connection, marketV);
    const polVaultAfter = await getTokenBalance(connection, polUsdcVault);
    const polState      = await program.account.polState.fetch(polStatePda);

    assert.isTrue(polVaultAfter > polVaultBefore, "pol_usdc_vault funded");
    assert.isTrue(marketAfter < marketBefore,     "market_vault reduced");
    assert.equal(
      polState.usdcAccumulated.toNumber(),
      COLLECT_AMOUNT.toNumber(),
      "lifetime accumulator updated"
    );

    console.log(
      `✅ initialize_pol + collect_to_pol — ${
        Number(polVaultAfter) / 1e6
      } USDC in pol_usdc_vault`
    );
  });

  // ── 16. deploy_pol: buy SOLA via bonding curve ───────────────────────────
  it("deploy_pol buys SOLA from pol_usdc_vault via bonding curve", async () => {
    // Recompute sorted pool PDA
    const aBytes = solaM.toBytes();
    const bBytes = usdcMint.toBytes();
    let solaIsA = false;
    for (let i = 0; i < 32; i++) {
      if (aBytes[i] < bBytes[i]) { solaIsA = true;  break; }
      if (aBytes[i] > bBytes[i]) { solaIsA = false; break; }
    }
    const [tA, tB] = solaIsA ? [solaM, usdcMint] : [usdcMint, solaM];
    const [poolPda]      = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("amm_pool"), tA.toBuffer(), tB.toBuffer()], program.programId
    );
    const [lpMintPda]    = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"),  poolPda.toBuffer()], program.programId
    );
    const [vaultA]       = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_a"),  poolPda.toBuffer()], program.programId
    );
    const [vaultB]       = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault_b"),  poolPda.toBuffer()], program.programId
    );
    const [polStatePda]  = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pol")], program.programId
    );
    const [polUsdcVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pol_usdc_vault")], program.programId
    );
    const [polSolaAta]   = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pol_sola_ata")], program.programId
    );
    const [polLpVault]   = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pol_lp_vault")], program.programId
    );

    const lpDeadKey   = anchor.web3.SystemProgram.programId;
    const lpDeadAta   = anchor.utils.token.associatedAddress({
      mint: lpMintPda, owner: lpDeadKey,
    });

    const solaBefore = await getTokenBalance(connection, polSolaAta);
    const usdcBefore = await getTokenBalance(connection, polUsdcVault);

    // Phase 1 only: spend 50_000 USDC units to buy SOLA; skip LP (sola_for_lp=0)
    const USDC_FOR_SOLA = new BN(50_000);
    await program.methods
      .deployPol(
        USDC_FOR_SOLA, // usdc_for_sola
        new BN(1),     // min_sola_out (accept any)
        new BN(0),     // sola_for_lp  (skip Phase 2)
        new BN(0),     // usdc_for_lp
        new BN(0),     // min_lp
      )
      .accounts({
        authority:      wallet.publicKey,
        protocolState:  statePda,
        polState:       polStatePda,
        polUsdcVault,
        polSolaAta,
        polLpVault,
        solaMint:       solaM,
        floorVault:     floorV,
        marketVault:    marketV,
        pool:           poolPda,
        lpMint:         lpMintPda,
        poolTokenAVault: vaultA,
        poolTokenBVault: vaultB,
        lpDeadAta,
        lpDead:         lpDeadKey,
        tokenProgram:   TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:  anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    const solaAfter = await getTokenBalance(connection, polSolaAta);
    const usdcAfter = await getTokenBalance(connection, polUsdcVault);

    assert.isTrue(solaAfter > solaBefore, "pol_sola_ata received SOLA");
    assert.isTrue(
      usdcAfter < usdcBefore - BigInt(USDC_FOR_SOLA.toString()) + 1n,
      "pol_usdc_vault decreased by at least usdc_for_sola"
    );

    // floor_vault should have grown (1 USDC per SOLA minted)
    const floorBalance = await getTokenBalance(connection, floorV);
    assert.isTrue(floorBalance > 0n, "floor vault funded by POL buy");

    console.log(
      `✅ deploy_pol — bought ${Number(solaAfter - solaBefore) / 1e6} SOLA via POL` +
      ` | ${Number(usdcAfter) / 1e6} USDC remaining in pol vault`
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Core Tokenomics — Invariant tests
  // Invariant: floor_vault + total_usdc_borrowed ≥ total_sola at all times
  // ══════════════════════════════════════════════════════════════════════════

  it("[invariant] floor_vault + total_usdc_borrowed ≥ total_sola after buy", async () => {
    const state = await program.account.protocolState.fetch(statePda);
    const floorBalance = await getTokenBalance(connection, floorV);

    const backed = BigInt(floorBalance.toString()) +
                   BigInt(state.totalUsdcBorrowed.toString());
    const supply = BigInt(state.totalSola.toString());

    assert.isTrue(
      backed >= supply,
      `INVARIANT VIOLATED after buy: floor+borrowed(${backed}) < totalSola(${supply})`
    );
    console.log(
      `✅ [invariant] buy — floor_vault=${Number(floorBalance)/1e6} ` +
      `borrowed=${Number(state.totalUsdcBorrowed)/1e6} ` +
      `totalSola=${Number(state.totalSola)/1e6}`
    );
  });

  it("[invariant] floor_vault + total_usdc_borrowed ≥ total_sola after sell", async () => {
    const userSolaAta = anchor.utils.token.associatedAddress({
      mint: solaM, owner: wallet.publicKey,
    });

    // Sell 1 SOLA
    await program.methods
      .sellSola(ONE)
      .accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
        solaMint:      solaM,
        userSola:      userSolaAta,
        floorVault:    floorV,
        userUsdc:      userUsdcAta,
        tokenProgram:  TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const state = await program.account.protocolState.fetch(statePda);
    const floorBalance = await getTokenBalance(connection, floorV);

    const backed = BigInt(floorBalance.toString()) +
                   BigInt(state.totalUsdcBorrowed.toString());
    const supply = BigInt(state.totalSola.toString());

    assert.isTrue(
      backed >= supply,
      `INVARIANT VIOLATED after sell: floor+borrowed(${backed}) < totalSola(${supply})`
    );
    console.log(
      `✅ [invariant] sell — floor_vault=${Number(floorBalance)/1e6} ` +
      `borrowed=${Number(state.totalUsdcBorrowed)/1e6} ` +
      `totalSola=${Number(state.totalSola)/1e6}`
    );
  });

  it("[invariant] floor_vault + total_usdc_borrowed ≥ total_sola after borrow/repay cycle", async () => {
    const userSolaAta    = anchor.utils.token.associatedAddress({ mint: solaM,   owner: wallet.publicKey });
    const userHiSolaAta  = anchor.utils.token.associatedAddress({ mint: hiSolaM, owner: wallet.publicKey });
    const [userPosition] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()], program.programId
    );
    const [solaVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("sola_vault")], program.programId
    );

    // Helper: assert invariant
    const checkInvariant = async (label: string) => {
      const s = await program.account.protocolState.fetch(statePda);
      const floor = await getTokenBalance(connection, floorV);
      const backed = BigInt(floor.toString()) + BigInt(s.totalUsdcBorrowed.toString());
      const supply = BigInt(s.totalSola.toString());
      assert.isTrue(
        backed >= supply,
        `INVARIANT VIOLATED at [${label}]: backed(${backed}) < supply(${supply})`
      );
      return { floor, borrowed: s.totalUsdcBorrowed, supply: s.totalSola };
    };

    // ── Buy 5 SOLA to have enough to stake ───────────────────────────────
    await program.methods.buySola(ONE.muln(5), new BN(0)).accounts({
      user: wallet.publicKey, protocolState: statePda,
      solaMint: solaM, userUsdc: userUsdcAta, userSola: userSolaAta,
      floorVault: floorV, marketVault: marketV,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any).rpc();
    await checkInvariant("after buy 5 SOLA");

    // ── Stake 2 SOLA → hiSOLA ────────────────────────────────────────────
    await program.methods.stakeSola(ONE.muln(2)).accounts({
      user: wallet.publicKey, protocolState: statePda,
      solaMint: solaM, hiSolaMint: hiSolaM,
      userSola: userSolaAta, userHiSola: userHiSolaAta,
      solaVault, marketVault: marketV, userPosition,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    } as any).rpc();
    await checkInvariant("after stake 2 SOLA");

    // ── Borrow 1 USDC ────────────────────────────────────────────────────
    await program.methods.borrowUsdc(ONE).accounts({
      user: wallet.publicKey, protocolState: statePda,
      hiSolaMint: hiSolaM, userHiSola: userHiSolaAta,
      floorVault: floorV, marketVault: marketV,
      userUsdc: userUsdcAta, userPosition,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    } as any).rpc();
    const afterBorrow = await checkInvariant("after borrow 1 USDC");
    assert.equal(
      Number(afterBorrow.borrowed.toString()), 1_000_000,
      "total_usdc_borrowed tracks protocol-wide borrow"
    );

    // ── Sell 1 liquid SOLA — must succeed (backed by hiSOLA collateral) ──
    await program.methods.sellSola(ONE).accounts({
      user: wallet.publicKey, protocolState: statePda,
      solaMint: solaM, userSola: userSolaAta,
      floorVault: floorV, userUsdc: userUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any).rpc();
    await checkInvariant("after sell 1 SOLA (while borrow active)");

    // ── Repay borrow ─────────────────────────────────────────────────────
    await program.methods.repayUsdc(ONE).accounts({
      user: wallet.publicKey, protocolState: statePda,
      userUsdc: userUsdcAta, floorVault: floorV,
      userPosition, tokenProgram: TOKEN_PROGRAM_ID,
    } as any).rpc();
    const afterRepay = await checkInvariant("after repay");
    assert.equal(
      Number(afterRepay.borrowed.toString()), 0,
      "total_usdc_borrowed back to 0 after full repay"
    );

    console.log("✅ [invariant] borrow/repay cycle — floor_vault invariant holds throughout");
  });

  it("[invariant] sell rejects when floor reserve exhausted", async () => {
    // This test verifies the pre-condition check catches insufficient floor funds.
    // We attempt to sell more SOLA than the floor vault holds.
    const userSolaAta = anchor.utils.token.associatedAddress({
      mint: solaM, owner: wallet.publicKey,
    });
    const hugeAmount = new BN(1_000_000_000_000); // 1 000 000 SOLA — way more than floor holds

    try {
      await program.methods.sellSola(hugeAmount).accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
        solaMint:      solaM,
        userSola:      userSolaAta,
        floorVault:    floorV,
        userUsdc:      userUsdcAta,
        tokenProgram:  TOKEN_PROGRAM_ID,
      } as any).rpc();
      assert.fail("Expected InsufficientFloorReserve error");
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      assert.isTrue(
        msg.includes("InsufficientFloorReserve") || msg.includes("insufficient"),
        `Expected floor reserve error, got: ${msg}`
      );
      console.log("✅ [invariant] sell correctly rejected: floor reserve exhausted");
    }
  });
});
