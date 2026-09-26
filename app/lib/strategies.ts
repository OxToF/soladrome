// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// Per-position reward strategies, client side.
//
// A `PoolStrategy` says what happens to ONE LP position's oSOLA: compounded into liquidity (its
// own pool by default, or any pool that pairs USDC or SOL), or exercised into voting power. The
// program harvests it at the source, straight from the position's accrual, so two strategies of
// one owner never touch each other's rewards — which a wallet-based order cannot promise, since
// oSOLA in a wallet no longer says which pool it came from.
//
// Everything here builds instructions exactly as the program derives its own checks. A cranker
// never chooses a route: the sale pool is THE oSOLA/USDC pool, the hop is THE SOL/USDC pool, and
// a same-pool strategy passes its pool once (the program refuses it twice).
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  getProgram, statePda, solaM, oSolaM, floorVault, marketVault, solaVaultAddr,
  positionPda, userAta, poolPda, PROGRAM_ID, WSOL_MINT_STR,
} from "./program";
import { autoPda, lpDestinationSide } from "./autocompound";
import {
  lpUserInfoPda, computePendingOsola, rewardBasis, emissionCfgOf,
} from "./lprewards";
import { decodeTokenAmount } from "./recipe";

const UNIT = 1_000_000;
export const STRATEGY_LIQUIDITY = 1;
export const STRATEGY_VOTE = 2;

/// Defaults the interface arms a strategy with. Shown in full wherever one is armed.
export const STRATEGY_DEFAULTS = {
  /// A round waits for at least this much oSOLA, so it is worth its transaction fee.
  minHarvest: 1,
  /// At most once an hour.
  minInterval: 3_600,
  /// The sale never goes below 70 % of an oSOLA's exercise value (agreed 2026-09-23).
  minIntrinsicBps: 7_000,
  /// A voting strategy accepts up to 20 % of the gain as exercise fee (the protocol takes 10 %).
  maxFeeBps: 2_000,
};

export function strategyPda(owner: PublicKey, sourcePool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("strategy"), owner.toBuffer(), sourcePool.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export type PoolStrategy = {
  address: PublicKey;
  owner: PublicKey;
  sourcePool: PublicKey;
  /// Liquidity: where the rewards go. Null for a voting strategy.
  targetPool: PublicKey | null;
  mode: "liquidity" | "vote";
  /// UI units.
  minHarvest: number;
  minInterval: number;
  lastTs: number;
  rounds: number;
  /// Lifetime oSOLA harvested, UI units.
  harvested: number;
  minIntrinsicBps: number;
  maxFeeBps: number;
};

function decode(address: PublicKey, raw: any): PoolStrategy {
  const target = raw.targetPool as PublicKey;
  return {
    address,
    owner: raw.owner,
    sourcePool: raw.sourcePool,
    targetPool: target.equals(PublicKey.default) ? null : target,
    mode: raw.mode === STRATEGY_VOTE ? "vote" : "liquidity",
    minHarvest: Number(raw.minHarvest) / UNIT,
    minInterval: Number(raw.minInterval),
    lastTs: Number(raw.lastTs),
    rounds: Number(raw.rounds),
    harvested: Number(raw.harvested) / UNIT,
    minIntrinsicBps: Number(raw.minIntrinsicBps),
    maxFeeBps: Number(raw.maxFeeBps),
  };
}

/// Every strategy `owner` has, keyed by source pool.
export async function readStrategies(
  connection: Connection,
  wallet: AnchorWallet,
  owner: PublicKey = wallet.publicKey,
): Promise<Map<string, PoolStrategy>> {
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  // `owner` is the first field, right after the 8-byte discriminator.
  const all: any[] = await (program.account as any).poolStrategy.all([
    { memcmp: { offset: 8, bytes: owner.toBase58() } },
  ]);
  return new Map(all.map((a) => [(a.account.sourcePool as PublicKey).toBase58(), decode(a.publicKey, a.account)]));
}

/// Create or change the strategy of the owner's position in `source`. For a voting strategy the
/// destination is ignored and the source is passed in its place, as the program expects.
export async function buildSetStrategyInstruction(
  connection: Connection,
  wallet: AnchorWallet,
  source: PublicKey,
  s:
    | { mode: "liquidity"; target: PublicKey; minHarvest?: number; minInterval?: number; minIntrinsicBps?: number }
    | { mode: "vote"; minHarvest?: number; minInterval?: number; maxFeeBps?: number },
): Promise<TransactionInstruction> {
  const user = wallet.publicKey;
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  const target = s.mode === "liquidity" ? s.target : source;
  const tgt: any = await (program.account as any).ammPool.fetch(target);
  return (program.methods as any)
    .setPoolStrategy(
      s.mode === "liquidity" ? STRATEGY_LIQUIDITY : STRATEGY_VOTE,
      new BN(Math.round((s.minHarvest ?? STRATEGY_DEFAULTS.minHarvest) * UNIT)),
      new BN(s.minInterval ?? STRATEGY_DEFAULTS.minInterval),
      s.mode === "liquidity" ? (s.minIntrinsicBps ?? STRATEGY_DEFAULTS.minIntrinsicBps) : 0,
      s.mode === "vote" ? (s.maxFeeBps ?? STRATEGY_DEFAULTS.maxFeeBps) : 0,
    )
    .accounts({
      user,
      strategy: strategyPda(user, source),
      protocolState: statePda,
      sourcePool: source,
      targetPool: target,
      targetLpMint: tgt.lpMint,
      targetUserLp: userAta(tgt.lpMint, user),
      targetLpUserInfo: lpUserInfoPda(target, user),
      oSolaMint: oSolaM,
      userOSola: userAta(oSolaM, user),
      userPosition: positionPda(user),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export async function buildCloseStrategyInstruction(
  connection: Connection,
  wallet: AnchorWallet,
  source: PublicKey,
): Promise<TransactionInstruction> {
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  return (program.methods as any)
    .closePoolStrategy()
    .accounts({ user: wallet.publicKey, strategy: strategyPda(wallet.publicKey, source) })
    .instruction();
}

/// Whether a position in `source` may compound into `target` — mirrors the program's rules, so the
/// interface never offers a choice the chain would refuse.
export function canCompound(
  source: { key: PublicKey },
  target: { mintA: PublicKey; mintB: PublicKey; key: PublicKey },
  usdcMint: PublicKey,
): boolean {
  const side = lpDestinationSide(target.mintA, target.mintB, usdcMint);
  if (!side) return false;
  const sell = poolPda(oSolaM, usdcMint);
  const hop = poolPda(new PublicKey(WSOL_MINT_STR), usdcMint);
  if (source.key.equals(sell)) return false;
  if (side.needsHop && source.key.equals(hop)) return false;
  return true;
}

/// The liquidity crank for any owner, built by any caller.
export async function buildStrategyLpCrankInstruction(
  connection: Connection,
  wallet: AnchorWallet,
  usdcMint: PublicKey,
  s: PoolStrategy,
): Promise<TransactionInstruction> {
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  if (s.mode !== "liquidity" || !s.targetPool) throw new Error("not a liquidity strategy");
  const wsol = new PublicKey(WSOL_MINT_STR);
  const sellKey = poolPda(oSolaM, usdcMint);
  const hopKey = poolPda(wsol, usdcMint);
  const same = s.sourcePool.equals(s.targetPool);
  const [sell, tgt, src]: any[] = await Promise.all([
    (program.account as any).ammPool.fetch(sellKey),
    (program.account as any).ammPool.fetch(s.targetPool),
    same ? Promise.resolve(null) : (program.account as any).ammPool.fetch(s.sourcePool),
  ]);
  const vaultOf = (pool: any, mint: PublicKey): PublicKey =>
    (pool.tokenAMint as PublicKey).equals(mint) ? pool.tokenAVault : pool.tokenBVault;
  const side = lpDestinationSide(tgt.tokenAMint, tgt.tokenBMint, usdcMint);
  if (!side) throw new Error("this pool cannot be a liquidity destination");
  const hop: any = side.needsHop ? await (program.account as any).ammPool.fetch(hopKey) : null;
  const owner = s.owner;

  return (program.methods as any)
    .crankPoolStrategyLp()
    .accounts({
      cranker: wallet.publicKey,
      owner,
      strategy: s.address,
      protocolState: statePda,
      oSolaMint: oSolaM,
      userOSola: userAta(oSolaM, owner),
      sourcePool: same ? null : s.sourcePool,
      sourceLpUserInfo: same ? null : lpUserInfoPda(s.sourcePool, owner),
      sourceUserLp: same ? null : userAta(src.lpMint, owner),
      sellPool: sellKey,
      sellOSolaVault: vaultOf(sell, oSolaM),
      sellUsdcVault: vaultOf(sell, usdcMint),
      hopPool: hop ? hopKey : null,
      hopUsdcVault: hop ? vaultOf(hop, usdcMint) : null,
      hopSolVault: hop ? vaultOf(hop, wsol) : null,
      targetPool: s.targetPool,
      targetDepositVault: vaultOf(tgt, side.deposit),
      lpMint: tgt.lpMint,
      userLp: userAta(tgt.lpMint, owner),
      targetLpUserInfo: lpUserInfoPda(s.targetPool, owner),
      marketVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/// The voting crank for any owner, built by any caller.
export async function buildStrategyVoteCrankInstruction(
  connection: Connection,
  wallet: AnchorWallet,
  usdcMint: PublicKey,
  s: PoolStrategy,
): Promise<TransactionInstruction> {
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  const src: any = await (program.account as any).ammPool.fetch(s.sourcePool);
  const owner = s.owner;
  return (program.methods as any)
    .crankPoolStrategyVote()
    .accounts({
      cranker: wallet.publicKey,
      owner,
      strategy: s.address,
      protocolState: statePda,
      sourcePool: s.sourcePool,
      sourceLpMint: src.lpMint,
      sourceLpUserInfo: lpUserInfoPda(s.sourcePool, owner),
      sourceUserLp: userAta(src.lpMint, owner),
      userPosition: positionPda(owner),
      userUsdc: userAta(usdcMint, owner),
      usdcMint,
      autoDelegate: autoPda(owner),
      solaMint: solaM,
      floorVault,
      marketVault,
      solaVault: solaVaultAddr,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/// What each position has pending, computed exactly as the program's harvest would, with whether
/// a stranger may harvest it now (the wallet must hold the whole recorded position).
export async function pendingForPositions(
  connection: Connection,
  wallet: AnchorWallet,
  owner: PublicKey,
  pools: PublicKey[],
  protocolState: any,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<Map<string, { pending: number; fullBasis: boolean; hasPosition: boolean }>> {
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  const cfg = emissionCfgOf(protocolState);
  const poolAccs: any[] = await (program.account as any).ammPool.fetchMultiple(pools);
  const infoKeys = pools.map((p) => lpUserInfoPda(p, owner));
  const infos: any[] = await (program.account as any).lpUserInfo.fetchMultiple(infoKeys);
  const lpAccs = await connection.getMultipleAccountsInfo(
    poolAccs.map((p) => (p ? userAta(p.lpMint, owner) : PublicKey.default)),
  );
  const out = new Map<string, { pending: number; fullBasis: boolean; hasPosition: boolean }>();
  pools.forEach((key, i) => {
    const p = poolAccs[i], info = infos[i];
    if (!p || !info) return out.set(key.toBase58(), { pending: 0, fullBasis: true, hasPosition: false });
    const wallet = decodeTokenAmount(lpAccs[i]?.data);
    const recorded = BigInt(info.lpAmount.toString());
    const pending = computePendingOsola(
      {
        totalLp: Number(p.totalLp) / UNIT,
        osolaRewardPerLp: BigInt(p.osolaRewardPerLp.toString()),
        lastRewardTs: Number(p.lastRewardTs),
        rewardsEnabled: !!p.rewardsEnabled,
      },
      BigInt(info.rewardDebt.toString()),
      rewardBasis(recorded, wallet),
      nowSec,
      cfg,
    );
    out.set(key.toBase58(), { pending, fullBasis: wallet >= recorded, hasPosition: recorded > BigInt(0) });
  });
  return out;
}

/// Every strategy on chain with whether it may fire — the keeper's view. Reads only.
export async function listCrankableStrategies(
  connection: Connection,
  wallet: AnchorWallet,
  protocolState: any,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<{ strategy: PoolStrategy; pending: number; ready: boolean; why: string }[]> {
  const program = getProgram(new AnchorProvider(connection, wallet, {}));
  const all: any[] = await (program.account as any).poolStrategy.all();
  const out = [];
  for (const a of all) {
    const s = decode(a.publicKey, a.account);
    const pend = (await pendingForPositions(connection, wallet, s.owner, [s.sourcePool], protocolState, nowSec))
      .get(s.sourcePool.toBase58())!;
    let why = "";
    if (!pend.hasPosition) why = "no position";
    else if (nowSec - s.lastTs < s.minInterval) why = `${s.minInterval - (nowSec - s.lastTs)}s to go`;
    else if (pend.pending < s.minHarvest) why = `pending ${pend.pending.toFixed(4)} < ${s.minHarvest}`;
    else if (!pend.fullBasis) why = "wallet holds less LP than recorded — only the owner may harvest";
    else if (s.mode === "vote" && !protocolState.exerciseEnabled) why = "exercise closed";
    else if (s.mode === "vote" && Number(protocolState.exerciseFeeBps) > s.maxFeeBps) why = "fee above the owner's bound";
    // A voting round exercises what the owner's USDC pays for, and the rest stays accrued — so
    // the round is the smaller of the two, and it is THAT which must reach `minHarvest`.
    let round = pend.pending;
    if (!why && s.mode === "vote") {
      const budget = await voteBudget(connection, s.owner, protocolState.usdcMint);
      round = Math.min(round, Number(maxExercisable(protocolState, budget)) / UNIT);
      if (budget === BigInt(0)) why = "no USDC budget: allowance spent or wallet empty";
      else if (round < s.minHarvest) why = `budget pays ${round.toFixed(4)} < ${s.minHarvest}`;
    }
    out.push({ strategy: s, pending: round, ready: why === "", why });
  }
  return out;
}

/// What one voting round can spend, in USDC base units: the allowance to the strategy delegate,
/// capped by the balance behind it. Zero without that delegate. Mirrors `crank_pool_strategy_vote`.
export async function voteBudget(connection: Connection, owner: PublicKey, usdcMint: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(userAta(usdcMint, owner));
  if (!info?.data || info.data.length < 129) return BigInt(0);
  const data = Buffer.from(info.data);
  if (data.readUInt32LE(72) !== 1 || !new PublicKey(data.subarray(76, 108)).equals(autoPda(owner))) return BigInt(0);
  const amount = data.readBigUInt64LE(64);
  const allowance = data.readBigUInt64LE(121);
  return amount < allowance ? amount : allowance;
}

/// The most oSOLA `budget` USDC exercises, strike and fee together — `curve::max_exercisable`,
/// bit for bit, so the keeper announces the round the program will actually run.
export function maxExercisable(protocolState: any, budget: bigint): bigint {
  const vu = BigInt(protocolState.virtualUsdc.toString());
  const vs = BigInt(protocolState.virtualSola.toString());
  const bps = BigInt(Number(protocolState.exerciseFeeBps ?? 0));
  if (vu <= vs || vs === BigInt(0) || bps === BigInt(0)) return budget;
  const unit = vs * BigInt(10_000);
  return (budget * unit) / (unit + (vu - vs) * bps);
}

/// The owner's USDC allowance to the strategy delegate — what a voting strategy pays strikes from.
export async function voteAllowance(
  connection: Connection,
  owner: PublicKey,
  usdcMint: PublicKey,
): Promise<bigint | null> {
  const info = await connection.getAccountInfo(userAta(usdcMint, owner));
  if (!info?.data || info.data.length < 129) return null;
  const data = Buffer.from(info.data);
  if (data.readUInt32LE(72) !== 1) return null;
  if (!new PublicKey(data.subarray(76, 108)).equals(autoPda(owner))) return null;
  return data.readBigUInt64LE(121);
}
