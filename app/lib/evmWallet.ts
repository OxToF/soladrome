// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// Minimal injected-EVM-wallet hook for the SODAX bridge: EIP-6963 discovery (MetaMask, Rabby,
// Phantom's EVM side, Coinbase…), connect, and chain switching. No wagmi, no WalletConnect — the
// bridge is the only EVM surface of a Solana app, and a browser wallet is what it needs.
"use client";
import { useCallback, useEffect, useState } from "react";
import type { Chain } from "viem";

export type Eip1193 = {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, fn: (...a: unknown[]) => void): void;
  removeListener?(event: string, fn: (...a: unknown[]) => void): void;
};

export type Eip6963Wallet = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193 };

type AnnounceEvent = CustomEvent<Eip6963Wallet>;

export function useEvmWallet() {
  const [wallets, setWallets] = useState<Eip6963Wallet[]>([]);
  const [active, setActive] = useState<Eip6963Wallet | null>(null);
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);

  // Discovery: wallets answer a request event with one announce each.
  useEffect(() => {
    const onAnnounce = (e: Event) => {
      const w = (e as AnnounceEvent).detail;
      setWallets((prev) => (prev.some((p) => p.info.uuid === w.info.uuid) ? prev : [...prev, w]));
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);

  // Follow account and chain changes made in the wallet itself.
  useEffect(() => {
    const p = active?.provider;
    if (!p?.on) return;
    const onAccounts = (a: unknown) => setAccount(((a as string[])[0] as `0x${string}`) ?? null);
    const onChain = (c: unknown) => setChainId(Number(c));
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [active]);

  const connect = useCallback(async (w: Eip6963Wallet) => {
    const accounts = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
    const cid = (await w.provider.request({ method: "eth_chainId" })) as string;
    setActive(w);
    setAccount((accounts[0] as `0x${string}`) ?? null);
    setChainId(Number(cid));
  }, []);

  const disconnect = useCallback(() => {
    setActive(null);
    setAccount(null);
    setChainId(null);
  }, []);

  /** Ask the wallet to switch to `chain`, adding it first if the wallet doesn't know it. */
  const switchTo = useCallback(
    async (chain: Chain) => {
      const p = active?.provider;
      if (!p) throw new Error("No EVM wallet connected");
      const hex = `0x${chain.id.toString(16)}`;
      try {
        await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      } catch (e) {
        if ((e as { code?: number }).code !== 4902) throw e;
        await p.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: hex,
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: chain.rpcUrls.default.http,
            blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
          }],
        });
      }
      setChainId(chain.id);
    },
    [active],
  );

  return { wallets, active, account, chainId, connect, disconnect, switchTo };
}
