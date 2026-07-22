import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Soladrome } from "../target/types/soladrome";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import * as fs from "fs";

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

/// Block until the cluster advances a slot.
///
/// `repay_usdc` rejects a repay in the same slot as the borrow (flash-borrow guard,
/// lib.rs:834). Localnet slots are ~400 ms and these tests fire back-to-back, so borrow
/// and repay land in the same slot and the guard correctly refuses. On devnet, network
/// latency happened to separate them — meaning this guard passed on devnet by accident of
/// latency, never because it was exercised. Waiting a slot is what the test always owed it.
async function waitForNewSlot(connection: anchor.web3.Connection): Promise<void> {
  const start = await connection.getSlot();
  while ((await connection.getSlot()) <= start) {
    await new Promise((r) => setTimeout(r, 100));
  }
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

  // ── 1b. Open the closed-launch gates ──────────────────────────────────────
  // `initialize` writes all five phase flags `false`, so buy_sola / create_pool /
  // exercise_o_sola / deposit_bribe / the vote paths all revert FeatureDisabled on a
  // fresh state. Until 2026-07-17 this suite only ever ran against the live devnet
  // ProtocolState, where the authority flipped these months ago — which is why a clean
  // localnet run was ~20 red and why a third party cloning the repo saw a red suite.
  // Mirrors the devnet enable-all form of scripts/set_phase_flags.ts.
  it("enables the closed-launch phase flags", async () => {
    await program.methods
      .setPhaseFlags(true, true, true, true, true)
      .accounts({
        authority:     wallet.publicKey,
        protocolState: statePda,
      } as any)
      .rpc();

    const state = await program.account.protocolState.fetch(statePda);
    assert.isTrue(
      state.lpEnabled && state.bribesEnabled && state.votingEnabled &&
      state.exerciseEnabled && state.curveEnabled,
      "all five closed-launch gates must be open for the rest of the suite"
    );
    console.log("✅ phase flags — lp/bribes/voting/exercise/curve all enabled");
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
        // usdc_mint is a test-created mint, not a PDA, so Anchor cannot derive the
        // user_usdc ATA constrained on it — both must be passed explicitly.
        usdcMint:      usdcMint,
        userUsdc:      userUsdcAta,
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
    // The borrow landed in the previous test; the flash-borrow guard rejects a repay in
    // the same slot, which localnet's 400 ms slots make the default.
    await waitForNewSlot(connection);

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
        marketVault:   marketV,
        // usdc_mint is test-created, not a PDA — Anchor cannot derive the user_usdc ATA
        // constrained on it, so both go in explicitly.
        usdcMint:      usdcMint,
        userUsdc:      userUsdcAta,
        userPosition:  positionPda,
        // UncheckedAccount — read only to bound the founder's unstake against vesting.
        // Passing the PDA is correct for any caller; it need not exist yet.
        founderHiVesting: anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("founder_hi_vesting")], program.programId)[0],
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
        // Same as the main stake test: usdc_mint is not a PDA, so the user_usdc ATA
        // constrained on it cannot be derived. This re-stake feeds `lock` and
        // `vote_gauge` downstream — all three fail together without it.
        usdcMint: usdcMint, userUsdc: userUsdcAta,
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

    // Lock 1 hiSOLA for max duration (104 epochs × EPOCH_DURATION=604800s = ~2 years)
    // EPOCH_DURATION is now always 604 800 s on both devnet and mainnet.
    const EPOCH_DURATION = 604_800;
    const FOUR_WEEKS     = new BN(104 * EPOCH_DURATION); // = MAX_LOCK_DURATION
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

  // ── 12b. A second staker — precondition for any meaningful vote test ──────
  // vote_gauge caps hiSOLA power at `min(user_snapshot, 30% of total_hi_sola)`. On a
  // single-staker chain the wallet IS total_hi_sola, so 30% of it is always BELOW its own
  // balance and the cap binds unconditionally — voting "beyond your raw balance" becomes
  // mathematically unreachable, ve boost or not. This passed on devnet only because
  // hundreds of testers had staked. Runs after claim_fees so pro-rata assertions upstream
  // are untouched.
  it("a second staker joins so the 30% global cap stops binding", async () => {
    const staker2 = anchor.web3.Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(staker2.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );

    const s2Usdc = await getOrCreateAssociatedTokenAccount(
      connection, wallet.payer, usdcMint, staker2.publicKey
    );
    await mintTo(connection, wallet.payer, usdcMint, s2Usdc.address, wallet.payer, 100_000_000);

    const s2Sola   = anchor.utils.token.associatedAddress({ mint: solaM,   owner: staker2.publicKey });
    const s2HiSola = anchor.utils.token.associatedAddress({ mint: hiSolaM, owner: staker2.publicKey });
    const [s2Pos]  = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), staker2.publicKey.toBuffer()], program.programId);

    await program.methods
      .buySola(new BN(50_000_000), new BN(1))
      .accounts({
        user: staker2.publicKey, protocolState: statePda, solaMint: solaM,
        userUsdc: s2Usdc.address, userSola: s2Sola,
        floorVault: floorV, marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([staker2])
      .rpc();

    const s2SolaBal = await getTokenBalance(connection, s2Sola);
    await program.methods
      .stakeSola(new BN(s2SolaBal.toString()))
      .accounts({
        user: staker2.publicKey, protocolState: statePda,
        solaMint: solaM, hiSolaMint: hiSolaM,
        usdcMint, userUsdc: s2Usdc.address,
        userSola: s2Sola, userHiSola: s2HiSola,
        solaVault, marketVault: marketV, userPosition: s2Pos,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([staker2])
      .rpc();

    const st = await program.account.protocolState.fetch(statePda);
    const mainHiSola = await getTokenBalance(
      connection, anchor.utils.token.associatedAddress({ mint: hiSolaM, owner: wallet.publicKey })
    );
    const globalCap = (st.totalHiSola.toNumber() * 3000) / 10_000;
    assert.isTrue(
      globalCap > Number(mainHiSola),
      "30% of total_hi_sola must now exceed the main wallet's balance, or the vote test is unreachable"
    );
    console.log(
      `✅ second staker — total_hi_sola = ${st.totalHiSola.toNumber() / 1e6}, ` +
      `30% cap = ${globalCap / 1e6} > main balance ${Number(mainHiSola) / 1e6}`
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
    const EPOCH_DUR = 604_800; // EPOCH_DURATION = 7 days (same on devnet and mainnet)
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

    // Vote for one unit MORE than the raw ATA balance: impossible without the ve boost,
    // which is the whole point of this test, and valid as long as the lock contributes any
    // power at all. The old hardcoded 1_100_000 assumed an exact 1-hiSOLA balance that the
    // suite's stake/unstake sequence no longer produces on a clean state.
    const rawHiSola  = await getTokenBalance(connection, userHiSolaAta);
    const voteAmount = new BN((rawHiSola + 1n).toString());

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

    // ── collect_to_pol: redirect uncredited fees from market_vault ──────────────
    // Buy first so market_vault holds fresh, uncredited fees — a prior stake/claim may
    // have advanced the accumulator to the full balance, leaving nothing to skim.
    const polUserUsdc = anchor.utils.token.associatedAddress({ mint: usdcMint, owner: wallet.publicKey });
    const polUserSola = anchor.utils.token.associatedAddress({ mint: solaM, owner: wallet.publicKey });
    await program.methods
      .buySola(TEN, new BN(1))
      .accounts({
        user: wallet.publicKey, protocolState: statePda,
        solaMint: solaM, userUsdc: polUserUsdc,
        userSola: polUserSola, floorVault: floorV, marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any).rpc();

    const marketBefore       = await getTokenBalance(connection, marketV);
    const polVaultBefore     = await getTokenBalance(connection, polUsdcVault);
    // Collect half of whatever fees actually exist, rather than a fixed 0.1 USDC.
    // market_vault only receives the spread between price paid and floor. At the curve's
    // real depth (N = 1M) a 10 USDC buy sends ~0.0001 USDC there; the old 100/100 curve
    // sent ~0.9 USDC because its price rocketed within a few dollars. The hardcoded
    // amount silently depended on that broken curve.
    //
    // Collect the ENTIRE uncredited growth — the worst case. Fixed 2026-07-18: the
    // accumulator now advances on (balance − amount), so the skim comes out of the
    // stakers' share instead of promising them fees the vault no longer holds, and a
    // solvency guard refuses to skim anything already credited (everything at or below
    // last_market_vault_balance is spoken for). Collecting 50% of the raw balance used
    // to brick claim_fees/stake_sola with a raw SPL "insufficient funds".
    const stBefore = await program.account.protocolState.fetch(statePda);
    const uncredited = marketBefore - BigInt(stBefore.lastMarketVaultBalance.toString());
    assert.isTrue(uncredited > 0n, "there must be uncredited fee growth to collect");
    const COLLECT_AMOUNT     = new BN(uncredited.toString());
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

    // Phase 1 only: spend the vault's USDC on SOLA; skip LP (sola_for_lp=0).
    // Sized off the actual vault balance rather than a fixed 50_000: what lands here is
    // half the market_vault, which at the curve's real depth is the thin floor-to-price
    // spread, not the fat one the old 100/100 curve produced.
    assert.isTrue(usdcBefore > 0n, "pol_usdc_vault must be funded by the collect above");
    const USDC_FOR_SOLA = new BN(usdcBefore.toString());
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
      usdcMint, userUsdc: userUsdcAta,
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
        usdcMint, userUsdc: userUsdcAta,
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

    // TX 2: repay in a later slot → guard passes.
    // A separate transaction does NOT imply a separate slot — that assumption only held
    // on devnet, where network latency happened to straddle a slot boundary. Localnet
    // lands both in the same 400 ms slot, so the wait must be explicit.
    await waitForNewSlot(connection);

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

  // ── Founder guards ────────────────────────────────────────────────────────
  // Only reachable on a `devnet`-feature build, where FOUNDER_WALLET resolves to
  // tests/keys/founder-devnet.json. On a mainnet build (--no-default-features) it is
  // a Ledger address no test can sign for — which is why this path had zero coverage.
  it("[founder] burn_o_sola_for_votes rejects the founder wallet", async () => {
    const founder = anchor.web3.Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync("tests/keys/founder-devnet.json", "utf8")))
    );

    const sig = await connection.requestAirdrop(
      founder.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(sig, "confirmed");

    // Give the founder oSOLA so the burn path is actually reachable — otherwise a
    // missing ATA would fail account validation and mask the guard.
    const founderOSola = anchor.utils.token.associatedAddress({
      mint: oSolaM, owner: founder.publicKey,
    });
    await program.methods
      .distributeOSola(ONE.muln(5))
      .accounts({
        authority:       wallet.publicKey,
        recipient:       founder.publicKey,
        protocolState:   statePda,
        oSolaMint:       oSolaM,
        recipientOSola:  founderOSola,
        tokenProgram:    TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:   anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    // The context constrains a hiSOLA ATA; empty is fine.
    const founderHiSola = await getOrCreateAssociatedTokenAccount(
      connection, founder, hiSolaM, founder.publicKey
    );

    const epoch = new BN(Math.floor(Date.now() / 1000 / 604_800));
    const [uev] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("uev"), founder.publicKey.toBuffer(), epoch.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    try {
      await program.methods
        .burnOSolaForVotes(ONE, epoch)
        .accounts({
          user:           founder.publicKey,
          protocolState:  statePda,
          oSolaMint:      oSolaM,
          userOSola:      founderOSola,
          hiSolaMint:     hiSolaM,
          userHiSola:     founderHiSola.address,
          // "Pass any account when not using a ve lock" — per the context doc.
          lockPosition:   anchor.web3.SystemProgram.programId,
          userEpochVotes: uev,
          tokenProgram:   TOKEN_PROGRAM_ID,
          systemProgram:  anchor.web3.SystemProgram.programId,
          rent:           anchor.web3.SYSVAR_RENT_PUBKEY,
        } as any)
        .signers([founder])
        .rpc();
      assert.fail("founder must not be able to convert oSOLA into voting power");
    } catch (e: any) {
      // The oSOLA bonus bypasses the per-address vote cap by design, so without this
      // guard the founder's 5M oSOLA would be an uncapped vote path around the muzzle
      // on the 7M reserve.
      assert.include(
        e.toString(), "FounderVotingDisabled",
        `expected the founder guard to fire, got: ${e}`
      );
      console.log("✅ [founder] burn_o_sola_for_votes — guard fired (FounderVotingDisabled)");
    }
  });

  it("[founder] claim_founder_hi_sola escrows into the ve lock, never the wallet", async () => {
    const founder = anchor.web3.Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync("tests/keys/founder-devnet.json", "utf8")))
    );

    const [hiVesting] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("founder_hi_vesting")], program.programId);
    const [oVesting] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("founder_vesting")], program.programId);

    await program.methods
      .mintFounderAllocation()
      .accounts({
        authority:        wallet.publicKey,
        protocolState:    statePda,
        founder:          founder.publicKey,
        founderHiVesting: hiVesting,
        founderVesting:   oVesting,
        systemProgram:    anchor.web3.SystemProgram.programId,
        rent:             anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    // start_ts is stamped from the Clock here, so the only way past the cliff is to wait it out.
    await new Promise((r) => setTimeout(r, 6_000));

    const [lockPos] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("velock"), founder.publicKey.toBuffer()], program.programId);
    const [veVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("ve_vault"), founder.publicKey.toBuffer()], program.programId);
    const [founderPos] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), founder.publicKey.toBuffer()], program.programId);

    const before = await program.account.protocolState.fetch(statePda);

    await program.methods
      .claimFounderHiSola()
      .accounts({
        founder:          founder.publicKey,
        protocolState:    statePda,
        solaMint:         solaM,
        hiSolaMint:       hiSolaM,
        solaVault:        solaVault,
        marketVault:      marketV,
        lockPosition:     lockPos,
        veLockVault:      veVault,
        founderPosition:  founderPos,
        founderHiVesting: hiVesting,
        tokenProgram:     TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:    anchor.web3.SystemProgram.programId,
      } as any)
      .signers([founder])
      .rpc();

    const after = await program.account.protocolState.fetch(statePda);
    const escrowed = await getTokenBalance(connection, veVault);

    // The reserve landed in escrow, not in a spendable balance.
    assert.isTrue(escrowed > 0n, "hiSOLA must be minted into the ve lock vault");

    // The wallet ATA exists (created by the previous test) — it must stay empty, which is
    // what makes borrow_usdc blind to the 7M and unstake → sell_sola unreachable.
    const founderHiAta = anchor.utils.token.associatedAddress({
      mint: hiSolaM, owner: founder.publicKey,
    });
    assert.equal(
      (await getTokenBalance(connection, founderHiAta)).toString(), "0",
      "founder wallet must never hold hiSOLA"
    );

    // The whole point: locked hiSOLA stays out of the fee accumulator denominator, so the
    // 7M reserve cannot capture protocol fees.
    assert.equal(
      after.totalHiSola.toString(), before.totalHiSola.toString(),
      "total_hi_sola must not grow → reserve earns no fees"
    );

    console.log(
      `✅ [founder] escrow — ${Number(escrowed) / 1e6} hiSOLA locked, wallet 0, ` +
      `total_hi_sola unchanged (${after.totalHiSola.toString()})`
    );
  });

  it("[founder] unlock_hi_sola rejects the founder — locked for life", async () => {
    const founder = anchor.web3.Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync("tests/keys/founder-devnet.json", "utf8")))
    );

    const [lockPos] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("velock"), founder.publicKey.toBuffer()], program.programId);
    const [veVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("ve_vault"), founder.publicKey.toBuffer()], program.programId);
    const [founderPos] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), founder.publicKey.toBuffer()], program.programId);
    const founderHiAta = anchor.utils.token.associatedAddress({
      mint: hiSolaM, owner: founder.publicKey,
    });

    try {
      await program.methods
        .unlockHiSola()
        .accounts({
          user:          founder.publicKey,
          protocolState: statePda,
          hiSolaMint:    hiSolaM,
          userHiSola:    founderHiAta,
          lockPosition:  lockPos,
          veLockVault:   veVault,
          marketVault:   marketV,
          userPosition:  founderPos,
          tokenProgram:  TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .signers([founder])
        .rpc();
      assert.fail("the founder reserve must never leave escrow");
    } catch (e: any) {
      // Unlocking would undo all three guarantees at once: fee accrual resumes,
      // borrow_usdc regains sight of the 7M, and unstake → sell_sola becomes a floor drain.
      assert.include(
        e.toString(), "FounderVestingLocked",
        `expected the lock-for-life guard to fire, got: ${e}`
      );
      console.log("✅ [founder] unlock_hi_sola — guard fired (FounderVestingLocked)");
    }
  });

  it("[team] ecosystem allocation locks the 250K into a ve position, never a wallet", async () => {
    const TEAM_WALLET = new anchor.web3.PublicKey(
      "CL4yt4Ep6N3AKbbHhQaidjVLNzQrdgT5NobQSE6FGHr3"
    );
    // No signature needed from the team: it is an address-checked UncheckedAccount and the
    // authority is the caller.
    const [teamLock] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("velock"), TEAM_WALLET.toBuffer()], program.programId);
    const [teamVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("ve_vault"), TEAM_WALLET.toBuffer()], program.programId);
    const [teamPos] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), TEAM_WALLET.toBuffer()], program.programId);

    const before = await program.account.protocolState.fetch(statePda);
    const authoritySolaBefore = await getTokenBalance(
      connection, anchor.utils.token.associatedAddress({ mint: solaM, owner: wallet.publicKey })
    );

    await program.methods
      .mintEcosystemAllocation()
      .accounts({
        authority:        wallet.publicKey,
        protocolState:    statePda,
        solaMint:         solaM,
        hiSolaMint:       hiSolaM,
        solaVault,
        marketVault:      marketV,
        teamWallet:       TEAM_WALLET,
        teamLockPosition: teamLock,
        teamVeLockVault:  teamVault,
        teamPosition:     teamPos,
        tokenProgram:     TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:    anchor.web3.SystemProgram.programId,
        rent:             anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const after    = await program.account.protocolState.fetch(statePda);
    const escrowed = await getTokenBalance(connection, teamVault);
    const TEAM_AMOUNT = 250_000_000_000n;

    assert.equal(escrowed.toString(), TEAM_AMOUNT.toString(),
      "the full 250K must land in the team's ve lock vault");

    // The team wallet must hold no hiSOLA: that is what keeps borrow_usdc blind to it (so
    // the 20% cap can't be sidestepped) and unstake → sell_sola out of reach.
    const teamHiAta = anchor.utils.token.associatedAddress({
      mint: hiSolaM, owner: TEAM_WALLET,
    });
    const teamWalletBal = await connection.getAccountInfo(teamHiAta);
    assert.isNull(teamWalletBal, "team wallet must have no hiSOLA ATA at all");

    // Locked hiSOLA stays out of the fee denominator — the team earns nothing during the lock.
    assert.equal(after.totalHiSola.toString(), before.totalHiSola.toString(),
      "total_hi_sola must not grow → team tranche earns no fees while locked");

    // Locked for LIFE: the whole tranche is permanent, so even after lock_end_ts passes,
    // unlock_hi_sola releases amount_locked − permanent_amount = 0. The 4-year deferred
    // drain (unlock → unstake → sell_sola) is closed; only the 20% borrow channel remains.
    const lock = await program.account.veLockPosition.fetch(teamLock);
    assert.equal(lock.permanentAmount.toString(), TEAM_AMOUNT.toString(),
      "the entire team tranche must be permanent — never releasable");
    const nowTs = Math.floor(Date.now() / 1000);
    assert.isTrue(lock.lockEndTs.toNumber() - nowTs > 200 * 604_800,
      "lock_end_ts is ~4 years out, but permanent_amount overrides it forever");

    // The 1.75M ecosystem budget must NOT be minted as liquid SOLA anymore — that was the
    // largest floor-drain vector in the protocol. It is issued as oSOLA via
    // distribute_o_sola instead, where the holder pays 1 USDC into the floor to exercise.
    const authoritySolaAfter = await getTokenBalance(
      connection, anchor.utils.token.associatedAddress({ mint: solaM, owner: wallet.publicKey })
    );
    assert.equal(
      authoritySolaAfter.toString(), authoritySolaBefore.toString(),
      "authority must receive ZERO liquid SOLA — the ecosystem budget is oSOLA now"
    );

    console.log(
      `✅ [team] 250K hiSOLA locked until epoch-time ${lock.lockEndTs.toString()}, ` +
      `wallet has no ATA, total_hi_sola unchanged, 0 unfinanced SOLA minted`
    );
  });

  it("[contributor] claims a lifetime-locked hiSOLA bag + oSOLA, all at launch", async () => {
    const contributor = anchor.web3.Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(contributor.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );

    const HI = new BN(5_000).mul(ONE);   // 5,000 hiSOLA
    const OS = new BN(5_000).mul(ONE);   // 5,000 oSOLA
    const [vesting] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), contributor.publicKey.toBuffer()], program.programId);

    // Authority registers the contributor.
    await program.methods
      .registerContributor(HI, OS)
      .accounts({
        authority:          wallet.publicKey,
        protocolState:      statePda,
        contributorWallet:  contributor.publicKey,
        contributorVesting: vesting,
        systemProgram:      anchor.web3.SystemProgram.programId,
        rent:               anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const [lockPos] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("velock"), contributor.publicKey.toBuffer()], program.programId);
    const [veVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("ve_vault"), contributor.publicKey.toBuffer()], program.programId);
    const [cPos] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), contributor.publicKey.toBuffer()], program.programId);

    const before = await program.account.protocolState.fetch(statePda);

    // Contributor claims the hiSOLA bag — all at once, into a lifetime ve lock.
    await program.methods
      .claimContributorHiSola()
      .accounts({
        contributor:        contributor.publicKey,
        protocolState:      statePda,
        solaMint:           solaM,
        hiSolaMint:         hiSolaM,
        solaVault,
        marketVault:        marketV,
        lockPosition:       lockPos,
        veLockVault:        veVault,
        contributorPosition: cPos,
        contributorVesting: vesting,
        tokenProgram:       TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:      anchor.web3.SystemProgram.programId,
      } as any)
      .signers([contributor])
      .rpc();

    const after = await program.account.protocolState.fetch(statePda);
    const escrowed = await getTokenBalance(connection, veVault);
    const lock = await program.account.veLockPosition.fetch(lockPos);

    assert.equal(escrowed.toString(), HI.toString(), "full 5K hiSOLA must land in the ve lock");
    assert.equal(lock.permanentAmount.toString(), HI.toString(),
      "the whole bag is permanent — locked for life");
    const cHiAta = anchor.utils.token.associatedAddress({ mint: hiSolaM, owner: contributor.publicKey });
    assert.isNull(await connection.getAccountInfo(cHiAta),
      "contributor wallet must hold no hiSOLA (escrowed, not liquid)");
    assert.equal(after.totalHiSola.toString(), before.totalHiSola.toString(),
      "total_hi_sola unchanged → locked bag earns no fees");

    // And claims the oSOLA tranche — to the wallet, floor-neutral until exercised.
    const cOSola = anchor.utils.token.associatedAddress({ mint: oSolaM, owner: contributor.publicKey });
    await program.methods
      .claimContributorVesting()
      .accounts({
        contributor:        contributor.publicKey,
        protocolState:      statePda,
        oSolaMint:          oSolaM,
        contributorVesting: vesting,
        contributorOSola:   cOSola,
        tokenProgram:       TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:      anchor.web3.SystemProgram.programId,
      } as any)
      .signers([contributor])
      .rpc();

    assert.equal((await getTokenBalance(connection, cOSola)).toString(), OS.toString(),
      "full 5K oSOLA minted to the contributor wallet");

    console.log("✅ [contributor] 5K hiSOLA locked for life (permanent) + 5K oSOLA claimed at launch");
  });

  it("[ecosystem] distribute_o_sola is capped at ECOSYSTEM_TOTAL", async () => {
    const ECOSYSTEM_TOTAL = 1_750_000_000_000n;
    const st = await program.account.protocolState.fetch(statePda);
    const alreadyMinted = BigInt(st.ecosystemOSolaMinted.toString());

    // Earlier tests minted a few oSOLA through this same path, so the counter tracks them.
    assert.isTrue(alreadyMinted > 0n, "the counter must track prior distribute_o_sola calls");

    const recipient = anchor.web3.Keypair.generate().publicKey;
    const recipientOSola = anchor.utils.token.associatedAddress({
      mint: oSolaM, owner: recipient,
    });

    // One unit past the remaining budget must be refused. Until 2026-07-18 the only check
    // was `amount > 0`: the published 1.75M constrained nothing and the authority could
    // dilute every holder's upside without limit.
    const overBudget = new BN((ECOSYSTEM_TOTAL - alreadyMinted + 1n).toString());
    try {
      await program.methods
        .distributeOSola(overBudget)
        .accounts({
          authority:      wallet.publicKey,
          recipient,
          protocolState:  statePda,
          oSolaMint:      oSolaM,
          recipientOSola,
          tokenProgram:   TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram:  anchor.web3.SystemProgram.programId,
        } as any)
        .rpc();
      assert.fail("minting past ECOSYSTEM_TOTAL must be refused");
    } catch (e: any) {
      assert.include(e.toString(), "EcosystemBudgetExceeded",
        `expected the budget cap to fire, got: ${e}`);
    }

    console.log(
      `✅ [ecosystem] cap holds — ${Number(alreadyMinted) / 1e6} oSOLA minted of ` +
      `${Number(ECOSYSTEM_TOTAL) / 1e6} budget; overspend refused`
    );
  });

  it("[partner] the welcome bag can never be unlocked — permanent voting power", async () => {
    const partner = anchor.web3.Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(partner.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );

    const [alloc] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("partner"), partner.publicKey.toBuffer()], program.programId);
    const [lockPos] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("velock"), partner.publicKey.toBuffer()], program.programId);
    const [veVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("ve_vault"), partner.publicKey.toBuffer()], program.programId);
    const [partnerPos] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), partner.publicKey.toBuffer()], program.programId);

    // Welcome bag only in practice: cap_hi_sola must be > 0 (register_partner refuses a
    // deal without a bribe commitment), but this partner never deposits a single bribe, so
    // bribe_earned stays 0 and everything claimed is the unfinanced bag.
    // lock_duration = MIN_LOCK_DURATION (5 s on devnet).
    await program.methods
      .registerPartner(usdcMint, new BN(1), new BN(1), ONE, ONE, new BN(5))
      .accounts({
        authority:         wallet.publicKey,
        protocolState:     statePda,
        partnerWallet:     partner.publicKey,
        partnerAllocation: alloc,
        systemProgram:     anchor.web3.SystemProgram.programId,
        rent:              anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    // Let a slice of the bag vest (BASE_BAG_VEST_SECS = 6 h on devnet → linear).
    await new Promise((r) => setTimeout(r, 6_000));

    await program.methods
      .claimPartnerAllocation()
      .accounts({
        partner:           partner.publicKey,
        protocolState:     statePda,
        solaMint:          solaM,
        hiSolaMint:        hiSolaM,
        solaVault,
        marketVault:       marketV,
        partnerAllocation: alloc,
        lockPosition:      lockPos,
        veLockVault:       veVault,
        partnerPosition:   partnerPos,
        tokenProgram:      TOKEN_PROGRAM_ID,
        systemProgram:     anchor.web3.SystemProgram.programId,
        rent:              anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([partner])
      .rpc();

    const lock = await program.account.veLockPosition.fetch(lockPos);
    assert.isTrue(lock.amountLocked.toNumber() > 0, "some of the bag must have vested");
    assert.equal(
      lock.permanentAmount.toString(), lock.amountLocked.toString(),
      "the whole bag must be marked permanent — it is unfinanced, no USDC ever backed it"
    );

    // Wait out the 5 s lock so the ONLY thing standing between the bag and a wallet is
    // permanent_amount, not the timer.
    await new Promise((r) => setTimeout(r, 6_000));

    const partnerHiAta = anchor.utils.token.associatedAddress({
      mint: hiSolaM, owner: partner.publicKey,
    });
    try {
      await program.methods
        .unlockHiSola()
        .accounts({
          user:          partner.publicKey,
          protocolState: statePda,
          hiSolaMint:    hiSolaM,
          userHiSola:    partnerHiAta,
          lockPosition:  lockPos,
          veLockVault:   veVault,
          marketVault:   marketV,
          userPosition:  partnerPos,
          tokenProgram:  TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .signers([partner])
        .rpc();
      assert.fail("the welcome bag must never leave the ve lock, expired or not");
    } catch (e: any) {
      // releasable = amount_locked − permanent_amount = 0 → NothingToClaim.
      assert.include(e.toString(), "NothingToClaim",
        `expected the permanent bag to block unlock, got: ${e}`);
    }

    // Still locked, still voting, and still borrowable at 20% via borrow_against_locked.
    const after = await program.account.veLockPosition.fetch(lockPos);
    assert.equal(after.amountLocked.toString(), lock.amountLocked.toString(),
      "the bag must remain in the vault after the failed unlock");

    console.log(
      `✅ [partner] bag of ${after.amountLocked.toNumber() / 1e6} hiSOLA is permanent — ` +
      `lock expired, unlock refused, voting power retained`
    );
  });

  it("[curve] k is mainnet-scale, not the Beradrome doc example", async () => {
    const st = await program.account.protocolState.fetch(statePda);

    // N = INIT_VIRTUAL_* = 1M tokens at 6 dec = 1e12 base units; k = N² = 1e24.
    // The old value was 100/100 (k = 1e16) — Beradrome's illustrative doc example,
    // under which $10k of buys priced SOLA at $10,201 against a $1 floor.
    const N = new BN(1_000_000).mul(ONE);
    assert.equal(st.k.toString(), N.mul(N).toString(), "k must be 1e24");

    // k is set once at initialize and never recomputed, so this assertion holds for the
    // life of the protocol — unlike the virtual reserves, which drift with every buy.
    console.log(`✅ [curve] k = ${st.k.toString()} | ×2 needs ~414k USDC of buys`);
  });

  // ── LP reward accounting (regression for the 2026-07-21 findings) ──────────
  // Best run on localnet: `anchor test --provider.cluster localnet`. Uses an isolated
  // pool with two throwaway mints so nothing here touches the SOLA/USDC pool or the
  // curve/POL/invariant tests above.
  //
  // The full epoch-emission path (emit_pool_rewards → claim_lp_emissions, Finding A) needs
  // a 7-day epoch boundary crossed, which this mocha/validator harness can't warp — that
  // stays a documented gap (needs a bankrun-style clock). What IS covered here, in-epoch:
  //   • the continuous path end-to-end (Finding B), including the exact exploit as a guard;
  //   • the checkpoint weight basis (Finding A), where a fresh wallet must bank zero.
  const LP_DEAD = anchor.web3.SystemProgram.programId; // = LP_DEAD_PUBKEY
  let lpPool: anchor.web3.PublicKey;
  let lpMintX: anchor.web3.PublicKey;
  let mintX: anchor.web3.PublicKey;
  let mintY: anchor.web3.PublicKey;
  let lpVaultA: anchor.web3.PublicKey;
  let lpVaultB: anchor.web3.PublicKey;

  const lpUserInfoPda = (pool: anchor.web3.PublicKey, u: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lp_user"), pool.toBuffer(), u.toBuffer()], program.programId)[0];

  it("[lp-reward] sets up an isolated rewards-enabled pool with liquidity", async () => {
    // Two fresh mints, wallet-funded on both sides.
    mintX = await createMint(connection, wallet.payer, wallet.publicKey, null, DECIMALS);
    mintY = await createMint(connection, wallet.payer, wallet.publicKey, null, DECIMALS);
    const [ma, mb] = Buffer.compare(mintX.toBuffer(), mintY.toBuffer()) < 0 ? [mintX, mintY] : [mintY, mintX];

    [lpPool]   = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("amm_pool"), ma.toBuffer(), mb.toBuffer()], program.programId);
    [lpMintX]  = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("lp_mint"), lpPool.toBuffer()], program.programId);
    [lpVaultA] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("vault_a"), lpPool.toBuffer()], program.programId);
    [lpVaultB] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("vault_b"), lpPool.toBuffer()], program.programId);

    await program.methods.createPool(30, 2000).accounts({
      creator: wallet.publicKey, tokenAMint: ma, tokenBMint: mb, pool: lpPool, lpMint: lpMintX,
      tokenAVault: lpVaultA, tokenBVault: lpVaultB, tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    } as any).rpc();

    // Fund the wallet's X/Y ATAs and provide liquidity.
    const ax = await getOrCreateAssociatedTokenAccount(connection, wallet.payer, ma, wallet.publicKey);
    const ay = await getOrCreateAssociatedTokenAccount(connection, wallet.payer, mb, wallet.publicKey);
    await mintTo(connection, wallet.payer, ma, ax.address, wallet.payer, 1_000_000_000);
    await mintTo(connection, wallet.payer, mb, ay.address, wallet.payer, 1_000_000_000);

    const userLp   = getAssociatedTokenAddressSync(lpMintX, wallet.publicKey);
    const deadLp   = getAssociatedTokenAddressSync(lpMintX, LP_DEAD, true);
    const userOSola = getAssociatedTokenAddressSync(oSolaM, wallet.publicKey);
    await program.methods.addLiquidity(HUNDRED, HUNDRED, new BN(0)).accounts({
      user: wallet.publicKey, pool: lpPool, lpMint: lpMintX, tokenAVault: lpVaultA, tokenBVault: lpVaultB,
      userTokenA: ax.address, userTokenB: ay.address, userLp, lpDeadAta: deadLp, lpDead: LP_DEAD,
      lpUserInfo: lpUserInfoPda(lpPool, wallet.publicKey), protocolState: statePda, oSolaMint: oSolaM,
      userOSola, rent: anchor.web3.SYSVAR_RENT_PUBKEY, tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId,
    } as any).rpc();

    const info = await program.account.lpUserInfo.fetch(lpUserInfoPda(lpPool, wallet.publicKey));
    const lpBal = await getTokenBalance(connection, userLp);
    assert.isTrue(lpBal > 0n, "wallet received LP");
    assert.equal(info.lpAmount.toString(), lpBal.toString(), "lp_amount tracks the recorded deposit");

    // Arm the continuous stream and enable this pool.
    await program.methods.configureContinuousEmissions(new BN(1_000_000), new BN(100)).accounts({
      authority: wallet.publicKey, protocolState: statePda } as any).rpc();
    await program.methods.setPoolRewards(true).accounts({
      authority: wallet.publicKey, protocolState: statePda, pool: lpPool } as any).rpc();
    console.log(`✅ [lp-reward] pool ${lpPool.toBase58().slice(0, 8)}… — LP=${lpBal}, lp_amount recorded, rewards armed`);
  });

  it("[lp-reward] a real depositor claims continuous oSOLA", async () => {
    const userLp = getAssociatedTokenAddressSync(lpMintX, wallet.publicKey);
    const userOSola = getAssociatedTokenAddressSync(oSolaM, wallet.publicKey);
    await waitForNewSlot(connection); // let osola_reward_per_lp accrue
    const before = await getTokenBalance(connection, userOSola);
    await program.methods.claimLpRewards().accounts({
      user: wallet.publicKey, pool: lpPool, lpMint: lpMintX, userLp,
      lpUserInfo: lpUserInfoPda(lpPool, wallet.publicKey), protocolState: statePda, oSolaMint: oSolaM,
      userOSola, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    } as any).rpc();
    const gained = (await getTokenBalance(connection, userOSola)) - before;
    assert.isTrue(gained > 0n, "legit LP earns continuous oSOLA");
    console.log(`✅ [lp-reward] real depositor claimed ${gained} oSOLA`);
  });

  it("[lp-reward][security] a fresh wallet holding TRANSFERRED LP cannot claim (Finding B)", async () => {
    // The exact confirmed exploit: move LP to a wallet that never deposited, then claim.
    // Pre-fix this minted the whole accumulator since pool creation; now reward_basis =
    // min(lp_amount, wallet_lp) = min(0, x) = 0 → require!(pending > 0) rejects it.
    const F = anchor.web3.Keypair.generate();
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: F.publicKey, lamports: 50_000_000 })));

    const walletLp = getAssociatedTokenAddressSync(lpMintX, wallet.publicKey);
    const fLp = getAssociatedTokenAddressSync(lpMintX, F.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction()
      .add(createAssociatedTokenAccountInstruction(wallet.publicKey, fLp, F.publicKey, lpMintX))
      .add(createTransferInstruction(walletLp, fLp, wallet.publicKey, 10_000_000)));
    assert.isTrue((await getTokenBalance(connection, fLp)) > 0n, "F holds transferred LP");

    const fOSola = getAssociatedTokenAddressSync(oSolaM, F.publicKey);
    await waitForNewSlot(connection); // ensure a non-zero accumulator exists
    let reverted = false;
    try {
      await program.methods.claimLpRewards().accounts({
        user: F.publicKey, pool: lpPool, lpMint: lpMintX, userLp: fLp,
        lpUserInfo: lpUserInfoPda(lpPool, F.publicKey), protocolState: statePda, oSolaMint: oSolaM,
        userOSola: fOSola, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any).signers([F]).rpc();
    } catch (e: any) {
      reverted = true;
      assert.match(e.toString(), /NothingToClaim/, "must reject with NothingToClaim, not another error");
    }
    assert.isTrue(reverted, "fresh-wallet transfer-based claim MUST revert (Finding B closed)");
    console.log("✅ [lp-reward][security] transfer-based claim rejected — Finding B closed");
  });

  it("[lp-emission][security] a fresh wallet banks zero checkpoint weight (Finding A)", async () => {
    // checkpoint_lp weight basis is now reward_basis, not the wallet balance. A fresh wallet
    // that was transferred LP has lp_amount = 0 → weighted_balance stays 0, so the same LP
    // walked through N wallets can no longer inflate the epoch pot.
    const F2 = anchor.web3.Keypair.generate();
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: F2.publicKey, lamports: 50_000_000 })));
    const walletLp = getAssociatedTokenAddressSync(lpMintX, wallet.publicKey);
    const f2Lp = getAssociatedTokenAddressSync(lpMintX, F2.publicKey);
    await provider.sendAndConfirm(new anchor.web3.Transaction()
      .add(createAssociatedTokenAccountInstruction(wallet.publicKey, f2Lp, F2.publicKey, lpMintX))
      .add(createTransferInstruction(walletLp, f2Lp, wallet.publicKey, 10_000_000)));

    const nowEpoch = new BN(Math.floor(Date.now() / 1000 / 604800));
    const [ckptF2] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lp_ckpt"), lpPool.toBuffer(), F2.publicKey.toBuffer()], program.programId);
    const [accum] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lp_pool_epoch"), lpPool.toBuffer(), nowEpoch.toArrayLike(Buffer, "le", 8)], program.programId);

    await waitForNewSlot(connection);
    await program.methods.checkpointLp(nowEpoch).accounts({
      user: F2.publicKey, protocolState: statePda, pool: lpPool, lpMint: lpMintX, userLp: f2Lp,
      lpUserInfo: lpUserInfoPda(lpPool, F2.publicKey), lpUserCheckpoint: ckptF2, poolEpochAccum: accum,
      systemProgram: anchor.web3.SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    } as any).signers([F2]).rpc();

    const ck = await program.account.lpUserCheckpoint.fetch(ckptF2);
    assert.equal(ck.weightedBalance.toString(), "0", "fresh wallet must bank zero weight (Finding A closed)");
    console.log("✅ [lp-emission][security] fresh-wallet checkpoint weight = 0 — Finding A closed");
  });
});
