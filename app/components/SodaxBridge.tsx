// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
//
// The SODAX bridge form. Loaded only through next/dynamic from Bridge.tsx (see lib/sodax.ts for
// why). Two directions, one form:
//
//   into Solana  — the EVM wallet signs on the source chain (approve if needed, then deposit);
//                  the recipient is the connected Solana wallet, never a typed address.
//   out of Solana — the Solana wallet signs; the recipient is an EVM address, prefilled from the
//                  connected EVM wallet.
//
// SODAX relays through its Sonic hub and delivers to an address — there is no call into a
// program on arrival, so using the funds on Soladrome is always a second, separate signature.
"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, createWalletClient, custom, erc20Abi, formatUnits, http, isAddress, parseUnits } from "viem";
import type { Sodax, SpokeChainKey, XToken } from "@sodax/sdk";
import { EvmWalletProvider, SolanaWalletProvider, getEvmViemChain } from "@sodax/wallet-sdk-core";
import {
  EVM_CHAINS, SOLANA, chainColor, chainLabel, errorText, getSodax, isNative, readHistory, routes,
  solanaMainnetRpc, writeHistory, type EvmChainKey, type HistoryEntry, type Route,
} from "@/lib/sodax";
import { useEvmWallet } from "@/lib/evmWallet";

type Direction = "in" | "out";
type Stage = "idle" | "switching" | "approving" | "bridging";

const STAGE_LABEL: Record<Stage, string> = {
  idle: "",
  switching: "Switching network in your EVM wallet…",
  approving: "Approve the token in your EVM wallet…",
  bridging: "Sign the deposit, then SODAX relays it through its hub (up to a few minutes)…",
};

function txUrl(chain: string, hash: string): string {
  if (chain === SOLANA) return `https://solscan.io/tx/${hash}`;
  const c = getEvmViemChain(chain as EvmChainKey);
  return `${c.blockExplorers?.default.url ?? "https://etherscan.io"}/tx/${hash}`;
}

function fmt(v: bigint, decimals: number, max = 6): string {
  const [i, f = ""] = formatUnits(v, decimals).split(".");
  const frac = f.slice(0, max).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i;
}

export default function SodaxBridge() {
  const sol = useWallet();
  const evm = useEvmWallet();
  const solMainnet = useMemo(() => new Connection(solanaMainnetRpc(), "confirmed"), []);

  const [sodax, setSodax] = useState<Sodax | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [dir, setDir] = useState<Direction>("in");
  const [evmChain, setEvmChain] = useState<EvmChainKey>("robinhood");
  const [routeIdx, setRouteIdx] = useState(0);
  const [amount, setAmount] = useState("");
  const [evmRecipient, setEvmRecipient] = useState("");
  const [ack, setAck] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [limit, setLimit] = useState<bigint | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    getSodax().then(setSodax).catch((e) => setInitError(errorText(e)));
    setHistory(readHistory());
  }, []);

  const srcChain: SpokeChainKey = dir === "in" ? evmChain : SOLANA;
  const dstChain: SpokeChainKey = dir === "in" ? SOLANA : evmChain;

  const available: Route[] = useMemo(
    () => (sodax ? routes(sodax, srcChain, dstChain) : []),
    [sodax, srcChain, dstChain],
  );
  const route: Route | undefined = available[routeIdx] ?? available[0];

  useEffect(() => setRouteIdx(0), [srcChain, dstChain]);
  useEffect(() => {
    if (evm.account && !evmRecipient) setEvmRecipient(evm.account);
  }, [evm.account, evmRecipient]);

  const solAddr = sol.publicKey?.toBase58() ?? null;
  const srcAddress = dir === "in" ? evm.account : solAddr;
  const recipient = dir === "in" ? solAddr : evmRecipient.trim();
  const recipientOk = dir === "in" ? !!solAddr : isAddress(recipient ?? "");

  // ── Source balance (mainnet) ──────────────────────────────────────────────
  const loadBalance = useCallback(async () => {
    setBalance(null);
    if (!route || !srcAddress) return;
    try {
      if (srcChain === SOLANA) {
        const owner = new PublicKey(srcAddress);
        if (isNative(SOLANA, route.src)) {
          setBalance(BigInt(await solMainnet.getBalance(owner)));
        } else {
          const res = await solMainnet.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(route.src.address) });
          setBalance(res.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount as string), 0n));
        }
      } else {
        const client = createPublicClient({ chain: getEvmViemChain(srcChain as EvmChainKey), transport: http() });
        setBalance(
          isNative(srcChain, route.src)
            ? await client.getBalance({ address: srcAddress as `0x${string}` })
            : await client.readContract({ address: route.src.address as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [srcAddress as `0x${string}`] }),
        );
      }
    } catch {
      setBalance(null);
    }
  }, [route, srcAddress, srcChain, solMainnet]);

  useEffect(() => { loadBalance(); }, [loadBalance]);

  // ── Route capacity: what the hub vault can move right now ────────────────
  useEffect(() => {
    setLimit(null);
    if (!sodax || !route) return;
    let live = true;
    sodax.bridge.getBridgeableAmount(route.src, route.dst).then((r) => {
      if (!live || !r.ok) return;
      // The limit is expressed in its own decimals; bring it to the source token's.
      const { amount: a, decimals: d } = r.value;
      const s = route.src.decimals;
      setLimit(d === s ? a : d > s ? a / 10n ** BigInt(d - s) : a * 10n ** BigInt(s - d));
    });
    return () => { live = false; };
  }, [sodax, route]);

  let parsed: bigint | null = null;
  try {
    parsed = route && amount ? parseUnits(amount, route.src.decimals) : null;
  } catch {
    parsed = null;
  }

  const blocker =
    !sodax ? "Loading SODAX…" :
    !route ? "No route for this pair" :
    dir === "in" && !evm.account ? "Connect an EVM wallet" :
    !solAddr ? "Connect your Solana wallet" :
    !recipientOk ? "Enter a valid EVM recipient" :
    !parsed || parsed <= 0n ? "Enter an amount" :
    balance !== null && parsed > balance ? "Insufficient balance" :
    limit !== null && parsed > limit ? "Above what the route can move right now" :
    !ack ? "Confirm you are bridging real funds on mainnet" :
    null;

  function pushHistory(e: HistoryEntry) {
    setHistory((prev) => {
      const next = [e, ...prev.filter((p) => p.at !== e.at)];
      writeHistory(next);
      return next;
    });
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  async function execute() {
    if (blocker || !sodax || !route || !parsed || !srcAddress || !recipient) return;
    setError(null);
    const entry: HistoryEntry = {
      at: Date.now(), srcChain, dstChain, symbol: route.src.symbol,
      amount: fmt(parsed, route.src.decimals), status: "pending",
    };
    const params = {
      srcAddress, srcChainKey: srcChain, srcToken: route.src.address, amount: parsed,
      dstChainKey: dstChain, dstToken: route.dst.address, recipient,
    };

    // Only a transfer that reached the deposit step belongs in the history; a refused approval doesn't.
    let submitted = false;
    try {
      let walletProvider: EvmWalletProvider | SolanaWalletProvider;
      if (srcChain === SOLANA) {
        if (!sol.publicKey || !sol.signTransaction) throw new Error("This Solana wallet cannot sign transactions");
        walletProvider = new SolanaWalletProvider({
          // The SDK bundles its own @solana/web3.js; the adapter's objects are structurally the same.
          wallet: { publicKey: sol.publicKey, signTransaction: sol.signTransaction } as never,
          endpoint: solanaMainnetRpc(),
        });
      } else {
        const chain = getEvmViemChain(srcChain as EvmChainKey);
        if (!evm.active) throw new Error("No EVM wallet connected");
        if (evm.chainId !== chain.id) {
          setStage("switching");
          await evm.switchTo(chain);
        }
        const walletClient = createWalletClient({ account: srcAddress as `0x${string}`, chain, transport: custom(evm.active.provider) });
        const publicClient = createPublicClient({ chain, transport: http() });
        walletProvider = new EvmWalletProvider({ walletClient, publicClient } as never);

        const allowed = await sodax.bridge.isAllowanceValid({ params, walletProvider } as never);
        if (!allowed.ok) throw allowed.error;
        if (!allowed.value) {
          setStage("approving");
          const approved = await sodax.bridge.approve({ params, walletProvider } as never);
          if (!approved.ok) throw approved.error;
          await publicClient.waitForTransactionReceipt({ hash: approved.value as `0x${string}` });
        }
      }

      setStage("bridging");
      submitted = true;
      pushHistory(entry);
      const res = await sodax.bridge.bridge({ params, walletProvider, timeout: 180_000 } as never);
      if (!res.ok) throw res.error;
      const { srcChainTxHash, dstChainTxHash } = res.value as { srcChainTxHash: string; dstChainTxHash: string };
      pushHistory({ ...entry, status: "done", srcTx: srcChainTxHash, dstTx: dstChainTxHash });
      setAmount("");
      loadBalance();
    } catch (e) {
      const msg = errorText(e);
      setError(msg);
      if (submitted) pushHistory({ ...entry, status: "failed", error: msg });
    } finally {
      setStage("idle");
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (initError) {
    return <div className="card-flat text-sm text-red-400">Could not reach SODAX: {initError}</div>;
  }

  const busy = stage !== "idle";
  const evmLabel = EVM_CHAINS.find((c) => c.key === evmChain)?.label;

  return (
    <div className="flex flex-col gap-4">
      {/* Direction */}
      <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-brand-dark/40 border border-brand-border">
        {(["in", "out"] as const).map((d) => (
          <button
            key={d}
            disabled={busy}
            onClick={() => setDir(d)}
            className={`py-2 rounded-lg text-sm font-semibold transition-colors ${dir === d ? "bg-brand-green/15 text-brand-green" : "text-brand-muted hover:text-white"}`}
          >
            {d === "in" ? "Into Solana" : "Out of Solana"}
          </button>
        ))}
      </div>

      {/* EVM wallet */}
      <div className="card-flat flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="stat-label">EVM wallet</span>
          {evm.account && (
            <button onClick={evm.disconnect} className="text-[11px] text-brand-muted hover:text-white">Disconnect</button>
          )}
        </div>
        {evm.account ? (
          <div className="flex items-center gap-2 text-sm text-white">
            {evm.active && <img src={evm.active.info.icon} alt="" className="w-4 h-4" />}
            <span className="font-mono">{evm.account.slice(0, 6)}…{evm.account.slice(-4)}</span>
          </div>
        ) : evm.wallets.length === 0 ? (
          <p className="text-xs text-brand-muted">No EVM wallet detected in this browser (MetaMask, Rabby, Phantom…).</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {evm.wallets.map((w) => (
              <button key={w.info.uuid} onClick={() => evm.connect(w).catch((e) => setError(errorText(e)))} className="btn-secondary !px-3 !py-1.5 !text-xs">
                <img src={w.info.icon} alt="" className="w-4 h-4" /> {w.info.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Route */}
      <div className="card-flat flex flex-col gap-3">
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <ChainField label="From" chain={srcChain} evmChain={evmChain} setEvmChain={setEvmChain} disabled={busy} />
          <span className="pb-2.5 text-brand-muted">→</span>
          <ChainField label="To" chain={dstChain} evmChain={evmChain} setEvmChain={setEvmChain} disabled={busy} />
        </div>

        <div className="flex flex-col gap-1">
          <span className="stat-label">Token</span>
          <select
            className="input cursor-pointer"
            value={routeIdx}
            disabled={busy || available.length === 0}
            onChange={(e) => setRouteIdx(Number(e.target.value))}
          >
            {available.map((r, i) => (
              <option key={`${r.src.address}-${r.dst.address}`} value={i}>
                {r.src.symbol === r.dst.symbol ? r.src.symbol : `${r.src.symbol} → ${r.dst.symbol}`}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="stat-label">Amount</span>
            {route && balance !== null && (
              <button
                disabled={busy}
                onClick={() => setAmount(formatUnits(balance, route.src.decimals))}
                className="text-[11px] text-brand-muted hover:text-brand-green"
              >
                Balance {fmt(balance, route.src.decimals)} {route.src.symbol} · Max
              </button>
            )}
          </div>
          <input
            className="input tabular-nums"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            disabled={busy}
            onChange={(e) => setAmount(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
          />
          {route && limit !== null && (
            <span className="text-[11px] text-brand-muted">
              Route capacity right now: {fmt(limit, route.src.decimals, 2)} {route.src.symbol}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <span className="stat-label">Recipient on {chainLabel(dstChain)}</span>
          {dir === "in" ? (
            <div className="input font-mono text-xs truncate">{solAddr ?? "Connect your Solana wallet"}</div>
          ) : (
            <input
              className="input font-mono text-xs"
              placeholder="0x…"
              value={evmRecipient}
              disabled={busy}
              onChange={(e) => setEvmRecipient(e.target.value)}
            />
          )}
        </div>

        {route && parsed && parsed > 0n && (
          <div className="flex items-center justify-between text-xs text-brand-muted">
            <span>You receive on {chainLabel(dstChain)}</span>
            <span className="text-white font-medium">
              {fmt(parsed, route.src.decimals)} {route.dst.symbol}
              <span className="text-brand-muted font-normal"> · no Soladrome fee</span>
            </span>
          </div>
        )}
      </div>

      {/* Mainnet acknowledgement */}
      <label className="flex gap-2.5 items-start p-3 rounded-xl border border-red-500/30 bg-red-500/5 text-xs text-brand-muted cursor-pointer">
        <input type="checkbox" className="mt-0.5 accent-red-500" checked={ack} disabled={busy} onChange={(e) => setAck(e.target.checked)} />
        <span>
          I understand this bridge runs on <span className="text-red-400 font-semibold">mainnet with real funds</span>, unlike the
          rest of Soladrome (devnet). Tokens arrive on {chainLabel(dstChain)} mainnet and cannot be deposited in Soladrome pools until
          Soladrome launches on mainnet.
        </span>
      </label>

      <button className="btn-primary w-full" disabled={!!blocker || busy} onClick={execute}>
        {busy ? "Working…" : blocker ?? `Bridge ${route?.src.symbol ?? ""} ${dir === "in" ? `from ${evmLabel}` : `to ${evmLabel}`}`}
      </button>

      {busy && <p className="text-xs text-brand-green animate-pulse text-center">{STAGE_LABEL[stage]}</p>}
      {error && <p className="text-xs text-red-400 break-words">{error}</p>}

      {history.length > 0 && <History entries={history} />}
    </div>
  );
}

function ChainField({ label, chain, evmChain, setEvmChain, disabled }: {
  label: string; chain: string; evmChain: EvmChainKey; setEvmChain: (c: EvmChainKey) => void; disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="stat-label">{label}</span>
      {chain === SOLANA ? (
        <div className="input flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: chainColor(SOLANA) }} /> Solana
        </div>
      ) : (
        <select className="input cursor-pointer" value={evmChain} disabled={disabled} onChange={(e) => setEvmChain(e.target.value as EvmChainKey)}>
          {EVM_CHAINS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      )}
    </div>
  );
}

function History({ entries }: { entries: HistoryEntry[] }) {
  return (
    <div className="card-flat flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-white">Your bridges (this browser)</h3>
      {entries.map((h) => (
        <div key={h.at} className="flex items-center justify-between gap-2 p-2.5 rounded-xl border border-brand-border bg-brand-dark/40 text-xs">
          <div className="flex items-center gap-1.5 min-w-0 text-brand-muted">
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: chainColor(h.srcChain) }} />
            {chainLabel(h.srcChain)} <span className="opacity-50">→</span>
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: chainColor(h.dstChain) }} />
            {chainLabel(h.dstChain)}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-white font-medium">{h.amount} {h.symbol}</span>
            <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase ${
              h.status === "done" ? "bg-brand-green/20 text-brand-green" :
              h.status === "failed" ? "bg-red-500/20 text-red-400" : "bg-yellow-500/20 text-yellow-400"
            }`} title={h.error}>{h.status}</span>
            {h.srcTx && (
              <a href={txUrl(h.srcChain, h.srcTx)} target="_blank" rel="noopener noreferrer" className="text-brand-muted/60 hover:text-brand-green" title="Source transaction">↗</a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
