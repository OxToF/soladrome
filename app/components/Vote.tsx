// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { getProgram, statePda, hiSolaM, userAta, PROGRAM_ID as PROG_ID } from "@/lib/program";
import { symbolByMint, isPoolTrusted } from "@/lib/tokens";
import { useSoladrome } from "@/lib/SoladromeContext";
import { currentEpoch, epochEnd, timeLeft } from "@/lib/epoch";

// ── PDA helpers ───────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
function lockPositionPda(user: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("velock"), user.toBuffer()], PROG_ID
  )[0];
}

const PCT = [25, 50, 75, 100] as const;

export function Vote() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const epoch = currentEpoch();
  const end   = epochEnd(epoch);

  // Known bribe tokens — add any protocol token here for display purposes.
  // Any unlisted mint is shown as a truncated address.
  const knownTokens = [
    { symbol: "oSOLA",   mint: new PublicKey("2rAqBLBi2Fjdjqf5za7uzpbYgNiVV74XMDKQ5RdMuEJT"), color: "#bbf7d0" },
    { symbol: "SOLA",    mint: new PublicKey("HENFwJCzmBAo2Qybrszr28tqLtEFYkXwN6h87AD5gS9p"),  color: "#4ade80" },
    { symbol: "hiSOLA",  mint: new PublicKey("nc1errcnXjKN4aZYL7AP89op26EMn5a2VcDT82wrTwW"),   color: "#86efac" },
    { symbol: "JitoSOL", mint: new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"), color: "#e05c5c" },
    { symbol: "JTO",     mint: new PublicKey("jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL"),  color: "#f97316" },
    { symbol: "JUP",     mint: new PublicKey("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"),  color: "#a78bfa" },
    { symbol: "ORCA",    mint: new PublicKey("orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE"), color: "#36d1dc" },
    { symbol: "MNDE",    mint: new PublicKey("MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTa3CbChoKBRP"), color: "#3b82f6" },
    ...(usdcMint ? [{ symbol: "USDC", mint: usdcMint, color: "#2775ca" }] : []),
  ];

  const [poolId,       setPoolId]       = useState("");
  const [votes,        setVotes]        = useState("");
  const [balance,      setBalance]      = useState<number | null>(null);
  const [allocated,    setAllocated]    = useState<number>(0);   // votes already cast this epoch
  const [oSolaBonus,   setOSolaBonus]   = useState<number>(0);   // voting power from burned oSOLA
  const [powerCap,     setPowerCap]     = useState<number | null>(null);
  const [loading,      setLoading]      = useState(false);
  const [status,       setStatus]       = useState("");
  const [ammPools,     setAmmPools]     = useState<{ label: string; addr: string }[]>([]);
  const [votedPools,   setVotedPools]   = useState<Set<string>>(new Set());
  // Live gauge info for selected pool
  const [gaugeVotes,   setGaugeVotes]   = useState<number | null>(null);
  // All bribe tokens for the selected pool this epoch
  const [bribes, setBribes] = useState<{ symbol: string; amount: number; color: string }[]>([]);

  // Total voting power = hiSOLA cap + oSOLA burn bonus (uncapped).
  // powerCap = 0 means the user burned oSOLA before casting any vote → snapshot
  // not set yet by vote_gauge. In that case, fall back to the live hiSOLA balance
  // so the hiSOLA component isn't lost from the display.
  const hiSolaCap = (powerCap !== null && powerCap > 0)
    ? powerCap                  // snapshotted by vote_gauge on first vote
    : (balance ?? 0);           // not voted yet → use live balance
  const totalPower = hiSolaCap + oSolaBonus;
  const remaining  = Math.max(0, totalPower - allocated);

  const fetchBalance = useCallback(async () => {
    if (!wallet) {
      setBalance(null);
      setAllocated(0); setOSolaBonus(0); setPowerCap(null);
      return;
    }
    // hiSOLA balance
    try {
      const ata  = userAta(hiSolaM, wallet.publicKey);
      const info = await connection.getTokenAccountBalance(ata);
      setBalance(Number(info.value.uiAmount ?? 0));
    } catch { setBalance(0); }

    // Read UserEpochVotes — layout after adding o_sola_bonus field:
    // discriminator(8) + epoch(8) + allocated(8) + total_power_snapshot(8) + o_sola_bonus(8) + bump(1)
    try {
      const ep = currentEpoch();
      const eb = Buffer.alloc(8);
      eb.writeBigUInt64LE(BigInt(ep));
      const [uevPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("uev"), wallet.publicKey.toBuffer(), eb], PROG_ID
      );
      const uevInfo = await connection.getAccountInfo(uevPda);
      console.log("[UEV] pda:", uevPda.toBase58(), "exists:", !!uevInfo, "len:", uevInfo?.data.length);
      if (uevInfo && uevInfo.data.length >= 40) {
        const alloc  = Number(uevInfo.data.readBigUInt64LE(16)) / 1e6;
        const cap    = Number(uevInfo.data.readBigUInt64LE(24)) / 1e6;
        const bonus  = Number(uevInfo.data.readBigUInt64LE(32)) / 1e6;
        console.log("[UEV] alloc:", alloc, "cap:", cap, "bonus:", bonus, "raw@32:", uevInfo.data.readBigUInt64LE(32).toString());
        setAllocated(alloc);
        setPowerCap(cap);
        setOSolaBonus(bonus);
      } else {
        setAllocated(0); setPowerCap(null); setOSolaBonus(0);
      }
    } catch { setAllocated(0); setPowerCap(null); setOSolaBonus(0); }
  }, [connection, wallet]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  // Fetch real AMM pools from chain
  useEffect(() => {
    const provider = new AnchorProvider(connection, wallet ?? ({} as any), {});
    const program  = getProgram(provider);
    (program.account as any).ammPool.all().then((all: any[]) => {
      setAmmPools(
        all
          .filter((p: any) =>
            isPoolTrusted(p.account.tokenAMint.toString(), p.account.tokenBMint.toString(), usdcMint)
          )
          .map((p: any) => {
            const sA = symbolByMint(p.account.tokenAMint.toString(), usdcMint);
            const sB = symbolByMint(p.account.tokenBMint.toString(), usdcMint);
            return { label: `${sA}/${sB}`, addr: p.publicKey.toString() };
          })
      );
    }).catch(() => {});
  }, [connection, wallet, usdcMint]);

  // Check which pools the wallet already voted for this epoch
  const checkVotedPools = useCallback(async () => {
    if (!wallet || ammPools.length === 0) return;
    const ep = currentEpoch();
    const eb = Buffer.alloc(8);
    eb.writeBigUInt64LE(BigInt(ep));
    const voted = new Set<string>();
    await Promise.all(ammPools.map(async (p) => {
      const pool = new PublicKey(p.addr);
      const [receiptPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote"), wallet.publicKey.toBuffer(), pool.toBuffer(), eb], PROG_ID
      );
      const info = await connection.getAccountInfo(receiptPda);
      if (info) voted.add(p.addr);
    }));
    setVotedPools(voted);
  }, [wallet, ammPools, connection]);

  useEffect(() => { checkVotedPools(); }, [checkVotedPools]);

  // Live gauge votes + ALL bribe tokens for the selected pool this epoch
  useEffect(() => {
    setGaugeVotes(null);
    setBribes([]);
    if (!poolId) return;
    let cancelled = false;
    (async () => {
      try {
        const provider = new AnchorProvider(connection, wallet ?? ({} as any), {});
        const program  = getProgram(provider);
        const pool = new PublicKey(poolId);
        const ep   = currentEpoch();
        const eb   = Buffer.alloc(8);
        eb.writeBigUInt64LE(BigInt(ep));

        // Gauge total votes
        const [gaugePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("gauge"), pool.toBuffer(), eb], PROGRAM_ID
        );
        const gaugeInfo = await connection.getAccountInfo(gaugePda);
        if (!cancelled && gaugeInfo) {
          // offset 8 discrim + 32 pool_id + 8 epoch = 48
          setGaugeVotes(Number(gaugeInfo.data.readBigUInt64LE(48)) / 1e6);
        }

        // Scan ALL BribeVault accounts for this pool (memcmp on pool_id at offset 8)
        const vaults: any[] = await (program.account as any).bribeVault.all([
          { memcmp: { offset: 8, bytes: pool.toBase58() } },
        ]);

        if (cancelled) return;

        // Filter to current epoch with a non-zero deposit
        const matching = vaults.filter(
          v => Number(v.account.epoch) === ep && Number(v.account.totalBribed) > 0
        );

        // Map to display objects, resolving symbol from tokens registry
        const result = matching.map(v => {
          const mintStr = (v.account.rewardMint as PublicKey).toBase58();
          const known   = knownTokens.find(t => t.mint.toBase58() === mintStr);
          return {
            symbol: known?.symbol ?? mintStr.slice(0, 6) + "…",
            color:  known?.color  ?? "#888",
            amount: Number(v.account.totalBribed) / 1e6,
          };
        });

        setBribes(result);
      } catch { /* pool not initialised yet */ }
    })();
    return () => { cancelled = true; };
  }, [poolId, connection, wallet]);

  function applyPct(pct: number) {
    if (!remaining || remaining <= 0) return;
    setVotes(((remaining * pct) / 100).toFixed(6).replace(/\.?0+$/, ""));
  }

  function tryPool(): PublicKey | null {
    try { return new PublicKey(poolId); } catch { return null; }
  }

  async function vote() {
    if (!wallet || !votes || !poolId) return;
    const pool = tryPool();
    if (!pool) { setStatus("❌ Invalid pool address"); return; }

    const amt = parseFloat(votes);
    if (isNaN(amt) || amt <= 0) { setStatus("❌ Montant invalide"); return; }

    setLoading(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);

      const ep = currentEpoch(); // recalculate just before tx
      const rawVotes   = new BN(Math.floor(amt * 1_000_000));
      const userHiSola = (await import("@solana/spl-token"))
        .getAssociatedTokenAddressSync(hiSolaM, wallet.publicKey);
      const lockPosition = lockPositionPda(wallet.publicKey);

      const epochBuf = Buffer.alloc(8);
      epochBuf.writeBigUInt64LE(BigInt(ep));

      const [gaugeState] = PublicKey.findProgramAddressSync(
        [Buffer.from("gauge"), pool.toBuffer(), epochBuf], PROG_ID
      );
      const [userVoteReceipt] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote"), wallet.publicKey.toBuffer(), pool.toBuffer(), epochBuf], PROG_ID
      );
      const [userEpochVotes] = PublicKey.findProgramAddressSync(
        [Buffer.from("uev"), wallet.publicKey.toBuffer(), epochBuf], PROG_ID
      );
      const [globalEpochVotes] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_votes"), epochBuf], PROG_ID
      );

      const tx = await program.methods
        .voteGauge(new BN(ep), rawVotes)
        .accounts({
          user:             wallet.publicKey,
          poolId:           pool,
          protocolState:    statePda,
          hiSolaMint:       hiSolaM,
          userHiSola,
          lockPosition,
          gaugeState,
          userVoteReceipt,
          userEpochVotes,
          globalEpochVotes,
          systemProgram:   SystemProgram.programId,
          rent:            SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
      setStatus(`✅ Vote recorded — tx: ${tx.slice(0, 16)}…`);
      setVotes("");
      setVotedPools(prev => new Set([...prev, poolId]));
      // Optimistic update for allocated counter
      setAllocated(prev => prev + parseFloat(votes));
      // Authoritative refresh after RPC propagates
      setTimeout(() => fetchBalance(), 2000);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.includes("already in use") || msg.includes("0x0")) {
        setStatus("✅ Vote already recorded for this pool this epoch.");
        setVotedPools(prev => new Set([...prev, poolId]));
      } else if (msg.includes("VoteOverflow") || msg.includes("6011") ||
                 msg.includes("VoteWeightCapExceeded") || msg.includes("6028")) {
        const rem = remaining.toFixed(4);
        setStatus(`❌ Vote exceeds your remaining power (${rem} hiSOLA left this epoch). Reduce the amount.`);
        fetchBalance(); // refresh allocated count
      } else {
        setStatus(`❌ ${msg}`);
      }
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-6">
      {/* Epoch banner */}
      <div className="card flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-widest">Current epoch</p>
          <p className="text-2xl font-black text-white">#{epoch}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-widest">Ends in</p>
          <p className="text-2xl font-black text-brand-green">{timeLeft(end)}</p>
          <p className="text-xs text-gray-500">{end.toLocaleDateString()}</p>
        </div>
        <div className="text-right hidden md:block">
          <p className="text-xs text-gray-500 mb-2">Mechanism</p>
          <p className="text-xs text-gray-400 max-w-xs">
            Your hiSOLA votes on pools. <br />
            Bribers reward voters of <br />
            the pools they support.
          </p>
        </div>
      </div>

      {/* Voting power summary bar */}
      {(balance !== null || oSolaBonus > 0) && (
        <div className="flex items-center gap-3 text-xs text-gray-500 px-1">
          {balance !== null && <span>hiSOLA: <span className="text-gray-300 font-mono">{balance.toFixed(2)}</span></span>}
          {oSolaBonus > 0 && <span>🔥 Burn bonus: <span className="text-brand-green font-mono">{oSolaBonus.toFixed(2)}</span></span>}
          <span className="ml-auto">Remaining: <span className={`font-mono ${remaining <= 0 ? "text-red-400" : "text-white"}`}>{remaining.toFixed(4)}</span></span>
        </div>
      )}

      <div className="card">
        <h2 className="text-lg font-bold text-white mb-1">Vote for a pool</h2>
        <p className="text-xs text-gray-500 mb-6">
          Vote weight = hiSOLA + oSOLA burn bonus · 1 vote per pool per epoch
        </p>

        {/* AMM pools from chain */}
        <p className="text-xs text-gray-500 mb-2 uppercase tracking-widest">
          Available pools {ammPools.length > 0 ? `(${ammPools.length})` : ""}
        </p>
        {ammPools.length > 0 ? (
          <div className="flex flex-wrap gap-2 mb-5">
            {ammPools.map((s) => {
              const voted = votedPools.has(s.addr);
              return (
                <button
                  key={s.addr}
                  onClick={() => setPoolId(s.addr)}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                    poolId === s.addr
                      ? "border-brand-green text-brand-green bg-brand-green/10"
                      : voted
                      ? "border-brand-green/40 text-brand-green/60"
                      : "border-brand-border text-gray-400 hover:border-gray-500"
                  }`}
                >
                  {voted && <span className="mr-1">✓</span>}
                  {s.label}
                  <span className="ml-1.5 text-gray-600 font-mono">
                    {s.addr.slice(0, 4)}…
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-gray-600 mb-5">Loading pools…</p>
        )}

        <label className="text-xs text-gray-400 mb-1 block">Pool address (Pubkey)</label>
        <input
          className="input mb-4"
          placeholder="Paste the address or select above"
          value={poolId}
          onChange={(e) => setPoolId(e.target.value)}
        />

        <div className="rounded-xl bg-brand-dark border border-brand-border p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-400">hiSOLA to allocate</span>
            <div className="text-right">
              {balance !== null &&(
                <button
                  className="text-gray-300 hover:text-brand-green transition-colors font-mono text-xs"
                  onClick={() => applyPct(100)}
                >
                  Remaining:{" "}
                  <span className={remaining <= 0 ? "text-red-400" : "text-brand-green"}>
                    {remaining.toLocaleString(undefined, { maximumFractionDigits: 4 })} hiSOLA
                  </span>
                </button>
              )}
              {allocated > 0 && (
                <p className="text-[10px] text-gray-600 mt-0.5">
                  {allocated.toLocaleString(undefined, { maximumFractionDigits: 4 })} already allocated this epoch
                </p>
              )}
            </div>
          </div>
          <input
            className="w-full bg-transparent text-right text-2xl font-bold text-white placeholder-gray-600 focus:outline-none mb-3"
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={votes}
            onChange={(e) => setVotes(e.target.value)}
          />
          <div className="flex gap-2">
            {PCT.map((pct) => (
              <button
                key={pct}
                onClick={() => applyPct(pct)}
                disabled={!balance}
                className="flex-1 text-xs py-1 rounded-md border border-brand-border text-gray-400
                           hover:border-brand-green hover:text-brand-green transition-colors
                           disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {pct === 100 ? "Max" : `${pct}%`}
              </button>
            ))}
          </div>
        </div>

        {/* Live gauge + ALL bribe tokens */}
        {poolId && (gaugeVotes !== null || bribes.length > 0) && (
          <div className="rounded-lg bg-brand-dark border border-brand-border px-3 py-2 mb-3 text-xs space-y-2">
            <div className="flex items-center justify-between">
              {gaugeVotes !== null && (
                <span className="text-gray-400">
                  🗳 Gauge:{" "}
                  <span className="text-white font-mono">
                    {gaugeVotes.toLocaleString(undefined, { maximumFractionDigits: 2 })} hiSOLA
                  </span>
                </span>
              )}
              {bribes.length === 0 && (
                <span className="text-gray-600 italic">No bribe deposited this epoch</span>
              )}
            </div>
            {bribes.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {bribes.map((b) => (
                  <span key={b.symbol} className="flex items-center gap-1 text-gray-400">
                    🎁
                    <span className="font-mono" style={{ color: b.color }}>
                      {b.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} {b.symbol}
                    </span>
                    {/* Estimated reward for this vote amount */}
                    {gaugeVotes !== null && votes && parseFloat(votes) > 0 && (
                      <span className="text-gray-600">
                        (est.{" "}
                        <span className="text-white font-mono">
                          {(b.amount * parseFloat(votes) / (gaugeVotes + parseFloat(votes))).toLocaleString(
                            undefined, { maximumFractionDigits: 4 }
                          )}{" "}{b.symbol}
                        </span>)
                      </span>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {votedPools.has(poolId) ? (
          <div className="w-full text-center py-2 text-sm text-brand-green border border-brand-green/30 rounded-xl">
            ✓ Already voted for this pool this epoch
          </div>
        ) : (
          <button
            className="btn-primary w-full"
            onClick={vote}
            disabled={loading || !wallet || !votes || !poolId}
          >
            {loading ? "Voting…" : "Vote for this pool"}
          </button>
        )}

        {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
      </div>
    </div>
  );
}