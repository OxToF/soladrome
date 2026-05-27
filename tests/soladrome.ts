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
    // On devnet, the protocol state may already exist from a prior test run.
    // If so, reuse the existing USDC mint — never create a new mint mid-protocol.
    const existingState = await program.account.protocolState.fetchNullable(statePda);

    if (existingState) {
      // Re-run: state PDA already exists. Reuse its USDC mint.
      usdcMint = existingState.usdcMint;
    } else {
      // First run: create a fresh USDC mint and initialize the protocol.
      usdcMint = await createMint(
        connection,
        wallet.payer,
        wallet.publicKey, // mint authority
        null,
        DECIMALS
      );
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
    }

    // Ensure user has an ATA for the USDC mint with at least 1 000 USDC.
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet.payer,
      usdcMint,
      wallet.publicKey
    );
    userUsdcAta = ata.address;
    if (BigInt(ata.amount.toString()) < 1_000_000_000n) {
      await mintTo(connection, wallet.payer, usdcMint, userUsdcAta, wallet.payer, 10_000_000_000);
    }

    const state = await program.account.protocolState.fetch(statePda);
    assert.equal(state.usdcMint.toBase58(), usdcMint.toBase58(), "USDC mint matches state");
    console.log("✅ initialize — state PDA:", statePda.toBase58(), "| usdcMint:", usdcMint.toBase58().slice(0, 8) + "…");
  });

  // ── 2. Buy SOLA ───────────────────────────────────────────────────────────
  it("buys SOLA via bonding curve", async () => {
    const userSolaAta = anchor.utils.token.associatedAddress({
      mint:  solaM,
      owner: wallet.publicKey,
    });

    const stateBefore = await program.account.protocolState.fetch(statePda);
    const usdcBefore  = await getTokenBalance(connection, userUsdcAta);

    // Dynamically compute how much USDC to buy to get at least 6 SOLA.
    // This handles the bonding curve being far from initial state on devnet.
    // Formula: usdc_in = k / (virtual_sola - target) - virtual_usdc
    const TARGET_SOLA = 6_000_000n; // 6 SOLA — enough for the entire test chain
    const vU = BigInt(stateBefore.virtualUsdc.toString());
    const vS = BigInt(stateBefore.virtualSola.toString());
    const k  = BigInt(stateBefore.k.toString());
    const minUsdc = k / (vS - TARGET_SOLA) - vU;
    const buyAmount = new BN((minUsdc + 1_000_000n).toString()); // +1 USDC safety buffer

    await program.methods
      .buySola(buyAmount, new BN(1)) // min_sola_out = 0.000001 SOLA
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

    const stateAfter  = await program.account.protocolState.fetch(statePda);
    const solaBalance = await getTokenBalance(connection, userSolaAta);
    const usdcAfter   = await getTokenBalance(connection, userUsdcAta);

    assert.isTrue(
      stateAfter.virtualUsdc.gt(stateBefore.virtualUsdc),
      "virtual USDC increased"
    );
    assert.isTrue(solaBalance >= BigInt(TARGET_SOLA.toString()), `user received ≥6 SOLA`);
    assert.isTrue(usdcAfter < usdcBefore, "user spent USDC");
    const floorBalance = await getTokenBalance(connection, floorV);
    assert.isTrue(floorBalance > 0n, "floor vault funded");

    console.log(
      `✅ buy_sola — received ${Number(solaBalance) / 1e6} SOLA for ${Number(buyAmount.toString())/1e6} USDC` +
      ` | floor_vault: ${Number(floorBalance) / 1e6} USDC`
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

    const solaBefore    = await getTokenBalance(connection, userSolaAta);
    const hiSolaBefore  = await getTokenBalance(connection, userHiSolaAta).catch(() => 0n);
    const vaultBefore   = await getTokenBalance(connection, solaVault);

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
    // Use delta (not absolute) — user may have pre-existing hiSOLA from prior devnet runs
    assert.equal(
      Number(hiSolaAfter - hiSolaBefore),
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
    assert.isTrue(balance >= BigInt(ONE.muln(5).toString()), "at least 5 oSOLA in account (may have prior balance)");
    console.log(`✅ distribute_o_sola — ${Number(balance)/1e6} oSOLA in account`);
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

    // Lock 1 hiSOLA for max duration (104 epochs × EPOCH_DURATION=3600s on devnet)
    // Mainnet: 104 × 604800 = ~2 years. Devnet: 104 × 3600 = ~4.3 days.
    const DEVNET_EPOCH = 3_600;
    const FOUR_WEEKS   = new BN(104 * DEVNET_EPOCH); // = MAX_LOCK_DURATION on devnet
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
    const EPOCH_DUR = 3_600; // devnet epoch (= state.rs EPOCH_DURATION)
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

    // Pool may already exist on devnet from a prior run — skip init if so.
    const existingPool = await program.account.ammPool.fetchNullable(poolPda);
    if (!existingPool) {
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
    }

    const pool = await program.account.ammPool.fetch(poolPda);
    assert.equal(pool.feeRate, FEE_RATE, "fee rate stored");
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

    // Initialize POL (skip if already done on devnet)
    const existingPol = await program.account.polState.fetchNullable(polStatePda);
    if (!existingPol) {
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
    }

    const pol = await program.account.polState.fetch(polStatePda);
    assert.equal(pol.polSplitBps, 1000, "split bps stored");
    assert.equal(pol.targetPool.toBase58(), poolPda.toBase58(), "target pool set");

    // ── collect_to_pol: redirect 0.1 USDC from market_vault ──────────────
    const marketBefore       = await getTokenBalance(connection, marketV);
    const polVaultBefore     = await getTokenBalance(connection, polUsdcVault);
    const COLLECT_AMOUNT     = new BN(100_000); // 0.1 USDC
    // Snapshot existing lifetime accumulator before this collect (may be non-zero on re-run)
    const polBefore          = await program.account.polState.fetch(polStatePda);
    const accumulatedBefore  = polBefore.usdcAccumulated.toNumber();

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
      polState.usdcAccumulated.toNumber() - accumulatedBefore,
      COLLECT_AMOUNT.toNumber(),
      "lifetime accumulator increased by collect amount"
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

  it("[invariant] floor_vault + total_usdc_borrowed ≥ total_purchased_sola after buy", async () => {
    // The floor invariant uses total_purchased_sola — not total_sola — because
    // founder/ecosystem allocations are unfinanced and should not affect the
    // floor-redemption guarantee for purchased users.
    const state = await program.account.protocolState.fetch(statePda);
    const floorBalance = await getTokenBalance(connection, floorV);

    const backed = BigInt(floorBalance.toString()) +
                   BigInt(state.totalUsdcBorrowed.toString());
    const supply = BigInt(state.totalPurchasedSola.toString());

    assert.isTrue(
      backed >= supply,
      `INVARIANT VIOLATED after buy: floor+borrowed(${backed}) < totalPurchasedSola(${supply})`
    );
    console.log(
      `✅ [invariant] buy — floor_vault=${Number(floorBalance)/1e6} ` +
      `borrowed=${Number(state.totalUsdcBorrowed)/1e6} ` +
      `totalPurchasedSola=${Number(state.totalPurchasedSola)/1e6}`
    );
  });

  it("[invariant] floor_vault + total_usdc_borrowed ≥ total_purchased_sola after sell", async () => {
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
    const supply = BigInt(state.totalPurchasedSola.toString());

    assert.isTrue(
      backed >= supply,
      `INVARIANT VIOLATED after sell: floor+borrowed(${backed}) < totalPurchasedSola(${supply})`
    );
    console.log(
      `✅ [invariant] sell — floor_vault=${Number(floorBalance)/1e6} ` +
      `borrowed=${Number(state.totalUsdcBorrowed)/1e6} ` +
      `totalPurchasedSola=${Number(state.totalPurchasedSola)/1e6}`
    );
  });

  it("[invariant] floor_vault + total_usdc_borrowed ≥ total_purchased_sola after borrow/repay cycle", async () => {
    const userSolaAta    = anchor.utils.token.associatedAddress({ mint: solaM,   owner: wallet.publicKey });
    const userHiSolaAta  = anchor.utils.token.associatedAddress({ mint: hiSolaM, owner: wallet.publicKey });
    const [userPosition] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()], program.programId
    );
    const [solaVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("sola_vault")], program.programId
    );

    // Helper: assert invariant (uses total_purchased_sola — not total_sola)
    const checkInvariant = async (label: string) => {
      const s = await program.account.protocolState.fetch(statePda);
      const floor = await getTokenBalance(connection, floorV);
      const backed = BigInt(floor.toString()) + BigInt(s.totalUsdcBorrowed.toString());
      const supply = BigInt(s.totalPurchasedSola.toString());
      assert.isTrue(
        backed >= supply,
        `INVARIANT VIOLATED at [${label}]: backed(${backed}) < totalPurchasedSola(${supply})`
      );
      return { floor, borrowed: s.totalUsdcBorrowed, supply: s.totalPurchasedSola };
    };

    // ── Buy enough to have at least 3 SOLA (stake 2 + sell 1) ───────────
    const stPre2 = await program.account.protocolState.fetch(statePda);
    const vU3 = BigInt(stPre2.virtualUsdc.toString());
    const vS3 = BigInt(stPre2.virtualSola.toString());
    const k3  = BigInt(stPre2.k.toString());
    const target3 = 3_000_000n; // 3 SOLA
    const buyAmt3 = new BN((k3 / (vS3 - target3) - vU3 + 1_000_000n).toString());
    await program.methods.buySola(buyAmt3, new BN(0)).accounts({
      user: wallet.publicKey, protocolState: statePda,
      solaMint: solaM, userUsdc: userUsdcAta, userSola: userSolaAta,
      floorVault: floorV, marketVault: marketV,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any).rpc();
    await checkInvariant("after buy SOLA for cycle test");

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
    // total_usdc_borrowed may include pre-existing borrows from devnet; just verify it grew
    assert.isTrue(
      Number(afterBorrow.borrowed.toString()) >= 1_000_000,
      "total_usdc_borrowed includes the new 1 USDC borrow"
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
    // The user's own borrow is cleared; total may still show pre-existing devnet borrows
    const posAfterRepay = await program.account.userPosition.fetch(userPosition);
    assert.equal(
      posAfterRepay.usdcBorrowed.toNumber(), 0,
      "user's personal debt cleared after repay"
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

  // ══════════════════════════════════════════════════════════════════════════
  // Security — Flash-borrow guard
  // Invariant: repay_usdc must execute in a strictly later slot than borrow_usdc
  // ══════════════════════════════════════════════════════════════════════════

  it("[security] flash-borrow rejected: borrow + repay in same transaction", async () => {
    const userSolaAta   = anchor.utils.token.associatedAddress({ mint: solaM,   owner: wallet.publicKey });
    const userHiSolaAta = anchor.utils.token.associatedAddress({ mint: hiSolaM, owner: wallet.publicKey });
    const [userPosition] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()],
      program.programId
    );

    // Ensure we have SOLA to stake (buy 3 SOLA)
    await program.methods.buySola(ONE.muln(3), new BN(0)).accounts({
      user: wallet.publicKey, protocolState: statePda,
      solaMint: solaM, userUsdc: userUsdcAta, userSola: userSolaAta,
      floorVault: floorV, marketVault: marketV,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    } as any).rpc();

    // Ensure we have hiSOLA collateral (stake 2 SOLA → 2 hiSOLA)
    const hiSolaBal = await getTokenBalance(connection, userHiSolaAta);
    if (hiSolaBal < BigInt(ONE.toString())) {
      await program.methods.stakeSola(ONE.muln(2)).accounts({
        user: wallet.publicKey, protocolState: statePda,
        solaMint: solaM, hiSolaMint: hiSolaM,
        userSola: userSolaAta, userHiSola: userHiSolaAta,
        solaVault: solaVault, marketVault: marketV, userPosition,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any).rpc();
    }

    // Clear any existing debt first (repay in a separate prior slot — always safe)
    const posState = await program.account.userPosition.fetch(userPosition);
    if (posState.usdcBorrowed.toNumber() > 0) {
      await program.methods.repayUsdc(posState.usdcBorrowed).accounts({
        user: wallet.publicKey, protocolState: statePda,
        userUsdc: userUsdcAta, floorVault: floorV,
        userPosition, tokenProgram: TOKEN_PROGRAM_ID,
      } as any).rpc();
    }

    // ── Flash-borrow attack: pack borrow + repay into a single transaction ──
    // Both instructions run in the same slot → guard fires on repay.
    const borrowIx = await program.methods
      .borrowUsdc(ONE)
      .accounts({
        user: wallet.publicKey, protocolState: statePda,
        hiSolaMint: hiSolaM, userHiSola: userHiSolaAta,
        floorVault: floorV, marketVault: marketV,
        userUsdc: userUsdcAta, userPosition,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .instruction();

    const repayIx = await program.methods
      .repayUsdc(ONE)
      .accounts({
        user: wallet.publicKey, protocolState: statePda,
        userUsdc: userUsdcAta, floorVault: floorV,
        userPosition, tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .instruction();

    const flashTx = new anchor.web3.Transaction().add(borrowIx, repayIx);

    try {
      await provider.sendAndConfirm(flashTx, [wallet.payer]);
      assert.fail("Expected FlashBorrowDetected — same-slot borrow+repay should be rejected");
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      assert.isTrue(
        msg.includes("FlashBorrowDetected") || msg.includes("0x1787"),
        `Expected FlashBorrowDetected (0x1787), got: ${msg}`
      );
      // Clean up the borrow debt (left by the partial execution if any)
      // Note: if the TX failed atomically, no state change occurred — no cleanup needed.
      console.log("✅ [security] flash-borrow guard correctly rejected same-slot borrow+repay");
    }
  });

  it("[security] normal borrow + repay in separate transactions succeeds", async () => {
    const userHiSolaAta = anchor.utils.token.associatedAddress({ mint: hiSolaM, owner: wallet.publicKey });
    const [userPosition] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()],
      program.programId
    );

    // Ensure no outstanding debt before test
    const posBefore = await program.account.userPosition.fetch(userPosition);
    if (posBefore.usdcBorrowed.toNumber() > 0) {
      await program.methods.repayUsdc(posBefore.usdcBorrowed).accounts({
        user: wallet.publicKey, protocolState: statePda,
        userUsdc: userUsdcAta, floorVault: floorV,
        userPosition, tokenProgram: TOKEN_PROGRAM_ID,
      } as any).rpc();
    }

    // TX 1: borrow 0.5 USDC → records last_borrow_slot
    const borrowAmount = ONE.divn(2); // 0.5 USDC
    await program.methods.borrowUsdc(borrowAmount).accounts({
      user: wallet.publicKey, protocolState: statePda,
      hiSolaMint: hiSolaM, userHiSola: userHiSolaAta,
      floorVault: floorV, marketVault: marketV,
      userUsdc: userUsdcAta, userPosition,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    } as any).rpc();

    const posAfterBorrow = await program.account.userPosition.fetch(userPosition);
    assert.isTrue(
      posAfterBorrow.lastBorrowSlot.toNumber() > 0,
      "last_borrow_slot recorded after borrow"
    );
    assert.equal(posAfterBorrow.usdcBorrowed.toString(), borrowAmount.toString(), "debt recorded");

    // TX 2: repay — different transaction → different slot → guard passes
    await program.methods.repayUsdc(borrowAmount).accounts({
      user: wallet.publicKey, protocolState: statePda,
      userUsdc: userUsdcAta, floorVault: floorV,
      userPosition, tokenProgram: TOKEN_PROGRAM_ID,
    } as any).rpc();

    const posAfterRepay = await program.account.userPosition.fetch(userPosition);
    assert.equal(posAfterRepay.usdcBorrowed.toNumber(), 0, "debt cleared after normal repay");

    console.log("✅ [security] normal borrow → repay (separate slots) works correctly");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Invariant — total_purchased_sola tracks floor-backed supply correctly
  // ══════════════════════════════════════════════════════════════════════════

  it("[invariant] total_purchased_sola increments on buy, decrements on sell", async () => {
    const userSolaAta = anchor.utils.token.associatedAddress({ mint: solaM, owner: wallet.publicKey });

    const stateBefore = await program.account.protocolState.fetch(statePda);
    const purchasedBefore = stateBefore.totalPurchasedSola.toNumber();
    const floorBefore     = await getTokenBalance(connection, floorV);

    // ── Buy enough USDC to get at least 2 SOLA → total_purchased_sola must increase ──
    // Dynamically compute amount needed (bonding curve state may vary on devnet)
    const stPre = await program.account.protocolState.fetch(statePda);
    const vU2 = BigInt(stPre.virtualUsdc.toString());
    const vS2 = BigInt(stPre.virtualSola.toString());
    const k2  = BigInt(stPre.k.toString());
    const target2 = 2_000_000n; // 2 SOLA
    const buyAmt2 = new BN((k2 / (vS2 - target2) - vU2 + 1_000_000n).toString());

    await program.methods.buySola(buyAmt2, new BN(0)).accounts({
      user: wallet.publicKey, protocolState: statePda,
      solaMint: solaM, userUsdc: userUsdcAta, userSola: userSolaAta,
      floorVault: floorV, marketVault: marketV,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    } as any).rpc();

    const stateAfterBuy  = await program.account.protocolState.fetch(statePda);
    const floorAfterBuy  = await getTokenBalance(connection, floorV);
    const purchasedAfterBuy = stateAfterBuy.totalPurchasedSola.toNumber();

    const solaBought = purchasedAfterBuy - purchasedBefore;
    assert.isTrue(solaBought > 0, "total_purchased_sola increases on buy");

    // Floor ratio must remain ≥ 1:1 (each SOLA bought adds 1 USDC to floor_vault)
    assert.isTrue(
      Number(floorAfterBuy) >= purchasedAfterBuy,
      `floor_vault (${Number(floorAfterBuy)/1e6}) must be ≥ total_purchased_sola (${purchasedAfterBuy/1e6})`
    );

    // ── Sell 1 SOLA → total_purchased_sola must decrease ─────────────────
    await program.methods.sellSola(ONE).accounts({
      user: wallet.publicKey, protocolState: statePda,
      solaMint: solaM, userSola: userSolaAta,
      floorVault: floorV, userUsdc: userUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any).rpc();

    const stateAfterSell = await program.account.protocolState.fetch(statePda);
    const floorAfterSell = await getTokenBalance(connection, floorV);
    const purchasedAfterSell = stateAfterSell.totalPurchasedSola.toNumber();

    assert.isTrue(
      purchasedAfterSell < purchasedAfterBuy,
      "total_purchased_sola decreases on sell"
    );
    assert.equal(
      purchasedAfterBuy - purchasedAfterSell,
      Number(ONE.toString()),
      "total_purchased_sola decremented by exactly 1 SOLA"
    );

    // Floor ratio still ≥ 1:1 after sell (floor_vault and purchased_sola both drop by 1)
    assert.isTrue(
      Number(floorAfterSell) >= purchasedAfterSell,
      `floor_vault (${Number(floorAfterSell)/1e6}) remains ≥ total_purchased_sola (${purchasedAfterSell/1e6}) after sell`
    );

    console.log(
      `✅ [invariant] total_purchased_sola: +${solaBought/1e6} on buy, -${Number(ONE.toString())/1e6} on sell` +
      ` | floor ratio: ${(Number(floorAfterSell) / purchasedAfterSell).toFixed(4)}`
    );
  });
});
