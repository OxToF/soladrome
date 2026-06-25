// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { SoladromeProvider } from "@/lib/SoladromeContext";

const ENDPOINT = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";

// The app fans out many getAccountInfo calls on mount and on every poll tick.
// On rate-limited RPCs (e.g. Helius free tier ~10 req/s) those bursts return
// HTTP 429. web3.js already retries 429 internally, so we do NOT add a second
// retry layer here (that just multiplies requests against a throttled endpoint
// and makes recovery slower). Instead we *space out* request starts with a
// global min-interval gate so we stay under the RPS cap and avoid 429 entirely.
// web3.js's native retry then mops up the rare residual throttle.
const MIN_INTERVAL_MS = 110; // ~9 req/s start rate, just under the free-tier cap
let gate: Promise<void> = Promise.resolve();
let lastStart = 0;
function throttledFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const ticket = gate.then(async () => {
    const wait = Math.max(0, lastStart + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
  });
  gate = ticket.catch(() => {});
  return ticket.then(() => fetch(input, init));
}

export function Providers({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );
  return (
    <ConnectionProvider endpoint={ENDPOINT} config={{ commitment: "confirmed", fetch: throttledFetch }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <SoladromeProvider>
            {children}
          </SoladromeProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
