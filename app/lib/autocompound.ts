// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// Standing compound orders, client side.
//
// ☢️ The allowances are the product, not the account. `configure_auto_compound` only records
// what the order should do; what makes it *able* to do it is two ordinary SPL `approve`
// instructions the user signs in the same transaction. That is deliberate and it is the whole
// safety story:
//
//   · the cap lives in the token program, where the wallet can display it, and where
//     `delegated_amount` decrements on every use without this program keeping score;
//   · `revoke` ends the arrangement from the wallet, needing nothing from us — it works even if
//     this application disappears;
//   · nothing is ever escrowed, so there is no vault to drain and no withdrawal path to break.
//
// ⚠️ An SPL token account has exactly ONE delegate. Approving here overwrites any delegation the
// user granted elsewhere on the same account, and a later `approve` by another application
// silently disables the order. Say so in the interface; do not discover it as a support ticket.
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createApproveInstruction, createRevokeInstruction,
} from "@solana/spl-token";
import {
  getProgram, statePda, solaM, oSolaM, floorVault, marketVault, solaVaultAddr,
  positionPda, userAta, lpMintPda, commonAccounts, PROGRAM_ID, poolPda, WSOL_MINT_STR,
} from "./program";
import { decodeTokenAmount } from "./recipe";
import { lpUserInfoPda } from "./lprewards";

const UNIT = 1_000_000;

export function autoPda(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("auto"), user.toBuffer()], PROGRAM_ID)[0];
}

export type StandingOrder = {
  owner: PublicKey;
  /// oSOLA balance that must be reached before a round may fire, in UI units.
  threshold: number;
  /// oSOLA exercised per round, in UI units.
  chunk: number;
  /// The most USDC the order will pay per oSOLA — strike plus fee. In UI units.
  ///
  /// ⚠️ No longer the control it looks like. It is an ABSOLUTE amount, so the only thing that
  /// can reach it is a price rise — which is when a round earns the most. Orders armed since
  /// the fee bound landed set it to "one round may spend the whole budget", leaving
  /// `maxFeeBps` to do the real work; orders armed before it still carry a real ceiling here.
  maxCostPerUnit: number;
  /// The share of the gain the order accepts, in basis points, compared against
  /// `ProtocolState.exercise_fee_bps` at every crank.
  ///
  /// ☢️ Zero means UNSET, not "only at a zero fee" — every order armed before the field existed
  /// reads zero out of the account's spare bytes, and the chain skips the check for them.
  maxFeeBps: number;
  /// Shortest gap between two rounds, in seconds.
  minInterval: number;
  enabled: boolean;
  rounds: number;
  usdcSpent: number;
  lastCrankTs: number;
  /// ☢️ WHERE IT GOES: the AMM pool the order compounds into, or null for voting power (hiSOLA).
  /// One order, one destination — the oSOLA account has a single delegate, so "liquidity OR
  /// vote" is this field and nothing else. Orders armed before it existed read null.
  lpTarget: PublicKey | null;
  /// For a liquidity order: the least share of an oSOLA's exercise value it will sell for, in
  /// basis points. Zero for a voting order.
  minIntrinsicBps: number;
};

/// Where a standing order sends what it compounds.
export type Destination =
  | { kind: "vote" }
  | { kind: "lp"; pool: PublicKey; minIntrinsicBps: number };

/// Whether `pool` can be a liquidity destination, mirroring `lp_deposit_side` in the program:
/// it must pair USDC (no hop) or wSOL (one hop through SOL/USDC), and must not hold oSOLA.
export function lpDestinationSide(
  mintA: PublicKey,
  mintB: PublicKey,
  usdcMint: PublicKey,
): { deposit: PublicKey; needsHop: boolean } | null {
  const holds = (m: PublicKey) => mintA.equals(m) || mintB.equals(m);
  const wsol = new PublicKey(WSOL_MINT_STR);
  if (holds(oSolaM)) return null;
  if (holds(usdcMint)) return { deposit: usdcMint, needsHop: false };
  if (holds(wsol)) return { deposit: wsol, needsHop: true };
  return null;
}

function decodeOrder(raw: any): StandingOrder {
  const target = raw.lpTarget as PublicKey | undefined;
  return {
    owner: raw.owner as PublicKey,
    threshold: Number(raw.threshold) / UNIT,
    chunk: Number(raw.chunk) / UNIT,
    maxCostPerUnit: Number(raw.maxCostPerUnit) / UNIT,
    // `?? 0` covers an account written before the field existed: Anchor reads the zero
    // bytes `init` left, which is the same "unset" the program treats as no bound.
    maxFeeBps: Number(raw.maxFeeBps ?? 0),
    minInterval: Number(raw.minInterval),
    enabled: !!raw.enabled,
    rounds: Number(raw.rounds),
    usdcSpent: Number(raw.usdcSpent) / UNIT,
    lastCrankTs: Number(raw.lastCrankTs),
    lpTarget: target && !target.equals(PublicKey.default) ? target : null,
    minIntrinsicBps: Number(raw.minIntrinsicBps ?? 0),
  };
}

/// What the order can still spend, as SPL Token records it. `null` when no delegation is in
/// place — which is the honest reading of "armed but unable to act".
export type Allowances = {
  oSola: bigint | null;
  usdc: bigint | null;
  /// True when a delegate exists but is NOT this order's PDA: another application took the slot.
  hijacked: boolean;
};

/// What `delegate` may still spend from this token account, as SPL Token records it.
///
/// Returns `[null, false]` when no delegation exists, and `[null, true]` when one exists but
/// belongs to somebody else — an SPL token account has exactly ONE delegate, so another
/// application taking the slot silently disables a standing order. The two cases look the same
/// to a caller that only asks "is there an allowance", and they mean very different things.
///
/// ☢️ AND SO DO "NEVER GRANTED" AND "FULLY SPENT". SPL Token CLEARS the delegate when
/// `delegated_amount` reaches zero, so an order that has just finished the ten rounds its owner
/// authorised is byte-for-byte indistinguishable here from one that was never armed. Nothing in
/// the token account can tell them apart; `AutoCompound.rounds` can, and every caller that
/// reports this to a human must use it — otherwise the screen tells someone who used the
/// feature exactly as intended that they never set it up.
///
/// SPL token account layout: mint(32) · owner(32) · amount(8) · delegate COption<Pubkey>(4+32)
/// · state(1) · is_native COption(4+8) · delegated_amount(8) → offset 121.
function decodeAllowance(
  info: { data: Buffer | Uint8Array } | null | undefined,
  delegate: PublicKey,
): [bigint | null, boolean] {
  if (!info?.data) return [null, false];
  const data = Buffer.from(info.data);
  if (data.length < 129) return [null, false];
  if (data.readUInt32LE(72) !== 1) return [null, false];
  if (!new PublicKey(data.subarray(76, 108)).equals(delegate)) return [null, true];
  return [data.readBigUInt64LE(121), false];
}

export async function readStandingOrder(
  connection: Connection,
  wallet: AnchorWallet,
  usdcMint: PublicKey,
): Promise<{
  order: StandingOrder | null;
  allowances: Allowances;
  /// The two balances the order spends from. Returned because a screen that shows an order as
  /// "on, 10 rounds left" while the wallet cannot satisfy a single one is telling the truth
  /// about the allowance and lying about what will happen.
  balances: { oSola: bigint; usdc: bigint };
}> {
  const user = wallet.publicKey;
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  const auto = autoPda(user);

  const [raw, infos] = await Promise.all([
    (program.account as any).autoCompound.fetch(auto).catch(() => null),
    connection.getMultipleAccountsInfo([userAta(oSolaM, user), userAta(usdcMint, user)]),
  ]);

  const [oSolaAllowance, oSolaHijacked] = decodeAllowance(infos[0], auto);
  const [usdcAllowance, usdcHijacked] = decodeAllowance(infos[1], auto);

  return {
    order: raw ? decodeOrder(raw) : null,
    allowances: {
      oSola: oSolaAllowance,
      usdc: usdcAllowance,
      hijacked: oSolaHijacked || usdcHijacked,
    },
    balances: {
      oSola: decodeTokenAmount(infos[0]?.data),
      usdc: decodeTokenAmount(infos[1]?.data),
    },
  };
}

/// One signature arms the whole thing: the order, and the two allowances that let it act.
export async function buildArmInstructions(
  connection: Connection,
  wallet: AnchorWallet,
  usdcMint: PublicKey,
  opts: {
    threshold: number;
    chunk: number;
    maxCostPerUnit: number;
    minInterval: number;
    /// How many rounds' worth of allowance to grant. The user is capping their own exposure
    /// here, and it is the only cap that matters — see the header.
    rounds: number;
    /// The share of the gain the order will accept, in basis points, checked against
    /// `ProtocolState.exercise_fee_bps` at every crank. Zero means UNSET and skips the check.
    ///
    /// ☢️ This is the bound that replaces a price forecast. `maxCostPerUnit` is absolute, so it
    /// can only ever be reached by the price RISING — which is when a round is most profitable,
    /// since the strike stays at 1 USDC while the SOLA minted is worth more. Bounding the rate
    /// instead is price-independent: the order adapts to the market and refuses only a change to
    /// the fee, which is the protocol's to make and never was the owner's to accept.
    maxFeeBps: number;
    /// Total USDC the order may ever spend, which becomes the SPL allowance verbatim.
    ///
    /// Sizing the allowance from the ceiling (`chunk × rounds × ceiling`) tied the two together,
    /// so loosening the price bound silently authorised more spending. Naming the budget breaks
    /// that: it is a question the owner can answer, and it is enforced by SPL Token rather than
    /// by us.
    budgetUsdc: number;
    /// Voting power (the default) or a pool. A liquidity order sells its oSOLA instead of
    /// exercising it, so it needs no USDC: no USDC allowance is granted for it.
    destination?: Destination;
  },
): Promise<TransactionInstruction[]> {
  const user = wallet.publicKey;
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  const auto = autoPda(user);
  const destination: Destination = opts.destination ?? { kind: "vote" };

  const configure = await (program.methods as any)
    .configureAutoCompound(
      new BN(Math.floor(opts.threshold * UNIT)),
      new BN(Math.floor(opts.chunk * UNIT)),
      new BN(Math.floor(opts.maxCostPerUnit * UNIT)),
      new BN(Math.floor(opts.minInterval)),
      Math.floor(opts.maxFeeBps),
    )
    .accounts({
      user,
      auto,
      userPosition: positionPda(user),
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  // The oSOLA allowance covers the rounds themselves; the USDC one is the budget, verbatim.
  //
  // ☢️ It used to be `chunk × rounds × maxCostPerUnit`, which made the price bound and the
  // spending bound one number: widening the first to stop the order stalling against a rising
  // market silently authorised more of the second. They answer different questions, so they are
  // now two fields, and only this one reaches SPL Token — where the cap is enforced by the token
  // program rather than by anything here.
  const oSolaAllowance = BigInt(Math.floor(opts.chunk * opts.rounds * UNIT));
  const usdcAllowance = BigInt(Math.ceil(opts.budgetUsdc * UNIT));

  const ixs: TransactionInstruction[] = [
    configure,
    createApproveInstruction(userAta(oSolaM, user), auto, user, oSolaAllowance),
  ];
  if (destination.kind === "lp") {
    // The pool and the price floor, in the same signature as the order they belong to.
    ixs.push(await buildSetLpInstruction(connection, wallet, destination.pool, destination.minIntrinsicBps));
    // ☢️ An order authorises what it uses and nothing more. A liquidity order spends no USDC, so
    // a USDC allowance left from its voting days is withdrawn here rather than left standing —
    // harmless today (the staking crank refuses this order), and exactly the kind of leftover
    // grant nobody remembers the day it stops being harmless. Only when this order holds it:
    // revoking clears the slot whoever it belongs to, and another application's is not ours.
    const usdcAta = userAta(usdcMint, user);
    const [held] = decodeAllowance(await connection.getAccountInfo(usdcAta), auto);
    if (held !== null) ixs.push(createRevokeInstruction(usdcAta, user));
  } else {
    ixs.push(createApproveInstruction(userAta(usdcMint, user), auto, user, usdcAllowance));
    // Pointing an order back at voting power is a field reset. `configure` above creates the
    // account when it does not exist yet, so this is valid on a first arming too — and it means
    // the caller never has to know which destination the order had before.
    ixs.push(
      await (program.methods as any)
        .clearAutoCompoundLp()
        .accounts({ user, auto })
        .instruction(),
    );
  }
  return ixs;
}

/// Point an existing order at `pool`. Also creates, at the owner's expense, the LP account and
/// the reward record the crank will write — the crank never initialises anything for anyone.
export async function buildSetLpInstruction(
  connection: Connection,
  wallet: AnchorWallet,
  pool: PublicKey,
  minIntrinsicBps: number,
): Promise<TransactionInstruction> {
  const user = wallet.publicKey;
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  const lpMint = lpMintPda(pool);
  return (program.methods as any)
    .setAutoCompoundLp(Math.round(minIntrinsicBps))
    .accounts({
      user,
      auto: autoPda(user),
      protocolState: statePda,
      targetPool: pool,
      lpMint,
      userLp: userAta(lpMint, user),
      lpUserInfo: lpUserInfoPda(pool, user),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: commonAccounts.associatedTokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}


/// Stop the order the way the design promises: by revoking, in the token program.
///
/// `set_auto_compound_enabled(false)` is offered alongside rather than instead — it pauses
/// without touching the allowance, which is what someone wants when they intend to resume. The
/// revoke is what someone wants when they are done trusting us.
export async function buildDisarmInstructions(
  connection: Connection,
  wallet: AnchorWallet,
  usdcMint: PublicKey,
  alsoDisable: boolean,
): Promise<TransactionInstruction[]> {
  const user = wallet.publicKey;
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  const ixs: TransactionInstruction[] = [
    createRevokeInstruction(userAta(oSolaM, user), user),
    createRevokeInstruction(userAta(usdcMint, user), user),
  ];
  if (alsoDisable) {
    ixs.push(
      await (program.methods as any)
        .setAutoCompoundEnabled(false)
        .accounts({ user, auto: autoPda(user), owner: user })
        .instruction(),
    );
  }
  return ixs;
}

/// The crank itself, built for any owner by any caller — the keeper uses this, and so could a
/// stranger. It is exported from the app's own library on purpose: a permissionless instruction
/// nobody outside the team can construct is permissionless in name only.
export async function buildCrankInstruction(
  connection: Connection,
  wallet: AnchorWallet,
  usdcMint: PublicKey,
  owner: PublicKey,
): Promise<TransactionInstruction> {
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  return (program.methods as any)
    .crankAutoCompound()
    .accounts({
      cranker: wallet.publicKey,
      owner,
      auto: autoPda(owner),
      protocolState: statePda,
      userPosition: positionPda(owner),
      solaMint: solaM,
      oSolaMint: oSolaM,
      usdcMint,
      userOSola: userAta(oSolaM, owner),
      userUsdc: userAta(usdcMint, owner),
      floorVault,
      marketVault,
      solaVault: solaVaultAddr,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/// The liquidity crank, built for any owner by any caller. The route is DERIVED here exactly as
/// the program derives it — the oSOLA/USDC pool, then the SOL/USDC pool when the destination
/// pairs SOL — because the program refuses any other: a cranker never chooses a hop.
export async function buildLpCrankInstruction(
  connection: Connection,
  wallet: AnchorWallet,
  usdcMint: PublicKey,
  owner: PublicKey,
  target: PublicKey,
): Promise<TransactionInstruction> {
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  const wsol = new PublicKey(WSOL_MINT_STR);
  const sellKey = poolPda(oSolaM, usdcMint);
  const hopKey = poolPda(wsol, usdcMint);
  const [sell, tgt]: any[] = await Promise.all([
    (program.account as any).ammPool.fetch(sellKey),
    (program.account as any).ammPool.fetch(target),
  ]);
  const vaultOf = (pool: any, mint: PublicKey): PublicKey =>
    (pool.tokenAMint as PublicKey).equals(mint) ? pool.tokenAVault : pool.tokenBVault;
  const side = lpDestinationSide(tgt.tokenAMint, tgt.tokenBMint, usdcMint);
  if (!side) throw new Error("this pool cannot be a liquidity destination");
  const hop: any = side.needsHop ? await (program.account as any).ammPool.fetch(hopKey) : null;

  return (program.methods as any)
    .crankAutoCompoundLp()
    .accounts({
      cranker: wallet.publicKey,
      owner,
      auto: autoPda(owner),
      protocolState: statePda,
      oSolaMint: oSolaM,
      userOSola: userAta(oSolaM, owner),
      sellPool: sellKey,
      sellOSolaVault: vaultOf(sell, oSolaM),
      sellUsdcVault: vaultOf(sell, usdcMint),
      hopPool: hop ? hopKey : null,
      hopUsdcVault: hop ? vaultOf(hop, usdcMint) : null,
      hopSolVault: hop ? vaultOf(hop, wsol) : null,
      targetPool: target,
      targetDepositVault: vaultOf(tgt, side.deposit),
      lpMint: tgt.lpMint,
      userLp: userAta(tgt.lpMint, owner),
      lpUserInfo: lpUserInfoPda(target, owner),
      marketVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/// Claim one pool's continuous oSOLA for `owner`, paid for by `wallet`.
///
/// ☢️ Permissionless since 2026-09-21, and that is what makes a standing order self-feeding.
/// The crank exercises what is in the wallet and claims nothing, so without this the rewards
/// that should refill the wallet sat one uncallable instruction away and an order fired until
/// the wallet ran dry, then went quiet forever. The destination is bound to the owner's own
/// ATA by `associated_token::authority`, so the caller pays a fee and gains nothing.
export async function buildClaimInstruction(
  connection: Connection,
  wallet: AnchorWallet,
  owner: PublicKey,
  pool: PublicKey,
): Promise<TransactionInstruction> {
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  const lpMint = lpMintPda(pool);
  return (program.methods as any)
    .claimLpRewards()
    .accounts({
      user: owner,
      payer: wallet.publicKey,
      pool,
      lpMint,
      userLp: userAta(lpMint, owner),
      lpUserInfo: lpUserInfoPda(pool, owner),
      protocolState: statePda,
      oSolaMint: oSolaM,
      userOSola: userAta(oSolaM, owner),
      ...commonAccounts,
    })
    .instruction();
}

/// Every standing order on chain, with the balance that decides whether it may fire.
///
/// This is the keeper's entire view of the world. It reads accounts and nothing else — no key,
/// no signature — so it is as runnable from a laptop as from our own infrastructure, which is
/// the property that makes "anyone can crank" true rather than decorative.
export async function listCrankableOrders(
  connection: Connection,
  wallet: AnchorWallet,
  usdcMint: PublicKey,
  /// The live `ProtocolState`, so the cost of a round can be priced. Without it the list still
  /// works, it just cannot tell an order that will fail on USDC from one that will fire.
  protocolState?: any,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<
  { owner: PublicKey; order: StandingOrder; oSolaBalance: bigint; ready: boolean; why: string }[]
> {
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  const all: any[] = await (program.account as any).autoCompound.all();

  const owners = all.map((a) => a.account.owner as PublicKey);
  // Both balances per owner, in one call: the oSOLA decides whether a round is due, the USDC
  // decides whether it can be paid for.
  const balances = await connection.getMultipleAccountsInfo(
    owners.flatMap((o) => [userAta(oSolaM, o), userAta(usdcMint, o)]),
  );

  // Strike plus the fee on the gain, per oSOLA, priced the way `exercise_fee` prices it.
  const costPerUnit = (() => {
    if (!protocolState) return 1;
    const vu = Number(protocolState.virtualUsdc.toString());
    const vs = Number(protocolState.virtualSola.toString());
    const feeBps = Number(protocolState.exerciseFeeBps ?? 0);
    return 1 + (Math.max(0, vu / vs - 1) * feeBps) / 10_000;
  })();

  return all.map((a, i) => {
    const raw = a.account;
    const oSolaBalance = decodeTokenAmount(balances[i * 2]?.data);
    const usdcBalance = decodeTokenAmount(balances[i * 2 + 1]?.data);
    const auto = autoPda(raw.owner as PublicKey);
    const [oSolaAllowance, oSolaHijacked] = decodeAllowance(balances[i * 2], auto);
    const [usdcAllowance, usdcHijacked] = decodeAllowance(balances[i * 2 + 1], auto);
    const threshold = BigInt(raw.threshold.toString());
    const chunk = BigInt(raw.chunk.toString());
    const elapsed = nowSec - Number(raw.lastCrankTs);
    const cost = BigInt(Math.ceil(Number(chunk) * costPerUnit));

    // Mirrors `AutoCompound::ready` in state/auto.rs, PLUS the two conditions the account
    // cannot see: whether the owner can pay, and whether the order's ceiling still holds.
    //
    // ⚠️ It stays a mirror, not the authority — the chain refuses anyway and the keeper
    // simulates before it sends, so being wrong here costs nothing on chain. What it costs is
    // an operator staring at "READY" for an order that will never fire, which is exactly what
    // happened the first time: a 500-oSOLA round against a 177 USDC balance.
    const isLp = !!raw.lpTarget && !(raw.lpTarget as PublicKey).equals(PublicKey.default);
    let why = "";
    if (!raw.enabled) why = "disabled";
    else if (oSolaBalance < threshold) why = "below threshold";
    else if (oSolaBalance < chunk) why = "not a full chunk";
    else if (elapsed < Number(raw.minInterval)) why = `${Number(raw.minInterval) - elapsed}s to go`;
    // A liquidity order sells its oSOLA and pays nothing, so the USDC conditions below are not
    // its conditions. What can still stop it — the price floor, the leg caps — the keeper learns
    // from its simulation.
    else if (isLp) {
      if (oSolaHijacked) why = "delegate slot taken by another application";
      else if (oSolaAllowance === null) {
        why = Number(raw.rounds) > 0 ? "allowance spent — re-arm to continue" : "no allowance granted";
      } else if (oSolaAllowance < chunk) {
        why = `allowance nearly spent (${(Number(oSolaAllowance) / UNIT).toFixed(2)} oSOLA left)`;
      }
    } else if (protocolState && usdcBalance < cost) {
      why = `needs ${(Number(cost) / UNIT).toFixed(2)} USDC, holds ${(Number(usdcBalance) / UNIT).toFixed(2)}`;
    } else if (
      protocolState &&
      Number(raw.maxFeeBps ?? 0) > 0 &&
      Number(protocolState.exerciseFeeBps ?? 0) > Number(raw.maxFeeBps)
    ) {
      // The bound an order armed today runs on. Named separately from the absolute ceiling
      // because the two clear in opposite ways: this one waits on the protocol lowering the
      // rate, the other on the curve coming back down.
      why = `fee is ${(Number(protocolState.exerciseFeeBps) / 100).toFixed(1)}%, order accepts ${(Number(raw.maxFeeBps) / 100).toFixed(0)}%`;
    } else if (protocolState && cost > BigInt(Math.floor(Number(chunk) * Number(raw.maxCostPerUnit) / UNIT))) {
      why = "over the order's cost ceiling";
    } else if (oSolaHijacked || usdcHijacked) {
      why = "delegate slot taken by another application";
    } else if (oSolaAllowance === null || usdcAllowance === null) {
      // The cap that actually stops an order is SPL Token's `delegated_amount`, not anything
      // this program holds — and SPL Token erases the delegate once it hits zero. So a cleared
      // slot means "spent" for an order that has fired, and "never armed" for one that has not.
      why = Number(raw.rounds) > 0 ? "allowance spent — re-arm to continue" : "no allowance granted";
    } else if (oSolaAllowance < chunk || usdcAllowance < cost) {
      why = `allowance nearly spent (${(Number(oSolaAllowance) / UNIT).toFixed(2)} oSOLA left)`;
    }

    return {
      owner: raw.owner as PublicKey,
      order: decodeOrder(raw),
      oSolaBalance,
      ready: why === "",
      why,
    };
  });
}
