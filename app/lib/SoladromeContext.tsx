// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, AccountInfo } from "@solana/web3.js";
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
