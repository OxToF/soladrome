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
  it("borrows USDC against hiSOLA collateral", async () => {
    const [positionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()],
      program.programId
    );
    const userHiSolaAta = anchor.utils.token.associatedAddress({
      mint: hiSolaM, owner: wallet.publicKey,
    });

    const usdcBefore  = await getTokenBalance(connection, userUsdcAta);
    const floorBefore = await getTokenBalance(connection, floorV);

    // Borrow 1 USDC (hiSOLA balance = 2, so max = 2 USDC)
    await program.methods
      .borrowUsdc(ONE)
      .accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
        hiSolaMint:    hiSolaM,
        userHiSola:    userHiSolaAta,
        floorVault:    floorV,
        userUsdc:      userUsdcAta,
        userPosition:  positionPda,
        tokenProgram:  TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    const usdcAfter  = await getTokenBalance(connection, userUsdcAta);
    const floorAfter = await getTokenBalance(connection, floorV);
    const position   = await program.account.userPosition.fetch(positionPda);

    assert.equal(
      Number(usdcAfter - usdcBefore),
      Number(ONE.toString()),
      "user received 1 USDC loan"
    );
    assert.equal(
      Number(position.usdcBorrowed.toString()),
      Number(ONE.toString()),
      "position debt = 1 USDC"
    );
    assert.isTrue(floorAfter < floorBefore, "floor vault reduced");

    console.log("✅ borrow_usdc — 1 USDC borrowed, debt tracked");
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
});
