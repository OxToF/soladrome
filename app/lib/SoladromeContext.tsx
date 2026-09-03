// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { createContext, useContext, useEffect, useState, useCallback, useMemo, ReactNode } from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, AccountInfo } from "@solana/web3.js";
import { unpackAccount } from "@solana/spl-token";
import { getProgram, statePda, floorVault, marketVault } from "./program";

// Protocol-wide read-only data cached here so individual components don't
// each fire their own protocolState.fetch / ammPool.all() on mount.
export interface SoladromeCtx {
  usdcMint:      PublicKey | null;
  protocolState: any | null;          // raw Anchor deserialized ProtocolState
  ammPools:      any[];               // raw AmmPool.all() result
  vaultInfos:    (AccountInfo<Buffer> | null)[];  // [floorVault, marketVault]
  loading:       boolean;
  refresh:       () => void;          // force an immediate re-fetch
}

const Ctx = createContext<SoladromeCtx>({
  usdcMint: null, protocolState: null, ammPools: [], vaultInfos: [],
  loading: true, refresh: () => {},
});

export function SoladromeProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const [usdcMint,      setUsdcMint]      = useState<PublicKey | null>(null);
  const [protocolState, setProtocolState] = useState<any | null>(null);
  const [ammPools,      setAmmPools]      = useState<any[]>([]);
  const [vaultInfos,    setVaultInfos]    = useState<(AccountInfo<Buffer> | null)[]>([]);
  const [loading,       setLoading]       = useState(true);

  const fetchAll = useCallback(async () => {
    const provider = wallet
      ? new AnchorProvider(connection, wallet, {})
      : new AnchorProvider(
          connection,
          { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (ts) => ts },
          {}
        );
    const program = getProgram(provider);
    try {
      const [s, infos, pools] = await Promise.all([
        (program.account as any).protocolState.fetch(statePda),
        connection.getMultipleAccountsInfo([floorVault, marketVault]),
        (program.account as any).ammPool.all(),
      ]);
      setProtocolState(s);
      setUsdcMint(new PublicKey(s.usdcMint));
      setVaultInfos(infos);
      setAmmPools(pools);
    } catch { /* keep stale data on transient errors */ }
    setLoading(false);
  }, [wallet, connection]);

  // Initial fetch + refresh every 10 s (matches previous Stats polling cadence)
  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 10_000);
    return () => clearInterval(id);
  }, [fetchAll]);

  return (
    <Ctx.Provider value={{ usdcMint, protocolState, ammPools, vaultInfos, loading, refresh: fetchAll }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSoladrome() {
  return useContext(Ctx);
}

// borrow.rs — the 75% floor buffer, guarding BOTH borrow paths (`borrow_usdc` and
// `borrow_against_locked`) with the same block.
const FLOOR_RESERVE_MIN_BPS = 7_500;

/**
 * How much USDC may still leave `floor_vault` before it reaches 75% of floor-backed
 * supply, in raw base units. `null` while the protocol state has not loaded.
 *
 * This is a SECOND ceiling on every borrow, independent of whatever collateral cap the
 * caller is subject to, and it belongs to the protocol rather than to the borrower: one
 * budget, drawn by everyone at once, moving with other people's borrows, repayments and
 * SOLA purchases. At low buy volume it is the binding one — the borrowable total across
 * all users is ~25% of `total_purchased_sola`.
 *
 * It lives here because four panels need it (Borrow, Contributor, Founder, Partner) and
 * each one that computed its own bound got it wrong in a different way: three ignored the
 * buffer outright, and the fourth capped on the whole floor vault balance, which is the
 * `InsufficientFloorReserve` guard rather than this one.
 */
export function useFloorHeadroom(): number | null {
  const { protocolState, vaultInfos } = useSoladrome();
  return useMemo(() => {
    if (!protocolState || !vaultInfos[0]) return null;
    const floorRaw = Number(unpackAccount(floorVault, vaultInfos[0]).amount);
    const minFloor =
      (protocolState.totalPurchasedSola.toNumber() * FLOOR_RESERVE_MIN_BPS) / 10_000;
    return Math.max(0, floorRaw - minFloor);
  }, [protocolState, vaultInfos]);
}
