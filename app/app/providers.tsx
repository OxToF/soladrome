// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import {
  SolanaMobileWalletAdapter,
  createDefaultAddressSelector,
  createDefaultAuthorizationResultCache,
  createDefaultWalletNotFoundHandler,
} from "@solana-mobile/wallet-adapter-mobile";
import { SoladromeProvider } from "@/lib/SoladromeContext";

const ENDPOINT  = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
const FALLBACK  = "https://api.devnet.solana.com";

// Public origin shown to the wallet in the connect/authorize dialog (and used
// for Digital Asset Links when wrapped as an Android APK). Canonical prod domain
// (apex soladrome.finance 308-redirects to www); override per-env if it changes.
const APP_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.soladrome.finance";

// Wallet cluster, derived from the RPC endpoint so it always matches the network
// the app talks to. At mainnet launch, switching NEXT_PUBLIC_RPC_URL to a mainnet
// RPC (no "devnet"/"testnet" in the host) flips this to "mainnet-beta" on its own.
const CLUSTER: "devnet" | "testnet" | "mainnet-beta" =
  ENDPOINT.includes("devnet")  ? "devnet"
  : ENDPOINT.includes("testnet") ? "testnet"
  : "mainnet-beta";

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
  // On Android, wallet-adapter-react auto-registers a Mobile Wallet Adapter, but
  // supplying our own lets us brand the connect dialog (name + icon) and pin the
  // cluster — important for the Solana Seeker / dApp Store experience. On desktop
  // & iOS this adapter reports Unsupported and is hidden, so Phantom/Solflare are
  // used instead. cluster follows the RPC endpoint (see CLUSTER above).
  const wallets = useMemo(
    () => [
      new SolanaMobileWalletAdapter({
        addressSelector: createDefaultAddressSelector(),
        appIdentity: {
          name: "Soladrome",
          uri: APP_URL,
          icon: "icons/icon-512.png", // relative to uri
        },
        authorizationResultCache: createDefaultAuthorizationResultCache(),
        cluster: CLUSTER,
        onWalletNotFound: createDefaultWalletNotFoundHandler(),
      }),
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
    ],
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
