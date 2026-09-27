// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// SODAX bridge helpers. Imported only by components/SodaxBridge.tsx, which the Bridge page loads
// with next/dynamic: the SDK pulls in Sui, Stellar, Near, Injective and Bitcoin clients (~3 MB of
// chunks), and none of that may reach a page that doesn't bridge.
//
// ☢️ EVERYTHING HERE IS MAINNET. SODAX has no devnet or testnet ("our solver system wouldn't work
// there"), so this is the one surface of a devnet app that moves real funds. It never touches the
// app's devnet Connection, and the page says so before the first signature.
import { Sodax, spokeChainConfig, type SpokeChainKey, type XToken } from "@sodax/sdk";
import { resolveRpcUrl } from "@/lib/rpc";

export const SOLANA = "solana" as const satisfies SpokeChainKey;

// The EVM side of every route. Enumerated against the SDK on 2026-09-27: each of these bridges
// USDC, USDT, SODA and bnUSD to and from Solana. Sonic is the SODAX hub and is the only chain
// that also carries SOL and JitoSOL — the Solana LSTs and xStocks in the SDK's token list are
// swap-only (solver intents), not bridgeable.
export const EVM_CHAINS = [
  { key: "0x2105.base",     label: "Base",      color: "#0052FF" },
  { key: "0xa4b1.arbitrum", label: "Arbitrum",  color: "#28A0F0" },
  { key: "0xa.optimism",    label: "Optimism",  color: "#FF0420" },
  { key: "ethereum",        label: "Ethereum",  color: "#627EEA" },
  { key: "0x38.bsc",        label: "BNB Chain", color: "#F0B90B" },
  { key: "0x89.polygon",    label: "Polygon",   color: "#8247E5" },
  { key: "0xa86a.avax",     label: "Avalanche", color: "#E84142" },
  { key: "sonic",           label: "Sonic",     color: "#FE9A4C" },
  { key: "hyper",           label: "HyperEVM",  color: "#97FCE4" },
] as const satisfies readonly { key: SpokeChainKey; label: string; color: string }[];

export type EvmChainKey = (typeof EVM_CHAINS)[number]["key"];

export function chainLabel(key: string): string {
  return key === SOLANA ? "Solana" : EVM_CHAINS.find((c) => c.key === key)?.label ?? key;
}

export function chainColor(key: string): string {
  return key === SOLANA ? "#14F195" : EVM_CHAINS.find((c) => c.key === key)?.color ?? "#888";
}

/**
 * Mainnet Solana endpoint for the bridge. An explicit NEXT_PUBLIC_SOLANA_MAINNET_RPC_URL wins;
 * otherwise the app's own Helius URL is pointed at mainnet — a Helius key serves both clusters,
 * so the browser key (already public, restricted to the domain) covers this page without a new
 * secret. Public mainnet-beta is the last resort: rate-limited, but reachable.
 */
export function solanaMainnetRpc(): string {
  const app = process.env.NEXT_PUBLIC_RPC_URL?.trim();
  const derived = app?.includes("devnet.helius-rpc.com")
    ? app.replace("devnet.helius-rpc.com", "mainnet.helius-rpc.com")
    : undefined;
  const url = resolveRpcUrl(process.env.NEXT_PUBLIC_SOLANA_MAINNET_RPC_URL, derived);
  // resolveRpcUrl's own fallback is public DEVNET — never acceptable on a mainnet page.
  return url.includes("devnet") ? "https://api.mainnet-beta.solana.com" : url;
}

let instance: Promise<Sodax> | null = null;

/** One initialized SDK per page load. `initialize()` fetches the live config from SODAX's API. */
export function getSodax(): Promise<Sodax> {
  instance ??= (async () => {
    const sodax = new Sodax({ chains: { solana: { rpcUrl: solanaMainnetRpc() } } });
    const init = await sodax.initialize();
    if (!init.ok) {
      instance = null;
      throw new Error(`SODAX init failed: ${errorText(init.error)}`);
    }
    return sodax;
  })();
  return instance;
}

export function supportedTokens(chain: SpokeChainKey): XToken[] {
  return Object.values(spokeChainConfig[chain].supportedTokens) as XToken[];
}

export type Route = { src: XToken; dst: XToken };

// USDC first: it is the base asset of every Soladrome pool, so it is the transfer this page exists for.
const PREFERRED = ["USDC", "USDT", "SODA"];
const rank = (s: string) => (PREFERRED.includes(s) ? PREFERRED.indexOf(s) : PREFERRED.length);

/** Every token pair the SDK will bridge from `from` to `to`, USDC first. */
export function routes(sodax: Sodax, from: SpokeChainKey, to: SpokeChainKey): Route[] {
  const out: Route[] = [];
  for (const src of supportedTokens(from)) {
    const r = sodax.bridge.getBridgeableTokens(from, to, src.address);
    if (r.ok) for (const dst of r.value) out.push({ src, dst });
  }
  return out.sort((a, b) => rank(a.src.symbol) - rank(b.src.symbol));
}

export function isNative(chain: SpokeChainKey, token: XToken): boolean {
  return spokeChainConfig[chain].nativeToken.toLowerCase() === token.address.toLowerCase();
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

// ── Local history ───────────────────────────────────────────────────────────
// The browser is the only place a bridge's hashes are kept: SODAX's relay runs server-side and
// Soladrome has no backend record of it. Enough to find a transfer again and hand SODAX support
// the source hash if one stalls.

export type HistoryEntry = {
  at: number;
  srcChain: string;
  dstChain: string;
  symbol: string;
  amount: string;
  status: "pending" | "done" | "failed";
  srcTx?: string;
  dstTx?: string;
  error?: string;
};

const HISTORY_KEY = "soladrome.sodax.history.v1";

export function readHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as HistoryEntry[];
  } catch {
    return [];
  }
}

export function writeHistory(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 20)));
  } catch {
    /* private mode / quota — history is a convenience, never a requirement */
  }
}
