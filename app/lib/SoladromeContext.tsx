// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getProgram, statePda } from "./program";

interface SoladromeCtx {
  usdcMint: PublicKey | null;
  loading: boolean;
}

const Ctx = createContext<SoladromeCtx>({ usdcMint: null, loading: true });

export function SoladromeProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [usdcMint, setUsdcMint] = useState<PublicKey | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Even without wallet we can read the state via a read-only provider
    const provider = wallet
      ? new AnchorProvider(connection, wallet, {})
      : new AnchorProvider(
          connection,
          { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (ts) => ts },
          {}
        );

    const program = getProgram(provider);
    (program.account as any).protocolState
      .fetch(statePda)
      .then((s: any) => {
        setUsdcMint(new PublicKey(s.usdcMint));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [wallet, connection]);

  return <Ctx.Provider value={{ usdcMint, loading }}>{children}</Ctx.Provider>;
}

export function useSoladrome() {
  return useContext(Ctx);
}
