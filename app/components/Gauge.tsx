// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getProgram, fromUi, toUi } from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";
import { currentEpoch, epochLabel } from "@/lib/epoch";

// ── PDA helpers ───────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], PROGRAM_ID);
function epochBuf(epoch: number) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(epoch >>> 0, 0);
  b.writeUInt32LE(Math.floor(epoch / 2 ** 32), 4);
  return b;
}
function bribeVaultPda(pool: PublicKey, mint: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bribe_vault"), pool.toBuffer(), mint.toBuffer(), epochBuf(epoch)], PROGRAM_ID)[0];
}
function bribeTokensPda(pool: PublicKey, mint: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bribe_tokens"), pool.toBuffer(), mint.toBuffer(), epochBuf(epoch)], PROGRAM_ID)[0];
}
function gaugePda(pool: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("gauge"), pool.toBuffer(), epochBuf(epoch)], PROGRAM_ID)[0];
}


// ── Component ─────────────────────────────────────────────────────────────────
export function Gauge() {
  const { connection } = useConnection();
  const wallet         = useAnchorWallet();
  const { usdcMint }   = useSoladrome();

  const [poolId,     setPoolId]     = useState("");
  const [rewardMint, setRewardMint] = useState("");
  const [amount,     setAmount]     = useState("");
  const [loading,    setLoading]    = useState(false);
  const [status,     setStatus]     = useState("");
  const [pools,      setPools]      = useState<{ address: string; label: string }[]>([]);
  const [copied,     setCopied]     = useState<string | null>(null);
  const [mintBalance, setMintBalance] = useState<number | null>(null);
  // Existing bribe vault info for current (pool, mint, epoch)
  const [existingBribe, setExistingBribe] = useState<number | null>(null);
  const [gaugeVotesInfo, setGaugeVotesInfo] = useState<number | null>(null);

  // ── Known protocol tokens ──────────────────────────────────────────────────
  const knownTokens = [
    { symbol: "oSOLA", mint: "2rAqBLBi2Fjdjqf5za7uzpbYgNiVV74XMDKQ5RdMuEJT", color: "#bbf7d0" },
    { symbol: "SOLA",  mint: "HENFwJCzmBAo2Qybrszr28tqLtEFYkXwN6h87AD5gS9p", color: "#4ade80" },
    { symbol: "hiSOLA",mint: "nc1errcnXjKN4aZYL7AP89op26EMn5a2VcDT82wrTwW",  color: "#86efac" },
    ...(usdcMint ? [{ symbol: "USDC", mint: usdcMint.toBase58(), color: "#2775ca" }] : []),
  ];

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  // ── Fetch existing bribe vault + gauge info when pool / mint / epoch changes ──
  useEffect(() => {
    setExistingBribe(null);
    setGaugeVotesInfo(null);
    if (!poolId || !rewardMint) return;
    let cancelled = false;
    (async () => {
      try {
        const pool = new PublicKey(poolId);
        const mint = new PublicKey(rewardMint);
        const ep   = currentEpoch();
        const eb   = epochBuf(ep);

        // Bribe vault
        const [bribeVaultPdaKey] = PublicKey.findProgramAddressSync(
          [Buffer.from("bribe_vault"), pool.toBuffer(), mint.toBuffer(), eb], PROGRAM_ID
        );
        const bribeInfo = await connection.getAccountInfo(bribeVaultPdaKey);
        if (!cancelled && bribeInfo) {
          const raw = bribeInfo.data.readBigUInt64LE(80);
          setExistingBribe(Number(raw) / 1e6);
        }

        // Gauge state
        const [gaugePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("gauge"), pool.toBuffer(), eb], PROGRAM_ID
        );
        const gaugeInfo = await connection.getAccountInfo(gaugePda);
        if (!cancelled && gaugeInfo) {
          const raw = gaugeInfo.data.readBigUInt64LE(48);
          setGaugeVotesInfo(Number(raw) / 1e6);
        }
      } catch { /* not yet initialized */ }
    })();
    return () => { cancelled = true; };
  }, [poolId, rewardMint, connection]);

  // ── Fetch wallet balance for selected reward mint ──────────────────────────
  useEffect(() => {
    setMintBalance(null);
    if (!wallet || !rewardMint) return;
    let mint: PublicKey;
    try { mint = new PublicKey(rewardMint); } catch { return; }
    const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
    connection.getTokenAccountBalance(ata)
      .then((r) => setMintBalance(toUi(new BN(r.value.amount))))
      .catch(() => setMintBalance(0));
  }, [wallet, rewardMint, connection]);

  // ── Fetch existing AMM pools for pool selector ────────────────────────────
  useState(() => {
    const provider = new AnchorProvider(connection, wallet ?? ({} as any), {});
    const program  = getProgram(provider);
    (program.account as any).ammPool.all().then((all: any[]) => {
      const list = all.map((p: any) => {
        const mA = p.account.tokenAMint.toString().slice(0, 4) + "…";
        const mB = p.account.tokenBMint.toString().slice(0, 4) + "…";
        // Match against known tokens for readable label
        const symA = knownTokens.find(t => t.mint === p.account.tokenAMint.toString())?.symbol ?? mA;
        const symB = knownTokens.find(t => t.mint === p.account.tokenBMint.toString())?.symbol ?? mB;
        return { address: p.publicKey.toString(), label: `${symA}/${symB}` };
      });
      setPools(list);
    }).catch(() => {});
  });

  function parsePool(): PublicKey | null { try { return new PublicKey(poolId); } catch { return null; } }
  function parseMint(): PublicKey | null { try { return new PublicKey(rewardMint); } catch { return null; } }

  // ── Deposit bribe ────────────────────────────────────────────────────────────
  async function depositBribe() {
    if (!wallet || !amount) return;
    const pool = parsePool(); const mint = parseMint();
    if (!pool || !mint) { setStatus("❌ Invalid pool or mint address"); return; }
    setLoading(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const ep = currentEpoch(); // recalculate just before tx, never stale
      const depositorToken  = getAssociatedTokenAddressSync(mint, wallet.publicKey);
      const bribeVault      = bribeVaultPda(pool, mint, ep);
      const bribeTokenVault = bribeTokensPda(pool, mint, ep);
      const tx = await program.methods
        .depositBribe(new BN(ep), fromUi(+amount))
        .accounts({
          depositor: wallet.publicKey, poolId: pool, rewardMint: mint,
          depositorToken, bribeVault, bribeTokenVault,
          protocolState: statePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any).rpc();
      setStatus(`✅ Bribe deposited — tx: ${tx.slice(0, 16)}…`);
      setAmount("");
    } catch (e: any) { setStatus(`❌ ${e?.message ?? e}`); }
    finally { setLoading(false); }
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-white">Bribes</h2>
        <span className="text-[10px] text-gray-500 border border-gray-700 rounded px-2 py-0.5 uppercase tracking-widest">
          {epochLabel(currentEpoch())}
        </span>
      </div>


      {/* ── Token reference panel ── */}
      <div className="mb-4">
        <p className="text-xs text-gray-500 mb-2 uppercase tracking-widest">Protocol tokens</p>
        <div className="grid grid-cols-2 gap-2">
          {knownTokens.map((tok) => (
            <div key={tok.mint}
              className="flex items-center justify-between rounded border border-brand-border bg-brand-bg px-2 py-1.5 gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: tok.color }} />
                <span className="text-xs font-semibold text-gray-200 flex-shrink-0">{tok.symbol}</span>
                <span className="text-[10px] text-gray-600 font-mono truncate">
                  {tok.mint.slice(0, 6)}…{tok.mint.slice(-4)}
                </span>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button
                  onClick={() => copyToClipboard(tok.mint, `copy-${tok.mint}`)}
                  title="Copy address"
                  className="text-[10px] px-1.5 py-0.5 rounded border border-brand-border text-gray-500 hover:text-gray-200 hover:border-gray-500 transition-colors">
                  {copied === `copy-${tok.mint}` ? "✓" : "⎘"}
                </button>
                <button
                  onClick={() => setRewardMint(tok.mint)}
                  title="Use as bribe token"
                  className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                    rewardMint === tok.mint
                      ? "border-brand-green text-brand-green"
                      : "border-brand-border text-gray-500 hover:text-gray-200 hover:border-gray-500"
                  }`}>
                  {rewardMint === tok.mint ? "✓ Sel." : "Sel."}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Pool selector ── */}
      <div className="mb-4">
        <label className="text-xs text-gray-400 mb-1 block">Pool / Gauge</label>
        {pools.length > 0 ? (
          <select
            className="input"
            value={poolId}
            onChange={(e) => setPoolId(e.target.value)}>
            <option value="">— Select a pool —</option>
            {pools.map((p) => (
              <option key={p.address} value={p.address}>{p.label}</option>
            ))}
          </select>
        ) : (
          <input className="input" placeholder="Target pool address"
            value={poolId} onChange={(e) => setPoolId(e.target.value)} />
        )}
        {poolId && (
          <div className="flex items-center gap-1 mt-1">
            <span className="text-[10px] text-gray-600 font-mono truncate flex-1">
              {poolId.slice(0, 12)}…{poolId.slice(-8)}
            </span>
            <button
              onClick={() => copyToClipboard(poolId, "pool")}
              className="text-[10px] px-1.5 py-0.5 rounded border border-brand-border text-gray-500 hover:text-gray-200 transition-colors">
              {copied === "pool" ? "✓" : "⎘"}
            </button>
          </div>
        )}
      </div>

      {/* ── Reward mint (manual fallback) ── */}
      <div className="mb-4">
        <label className="text-xs text-gray-400 mb-1 block">Bribe token (mint)</label>
        <input className="input"
          placeholder="Select above or paste an address"
          value={rewardMint} onChange={(e) => setRewardMint(e.target.value)} />
      </div>

      {/* ── Deposit ── */}
      {/* Live bribe vault + gauge info */}
      {poolId && rewardMint && (existingBribe !== null || gaugeVotesInfo !== null) && (
        <div className="rounded-lg bg-brand-dark border border-brand-border px-3 py-2 mb-3 text-xs flex gap-4">
          {gaugeVotesInfo !== null && (
            <span className="text-gray-400">
              🗳 Votes this epoch:{" "}
              <span className="text-white font-mono">
                {gaugeVotesInfo.toLocaleString(undefined, { maximumFractionDigits: 2 })} hiSOLA
              </span>
            </span>
          )}
          {existingBribe !== null ? (
            <span className="text-gray-400">
              🎁 Bribe already deposited:{" "}
              <span className="text-brand-green font-mono font-semibold">
                {existingBribe.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
              {" "}— your deposit will be added on top
            </span>
          ) : (
            <span className="text-gray-600 italic">No bribe yet for this epoch · you would be the first</span>
          )}
        </div>
      )}

      <p className="text-xs text-gray-500 mb-4">
        Incentivize hiSOLA holders to vote for your pool. Deposits are additive.
      </p>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs text-gray-400">Amount</label>
        {wallet && rewardMint && (
          <span className="text-xs text-gray-500">
            Balance:{" "}
            <button
              className="text-brand-green hover:underline font-mono"
              onClick={() => mintBalance !== null && setAmount(String(mintBalance))}>
              {mintBalance !== null
                ? mintBalance.toLocaleString(undefined, { maximumFractionDigits: 6 })
                : "…"}
            </button>
          </span>
        )}
      </div>
      <div className="flex gap-2 mb-4">
        <input className="input flex-1" type="number" min="0" placeholder="0.00"
          value={amount} onChange={(e) => setAmount(e.target.value)} />
        {mintBalance !== null && mintBalance > 0 && (
          <button
            className="text-xs px-3 rounded border border-brand-border text-gray-400 hover:text-brand-green hover:border-brand-green transition-colors"
            onClick={() => setAmount(String(mintBalance))}>
            Max
          </button>
        )}
      </div>
      <button className="btn-primary w-full" onClick={depositBribe}
        disabled={loading || !wallet || !amount || !poolId || !rewardMint}>
        {loading ? "Depositing…" : "Deposit bribe"}
      </button>

      {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
    </div>
  );
}