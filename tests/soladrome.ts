import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Soladrome } from "../target/types/soladrome";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getMint,
  transfer as splTransfer,
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

  // The founder wallet is no longer a compile-time constant selected by a `devnet` feature —
  // `initialize` records it in `ProtocolState.founder_wallet`. That is what lets ONE binary
  // serve devnet and mainnet: a hardcoded Ledger address is unsignable by any harness, so the
  // 12.25M path could only ever be covered by shipping a different binary to devnet.
  //
  // Generated per run rather than read from tests/keys/founder-devnet.json — that file was
  // gitignored, its predecessor leaked to the public repo and forced the 2026-07-21 purge,
  // and its absence silently killed the `[founder]` tests for weeks. Nothing to leak now.
  const founderKp = anchor.web3.Keypair.generate();

  // ── 0. Shared setup (runs before EVERY test in this describe) ───────────────
  // Must be a `before()` hook, not a leading `it()`: a fresh `initialize` writes
  // all six phase flags `false`, so buy_sola / create_pool / exercise_o_sola /
  // deposit_bribe / the vote paths revert FeatureDisabled until the gates are
  // opened. Putting init+funding+flags here (idempotent) guarantees they run even
  // for a filtered/`.only` run of a single test — a plain `it()` would be skipped
  // by the grep and the isolated test would fail FeatureDisabled. This is what a
  // third party (an auditor) hits when they run one test to investigate.
  // Mirrors the devnet enable-all form of scripts/set_phase_flags.ts.
  before("initialize + fund USDC + open the closed-launch gates", async () => {
    // 1. Initialize (idempotent — on devnet/re-run the state PDA already exists,
    //    so reuse its USDC mint; never create a new mint mid-protocol).
    const existingState = await program.account.protocolState.fetchNullable(statePda);
    if (existingState) {
      usdcMint = existingState.usdcMint;
    } else {
      usdcMint = await createMint(
        connection,
        wallet.payer,
        wallet.publicKey, // mint authority
        null,
        DECIMALS
      );
      await program.methods
        .initialize(founderKp.publicKey)
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

    // 2. Ensure the user has an ATA for the USDC mint with at least 1 000 USDC.
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

    // 3. Open the closed-launch gates (idempotent — authority-only, all-true).
    await program.methods
      .setPhaseFlags(true, true, true, true, true, true)
      .accounts({
        authority:     wallet.publicKey,
        protocolState: statePda,
      } as any)
      .rpc();
  });

  // ── 1. Initialize (assertion only — the work is done in before()) ───────────
  it("initializes the protocol", async () => {
    const state = await program.account.protocolState.fetch(statePda);
    assert.equal(state.usdcMint.toBase58(), usdcMint.toBase58(), "USDC mint matches state");
    const ata = await getAccount(connection, userUsdcAta);
    assert.isAtLeast(Number(ata.amount), 1_000_000_000, "user USDC funded to >= 1000");
    console.log("✅ initialize — state PDA:", statePda.toBase58(), "| usdcMint:", usdcMint.toBase58().slice(0, 8) + "…");
  });

  // ── 1b. The closed-launch gates are open (assertion only) ───────────────────
  it("enables the closed-launch phase flags", async () => {
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
    const [positionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()],
      program.programId
    );

    const solaBefore    = await getTokenBalance(connection, userSolaAta);
    const vaultBefore   = await getTokenBalance(connection, solaVault);
    // hiSOLA is a field on the position, not a token balance — there is no mint to read and
    // no ATA to derive. A wallet that has never staked has no position account at all, hence
    // the nullable fetch rather than a `.catch(() => 0n)` on a missing token account.
    const posBefore     = await program.account.userPosition.fetchNullable(positionPda);
    const hiSolaBefore  = posBefore ? BigInt(posBefore.hiSola.toString()) : 0n;

    // Stake 2 SOLA
    const stakeAmount = ONE.muln(2);
    await program.methods
      .stakeSola(stakeAmount)
      .accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
        solaMint:      solaM,
        // usdc_mint is a test-created mint, not a PDA, so Anchor cannot derive the
        // user_usdc ATA constrained on it — both must be passed explicitly.
        usdcMint:      usdcMint,
        userUsdc:      userUsdcAta,
        userSola:      userSolaAta,
        solaVault:     solaVault,
        marketVault:   marketV,
        userPosition:  positionPda,
        tokenProgram:  TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    const solaAfter    = await getTokenBalance(connection, userSolaAta);
    const posAfter     = await program.account.userPosition.fetch(positionPda);
    const hiSolaAfter  = BigInt(posAfter.hiSola.toString());
    const vaultAfter   = await getTokenBalance(connection, solaVault);

    assert.equal(
      Number(solaBefore - solaAfter),
      Number(stakeAmount.toString()),
      "SOLA locked"
    );
    // Use delta (not absolute) — the position may carry hiSOLA from prior devnet runs
    assert.equal(
      Number(hiSolaAfter - hiSolaBefore),
      Number(stakeAmount.toString()),
      "hiSOLA credited 1:1"
    );
    assert.equal(
      Number(BigInt(posAfter.stakedAmount.toString()) -
             BigInt(posBefore ? posBefore.stakedAmount.toString() : "0")),
      Number(stakeAmount.toString()),
      "staked_amount tracks the financed deposit alongside the balance"
    );
    assert.equal(
      Number(vaultAfter - vaultBefore),
      Number(stakeAmount.toString()),
      "sola_vault increased"
    );

    console.log("✅ stake_sola — 2 SOLA → 2 hiSOLA credited to the position");
  });

  // ── 5. Borrow USDC against hiSOLA ─────────────────────────────────────────
  it("borrows USDC against hiSOLA collateral (2% fee to market_vault)", async () => {
    const [positionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()],
      program.programId
    );
    const usdcBefore   = await getTokenBalance(connection, userUsdcAta);
    const floorBefore  = await getTokenBalance(connection, floorV);
    const marketBefore = await getTokenBalance(connection, marketV);

    // Borrow 1 USDC — 2% fee = 0.02 USDC → market_vault; user receives 0.98 USDC
    await program.methods
      .borrowUsdc(ONE)
      .accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
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

  // Third instance of the same defect class as the vote duplication and the fee-history
  // drain: an entitlement priced off a token balance. The borrow cap used to read
  // `user_hi_sola.amount` alone, and `unstake_hi_sola`'s debt guard gates the burn, not a
  // transfer — so the same collateral could be walked wallet to wallet, each hop drawing the
  // floor down again, with no interest and no liquidation to ever bring it back.
  //
  // The attack is no longer constructible: it needed a transfer, and `stake_sola` mints no
  // token, so the borrower holds nothing to hand over. This asserts that ABSENCE against a
  // real validator — if a mint ever comes back, the assertion fails here and the
  // `staked_amount.min(hi_sola)` cap becomes load-bearing again. The cap's own behaviour is
  // proven by mutation in tests/bankrun_borrow_recycle.ts; this is the end-to-end companion.
  it("[security] there is no collateral to walk to a fresh wallet", async () => {
    const borrower = anchor.web3.Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(borrower.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );
    const bUsdc = await getOrCreateAssociatedTokenAccount(
      connection, wallet.payer, usdcMint, borrower.publicKey
    );
    await mintTo(connection, wallet.payer, usdcMint, bUsdc.address, wallet.payer, 100_000_000);

    const bSola   = anchor.utils.token.associatedAddress({ mint: solaM,   owner: borrower.publicKey });
    // Derived only to prove it does not exist — see the ABSENCE assertions below.
    const bHiSola = anchor.utils.token.associatedAddress({ mint: hiSolaM, owner: borrower.publicKey });
    const [bPos]  = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), borrower.publicKey.toBuffer()], program.programId);

    await program.methods
      .buySola(new BN(10_000_000), new BN(1))
      .accounts({
        user: borrower.publicKey, protocolState: statePda, solaMint: solaM,
        userUsdc: bUsdc.address, userSola: bSola,
        floorVault: floorV, marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([borrower])
      .rpc();

    const bought = await getTokenBalance(connection, bSola);
    await program.methods
      .stakeSola(new BN(bought.toString()))
      .accounts({
        user: borrower.publicKey, protocolState: statePda,
        solaMint: solaM, usdcMint, userUsdc: bUsdc.address,
        userSola: bSola, solaVault, marketVault: marketV, userPosition: bPos,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([borrower])
      .rpc();

    const bPosStaked = await program.account.userPosition.fetch(bPos);
    const collateral = BigInt(bPosStaked.hiSola.toString());
    assert.isAbove(Number(collateral), 0, "the borrower must hold real, financed hiSOLA");
    assert.equal(
      bPosStaked.stakedAmount.toString(), collateral.toString(),
      "and it must be financed — bought through the curve, not released by a lock"
    );

    // ── The premise of the old attack, now unavailable ────────────────────────
    // No supply and no token account: there is no object a transfer could take.
    assert.equal(
      (await getMint(connection, hiSolaM)).supply, 0n,
      "hiSOLA has no supply, so no balance exists to hand over"
    );
    assert.isNull(
      await connection.getAccountInfo(bHiSola),
      "the borrower holds no hiSOLA token account at all"
    );

    // A modest draw: this test is about who may borrow, not about the floor buffer.
    const draw = new BN(1_000_000);
    await program.methods
      .borrowUsdc(draw)
      .accounts({
        user: borrower.publicKey, protocolState: statePda,
        floorVault: floorV, marketVault: marketV,
        userUsdc: bUsdc.address, userPosition: bPos,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([borrower])
      .rpc();

    // What the accomplice would have received is now unreachable: their position stays empty
    // whatever the borrower does, so the second hop starts from nothing.
    const accomplice = anchor.web3.Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(accomplice.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );
    const aUsdc = await getOrCreateAssociatedTokenAccount(
      connection, wallet.payer, usdcMint, accomplice.publicKey
    );

    const [aPos] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), accomplice.publicKey.toBuffer()], program.programId);

    const floorBefore = await getTokenBalance(connection, floorV);
    let secondDrawSucceeded = false;
    try {
      await program.methods
        .borrowUsdc(draw)
        .accounts({
          user: accomplice.publicKey, protocolState: statePda,
          floorVault: floorV, marketVault: marketV,
          userUsdc: aUsdc.address, userPosition: aPos,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .signers([accomplice])
        .rpc();
      secondDrawSucceeded = true;
    } catch (e: any) {
      assert.include(
        e.toString(), "BorrowLimitExceeded",
        `expected the cap to refuse unfinanced collateral, got: ${e}`
      );
    }

    assert.isFalse(
      secondDrawSucceeded,
      "a wallet that never staked drew on the floor"
    );
    assert.equal(
      await getTokenBalance(connection, floorV), floorBefore,
      "floor_vault must not fund a borrow against collateral the wallet never financed"
    );
    // `borrow_usdc` opens the position with init_if_needed, but the refusal rolls the whole
    // transaction back, so the account never lands. Either way the accomplice must end with
    // nothing: no position at all, or an empty one.
    const aPosAfter = await program.account.userPosition.fetchNullable(aPos);
    if (aPosAfter) {
      assert.equal(aPosAfter.hiSola.toString(), "0", "the accomplice holds no hiSOLA");
      assert.equal(aPosAfter.stakedAmount.toString(), "0", "and financed nothing");
      assert.equal(aPosAfter.usdcBorrowed.toString(), "0", "so it carries no debt");
    }

    // The borrower's own collateral is untouched by any of this: nothing left, nothing to
    // lose. The old PoC asserted the opposite here — that handing the tokens away also cost
    // the sender their borrow capacity — which was the Invictus failure mode, not a defence.
    assert.equal(
      BigInt((await program.account.userPosition.fetch(bPos)).hiSola.toString()),
      collateral,
      "the borrower still holds every unit of their stake"
    );

    // Clean up: hand the draw back. An unrepaid borrow leaves floor_vault permanently short,
    // which later trips the narrower `floor_vault >= total_purchased_sola` invariant assertion
    // — a real effect of this test, not a protocol defect (the program's own invariant counts
    // total_usdc_borrowed and held throughout).
    await waitForNewSlot(connection);
    await program.methods
      .repayUsdc(draw)
      .accounts({
        user: borrower.publicKey, protocolState: statePda, userPosition: bPos,
        floorVault: floorV, userUsdc: bUsdc.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([borrower])
      .rpc();
    assert.equal(
      (await program.account.userPosition.fetch(bPos)).usdcBorrowed.toNumber(), 0,
      "the PoC returns the protocol to a zero-debt state"
    );

    console.log("✅ security — no hiSOLA supply exists to walk, and an empty position borrows nothing");
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
    const hiSolaBefore = BigInt(
      (await program.account.userPosition.fetch(positionPda)).hiSola.toString()
    );
    const solaBefore   = await getTokenBalance(connection, userSolaAta);

    await program.methods
      .unstakeHiSola(ONE.muln(2))
      .accounts({
        user:          wallet.publicKey,
        protocolState: statePda,
        solaMint:      solaM,
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

    const posAfter    = await program.account.userPosition.fetch(positionPda);
    const hiSolaAfter = BigInt(posAfter.hiSola.toString());
    const solaAfter   = await getTokenBalance(connection, userSolaAta);

    assert.equal(Number(hiSolaBefore - hiSolaAfter), Number(ONE.muln(2).toString()), "hiSOLA debited");
    assert.equal(Number(solaAfter - solaBefore), Number(ONE.muln(2).toString()), "SOLA returned");
    console.log("✅ unstake_hi_sola — 2 hiSOLA → 2 SOLA");
  });

  // ── 8. Claim fees from market vault ──────────────────────────────────────
  it("claims pro-rata fees from market_vault (permissionless)", async () => {
    // Re-stake so the position carries hiSOLA again (the unstake test debited it)
    const userSolaAta = anchor.utils.token.associatedAddress({ mint: solaM, owner: wallet.publicKey });
    const [positionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .stakeSola(ONE.muln(2))
      .accounts({
        user: wallet.publicKey, protocolState: statePda,
        solaMint: solaM,
        // Same as the main stake test: usdc_mint is not a PDA, so the user_usdc ATA
        // constrained on it cannot be derived. This re-stake feeds `lock` and
        // `vote_gauge` downstream — all three fail together without it.
        usdcMint: usdcMint, userUsdc: userUsdcAta,
        userSola: userSolaAta, solaVault: solaVault, marketVault: marketV,
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

  // Found by the guided Trident target (invariant I-3), then reduced to this deterministic
  // case. Unlike the two bugs fixed earlier, this one needed no unstamped position: both
  // wallets were stamped correctly. It was the transfer itself that broke the accounting —
  // hiSOLA carried its unclaimed accrual to a recipient whose `fees_debt` baseline was OLDER,
  // so the moved tokens were credited fees from before they ever sat in that wallet.
  //
  // A ledger balance never changes hands, so the two baselines can no longer be merged. What
  // survives is the half of the test that was never about the transfer: each staker draws no
  // more than the accumulator says it earned since ITS OWN entry. Keeping the honest-
  // entitlement arithmetic (rather than only asserting the transfer is gone) is deliberate —
  // it is the accumulator that this case actually exercises end-to-end on a real validator.
  it("[security] a later staker's balance cannot reach an older fee baseline", async () => {
    const PRECISION = new BN("1000000000000");

    const mkUser = async () => {
      const kp = anchor.web3.Keypair.generate();
      await connection.confirmTransaction(
        await connection.requestAirdrop(kp.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
        "confirmed"
      );
      const usdc = await getOrCreateAssociatedTokenAccount(
        connection, wallet.payer, usdcMint, kp.publicKey
      );
      await mintTo(connection, wallet.payer, usdcMint, usdc.address, wallet.payer, 200_000_000);
      return {
        kp,
        usdc: usdc.address,
        sola: anchor.utils.token.associatedAddress({ mint: solaM, owner: kp.publicKey }),
        hi: anchor.utils.token.associatedAddress({ mint: hiSolaM, owner: kp.publicKey }),
        pos: anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("position"), kp.publicKey.toBuffer()], program.programId)[0],
      };
    };

    const buyAndStake = async (u: any, usdcIn: number) => {
      await program.methods
        .buySola(new BN(usdcIn), new BN(1))
        .accounts({
          user: u.kp.publicKey, protocolState: statePda, solaMint: solaM,
          userUsdc: u.usdc, userSola: u.sola, floorVault: floorV, marketVault: marketV,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .signers([u.kp])
        .rpc();
      const bought = await getTokenBalance(connection, u.sola);
      await program.methods
        .stakeSola(new BN(bought.toString()))
        .accounts({
          user: u.kp.publicKey, protocolState: statePda,
          solaMint: solaM, usdcMint,
          userUsdc: u.usdc, userSola: u.sola, solaVault, marketVault: marketV, userPosition: u.pos,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .signers([u.kp])
        .rpc();
      return BigInt(
        (await program.account.userPosition.fetch(u.pos)).hiSola.toString()
      );
    };

    // `old` stakes FIRST, so its fees_debt baseline is the older, lower one.
    const older = await mkUser();
    const oldStake = await buyAndStake(older, 40_000_000);
    assert.isAbove(Number(oldStake), 0, "the early staker must hold hiSOLA");

    // Fees accrue while only `older` is staked, then `newer` joins at a higher baseline.
    await program.methods
      .buySola(new BN(60_000_000), new BN(1))
      .accounts({
        user: wallet.publicKey, protocolState: statePda, solaMint: solaM,
        userUsdc: userUsdcAta,
        userSola: anchor.utils.token.associatedAddress({ mint: solaM, owner: wallet.publicKey }),
        floorVault: floorV, marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    const newer = await mkUser();
    const newStake = await buyAndStake(newer, 40_000_000);
    assert.isAbove(Number(newStake), 0, "the late staker must hold hiSOLA");

    // More fees AFTER the late staker joined, so its honest entitlement is genuinely
    // non-zero and the assertion compares two real terms rather than one.
    await program.methods
      .buySola(new BN(50_000_000), new BN(1))
      .accounts({
        user: wallet.publicKey, protocolState: statePda, solaMint: solaM,
        userUsdc: userUsdcAta,
        userSola: anchor.utils.token.associatedAddress({ mint: solaM, owner: wallet.publicKey }),
        floorVault: floorV, marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    const posOld = await program.account.userPosition.fetch(older.pos);
    const posNew = await program.account.userPosition.fetch(newer.pos);
    assert.isTrue(
      (posNew.feesDebt as BN).gt(posOld.feesDebt as BN),
      "the late staker must carry a strictly higher baseline for this test to bite"
    );

    // The move that used to work: the late staker hands its stake to the early one, whose
    // baseline is older. It has no expression left — neither wallet owns a hiSOLA token
    // account, and the mint has no supply to move between them.
    assert.isNull(
      await connection.getAccountInfo(newer.hi),
      "the late staker holds no hiSOLA token account to send from"
    );
    assert.isNull(
      await connection.getAccountInfo(older.hi),
      "and the early staker holds none to receive into"
    );
    assert.equal(
      (await getMint(connection, hiSolaM)).supply, 0n,
      "the mint carries no supply, so no balance can change baselines"
    );

    // Compare against the HONEST entitlement rather than the vault balance. Measuring
    // solvency alone is too blunt here: the other stakers' unclaimed fees leave slack that
    // silently absorbs a modest over-claim, which is exactly why the first version of this
    // test passed while the defect was live. What each baseline owes is computable:
    //   the early stake earned (acc2 − acc0) on itself,
    //   the late stake earned only (acc2 − acc1) — never the stretch before it existed.
    const st: any = await program.account.protocolState.fetch(statePda);
    const marketBalance = new BN((await getTokenBalance(connection, marketV)).toString());
    const lastBal = new BN(st.lastMarketVaultBalance.toString());
    const totalHi = new BN(st.totalHiSola.toString());
    let acc2 = st.feesPerHiSola as BN;
    if (marketBalance.gt(lastBal) && totalHi.gtn(0)) {
      acc2 = acc2.add(marketBalance.sub(lastBal).mul(PRECISION).div(totalHi));
    }

    const acc0 = posOld.feesDebt as BN;
    const acc1 = posNew.feesDebt as BN;
    const sA = new BN(oldStake.toString());
    const sB = new BN(newStake.toString());

    const honestOld = acc2.sub(acc0).mul(sA).div(PRECISION);
    const honestNew = acc2.sub(acc1).mul(sB).div(PRECISION);
    assert.isTrue(
      honestNew.gtn(0),
      "the late staker must be owed something, or its bound is satisfied vacuously"
    );

    // Measure what each wallet can actually draw by drawing it — never by re-deriving the
    // formula here, which would silently track any change to the program and prove nothing.
    const draw = async (u: any): Promise<BN> => {
      const usdcBefore = await getTokenBalance(connection, u.usdc);
      try {
        await program.methods
          .claimFees()
          .accounts({
            user: u.kp.publicKey, protocolState: statePda,
            marketVault: marketV, userUsdc: u.usdc,
            userPosition: u.pos, tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([u.kp])
          .rpc();
        return new BN(((await getTokenBalance(connection, u.usdc)) - usdcBefore).toString());
      } catch (e: any) {
        // A claim the vault cannot honour is the same defect seen from the other side.
        if (/insufficient funds/i.test(e.toString())) {
          assert.fail(
            `claim_fees promised more than market_vault holds — the fee accounting is ` +
            `insolvent: ${e}`
          );
        }
        // NothingToClaim is a legitimate outcome: the cap can leave a wallet owed zero.
        if (!/NothingToClaim/.test(e.toString())) throw e;
        return new BN(0);
      }
    };

    // The early wallet first: under the old defect it was the recipient, so it is the one
    // that would show the over-claim. It must now draw only what its OWN stake earned.
    const drewOld = await draw(older);
    assert.isTrue(
      drewOld.lte(honestOld),
      `the early staker drew ${drewOld.toString()} but only earned ${honestOld.toString()} ` +
      `(over-claim ${drewOld.sub(honestOld).toString()}) — its baseline is being applied to ` +
      `stake that arrived after it`
    );

    // And the late wallet keeps its own accrual: the balance did not follow the old transfer,
    // so its entitlement is still there to claim.
    const drewNew = await draw(newer);
    assert.isTrue(
      drewNew.lte(honestNew),
      `the late staker drew ${drewNew.toString()} but only earned ${honestNew.toString()}`
    );
    assert.isTrue(
      drewNew.gtn(0),
      "the late staker's fees stayed with it — under the token model they could be handed away"
    );

    console.log(
      `✅ security — each baseline draws only its own accrual ` +
      `(early ${drewOld.toString()}/${honestOld.toString()}, ` +
      `late ${drewNew.toString()}/${honestNew.toString()})`
    );
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

  /// Mirror of the on-chain fee math (lib.rs `exercise_o_sola`), kept as an
  /// independent reimplementation on purpose: if the contract's ordering or
  /// rounding ever changes, this diverges and the test fails rather than
  /// silently agreeing with whatever the program now does.
  ///   fee = (amount × (vu − vs) / vs) × fee_bps / 10_000
  function expectedExerciseFee(
    amount: bigint, virtualUsdc: bigint, virtualSola: bigint, feeBps: bigint,
  ): bigint {
    if (virtualUsdc <= virtualSola || virtualSola === 0n || feeBps === 0n) return 0n;
    const gain = (amount * (virtualUsdc - virtualSola)) / virtualSola;
    return (gain * feeBps) / 10_000n;
  }

  /// Mint oSOLA to the test wallet so each exercise test stands on its own instead of
  /// consuming whatever the previous one left behind — a filtered/`.only` run must pass
  /// in isolation (same reasoning as the top-level `before()` hook).
  async function topUpOSola(amount: BN) {
    const userOSolaAta = anchor.utils.token.associatedAddress({ mint: oSolaM, owner: wallet.publicKey });
    await program.methods
      .distributeOSola(amount)
      .accounts({
        authority:      wallet.publicKey,
        recipient:      wallet.publicKey,
        protocolState:  statePda,
        oSolaMint:      oSolaM,
        recipientOSola: userOSolaAta,
        tokenProgram:   TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:  anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();
  }

  it("exercises oSOLA: strike to floor IN FULL, gain-based fee on top to market_vault", async () => {
    const userOSolaAta = anchor.utils.token.associatedAddress({
      mint: oSolaM, owner: wallet.publicKey,
    });
    const userSolaAta = anchor.utils.token.associatedAddress({
      mint: solaM, owner: wallet.publicKey,
    });

    await topUpOSola(ONE.muln(3));

    const st = await program.account.protocolState.fetch(statePda);
    const feeBps = BigInt(st.exerciseFeeBps);
    assert.equal(Number(feeBps), 1000, "initialize sets the 10%-of-gain default");

    const oSolaBefore  = await getTokenBalance(connection, userOSolaAta);
    const solaBefore   = await getTokenBalance(connection, userSolaAta);
    const usdcBefore   = await getTokenBalance(connection, userUsdcAta);
    const floorBefore  = await getTokenBalance(connection, floorV);
    const marketBefore = await getTokenBalance(connection, marketV);

    // Exercise 3 oSOLA: strike = 3 USDC, plus 10% of the gain at the curve price.
    const exerciseAmt = ONE.muln(3);
    const amt = BigInt(exerciseAmt.toString());
    const fee = expectedExerciseFee(
      amt,
      BigInt(st.virtualUsdc.toString()),
      BigInt(st.virtualSola.toString()),
      feeBps,
    );

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
        marketVault:   marketV,
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
    const marketAfter = await getTokenBalance(connection, marketV);
    const stAfter     = await program.account.protocolState.fetch(statePda);

    assert.equal(oSolaBefore - oSolaAfter, amt, "oSOLA burned");
    assert.equal(solaAfter - solaBefore,   amt, "SOLA received");

    // ☢️ The load-bearing assertion. The floor must receive the FULL strike — if the
    // fee were ever carved out of it, the floor would grow by less than
    // total_purchased_sola and every exercised SOLA would be under-backed. This is the
    // unfinanced-supply defect closed on 2026-07-17, in a new location.
    assert.equal(floorAfter - floorBefore, amt, "floor receives the FULL strike, fee not carved out");
    assert.equal(marketAfter - marketBefore, fee, "fee landed in market_vault, exactly");
    assert.equal(usdcBefore - usdcAfter, amt + fee, "user paid strike + fee");

    // Backing invariant: the counter grew by exactly what the floor received.
    assert.equal(
      BigInt(stAfter.totalPurchasedSola.toString()) - BigInt(st.totalPurchasedSola.toString()),
      amt,
      "total_purchased_sola incremented by the financed amount only",
    );

    // The fee must never make exercise unprofitable — that is the whole point of
    // pricing it off the gain rather than flat.
    assert.isTrue(fee < amt, "fee stays far below the strike; exercise remains profitable");

    console.log(
      `✅ exercise_o_sola — 3 oSOLA, floor +3 USDC, fee ${Number(fee) / 1e6} USDC → market_vault`,
    );
  });

  it("[exercise-fee] fee accrues to hiSOLA stakers through the lazy accumulator", async () => {
    // Rule 4: the accumulator is advanced on USDC that actually landed, never on a
    // computed figure. exercise_o_sola deliberately does NOT advance it — the next
    // staker interaction picks the growth up. Prove the fee is neither lost nor
    // double-counted: uncredited growth must rise by exactly the fee.
    const userOSolaAta = anchor.utils.token.associatedAddress({ mint: oSolaM, owner: wallet.publicKey });
    const userSolaAta  = anchor.utils.token.associatedAddress({ mint: solaM,  owner: wallet.publicKey });

    await topUpOSola(ONE.muln(2));

    const stBefore = await program.account.protocolState.fetch(statePda);
    const marketBefore = await getTokenBalance(connection, marketV);
    const uncreditedBefore = marketBefore - BigInt(stBefore.lastMarketVaultBalance.toString());

    const exerciseAmt = ONE.muln(2);
    const fee = expectedExerciseFee(
      BigInt(exerciseAmt.toString()),
      BigInt(stBefore.virtualUsdc.toString()),
      BigInt(stBefore.virtualSola.toString()),
      BigInt(stBefore.exerciseFeeBps),
    );
    assert.isTrue(fee > 0n, "curve must be above floor for this test to mean anything");

    await program.methods
      .exerciseOSola(exerciseAmt)
      .accounts({
        user: wallet.publicKey, protocolState: statePda,
        solaMint: solaM, oSolaMint: oSolaM,
        userOSola: userOSolaAta, userSola: userSolaAta,
        floorVault: floorV, marketVault: marketV, userUsdc: userUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    const stAfter = await program.account.protocolState.fetch(statePda);
    const marketAfter = await getTokenBalance(connection, marketV);
    const uncreditedAfter = marketAfter - BigInt(stAfter.lastMarketVaultBalance.toString());

    assert.equal(
      BigInt(stAfter.lastMarketVaultBalance.toString()),
      BigInt(stBefore.lastMarketVaultBalance.toString()),
      "exercise must NOT touch last_market_vault_balance (that would hide the fee from stakers)",
    );
    assert.equal(
      BigInt(stAfter.feesPerHiSola.toString()),
      BigInt(stBefore.feesPerHiSola.toString()),
      "exercise must NOT advance the accumulator itself (lazy pattern, same as buy_sola)",
    );
    assert.equal(uncreditedAfter - uncreditedBefore, fee, "the fee is claimable by stakers, in full");
    assert.equal(
      BigInt(stAfter.accumulatedFees.toString()) - BigInt(stBefore.accumulatedFees.toString()),
      fee,
      "lifetime inflow counter tracks the fee",
    );
    console.log(`✅ exercise fee ${Number(fee) / 1e6} USDC is uncredited growth → claimable by stakers`);
  });

  it("[exercise-fee] set_exercise_fee: caps at 50%, and 0 restores the pre-fee behaviour", async () => {
    // Above the cap → rejected. The cap is not a solvency bound (the floor is untouched
    // either way); it stops an authority from making oSOLA worthless as an LP incentive.
    await topUpOSola(ONE.muln(1));

    let rejected = false;
    try {
      await program.methods.setExerciseFee(5_001)
        .accounts({ authority: wallet.publicKey, protocolState: statePda } as any).rpc();
    } catch { rejected = true; }
    assert.isTrue(rejected, "fee above MAX_EXERCISE_FEE_BPS must revert");

    // Set to 0 and prove exercise is byte-for-byte the old behaviour: strike only.
    await program.methods.setExerciseFee(0)
      .accounts({ authority: wallet.publicKey, protocolState: statePda } as any).rpc();

    const userOSolaAta = anchor.utils.token.associatedAddress({ mint: oSolaM, owner: wallet.publicKey });
    const userSolaAta  = anchor.utils.token.associatedAddress({ mint: solaM,  owner: wallet.publicKey });
    const usdcBefore   = await getTokenBalance(connection, userUsdcAta);
    const marketBefore = await getTokenBalance(connection, marketV);
    const floorBefore  = await getTokenBalance(connection, floorV);

    const exerciseAmt = ONE.muln(1);
    await program.methods
      .exerciseOSola(exerciseAmt)
      .accounts({
        user: wallet.publicKey, protocolState: statePda,
        solaMint: solaM, oSolaMint: oSolaM,
        userOSola: userOSolaAta, userSola: userSolaAta,
        floorVault: floorV, marketVault: marketV, userUsdc: userUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    const amt = BigInt(exerciseAmt.toString());
    assert.equal(await getTokenBalance(connection, marketV) - marketBefore, 0n, "fee 0 → nothing to market_vault");
    assert.equal(await getTokenBalance(connection, floorV) - floorBefore, amt, "floor still receives the full strike");
    assert.equal(usdcBefore - await getTokenBalance(connection, userUsdcAta), amt, "user pays the strike only");

    // Restore the default so later tests see the launch configuration.
    await program.methods.setExerciseFee(1_000)
      .accounts({ authority: wallet.publicKey, protocolState: statePda } as any).rpc();
    const st = await program.account.protocolState.fetch(statePda);
    assert.equal(st.exerciseFeeBps, 1000, "default restored");
    console.log("✅ set_exercise_fee — cap enforced, 0 is a clean no-op, default restored");
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
    const [veLockPda]   = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("velock"), wallet.publicKey.toBuffer()],
      program.programId
    );
    const [positionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()],
      program.programId
    );
    // The ve lock used to be a custody vault holding real tokens. It is now a move between
    // two ledger figures (`UserPosition.hi_sola` → `VeLockPosition.amount_locked`), so the
    // vault PDA is derived here only to assert that nothing created it.
    const [veLockVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("ve_vault"), wallet.publicKey.toBuffer()],
      program.programId
    );

    const hiSolaBefore  = BigInt(
      (await program.account.userPosition.fetch(positionPda)).hiSola.toString()
    );
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
        lockPosition:  veLockPda,
        marketVault:   marketV,
        userPosition:  positionPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent:          anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const hiSolaAfter  = BigInt(
      (await program.account.userPosition.fetch(positionPda)).hiSola.toString()
    );
    const lockPos      = await program.account.veLockPosition.fetch(veLockPda);
    const stateAfter   = await program.account.protocolState.fetch(statePda);

    assert.equal(
      Number(hiSolaBefore - hiSolaAfter),
      Number(ONE.toString()),
      "1 hiSOLA left the position balance"
    );
    assert.isNull(
      await connection.getAccountInfo(veLockVault),
      "no custody vault was created — the lock is a ledger move, not a transfer"
    );
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
        solaMint: solaM, usdcMint, userUsdc: s2Usdc.address,
        userSola: s2Sola, solaVault, marketVault: marketV, userPosition: s2Pos,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([staker2])
      .rpc();

    const st = await program.account.protocolState.fetch(statePda);
    const [mainPos] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()], program.programId);
    const mainHiSola = BigInt(
      (await program.account.userPosition.fetch(mainPos)).hiSola.toString()
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
    // Derived only to assert nothing created it: the global escrow vault died with the
    // token model, replaced by `vote_locked` / `vote_lock_epoch` on the position itself.
    const [voteEscrowVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vote_escrow")],
      program.programId
    );
    const [userPosition] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), wallet.publicKey.toBuffer()],
      program.programId
    );

    // Vote for one unit MORE than the raw balance: impossible without the ve boost, which is
    // the whole point of this test, and valid as long as the lock contributes any power at
    // all. The old hardcoded 1_100_000 assumed an exact 1-hiSOLA balance that the suite's
    // stake/unstake sequence no longer produces on a clean state.
    const rawHiSola  = BigInt(
      (await program.account.userPosition.fetch(userPosition)).hiSola.toString()
    );
    const voteAmount = new BN((rawHiSola + 1n).toString());

    await program.methods
      .voteGauge(new BN(epoch), voteAmount)
      .accounts({
        user:          wallet.publicKey,
        poolId:        poolId,
        protocolState: statePda,
        marketVault:   marketV,
        userPosition:  userPosition,
        lockPosition:  veLockPda,
        gaugeState:    gaugeState,
        userVoteReceipt: voteReceipt,
        userEpochVotes: epochVotes,
        tokenProgram:  TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent:          anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    // The lock is derived from the ve snapshot the program itself froze, not from a constant:
    // only the share of the vote NOT covered by ve power immobilises balance, and ve_power
    // decays with the clock. On this wallet the suite's earlier ve lock covers the whole
    // vote, so the expected figure is 0 — asserting the formula rather than a literal keeps
    // the test honest either way. (An earlier version asserted only conservation, which
    // passed vacuously at zero and proved nothing.)
    const posAfterVote = await program.account.userPosition.fetch(userPosition);
    const uev          = await program.account.userEpochVotes.fetch(epochVotes);
    const voteLocked   = BigInt(posAfterVote.voteLocked.toString());
    const vePower      = BigInt(uev.vePowerSnapshot.toString());
    const expected     = voteAmount.toNumber() > Number(vePower)
      ? BigInt(voteAmount.toString()) - vePower
      : 0n;

    assert.equal(voteLocked, expected, "vote_locked = vote − ve power, exactly");
    // No custody: the balance stays where it was and is merely marked unspendable.
    assert.equal(
      BigInt(posAfterVote.hiSola.toString()),
      rawHiSola,
      "voting immobilises the balance in place — it never moves"
    );
    assert.isNull(
      await connection.getAccountInfo(voteEscrowVault),
      "no escrow vault exists to move it into"
    );
    assert.equal(
      posAfterVote.voteLockEpoch.toNumber(),
      epoch,
      "the lock is stamped with the voted epoch — this is what makes it lapse"
    );

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

  // ── 13b. Vote escrow — the wallet-splitting vote duplication is closed ─────
  //
  // THE BUG THIS PINS (found 2026-08-09, pre-fix behaviour):
  //   hiSOLA is a plain SPL token in a user-owned ATA with no freeze authority, so the
  //   program is never invoked on a transfer and cannot block one. `UserEpochVotes` is
  //   seeded [user, epoch], so a FRESH wallet gets a fresh power snapshot — while the first
  //   wallet's `UserVoteReceipt` is created with `init` and stays counted forever. So:
  //   vote with X → send X to a new wallet → vote X again → repeat. Gauge weight became
  //   unbounded for ~0.005 SOL of rent per hop, and `claim_bribe` pays pro-rata on that
  //   weight, i.e. it drained bribes deposited by third parties.
  //
  //   Snapshotting could never fix this (it only ever guarded one wallet against itself).
  //   Custody could — voted hiSOLA left the ATA — but only by adding a vault. Making the
  //   balance a ledger figure removes the send instead of intercepting it.
  it("[vote-lock] there is no voted hiSOLA to forward to a second wallet", async () => {
    const voter = anchor.web3.Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(voter.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );

    // Fund → buy → stake, so the voter holds real hiSOLA and no ve lock (the ve share of
    // the vote needs no collateral, and a zero ve power makes the escrow exactly the vote).
    const vUsdc = await getOrCreateAssociatedTokenAccount(
      connection, wallet.payer, usdcMint, voter.publicKey
    );
    await mintTo(connection, wallet.payer, usdcMint, vUsdc.address, wallet.payer, 100_000_000);

    const vSola   = anchor.utils.token.associatedAddress({ mint: solaM,   owner: voter.publicKey });
    const vHiSola = anchor.utils.token.associatedAddress({ mint: hiSolaM, owner: voter.publicKey });
    const [vPos]  = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), voter.publicKey.toBuffer()], program.programId);

    await program.methods
      .buySola(new BN(20_000_000), new BN(1))
      .accounts({
        user: voter.publicKey, protocolState: statePda, solaMint: solaM,
        userUsdc: vUsdc.address, userSola: vSola,
        floorVault: floorV, marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([voter])
      .rpc();

    const boughtSola = await getTokenBalance(connection, vSola);
    await program.methods
      .stakeSola(new BN(boughtSola.toString()))
      .accounts({
        user: voter.publicKey, protocolState: statePda,
        solaMint: solaM, usdcMint, userUsdc: vUsdc.address,
        userSola: vSola, solaVault, marketVault: marketV, userPosition: vPos,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([voter])
      .rpc();

    const staked = BigInt(
      (await program.account.userPosition.fetch(vPos)).hiSola.toString()
    );
    assert.isAbove(Number(staked), 0, "voter must hold hiSOLA for this test to mean anything");

    const slot      = await connection.getSlot();
    const blockTime = await connection.getBlockTime(slot);
    const epoch     = Math.floor(blockTime / 604_800);
    const epochLE   = Buffer.alloc(8);
    epochLE.writeBigUInt64LE(BigInt(epoch));

    const poolId = anchor.web3.Keypair.generate().publicKey;
    const pda = (seeds: (Buffer | Uint8Array)[]) =>
      anchor.web3.PublicKey.findProgramAddressSync(seeds, program.programId)[0];

    const voteAccounts = {
      user: voter.publicKey,
      poolId,
      protocolState: statePda,
      marketVault: marketV,
      userPosition: vPos,
      // No ve lock: SystemProgram is the documented "absent lock" placeholder.
      lockPosition: anchor.web3.SystemProgram.programId,
      gaugeState: pda([Buffer.from("gauge"), poolId.toBuffer(), epochLE]),
      userVoteReceipt: pda([Buffer.from("vote"), voter.publicKey.toBuffer(), poolId.toBuffer(), epochLE]),
      userEpochVotes: pda([Buffer.from("uev"), voter.publicKey.toBuffer(), epochLE]),
      globalEpochVotes: pda([Buffer.from("epoch_votes"), epochLE]),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    await program.methods
      .voteGauge(new BN(epoch), new BN(staked.toString()))
      .accounts(voteAccounts as any)
      .signers([voter])
      .rpc();

    // The whole point: the stake never leaves the position, and the vote marks it.
    const pos = await program.account.userPosition.fetch(vPos);
    assert.equal(
      pos.hiSola.toString(), staked.toString(),
      "voting moves nothing — the balance is still on the position"
    );
    assert.equal(
      pos.voteLocked.toString(), staked.toString(),
      "the full voted weight is immobilised"
    );
    assert.equal(
      pos.voteLockEpoch.toString(), epoch.toString(),
      "and the lock is stamped with the epoch it backs"
    );

    // The attack this test was written for: forward the stake to a virgin wallet and vote a
    // second time. It is now unconstructible rather than merely blocked — hiSOLA is not a
    // token, so the voter has no balance to send and the mint has no supply at all. The
    // assertion is on the ABSENCE, which is what makes it a real check: if a mint CPI ever
    // comes back, this fails.
    const supply = (await getMint(connection, hiSolaM)).supply;
    assert.equal(supply, 0n, "hiSOLA has no supply, so there is nothing to forward");
    assert.isNull(
      await connection.getAccountInfo(vHiSola),
      "and the voter holds no hiSOLA token account"
    );

    // ── Unstaking the backing is refused inside the voted epoch ────────────
    // What `withdraw_vote_escrow` used to guard, now enforced where the stake actually is.
    // Asserted here rather than in its own `it`: this voter is the one that actually holds a
    // vote lock, and reaching for it across test boundaries made the assertion depend on
    // which wallet the suite happened to leave collateralised.
    try {
      await program.methods
        .unstakeHiSola(new BN(staked.toString()))
        .accounts({
          user: voter.publicKey,
          protocolState: statePda,
          solaMint: solaM,
          userSola: vSola,
          solaVault,
          marketVault: marketV,
          usdcMint,
          userUsdc: vUsdc.address,
          userPosition: vPos,
          founderHiVesting: program.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .signers([voter])
        .rpc();
      assert.fail("unstaking the voted backing should be locked until the epoch is over");
    } catch (e: any) {
      assert.include(
        e.toString(), "VoteEscrowLocked",
        `expected the epoch guard to fire, got: ${e}`
      );
    }
    const after = await program.account.userPosition.fetch(vPos);
    assert.equal(
      after.hiSola.toString(), staked.toString(),
      "the refused unstake took nothing"
    );

    // Epochs are 7 days with no devnet override, so the lapse cannot be exercised in-suite —
    // only the refusal. The happy path lives in tests/bankrun.ts, on a warped clock.
    console.log("✅ vote lock — duplication unconstructible; unstake refused inside the voted epoch");
  });

  // Same defect class as the vote duplication above, on the fee accumulator instead of the
  // gauge: hiSOLA was a plain SPL token with no freeze authority, so a balance could always
  // walk to a wallet the protocol had never seen. `stake_sola`, `unstake_hi_sola` and
  // `borrow_usdc` defended against that by stamping `fees_debt = acc` when they lazily created
  // a UserPosition. `vote_gauge` created the very same account and did not — so the position
  // was born with `fees_debt = 0` and `claim_fees` read it as "staked since genesis".
  //
  // Two independent closures now stand between a virgin wallet and that payout, and this test
  // walks both in order:
  //   1. there is no balance to walk — hiSOLA is a ledger figure with no transfer;
  //   2. so `vote_gauge` refuses the vote for want of backing, and the position it would have
  //      opened is rolled back with the transaction.
  // `vote_gauge`'s `fees_debt` stamp survives in the program as defence in depth, but no
  // caller can reach it any more: every route to hiSOLA or ve power opens the position first.
  it("[security] a virgin wallet cannot vote its way into the whole fee history", async () => {
    const PRECISION = new BN("1000000000000"); // 1e12, matches state.rs

    // ── The holder: buys and stakes normally, so their own position is stamped correctly ──
    const holder = anchor.web3.Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(holder.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );
    const hUsdc = await getOrCreateAssociatedTokenAccount(
      connection, wallet.payer, usdcMint, holder.publicKey
    );
    await mintTo(connection, wallet.payer, usdcMint, hUsdc.address, wallet.payer, 100_000_000);

    const hSola   = anchor.utils.token.associatedAddress({ mint: solaM,   owner: holder.publicKey });
    const hHiSola = anchor.utils.token.associatedAddress({ mint: hiSolaM, owner: holder.publicKey });
    const [hPos]  = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), holder.publicKey.toBuffer()], program.programId);

    await program.methods
      .buySola(new BN(20_000_000), new BN(1))
      .accounts({
        user: holder.publicKey, protocolState: statePda, solaMint: solaM,
        userUsdc: hUsdc.address, userSola: hSola,
        floorVault: floorV, marketVault: marketV,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([holder])
      .rpc();

    const bought = await getTokenBalance(connection, hSola);
    await program.methods
      .stakeSola(new BN(bought.toString()))
      .accounts({
        user: holder.publicKey, protocolState: statePda,
        solaMint: solaM, usdcMint, userUsdc: hUsdc.address,
        userSola: hSola, solaVault, marketVault: marketV, userPosition: hPos,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([holder])
      .rpc();

    const stake = BigInt(
      (await program.account.userPosition.fetch(hPos)).hiSola.toString()
    );
    assert.isAbove(Number(stake), 0, "the holder must actually hold hiSOLA");

    // The accumulator has to carry history, otherwise there is nothing to steal and the
    // test would pass for the wrong reason.
    const stateBefore = await program.account.protocolState.fetch(statePda);
    const acc = stateBefore.feesPerHiSola as BN;
    assert.isTrue(acc.gtn(0), "fees_per_hi_sola must be non-zero for this PoC to mean anything");

    // What a position born with fees_debt = 0 would be handed on a balance of `stake`.
    const stealable = acc.mul(new BN(stake.toString())).div(PRECISION);
    assert.isTrue(stealable.gtn(0), "the history must be worth at least 1 base unit");

    // ── Closure 1: the balance cannot be moved to a wallet the protocol has never seen ──
    const virgin = anchor.web3.Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(virgin.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
      "confirmed"
    );
    const vUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection, wallet.payer, usdcMint, virgin.publicKey
    );

    assert.isNull(
      await connection.getAccountInfo(hHiSola),
      "the holder has no hiSOLA token account, so there is no send to make"
    );
    assert.equal(
      (await getMint(connection, hiSolaM)).supply, 0n,
      "and the mint has no supply that any wallet could be holding"
    );

    const [vPos] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), virgin.publicKey.toBuffer()], program.programId);
    assert.isNull(
      await program.account.userPosition.fetchNullable(vPos),
      "the virgin wallet must have no position yet — vote_gauge is what would create it"
    );

    // ── Closure 2: vote_gauge is the only instruction that would open a UserPosition for
    // this wallet, and it will not, because a vote must be backed by ledger hiSOLA or ve
    // power and the wallet has neither.
    const slot      = await connection.getSlot();
    const blockTime = await connection.getBlockTime(slot);
    const epoch     = Math.floor(blockTime / 604_800);
    const epochLE   = Buffer.alloc(8);
    epochLE.writeBigUInt64LE(BigInt(epoch));
    const poolId = anchor.web3.Keypair.generate().publicKey;
    const pda = (seeds: (Buffer | Uint8Array)[]) =>
      anchor.web3.PublicKey.findProgramAddressSync(seeds, program.programId)[0];

    // Stay under both caps so the backing check is what refuses, never a cap.
    const globalCap = new BN(stateBefore.totalHiSola.toString()).muln(3_000).divn(10_000);
    const votes     = BN.min(new BN(stake.toString()), globalCap);
    assert.isTrue(votes.gtn(0), "the vote must be castable");

    const vaultBefore = await getTokenBalance(connection, marketV);
    let voted = false;
    try {
      await program.methods
        .voteGauge(new BN(epoch), votes)
        .accounts({
          user: virgin.publicKey,
          poolId,
          protocolState: statePda,
          marketVault: marketV,
          userPosition: vPos,
          lockPosition: anchor.web3.SystemProgram.programId,
          gaugeState: pda([Buffer.from("gauge"), poolId.toBuffer(), epochLE]),
          userVoteReceipt: pda([Buffer.from("vote"), virgin.publicKey.toBuffer(), poolId.toBuffer(), epochLE]),
          userEpochVotes: pda([Buffer.from("uev"), virgin.publicKey.toBuffer(), epochLE]),
          globalEpochVotes: pda([Buffer.from("epoch_votes"), epochLE]),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        } as any)
        .signers([virgin])
        .rpc();
      voted = true;
    } catch (e: any) {
      // VoteOverflow, not InsufficientVoteBacking: with no stake and no lock the wallet's
      // `total_power_snapshot` is 0, so the per-address power cap refuses before the backing
      // check is ever reached. Both are the intended refusal; asserting the specific code
      // keeps the test honest about WHICH guard is load-bearing for a virgin wallet.
      assert.include(
        e.toString(), "VoteOverflow",
        `expected a zero power cap to refuse an unbacked vote, got: ${e}`
      );
    }
    assert.isFalse(voted, "a wallet with no stake and no lock cast a vote");

    // The position the refused instruction would have opened went back with it, so the
    // unstamped-`fees_debt` position the old attack depended on never comes into existence.
    assert.isNull(
      await program.account.userPosition.fetchNullable(vPos),
      "the rolled-back vote must leave no position behind"
    );

    // ── The payout that followed: with no position, claim_fees has nothing to read ────
    let claimed = 0n;
    let claimSucceeded = false;
    try {
      await program.methods
        .claimFees()
        .accounts({
          user: virgin.publicKey,
          protocolState: statePda,
          marketVault: marketV,
          userUsdc: vUsdcAta.address,
          userPosition: vPos,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([virgin])
        .rpc();
      claimSucceeded = true;
      claimed = await getTokenBalance(connection, vUsdcAta.address);
    } catch (e: any) {
      // AccountNotInitialized (no position) and NothingToClaim (an empty one) are both
      // correct outcomes: a wallet that just arrived is owed nothing either way.
      assert.isTrue(
        /AccountNotInitialized|NothingToClaim/.test(e.toString()),
        `expected the virgin wallet to be owed nothing, got: ${e}`
      );
    }

    assert.isFalse(claimSucceeded, "a wallet that never staked was paid fees");
    assert.equal(
      claimed, 0n,
      `a wallet that never staked drained ${claimed} USDC of other stakers' fees ` +
      `(history was worth ${stealable.toString()})`
    );
    assert.equal(
      await getTokenBalance(connection, marketV), vaultBefore,
      "market_vault must be untouched by a virgin wallet's claim"
    );
    console.log("✅ security — an unbacked vote opens no position, so no fee history is reachable");
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
    // Collect the MAXIMUM the configured split allows. Until 2026-08-12 this test took the
    // entire uncredited growth, because nothing stopped it: `pol_split_bps` was stored,
    // validated as "max 50 %", and then read by no instruction — the authority could route
    // 100 % of fresh fees into POL while the docs promised a fraction. The split is now
    // enforced in `collect_to_pol`, so the worst case a test can exercise is the cap itself.
    //
    // The solvency property this test used to guard still holds and is asserted below: the
    // accumulator advances on (balance − amount), so the skim comes out of the stakers'
    // share rather than promising them fees the vault no longer holds.
    const stBefore = await program.account.protocolState.fetch(statePda);
    const uncredited = marketBefore - BigInt(stBefore.lastMarketVaultBalance.toString());
    assert.isTrue(uncredited > 0n, "there must be uncredited fee growth to collect");
    const splitBps = BigInt(pol.polSplitBps);
    const maxSkim = (uncredited * splitBps) / 10_000n;
    assert.isTrue(maxSkim > 0n, "the split must allow a non-zero skim for this test to bite");
    const COLLECT_AMOUNT     = new BN(maxSkim.toString());

    // One base unit past the cap must be refused — otherwise "max 50 %" is decoration again.
    let overSkimmed = false;
    try {
      await program.methods
        .collectToPol(new BN((maxSkim + 1n).toString()))
        .accounts({
          authority:     wallet.publicKey,
          protocolState: statePda,
          polState:      polStatePda,
          marketVault:   marketV,
          polUsdcVault,
          tokenProgram:  TOKEN_PROGRAM_ID,
        } as any)
        .rpc();
      overSkimmed = true;
    } catch (e: any) {
      assert.include(
        e.toString(), "PolSplitExceeded",
        `expected the split cap to fire, got: ${e}`
      );
    }
    assert.isFalse(overSkimmed, "POL must not skim beyond pol_split_bps of the growth");
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
      solaMint: solaM, usdcMint, userUsdc: userUsdcAta,
      userSola: userSolaAta, solaVault, marketVault: marketV, userPosition,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    } as any).rpc();
    await checkInvariant("after stake 2 SOLA");

    // ── Borrow 1 USDC ────────────────────────────────────────────────────
    await program.methods.borrowUsdc(ONE).accounts({
      user: wallet.publicKey, protocolState: statePda,
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
    const posPre    = await program.account.userPosition.fetchNullable(userPosition);
    const hiSolaBal = posPre ? BigInt(posPre.hiSola.toString()) : 0n;
    if (hiSolaBal < BigInt(ONE.toString())) {
      await program.methods.stakeSola(ONE.muln(2)).accounts({
        user: wallet.publicKey, protocolState: statePda,
        solaMint: solaM, usdcMint, userUsdc: userUsdcAta,
        userSola: userSolaAta, solaVault: solaVault, marketVault: marketV, userPosition,
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
  // Reachable on the ONE binary that now serves every cluster. Until 2026-08-23 these tests
  // only ran on a `devnet`-feature build whose FOUNDER_WALLET was a throwaway key, while the
  // mainnet build pinned a Ledger address no test can sign for — so the shipped binary's
  // founder path had zero coverage. `initialize` now records the address, so the suite simply
  // initialises with a keypair it holds.
  it("[founder] burn_o_sola_for_votes rejects the founder wallet", async () => {
    // The founder wallet this protocol was initialised with — a keypair the suite holds, not
    // a file on disk and not a constant in the binary.
    const founder = founderKp;

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

    // `burn_o_sola_for_votes` requires an EXISTING UserPosition (it deliberately does not
    // open one — see the account doc: opening it here would add the unstamped-`fees_debt`
    // variant that `vote_gauge` guards against). Without one the founder is refused by
    // AccountNotInitialized, which would mask the guard actually under test. So give the
    // founder a real, financed position first: buy a little SOLA and stake it.
    const founderUsdc = await getOrCreateAssociatedTokenAccount(
      connection, wallet.payer, usdcMint, founder.publicKey
    );
    await mintTo(connection, wallet.payer, usdcMint, founderUsdc.address, wallet.payer, 10_000_000);
    const founderSola = anchor.utils.token.associatedAddress({
      mint: solaM, owner: founder.publicKey,
    });
    const [founderPosPre] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), founder.publicKey.toBuffer()], program.programId);

    if (!(await program.account.userPosition.fetchNullable(founderPosPre))) {
      await program.methods
        .buySola(new BN(5_000_000), new BN(1))
        .accounts({
          user: founder.publicKey, protocolState: statePda, solaMint: solaM,
          userUsdc: founderUsdc.address, userSola: founderSola,
          floorVault: floorV, marketVault: marketV,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .signers([founder])
        .rpc();

      const founderBought = await getTokenBalance(connection, founderSola);
      await program.methods
        .stakeSola(new BN(founderBought.toString()))
        .accounts({
          user: founder.publicKey, protocolState: statePda,
          solaMint: solaM, usdcMint, userUsdc: founderUsdc.address,
          userSola: founderSola, solaVault, marketVault: marketV,
          userPosition: founderPosPre,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .signers([founder])
        .rpc();
    }

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
          userPosition:   founderPosPre,
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

  // ── [founder] claim_founder_hi_sola / unlock_hi_sola, and [partner] the welcome bag,
  // moved to tests/bankrun_allocations.ts on 2026-08-23. ───────────────────────────────
  //
  // They are time-gated on VESTING_CLIFF_SECS (180 d), BASE_BAG_VEST_SECS (180 d) and
  // MIN_LOCK_DURATION (7 d). They only ever passed here because the `devnet` feature
  // shortened those constants to 5 s / 6 h / 5 s and the test slept through them — which is
  // precisely the divergence that made devnet a different protocol from mainnet. The feature
  // is gone and the constants are mainnet-only, so the cases run against a warped clock
  // instead of against shortened numbers. The test moved; the constant did not.


  it("[team] ecosystem allocation locks the 250K into a ve position, never a wallet", async () => {
    const TEAM_WALLET = new anchor.web3.PublicKey(
      "BVaJbgw3NF7Ng28sHorBnzJrHgvu7S3L5wpdB6923LjA"
    );
    // No signature needed from the team: it is an address-checked UncheckedAccount and the
    // authority is the caller.
    const [teamLock] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("velock"), TEAM_WALLET.toBuffer()], program.programId);
    // Derived only to assert nothing created it: the tranche is a ledger credit now.
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
        solaVault,
        marketVault:      marketV,
        teamWallet:       TEAM_WALLET,
        teamLockPosition: teamLock,
        teamPosition:     teamPos,
        tokenProgram:     TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:    anchor.web3.SystemProgram.programId,
        rent:             anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    const after       = await program.account.protocolState.fetch(statePda);
    const teamLockAcc = await program.account.veLockPosition.fetch(teamLock);
    const escrowed    = BigInt(teamLockAcc.amountLocked.toString());
    const TEAM_AMOUNT = 250_000_000_000n;

    assert.equal(escrowed.toString(), TEAM_AMOUNT.toString(),
      "the full 250K must land in the team's ve lock position");
    assert.isNull(
      await connection.getAccountInfo(teamVault),
      "and no custody vault was created for it"
    );

    // The team position must hold no spendable hiSOLA: that is what keeps borrow_usdc blind
    // to it (so the 20% cap can't be sidestepped) and unstake → sell_sola out of reach.
    const teamPosAcc = await program.account.userPosition.fetch(teamPos);
    assert.equal(teamPosAcc.hiSola.toString(), "0",
      "the team position must carry no spendable balance");
    assert.equal(teamPosAcc.stakedAmount.toString(), "0",
      "and nothing financed — the tranche never paid into the floor");

    // Locked hiSOLA stays out of the fee denominator — the team earns nothing during the lock.
    assert.equal(after.totalHiSola.toString(), before.totalHiSola.toString(),
      "total_hi_sola must not grow → team tranche earns no fees while locked");

    // Locked for LIFE: the whole tranche is permanent, so even after lock_end_ts passes,
    // unlock_hi_sola releases amount_locked − permanent_amount = 0. The 4-year deferred
    // drain (unlock → unstake → sell_sola) is closed; only the 20% borrow channel remains.
    const lock = teamLockAcc;
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
      `position balance 0, total_hi_sola unchanged, 0 unfinanced SOLA minted`
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
        solaVault,
        marketVault:        marketV,
        lockPosition:       lockPos,
        contributorPosition: cPos,
        contributorVesting: vesting,
        tokenProgram:       TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:      anchor.web3.SystemProgram.programId,
      } as any)
      .signers([contributor])
      .rpc();

    const after = await program.account.protocolState.fetch(statePda);
    const lock = await program.account.veLockPosition.fetch(lockPos);

    assert.equal(lock.amountLocked.toString(), HI.toString(),
      "full 5K hiSOLA must land in the ve lock");
    assert.equal(lock.permanentAmount.toString(), HI.toString(),
      "the whole bag is permanent — locked for life");
    assert.isNull(await connection.getAccountInfo(veVault),
      "no custody vault was created — the bag is a ledger credit");
    const cPosAcc = await program.account.userPosition.fetch(cPos);
    assert.equal(cPosAcc.hiSola.toString(), "0",
      "contributor position holds no spendable hiSOLA (locked, not liquid)");
    assert.equal(cPosAcc.stakedAmount.toString(), "0",
      "and nothing financed — the bag never paid into the floor");
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
});
