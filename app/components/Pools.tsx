// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import {
  getProgram, poolPda, lpMintPda, vaultAPda, vaultBPda,
  sortMints, userAta, commonAccounts, fromUi, toUi,
  PROGRAM_ID,
} from "@/lib/program";

import { getTokenList, symbolByMint } from "@/lib/tokens";
import { useSoladrome } from "@/lib/SoladromeContext";

function mintByIndex(tokens: ReturnType<typeof getTokenList>, i: number): string {
  return tokens[i]?.mint ?? "";
}

// Dead pubkey for MINIMUM_LIQUIDITY lock (system program = all zeros)
const LP_DEAD = new PublicKey("11111111111111111111111111111111");

type Tab = "pools" | "add" | "remove" | "create";

interface PoolInfo {
  address: string;
  mintA: string;
  mintB: string;
  reserveA: number;
  reserveB: number;
  feeRate: number;
  totalLp: number;
}

export function Pools() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const tokens = getTokenList(usdcMint);

  const [tab, setTab] = useState<Tab>("pools");
  const [pools, setPools]  = useState<PoolInfo[]>([]);
  const [selected, setSelected] = useState<PoolInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  // ── Add liquidity form ────────────────────────────────────────────────────
  const [addA, setAddA] = useState("");
  const [addB, setAddB] = useState("");
  const [minLp, setMinLp] = useState("0");

  // ── Remove liquidity form ─────────────────────────────────────────────────
  const [lpAmt, setLpAmt] = useState("");

  // ── Create pool form ──────────────────────────────────────────────────────
  const [newMintA, setNewMintA] = useState(0);
  const [newMintB, setNewMintB] = useState(1);
  const [newFee,   setNewFee]   = useState("30");   // bps
  const [newProto, setNewProto] = useState("2000"); // bps of fee

  // ── Fetch all AMM pools ───────────────────────────────────────────────────
  const fetchPools = useCallback(async () => {
    try {
      const provider = new AnchorProvider(connection, wallet ?? ({} as any), {});
      const program  = getProgram(provider);
      const allPools = await (program.account as any).ammPool.all();

      setPools(allPools.map((p: any) => ({
        address:  p.publicKey.toString(),
        mintA:    p.account.tokenAMint.toString(),
        mintB:    p.account.tokenBMint.toString(),
        reserveA: toUi(p.account.reserveA as BN),
        reserveB: toUi(p.account.reserveB as BN),
        feeRate:  p.account.feeRate as number,
        totalLp:  toUi(p.account.totalLp as BN),
      })));
    } catch {
      /* no pools yet */
    }
  }, [connection, wallet]);

  useEffect(() => { fetchPools(); }, [fetchPools]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  function provider() {
    return new AnchorProvider(connection, wallet!, {});
  }

  // ── Create pool ───────────────────────────────────────────────────────────
  async function createPool() {
    if (!wallet) return;
    setLoading(true); setStatus("");
    try {
      const program  = getProgram(provider());
      const ma       = mintByIndex(tokens, newMintA);
      const mb       = mintByIndex(tokens, newMintB);
      if (!ma || !mb || ma === mb) throw new Error("Invalid token pair");

      const [mintAPk, mintBPk] = sortMints(new PublicKey(ma), new PublicKey(mb));
      const poolAddr = poolPda(mintAPk, mintBPk);
      const lpMint   = lpMintPda(poolAddr);
      const vaultA   = vaultAPda(poolAddr);
      const vaultB   = vaultBPda(poolAddr);

      const tx = await program.methods
        .createPool(+newFee, +newProto)
        .accounts({
          creator:      wallet.publicKey,
          tokenAMint:   mintAPk,
          tokenBMint:   mintBPk,
          pool:         poolAddr,
          lpMint,
          tokenAVault:  vaultA,
          tokenBVault:  vaultB,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent:         commonAccounts.rent,
        } as any)
        .rpc();

      setStatus(`✅ Pool created — tx: ${tx.slice(0, 16)}…`);
      fetchPools();
      setTab("pools");
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  // ── Add liquidity ─────────────────────────────────────────────────────────
  async function addLiquidity() {
    if (!wallet || !selected) return;
    setLoading(true); setStatus("");
    try {
      const program  = getProgram(provider());
      const poolAddr = new PublicKey(selected.address);
      const mintAPk  = new PublicKey(selected.mintA);
      const mintBPk  = new PublicKey(selected.mintB);
      const lpMint   = lpMintPda(poolAddr);

      const userLp    = getAssociatedTokenAddressSync(lpMint, wallet.publicKey);
      const deadLpAta = getAssociatedTokenAddressSync(lpMint, LP_DEAD, true);

      const tx = await program.methods
        .addLiquidity(fromUi(+addA), fromUi(+addB), fromUi(+minLp))
        .accounts({
          user:                   wallet.publicKey,
          pool:                   poolAddr,
          lpMint,
          tokenAVault:            vaultAPda(poolAddr),
          tokenBVault:            vaultBPda(poolAddr),
          userTokenA:             userAta(mintAPk, wallet.publicKey),
          userTokenB:             userAta(mintBPk, wallet.publicKey),
          userLp,
          lpDeadAta:              deadLpAta,
          lpDead:                 LP_DEAD,
          tokenProgram:           TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram:          SystemProgram.programId,
        } as any)
        .rpc();

      setStatus(`✅ Liquidity added — tx: ${tx.slice(0, 16)}…`);
      fetchPools();
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  // ── Remove liquidity ──────────────────────────────────────────────────────
  async function removeLiquidity() {
    if (!wallet || !selected || !lpAmt) return;
    setLoading(true); setStatus("");
    try {
      const program  = getProgram(provider());
      const poolAddr = new PublicKey(selected.address);
      const mintAPk  = new PublicKey(selected.mintA);
      const mintBPk  = new PublicKey(selected.mintB);
      const lpMint   = lpMintPda(poolAddr);

      const tx = await program.methods
        .removeLiquidity(fromUi(+lpAmt), new BN(1), new BN(1))
        .accounts({
          user:          wallet.publicKey,
          pool:          poolAddr,
          lpMint,
          tokenAVault:   vaultAPda(poolAddr),
          tokenBVault:   vaultBPda(poolAddr),
          userLp:        getAssociatedTokenAddressSync(lpMint, wallet.publicKey),
          userTokenA:    userAta(mintAPk, wallet.publicKey),
          userTokenB:    userAta(mintBPk, wallet.publicKey),
          tokenProgram:  TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        } as any)
        .rpc();

      setStatus(`✅ Liquidity removed — tx: ${tx.slice(0, 16)}…`);
      fetchPools();
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex gap-4 border-b border-brand-border mb-2">
        {(["pools", "create"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setStatus(""); }}
            className={`pb-2 text-sm font-semibold uppercase tracking-wide transition-colors ${
              tab === t ? "tab-active" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t === "pools" ? "All Pools" : "Create Pool"}
          </button>
        ))}
      </div>

      {/* ── Pool list ─────────────────────────────────────────────── */}
      {tab === "pools" && (
        <>
          {pools.length === 0 ? (
            <div className="card text-gray-400 text-sm text-center py-8">
              No AMM pools found. Create one first.
            </div>
          ) : (
            <div className="space-y-3">
              {pools.map((p) => (
                <div key={p.address} className="card hover:border-brand-green/40 transition-colors">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-bold text-white">
                      {symbolByMint(p.mintA, usdcMint)} / {symbolByMint(p.mintB, usdcMint)}
                    </span>
                    <span className="text-xs text-gray-400">Fee: {(p.feeRate / 100).toFixed(2)}%</span>
                  </div>
                  <div className="text-xs text-gray-400 mb-3 flex gap-6">
                    <span>Reserve A: {p.reserveA.toFixed(2)}</span>
                    <span>Reserve B: {p.reserveB.toFixed(2)}</span>
                    <span>LP supply: {p.totalLp.toFixed(2)}</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="btn-primary text-xs px-3 py-1.5"
                      onClick={() => { setSelected(p); setTab("add"); setStatus(""); }}
                    >
                      + Add Liquidity
                    </button>
                    <button
                      className="btn-secondary text-xs px-3 py-1.5"
                      onClick={() => { setSelected(p); setTab("remove"); setStatus(""); }}
                    >
                      − Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <button className="text-xs text-brand-green hover:underline" onClick={fetchPools}>
            ↻ Refresh
          </button>
        </>
      )}

      {/* ── Add liquidity ──────────────────────────────────────────── */}
      {tab === "add" && selected && (
        <div className="card glow">
          <div className="flex items-center gap-2 mb-4">
            <button onClick={() => setTab("pools")} className="text-gray-400 hover:text-white text-sm">← Back</button>
            <h2 className="text-lg font-bold text-white">
              Add Liquidity — {symbolByMint(selected.mintA, usdcMint)}/{symbolByMint(selected.mintB, usdcMint)}
            </h2>
          </div>

          <label className="text-xs text-gray-400 mb-1 block">
            {symbolByMint(selected.mintA, usdcMint)} amount
          </label>
          <input className="input mb-3" type="number" min="0" placeholder="0.00"
            value={addA} onChange={(e) => setAddA(e.target.value)} />

          <label className="text-xs text-gray-400 mb-1 block">
            {symbolByMint(selected.mintB, usdcMint)} amount
          </label>
          <input className="input mb-3" type="number" min="0" placeholder="0.00"
            value={addB} onChange={(e) => setAddB(e.target.value)} />

          <label className="text-xs text-gray-400 mb-1 block">Min LP out (slippage guard)</label>
          <input className="input mb-4" type="number" min="0" placeholder="0"
            value={minLp} onChange={(e) => setMinLp(e.target.value)} />

          <button className="btn-primary w-full" onClick={addLiquidity}
            disabled={loading || !addA || !addB}>
            {loading ? "Processing…" : "Add Liquidity"}
          </button>
          {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
        </div>
      )}

      {/* ── Remove liquidity ───────────────────────────────────────── */}
      {tab === "remove" && selected && (
        <div className="card glow">
          <div className="flex items-center gap-2 mb-4">
            <button onClick={() => setTab("pools")} className="text-gray-400 hover:text-white text-sm">← Back</button>
            <h2 className="text-lg font-bold text-white">
              Remove Liquidity — {symbolByMint(selected.mintA, usdcMint)}/{symbolByMint(selected.mintB, usdcMint)}
            </h2>
          </div>

          <label className="text-xs text-gray-400 mb-1 block">LP tokens to burn</label>
          <input className="input mb-4" type="number" min="0" placeholder="0.00"
            value={lpAmt} onChange={(e) => setLpAmt(e.target.value)} />

          <p className="text-xs text-gray-500 mb-4">
            Your LP balance: — (check wallet) · Pool LP supply: {selected.totalLp.toFixed(2)}
          </p>

          <button className="btn-primary w-full" onClick={removeLiquidity}
            disabled={loading || !lpAmt}>
            {loading ? "Processing…" : "Remove Liquidity"}
          </button>
          {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
        </div>
      )}

      {/* ── Create pool ────────────────────────────────────────────── */}
      {tab === "create" && (
        <div className="card glow">
          <h2 className="text-lg font-bold text-white mb-4">Create AMM Pool</h2>

          <div className="flex gap-3 mb-3">
            <div className="flex-1">
              <label className="text-xs text-gray-400 mb-1 block">Token A</label>
              <select className="input w-full" value={newMintA}
                onChange={(e) => setNewMintA(+e.target.value)}>
                {tokens.map((t, i) => (
                  <option key={i} value={i} disabled={i === newMintB}>{t.symbol}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-400 mb-1 block">Token B</label>
              <select className="input w-full" value={newMintB}
                onChange={(e) => setNewMintB(+e.target.value)}>
                {tokens.map((t, i) => (
                  <option key={i} value={i} disabled={i === newMintA}>{t.symbol}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex gap-3 mb-4">
            <div className="flex-1">
              <label className="text-xs text-gray-400 mb-1 block">Swap fee (bps)</label>
              <input className="input w-full" type="number" min="1" max="1000"
                value={newFee} onChange={(e) => setNewFee(e.target.value)} />
              <span className="text-xs text-gray-500">{(+newFee / 100).toFixed(2)}%</span>
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-400 mb-1 block">Protocol share (bps of fee)</label>
              <input className="input w-full" type="number" min="0" max="5000"
                value={newProto} onChange={(e) => setNewProto(e.target.value)} />
              <span className="text-xs text-gray-500">{(+newProto / 100).toFixed(0)}% of fee</span>
            </div>
          </div>

          <button className="btn-primary w-full" onClick={createPool}
            disabled={loading || !wallet || newMintA === newMintB}>
            {loading ? "Processing…" : "Create Pool"}
          </button>
          {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
        </div>
      )}
    </div>
  );
}
