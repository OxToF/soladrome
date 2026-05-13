// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { getProgram, statePda, toUi } from "@/lib/program";

interface ProtocolStats {
  totalSola: number;
  totalHiSola: number;
  marketPrice: number;
  floorPrice: number;
  accumulatedFees: number;
}

export function Stats() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [stats, setStats] = useState<ProtocolStats | null>(null);

  useEffect(() => {
    if (!wallet) return;
    const provider = new AnchorProvider(connection, wallet, {});
    const program = getProgram(provider);

    (program.account as any).protocolState.fetch(statePda).then((s: any) => {
      const vU = s.virtualUsdc.toNumber();
      const vS = s.virtualSola.toNumber();
      setStats({
        totalSola:        toUi(s.totalSola),
        totalHiSola:      toUi(s.totalHiSola),
        marketPrice:      vS > 0 ? vU / vS : 1,
        floorPrice:       1,
        accumulatedFees:  toUi(s.accumulatedFees),
      });
    }).catch(() => {});
  }, [wallet, connection]);

  const items = stats
    ? [
        { label: "SOLA Supply",    value: stats.totalSola.toLocaleString()    },
        { label: "hiSOLA Staked",  value: stats.totalHiSola.toLocaleString()  },
        { label: "Market Price",   value: `${stats.marketPrice.toFixed(4)} USDC` },
        { label: "Floor Price",    value: "1.000 USDC"                         },
        { label: "Protocol Fees",  value: `${stats.accumulatedFees.toFixed(2)} USDC` },
      ]
    : [];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
      {items.map((item) => (
        <div key={item.label} className="card text-center">
          <p className="text-xs text-gray-500 mb-1">{item.label}</p>
          <p className="font-bold text-brand-green">{item.value}</p>
        </div>
      ))}
      {!stats && wallet && (
        <div className="col-span-5 text-center text-gray-500 text-sm py-4">
          Loading protocol stats…
        </div>
      )}
    </div>
  );
}