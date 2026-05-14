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
} from "@/lib/program";
import { getTokenList, symbolByMint, WSOL_MINT } from "@/lib/tokens";
import { useSoladrome } from "@/lib/SoladromeContext";

const LP_DEAD = new PublicKey("11111111111111111111111111111111");
const PCT = [25, 50, 75, 100] as const;

type Tab = "pools" | "add" | "remove" | "create";

interface PoolInfo {
  address:  string;
  mintA:    string;
  mintB:    string;
  reserveA: number;
  reserveB: number;
  feeRate:  number;
  totalLp:  number;
}

function numInput(v: string, set: (s: string) => void) {
  if (v === "" || /^\d*\.?\d*$/.test(v)) set(v);
}

export function Pools() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const tokens = getTokenList(usdcMint);

  const [tab,      setTab]      = useState<Tab>("pools");
  const [pools,    setPools]    = useState<PoolInfo[]>([]);
  const [selected, setSelected] = useState<PoolInfo | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [status,   setStatus]   = useState("");

  // ── Add liquidity state ───────────────────────────────────────────────────
  const [addA, setAddA] = useState("");
  const [addB, setAddB] = useState("");
  const [balA, setBalA] = useState<number | null>(null);
  const [balB, setBalB] = useState<number | null>(null);

  // ── Remove liquidity state ────────────────────────────────────────────────
  const [lpAmt,  setLpAmt]  = useState("");
  const [lpBal,  setLpBal]  = useState<number | null>(null);
  const [retA,   setRetA]   = useState<number | null>(null);
  const [retB,   setRetB]   = useState<number | null>(null);

  // ── Create pool state ─────────────────────────────────────────────────────
  const [newMintA, setNewMintA] = useState(0);
  const [newMintB, setNewMintB] = useState(1);
  const [newFee,   setNewFee]   = useState("30");
  const [newProto, setNewProto] = useState("2000");

  // ── Fetch all pools ───────────────────────────────────────────────────────
  const fetchPools = useCallback(async () => {
    try {
      const provider = new AnchorProvider(connection, wallet ?? ({} as any), {});
      const program  = getProgram(provider);
      const all      = await (program.account as any).ammPool.all();
      setPools(all.map((p: any) => ({
        address:  p.publicKey.toString(),
        mintA:    p.account.tokenAMint.toString(),
        mintB:    p.account.tokenBMint.toString(),
        reserveA: toUi(p.account.reserveA as BN),
        reserveB: toUi(p.account.reserveB as BN),
        feeRate:  p.account.feeRate as number,
        totalLp:  toUi(p.account.totalLp as BN),
      })));
    } catch { /* no pools yet */ }
  }, [connection, wallet]);

  useEffect(() => { fetchPools(); }, [fetchPools]);

  // ── Fetch balances when entering add/remove tab ───────────────────────────
  useEffect(() => {
    if (!wallet || !selected) return;
    const mintAPk = new PublicKey(selected.mintA);
    const mintBPk = new PublicKey(selected.mintB);
    const lpMint  = lpMintPda(new PublicKey(selected.address));

    const fetchBal = async (mint: PublicKey): Promise<number> => {
      try {
        if (mint.toString() === WSOL_MINT) {
          const lamports = await connection.getBalance(wallet.publicKey);
          return lamports / 1e9;
        }
        const ata = userAta(mint, wallet.publicKey);
        const res = await connection.getTokenAccountBalance(ata);
        return res.value.uiAmount ?? 0;
      } catch { return 0; }
    };

    if (tab === "add") {
      fetchBal(mintAPk).then(setBalA);
      fetchBal(mintBPk).then(setBalB);
    }
    if (tab === "remove") {
      fetchBal(lpMint).then(setLpBal);
    }
  }, [tab, selected, wallet, connection]);

  // ── Auto-compute proportional B when A changes ────────────────────────────
  function onChangeA(v: string) {
    numInput(v, setAddA);
    if (!selected || selected.reserveA <= 0 || selected.reserveB <= 0) return;
    const a = parseFloat(v);
    if (!isNaN(a) && a > 0) {
      setAddB((a * selected.reserveB / selected.reserveA).toFixed(6).replace(/\.?0+$/, ""));
    } else {
      setAddB("");
    }
  }

  function onChangeB(v: string) {
    numInput(v, setAddB);
    if (!selected || selected.reserveA <= 0 || selected.reserveB <= 0) return;
    const b = parseFloat(v);
    if (!isNaN(b) && b > 0) {
      setAddA((b * selected.reserveA / selected.reserveB).toFixed(6).replace(/\.?0+$/, ""));
    } else {
      setAddA("");
    }
  }

  function applyPctA(pct: number) {
    if (!balA) return;
    onChangeA(((balA * pct) / 100).toFixed(6).replace(/\.?0+$/, ""));
  }

  // ── Estimate return when LP amount changes ────────────────────────────────
  function onChangeLp(v: string) {
    numInput(v, setLpAmt);
    if (!selected || selected.totalLp <= 0) { setRetA(null); setRetB(null); return; }
    const lp = parseFloat(v);
    if (!isNaN(lp) && lp > 0) {
      setRetA(lp * selected.reserveA / selected.totalLp);
      setRetB(lp * selected.reserveB / selected.totalLp);
    } else {
      setRetA(null); setRetB(null);
    }
  }

  function applyPctLp(pct: number) {
    if (!lpBal) return;
    onChangeLp(((lpBal * pct) / 100).toFixed(6).replace(/\.?0+$/, ""));
  }

  // ── provider helper ───────────────────────────────────────────────────────
  function prov() { return new AnchorProvider(connection, wallet!, {}); }

  // ── Create pool ───────────────────────────────────────────────────────────
  async function createPool() {
    if (!wallet) return;
    setLoading(true); setStatus("");
    try {
      const program     = getProgram(prov());
      const ma          = tokens[newMintA]?.mint;
      const mb          = tokens[newMintB]?.mint;
      if (!ma || !mb || ma === mb) throw new Error("Invalid token pair");
      const [mintAPk, mintBPk] = sortMints(new PublicKey(ma), new PublicKey(mb));
      const poolAddr = poolPda(mintAPk, mintBPk);
      const lpMint   = lpMintPda(poolAddr);

      const tx = await program.methods
        .createPool(+newFee, +newProto)
        .accounts({
          creator:       wallet.publicKey,
          tokenAMint:    mintAPk,
          tokenBMint:    mintBPk,
          pool:          poolAddr,
          lpMint,
          tokenAVault:   vaultAPda(poolAddr),
          tokenBVault:   vaultBPda(poolAddr),
          tokenProgram:  TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent:          commonAccounts.rent,
        } as any)
        .rpc();

      setStatus(`✅ Pool créée — tx: ${tx.slice(0, 16)}…`);
      fetchPools(); setTab("pools");
    } catch (e: any) { setStatus(`❌ ${e?.message ?? e}`); }
    finally { setLoading(false); }
  }

  // ── Add liquidity ─────────────────────────────────────────────────────────
  async function addLiquidity() {
    if (!wallet || !selected || !addA || !addB) return;
    setLoading(true); setStatus("");
    try {
      const program  = getProgram(prov());
      const poolAddr = new PublicKey(selected.address);
      const mintAPk  = new PublicKey(selected.mintA);
      const mintBPk  = new PublicKey(selected.mintB);
      const lpMint   = lpMintPda(poolAddr);
      const userLp   = getAssociatedTokenAddressSync(lpMint, wallet.publicKey);
      const deadLpAta = getAssociatedTokenAddressSync(lpMint, LP_DEAD, true);

      const tx = await program.methods
        .addLiquidity(fromUi(+addA), fromUi(+addB), new BN(0))
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

      setStatus(`✅ Liquidité ajoutée — tx: ${tx.slice(0, 16)}…`);
      setAddA(""); setAddB("");
      fetchPools();
    } catch (e: any) { setStatus(`❌ ${e?.message ?? e}`); }
    finally { setLoading(false); }
  }

  // ── Remove liquidity ──────────────────────────────────────────────────────
  async function removeLiquidity() {
    if (!wallet || !selected || !lpAmt) return;
    setLoading(true); setStatus("");
    try {
      const program  = getProgram(prov());
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

      setStatus(`✅ Liquidité retirée — tx: ${tx.slice(0, 16)}…`);
      setLpAmt(""); setRetA(null); setRetB(null);
      fetchPools();
    } catch (e: any) { setStatus(`❌ ${e?.message ?? e}`); }
    finally { setLoading(false); }
  }

  // ── UI helpers ────────────────────────────────────────────────────────────
  const symA = selected ? symbolByMint(selected.mintA, usdcMint) : "";
  const symB = selected ? symbolByMint(selected.mintB, usdcMint) : "";

  function goTo(p: PoolInfo, t: Tab) {
    setSelected(p); setTab(t); setStatus("");
    setAddA(""); setAddB(""); setLpAmt(""); setRetA(null); setRetB(null);
  }

  return (
    <div className="space-y-4">

      {/* ── Tab bar ───────────────────────────────────────────────── */}
      <div className="flex gap-4 border-b border-brand-border mb-2">
        {(["pools", "create"] as const).map((t) => (
          <button key={t}
            onClick={() => { setTab(t); setStatus(""); }}
            className={`pb-2 text-sm font-semibold uppercase tracking-wide transition-colors ${
              tab === t ? "tab-active" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t === "pools" ? "Pools" : "Créer un pool"}
          </button>
        ))}
      </div>

      {/* ── Pool list ──────────────────────────────────────────────── */}
      {tab === "pools" && (
        <>
          {pools.length === 0 ? (
            <div className="card text-gray-400 text-sm text-center py-8">
              Aucun pool AMM. Crée-en un.
            </div>
          ) : (
            <div className="space-y-3">
              {pools.map((p) => {
                const sA = symbolByMint(p.mintA, usdcMint);
                const sB = symbolByMint(p.mintB, usdcMint);
                const tvl = p.reserveA + p.reserveB;
                return (
                  <div key={p.address} className="card hover:border-brand-green/40 transition-colors">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold text-white text-lg">{sA} / {sB}</span>
                      <span className="text-xs text-gray-400 border border-brand-border rounded px-2 py-0.5">
                        Fee {(p.feeRate / 100).toFixed(2)}%
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center mb-3">
                      <div className="rounded-lg bg-brand-dark p-2">
                        <p className="text-xs text-gray-500 mb-0.5">{sA} reserve</p>
                        <p className="font-mono text-sm text-white">{p.reserveA.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                      </div>
                      <div className="rounded-lg bg-brand-dark p-2">
                        <p className="text-xs text-gray-500 mb-0.5">{sB} reserve</p>
                        <p className="font-mono text-sm text-white">{p.reserveB.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                      </div>
                      <div className="rounded-lg bg-brand-dark p-2">
                        <p className="text-xs text-gray-500 mb-0.5">LP supply</p>
                        <p className="font-mono text-sm text-white">{p.totalLp.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button className="btn-primary text-xs px-3 py-1.5 flex-1"
                        onClick={() => goTo(p, "add")}>+ Add Liquidity</button>
                      <button className="btn-secondary text-xs px-3 py-1.5 flex-1"
                        onClick={() => goTo(p, "remove")}>− Remove</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <button className="text-xs text-brand-green hover:underline" onClick={fetchPools}>
            ↻ Refresh
          </button>
        </>
      )}

      {/* ── Add liquidity ──────────────────────────────────────────── */}
      {tab === "add" && selected && (
        <div className="card glow space-y-4">
          <div className="flex items-center gap-2">
            <button onClick={() => setTab("pools")} className="text-gray-400 hover:text-white text-sm">← Back</button>
            <h2 className="text-lg font-bold text-white">Add Liquidity — {symA}/{symB}</h2>
          </div>

          {/* Token A */}
          <div className="rounded-xl bg-brand-dark border border-brand-border p-4">
            <div className="flex justify-between mb-2">
              <span className="text-xs text-gray-400">{symA}</span>
              {balA !== null && (
                <span className="text-xs text-gray-500">
                  Balance:{" "}
                  <button className="text-gray-300 hover:text-brand-green font-mono"
                    onClick={() => applyPctA(100)}>
                    {balA.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                  </button>
                </span>
              )}
            </div>
            <input
              className="w-full bg-transparent text-right text-2xl font-bold text-white placeholder-gray-600 focus:outline-none"
              type="text" inputMode="decimal" placeholder="0"
              value={addA} onChange={(e) => onChangeA(e.target.value)}
            />
            <div className="flex gap-2 mt-3">
              {PCT.map((p) => (
                <button key={p} onClick={() => applyPctA(p)} disabled={!balA}
                  className="flex-1 text-xs py-1 rounded-md border border-brand-border text-gray-400
                             hover:border-brand-green hover:text-brand-green transition-colors
                             disabled:opacity-30 disabled:cursor-not-allowed">
                  {p === 100 ? "Max" : `${p}%`}
                </button>
              ))}
            </div>
          </div>

          {/* Token B */}
          <div className="rounded-xl bg-brand-dark border border-brand-border p-4">
            <div className="flex justify-between mb-2">
              <span className="text-xs text-gray-400">{symB}</span>
              {balB !== null && (
                <span className="text-xs text-gray-500 font-mono">
                  Balance: {balB.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </span>
              )}
            </div>
            <input
              className="w-full bg-transparent text-right text-2xl font-bold text-white placeholder-gray-600 focus:outline-none"
              type="text" inputMode="decimal" placeholder="0"
              value={addB} onChange={(e) => onChangeB(e.target.value)}
            />
            {selected.reserveA > 0 && (
              <p className="text-xs text-gray-500 mt-2 text-right">
                Ratio actuel : 1 {symA} = {(selected.reserveB / selected.reserveA).toFixed(4)} {symB}
              </p>
            )}
          </div>

          <button className="btn-primary w-full" onClick={addLiquidity}
            disabled={loading || !addA || !addB}>
            {loading ? "Processing…" : "Add Liquidity"}
          </button>
          {status && <p className="text-xs text-gray-400 break-all">{status}</p>}
        </div>
      )}

      {/* ── Remove liquidity ───────────────────────────────────────── */}
      {tab === "remove" && selected && (
        <div className="card glow space-y-4">
          <div className="flex items-center gap-2">
            <button onClick={() => setTab("pools")} className="text-gray-400 hover:text-white text-sm">← Back</button>
            <h2 className="text-lg font-bold text-white">Remove Liquidity — {symA}/{symB}</h2>
          </div>

          {/* LP input */}
          <div className="rounded-xl bg-brand-dark border border-brand-border p-4">
            <div className="flex justify-between mb-2">
              <span className="text-xs text-gray-400">LP tokens à brûler</span>
              {lpBal !== null && (
                <span className="text-xs text-gray-500">
                  Balance:{" "}
                  <button className="text-gray-300 hover:text-brand-green font-mono"
                    onClick={() => applyPctLp(100)}>
                    {lpBal.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                  </button>
                </span>
              )}
            </div>
            <input
              className="w-full bg-transparent text-right text-2xl font-bold text-white placeholder-gray-600 focus:outline-none"
              type="text" inputMode="decimal" placeholder="0"
              value={lpAmt} onChange={(e) => onChangeLp(e.target.value)}
            />
            <div className="flex gap-2 mt-3">
              {PCT.map((p) => (
                <button key={p} onClick={() => applyPctLp(p)} disabled={!lpBal}
                  className="flex-1 text-xs py-1 rounded-md border border-brand-border text-gray-400
                             hover:border-brand-green hover:text-brand-green transition-colors
                             disabled:opacity-30 disabled:cursor-not-allowed">
                  {p === 100 ? "Max" : `${p}%`}
                </button>
              ))}
            </div>
          </div>

          {/* Estimated return */}
          {retA !== null && retB !== null && (
            <div className="rounded-xl border border-brand-border p-4 space-y-2">
              <p className="text-xs text-gray-400 mb-1">Vous recevrez (estimé)</p>
              <div className="flex justify-between">
                <span className="text-sm text-white font-bold">{symA}</span>
                <span className="font-mono text-brand-green">{retA.toFixed(6)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-white font-bold">{symB}</span>
                <span className="font-mono text-brand-green">{retB.toFixed(6)}</span>
              </div>
            </div>
          )}

          <button className="btn-primary w-full" onClick={removeLiquidity}
            disabled={loading || !lpAmt}>
            {loading ? "Processing…" : "Remove Liquidity"}
          </button>
          {status && <p className="text-xs text-gray-400 break-all">{status}</p>}
        </div>
      )}

      {/* ── Create pool ────────────────────────────────────────────── */}
      {tab === "create" && (
        <div className="card glow space-y-4">
          <h2 className="text-lg font-bold text-white">Créer un pool AMM</h2>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-gray-400 mb-1 block">Token A</label>
              <select className="input w-full" value={newMintA}
                onChange={(e) => setNewMintA(+e.target.value)}>
                {tokens.map((t, i) => (
                  <option key={i} value={i} disabled={i === newMintB} className="bg-gray-900">{t.symbol}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-400 mb-1 block">Token B</label>
              <select className="input w-full" value={newMintB}
                onChange={(e) => setNewMintB(+e.target.value)}>
                {tokens.map((t, i) => (
                  <option key={i} value={i} disabled={i === newMintA} className="bg-gray-900">{t.symbol}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-gray-400 mb-1 block">Swap fee</label>
              <input className="input w-full" type="text" inputMode="decimal"
                value={newFee} onChange={(e) => numInput(e.target.value, setNewFee)} />
              <span className="text-xs text-gray-500">{(+newFee / 100).toFixed(2)}%</span>
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-400 mb-1 block">Protocol share (% de la fee)</label>
              <input className="input w-full" type="text" inputMode="decimal"
                value={newProto} onChange={(e) => numInput(e.target.value, setNewProto)} />
              <span className="text-xs text-gray-500">{(+newProto / 100).toFixed(0)}%</span>
            </div>
          </div>

          <button className="btn-primary w-full" onClick={createPool}
            disabled={loading || !wallet || newMintA === newMintB}>
            {loading ? "Processing…" : "Créer le pool"}
          </button>
          {status && <p className="text-xs text-gray-400 break-all">{status}</p>}
        </div>
      )}
    </div>
  );
}
