// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getMint,
} from "@solana/spl-token";
import {
  getProgram, fromUiDecimals, toUiDecimals, sendTx, getMintProgram, userAtaAuto,
  solaM, oSolaM,
} from "@/lib/program";
import { symbolByMint, isPoolTrusted } from "@/lib/tokens";
import { useSoladrome } from "@/lib/SoladromeContext";
import { currentEpoch, epochLabel } from "@/lib/epoch";
import { StatusBanner } from "./ui/StatusBanner";
import { EmptyState } from "./ui/EmptyState";
import { ButtonHint } from "./ui/ButtonHint";

// ── PDA helpers ───────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");
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

  // ── Rollover state ────────────────────────────────────────────────────────
  const [rolloverEpoch, setRolloverEpoch] = useState("");
  const [rolloverPool,  setRolloverPool]  = useState("");
  const [rolloverMint,  setRolloverMint]  = useState("");
  const [rolloverLoading, setRolloverLoading] = useState(false);
  const [rolloverStatus,  setRolloverStatus]  = useState("");

  const [poolId,     setPoolId]     = useState("");
  const [rewardMint, setRewardMint] = useState("");
  const [amount,     setAmount]     = useState("");
  const [loading,    setLoading]    = useState(false);
  const [status,     setStatus]     = useState("");
  const [pools,      setPools]      = useState<{ address: string; label: string }[]>([]);
  const [copied,     setCopied]     = useState<string | null>(null);
  const [mintBalance, setMintBalance] = useState<{ raw: bigint; decimals: number } | null>(null);
  // Decimals of the selected bribe mint, read from the mint account itself.
  const [rewardDecimals, setRewardDecimals] = useState<number | null>(null);
  // Every SPL / Token-2022 mint the connected wallet actually holds.
  const [walletTokens, setWalletTokens] =
    useState<{ mint: string; symbol: string; raw: bigint; decimals: number }[]>([]);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletNonce,   setWalletNonce]   = useState(0);
  // Existing bribe vault info for current (pool, mint, epoch)
  const [existingBribe, setExistingBribe] = useState<bigint | null>(null);
  const [gaugeVotesInfo, setGaugeVotesInfo] = useState<number | null>(null);

  // ── Known protocol tokens ──────────────────────────────────────────────────
  //
  // ☢️ These three were hardcoded until 2026-09-15, and all three were the *pre-rotation*
  // mints — `2rAqBLBi…` / `HENFwJCz…` / `nc1errcn…` belong to the program ID burned on
  // 2026-08-08. Selecting one set a reward mint that does not exist under `DgD37Vjs…`, so its
  // ATA could not be derived, the balance read threw, and the panel rendered a permanent 0.
  // The same stale list was the pool selector's label table, which is why a USDC/SOLA pool
  // showed as `USDC/CaGH…`. Derive them, never retype them.
  //
  // hiSOLA is deliberately absent: since 2026-08-21 it is a position (`UserPosition.hi_sola`),
  // not a mint. There is no ATA to debit, so it can never be a bribe token — offering it was
  // an invitation to send tokens to an orphaned mint.
  const knownTokens = [
    { symbol: "oSOLA", mint: oSolaM.toBase58(), color: "#bbf7d0" },
    { symbol: "SOLA",  mint: solaM.toBase58(),  color: "#4ade80" },
    ...(usdcMint ? [{ symbol: "USDC", mint: usdcMint.toBase58(), color: "#2775ca" }] : []),
  ];

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  // ── Fetch the decimals of the selected bribe mint ───────────────────────────
  //
  // Read from the mint, never assumed. `fromUi`/`toUi` are pinned to the protocol's 6, and the
  // bribe mint is the one place a third-party mint reaches this screen: the xStocks are 8, so a
  // 6-decimal conversion deposited 1/100th of the amount typed and displayed a balance 100×
  // too large. Everything below converts through this number.
  useEffect(() => {
    setRewardDecimals(null);
    if (!rewardMint) return;
    let mint: PublicKey;
    try { mint = new PublicKey(rewardMint); } catch { return; }
    let cancelled = false;
    getMintProgram(connection, mint)
      .then((prog) => getMint(connection, mint, undefined, prog))
      .then((info) => { if (!cancelled) setRewardDecimals(info.decimals); })
      .catch(() => { /* mint not found — deposit stays disabled */ });
    return () => { cancelled = true; };
  }, [rewardMint, connection]);

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
        // Offset 80 = `BribeVault.total_bribed` (8 discriminator + 32 pool_id + 32 reward_mint
        // + 8 epoch). It is denominated in the reward mint, so it is scaled at render time by
        // `rewardDecimals` — not here, and never by 1e6.
        const bribeInfo = await connection.getAccountInfo(bribeVaultPdaKey);
        if (!cancelled && bribeInfo) {
          setExistingBribe(bribeInfo.data.readBigUInt64LE(80));
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
    let cancelled = false;
    // `rewardMint` is whatever the depositor typed, so it can be Token-2022. The deposit path
    // below already derives its ATA under `rewardProgram`; this read did not, and showed a
    // zero balance for a bribe token sitting in the wallet.
    userAtaAuto(connection, mint, wallet.publicKey)
      .then((ata) => connection.getTokenAccountBalance(ata))
      .then((r) => {
        if (!cancelled) setMintBalance({ raw: BigInt(r.value.amount), decimals: r.value.decimals });
      })
      .catch(() => { if (!cancelled) setMintBalance(null); });
    return () => { cancelled = true; };
  }, [wallet, rewardMint, connection, walletNonce]);

  // ── Scan the wallet for anything it can actually bribe with ────────────────
  //
  // The panel above only knows the protocol's own three mints, so until now the only way to
  // bribe with an xStock was to paste its mint by hand — and nothing on screen said which
  // stocks the wallet even held. Both token programs are queried: the xStocks are Token-2022
  // and `getParsedTokenAccountsByOwner` is scoped to one program per call.
  useEffect(() => {
    setWalletTokens([]);
    if (!wallet) return;
    let cancelled = false;
    setWalletLoading(true);
    Promise.all([
      connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID }),
      connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
    ])
      .then(([spl, t22]) => {
        // Base units, never `uiAmount`: a ScaledUiAmountConfig mint (allowed by
        // `token_ext::require_supported_mint`) reports a *scaled* uiAmount, while
        // `deposit_bribe` books the raw amount. Showing the scaled figure would put a number
        // in the Amount field that is not the number the program receives.
        const byMint = new Map<string, { raw: bigint; decimals: number }>();
        for (const { account } of [...spl.value, ...t22.value]) {
          const info = account.data.parsed?.info;
          if (!info) continue;
          const raw = BigInt(info.tokenAmount.amount);
          if (raw === 0n) continue;
          const prev = byMint.get(info.mint);
          byMint.set(info.mint, {
            raw: (prev?.raw ?? 0n) + raw,
            decimals: info.tokenAmount.decimals,
          });
        }
        const rows = [...byMint.entries()]
          .map(([mint, v]) => ({ mint, symbol: symbolByMint(mint, usdcMint), ...v }))
          // Named tokens first, then alphabetically — an unresolved `4xY…` is noise, not a pick.
          .sort((a, b) => {
            const na = a.symbol.endsWith("…") ? 1 : 0;
            const nb = b.symbol.endsWith("…") ? 1 : 0;
            return na - nb || a.symbol.localeCompare(b.symbol);
          });
        if (!cancelled) setWalletTokens(rows);
      })
      .catch(() => { /* RPC hiccup — the manual mint field still works */ })
      .finally(() => { if (!cancelled) setWalletLoading(false); });
    return () => { cancelled = true; };
  }, [wallet, connection, usdcMint, walletNonce]);

  // ── Fetch existing AMM pools for pool selector ────────────────────────────
  //
  // Keyed on `usdcMint`, which arrives asynchronously from `SoladromeContext`. This ran in a
  // `useState` initialiser before, i.e. exactly once on first render — so the labels were built
  // against whatever the registry could resolve at that instant and never rebuilt.
  useEffect(() => {
    const provider = new AnchorProvider(connection, wallet ?? ({} as any), {});
    const program  = getProgram(provider);
    let cancelled = false;
    (program.account as any).ammPool.all().then((all: any[]) => {
      const list = all
        .filter((p: any) =>
          isPoolTrusted(p.account.tokenAMint.toString(), p.account.tokenBMint.toString(), usdcMint))
        .map((p: any) => {
          // The shared registry — it carries the devnet xStock fixtures, wSOL and the derived
          // protocol mints, so `USDC/7Kq6…` reads as `USDC/TSLAx`. Vote.tsx already used it;
          // this screen kept its own stale copy and so disagreed with the page you vote on.
          const symA = symbolByMint(p.account.tokenAMint.toString(), usdcMint);
          const symB = symbolByMint(p.account.tokenBMint.toString(), usdcMint);
          return { address: p.publicKey.toString(), label: `${symA}/${symB}` };
        })
        .sort((a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label));
      if (!cancelled) setPools(list);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [connection, wallet, usdcMint]);

  // ── Base-unit formatting ───────────────────────────────────────────────────
  // Percentages are computed on the raw balance and only then rendered, so "100%" is the
  // balance to the last base unit rather than a float that rounds a digit off the end.
  const fmtRaw = useCallback((raw: bigint, decimals: number): string => {
    if (decimals === 0) return raw.toString();
    const s = raw.toString().padStart(decimals + 1, "0");
    const whole = s.slice(0, s.length - decimals);
    const frac  = s.slice(s.length - decimals).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole;
  }, []);

  function setPercent(pct: number) {
    if (!mintBalance) return;
    setAmount(fmtRaw((mintBalance.raw * BigInt(pct)) / 100n, mintBalance.decimals));
  }

  function parsePool(): PublicKey | null { try { return new PublicKey(poolId); } catch { return null; } }
  function parseMint(): PublicKey | null { try { return new PublicKey(rewardMint); } catch { return null; } }

  // ── Rollover bribe ───────────────────────────────────────────────────────────
  async function rolloverBribe() {
    if (!wallet) return;
    let oldEp: number, pool: PublicKey, mint: PublicKey;
    try {
      oldEp = parseInt(rolloverEpoch);
      pool  = new PublicKey(rolloverPool);
      mint  = new PublicKey(rolloverMint);
    } catch { setRolloverStatus("❌ Invalid epoch / pool / mint"); return; }
    if (isNaN(oldEp) || oldEp <= 0) { setRolloverStatus("❌ Invalid epoch number"); return; }

    setRolloverLoading(true); setRolloverStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const newEp = currentEpoch();

      const oldBribeVault      = bribeVaultPda(pool, mint, oldEp);
      const oldBribeTokenVault = bribeTokensPda(pool, mint, oldEp);
      const oldGaugeState      = gaugePda(pool, oldEp);
      const newBribeVault      = bribeVaultPda(pool, mint, newEp);
      const newBribeTokenVault = bribeTokensPda(pool, mint, newEp);
      const rewardProgram      = await getMintProgram(connection, mint);

      const ix = await program.methods
        .rolloverBribe(new BN(oldEp), new BN(newEp))
        .accounts({
          payer: wallet.publicKey, poolId: pool, rewardMint: mint,
          oldBribeVault, oldBribeTokenVault, oldGaugeState,
          newBribeVault, newBribeTokenVault,
          tokenProgram: rewardProgram,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any).instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setRolloverStatus(`✅ Rolled over to epoch ${newEp} — tx: ${tx.slice(0, 16)}…`);
      setRolloverEpoch(""); setRolloverPool(""); setRolloverMint("");
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.includes("RolloverTooEarly") || msg.includes("6029")) {
        setRolloverStatus("❌ Grace period not passed yet — wait ROLLOVER_DELAY_EPOCHS.");
      } else if (msg.includes("NothingToClaim") || msg.includes("6007")) {
        setRolloverStatus("❌ No tokens remaining in that vault.");
      } else {
        setRolloverStatus(`❌ ${msg}`);
      }
    } finally { setRolloverLoading(false); }
  }

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
      // The reward mint is whatever the briber chose — it may be Token-2022 (USDG, PYUSD, an
      // xStock), which also decides how their ATA is derived.
      const rewardProgram   = await getMintProgram(connection, mint);
      // Re-read the decimals here rather than trusting the state above: the picker can change
      // between the fetch and the click, and a stale 6-vs-8 is a silent 100× on the amount.
      const decimals        = (await getMint(connection, mint, undefined, rewardProgram)).decimals;
      const depositorToken  = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, rewardProgram);
      const bribeVault      = bribeVaultPda(pool, mint, ep);
      const bribeTokenVault = bribeTokensPda(pool, mint, ep);
      const ix = await program.methods
        .depositBribe(new BN(ep), fromUiDecimals(+amount, decimals))
        .accounts({
          depositor: wallet.publicKey, poolId: pool, rewardMint: mint,
          depositorToken, bribeVault, bribeTokenVault,
          protocolState: statePda,
          tokenProgram: rewardProgram,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any).instruction();
      const tx = await sendTx(connection, wallet, [ix]);
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
                <span className="hidden sm:block text-[10px] text-gray-600 font-mono truncate">
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

      {/* ── What the connected wallet can actually bribe with ── */}
      {wallet && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-500 uppercase tracking-widest">In your wallet</p>
            <button
              onClick={() => setWalletNonce((n) => n + 1)}
              title="Refresh wallet balances"
              disabled={walletLoading}
              className="text-[10px] px-1.5 py-0.5 rounded border border-brand-border text-gray-500 hover:text-gray-200 hover:border-gray-500 transition-colors disabled:opacity-40">
              {walletLoading ? "…" : "↻"}
            </button>
          </div>
          {walletTokens.length === 0 ? (
            <p className="text-[11px] text-gray-600 italic">
              {walletLoading ? "Reading token accounts…" : "No token balances found in this wallet."}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {walletTokens.map((tok) => (
                <button
                  key={`w-${tok.mint}`}
                  onClick={() => setRewardMint(tok.mint)}
                  title={tok.mint}
                  className={`flex items-center justify-between rounded border bg-brand-bg px-2 py-1.5 gap-2 text-left transition-colors ${
                    rewardMint === tok.mint
                      ? "border-brand-green"
                      : "border-brand-border hover:border-gray-500"
                  }`}>
                  <span className={`text-xs font-semibold flex-shrink-0 ${
                    rewardMint === tok.mint ? "text-brand-green" : "text-gray-200"
                  }`}>
                    {tok.symbol}
                  </span>
                  <span className="text-[10px] text-gray-500 font-mono truncate">
                    {fmtRaw(tok.raw, tok.decimals)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Pool selector ── */}
      <div className="mb-4">
        <label className="text-xs text-gray-400 mb-1 block">Pool / Gauge</label>
        {pools.length > 0 ? (
          <>
            <select
              className="input"
              value={pools.some((p) => p.address === poolId) ? poolId : ""}
              onChange={(e) => setPoolId(e.target.value)}>
              <option value="">— Select a pool —</option>
              {pools.map((p) => (
                <option key={p.address} value={p.address}>{p.label}</option>
              ))}
            </select>
            {/* The list is filtered to trusted mints, same as Vote — so keep the manual field
                for a pool that is real but not in the registry. */}
            <input className="input mt-2" placeholder="…or paste a pool address"
              value={poolId} onChange={(e) => setPoolId(e.target.value)} />
          </>
        ) : (
          <>
            <input className="input" placeholder="Target pool address"
              value={poolId} onChange={(e) => setPoolId(e.target.value)} />
            <EmptyState title="No AMM pools found yet." hint="Paste a pool address manually, or create the first pool on the Pools page." />
          </>
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
                {rewardDecimals !== null
                  ? toUiDecimals(existingBribe, rewardDecimals)
                      .toLocaleString(undefined, { maximumFractionDigits: 4 })
                  : "…"}
              </span>
              {" "}{symbolByMint(rewardMint, usdcMint)} — your deposit will be added on top
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
              onClick={() => setPercent(100)}>
              {mintBalance
                ? `${fmtRaw(mintBalance.raw, mintBalance.decimals)} ${symbolByMint(rewardMint, usdcMint)}`
                : "…"}
            </button>
          </span>
        )}
      </div>
      <input
        className={`input w-full ${mintBalance && mintBalance.raw > 0n ? "mb-2" : "mb-4"}`}
        type="number" min="0" placeholder="0.00"
        value={amount} onChange={(e) => setAmount(e.target.value)} />
      {mintBalance && mintBalance.raw > 0n && (
        <div className="grid grid-cols-4 gap-2 mb-4">
          {[25, 50, 75, 100].map((pct) => (
            <button
              key={pct}
              onClick={() => setPercent(pct)}
              className="text-xs py-1.5 rounded border border-brand-border text-gray-400 hover:text-brand-green hover:border-brand-green transition-colors">
              {pct === 100 ? "Max" : `${pct}%`}
            </button>
          ))}
        </div>
      )}
      <button className="btn-primary w-full" onClick={depositBribe}
        disabled={loading || !wallet || !amount || !poolId || !rewardMint || rewardDecimals === null}>
        {loading ? "Depositing…" : "Deposit bribe"}
      </button>
      <ButtonHint
        text={
          !wallet ? "Connect your wallet to continue"
          : !poolId ? "Select or paste a pool address"
          : !rewardMint ? "Select or paste a bribe token"
          : rewardDecimals === null ? "Reading that mint… (no mint at this address?)"
          : !amount && !loading ? "Enter an amount"
          : null
        }
      />

      <StatusBanner message={status} />

      {/* ── Rollover section ── */}
      <div className="mt-6 border-t border-brand-border pt-5">
        <p className="text-xs text-gray-500 mb-1 uppercase tracking-widest">Rollover unclaimed bribes</p>
        <p className="text-xs text-gray-600 mb-3">
          Move remaining tokens from a past epoch into the current one.
          Pools with zero votes can be rolled immediately; pools with votes require a 2-epoch grace period.
        </p>
        <div className="flex flex-col gap-2 mb-3">
          <input className="input" placeholder="Old epoch number (e.g. 494541)"
            value={rolloverEpoch} onChange={e => setRolloverEpoch(e.target.value)} />
          <input className="input" placeholder="Pool address"
            value={rolloverPool} onChange={e => setRolloverPool(e.target.value)} />
          <input className="input" placeholder="Bribe token mint"
            value={rolloverMint} onChange={e => setRolloverMint(e.target.value)} />
        </div>
        <button
          className="w-full text-sm py-2 rounded-xl border border-brand-border text-gray-400 hover:border-brand-green hover:text-brand-green transition-colors disabled:opacity-30"
          onClick={rolloverBribe}
          disabled={rolloverLoading || !wallet || !rolloverEpoch || !rolloverPool || !rolloverMint}>
          {rolloverLoading ? "Rolling over…" : "↻ Rollover to current epoch"}
        </button>
        <ButtonHint
          text={
            !wallet ? "Connect your wallet to continue"
            : (!rolloverEpoch || !rolloverPool || !rolloverMint) && !rolloverLoading
              ? "Fill in the old epoch, pool address, and bribe token mint"
              : null
          }
        />
        <StatusBanner message={rolloverStatus} />
      </div>
    </div>
  );
}