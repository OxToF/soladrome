// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { SoladromeProvider } from "@/lib/SoladromeContext";

const ENDPOINT  = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
const FALLBACK  = "https://api.devnet.solana.com";

// Token-bucket throttle: burst capacity of 4 lets the first 4 concurrent requests
// fire immediately (important on mount when several components fetch in parallel),
// then refills at 1 token / 110 ms (~9 req/s) to stay under the Helius free-tier
// cap. Pure serial gating (the previous approach) forced even burst requests to
// queue one-by-one, adding ~1 s of artificial delay on every page load.
const RATE_MS = 110;
const BURST   = 4;
let credit    = BURST;
let lastTick  = Date.now();
let draining  = false;
const queue: Array<() => void> = [];

function drainQueue() {
  if (draining) return;
  draining = true;
  (function tick() {
    const now     = Date.now();
    const earned  = Math.floor((now - lastTick) / RATE_MS);
    if (earned > 0) {
      credit   = Math.min(BURST, credit + earned);
      lastTick += earned * RATE_MS;
    }
    while (credit > 0 && queue.length > 0) {
      credit--;
      queue.shift()!();
    }
    if (queue.length > 0) {
      setTimeout(tick, RATE_MS - (Date.now() - lastTick));
    } else {
      draining = false;
    }
  })();
}

function throttledFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise<void>(resolve => {
    queue.push(resolve);
    drainQueue();
  }).then(async () => {
    const res = await fetch(input, init);
    if (res.status !== 429 || ENDPOINT === FALLBACK) return res;
    // Helius quota exhausted — clone the request to the public devnet RPC
    const url     = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const fbUrl   = url.replace(ENDPOINT, FALLBACK);
    if (fbUrl === url) return res;
    return fetch(fbUrl, init);
  });
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
