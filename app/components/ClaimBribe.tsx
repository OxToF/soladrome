// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect, useCallback } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { getProgram } from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";
import { currentEpoch, epochLabel } from "@/lib/epoch";

const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");

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
function votePda(user: PublicKey, pool: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vote"), user.toBuffer(), pool.toBuffer(), epochBuf(epoch)], PROGRAM_ID)[0];
}
function claimPda(user: PublicKey, pool: PublicKey, mint: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bribe_claim"), user.toBuffer(), pool.toBuffer(), mint.toBuffer(), epochBuf(epoch)], PROGRAM_ID)[0];
}

interface VoteEntry {
  pool:       PublicKey;
  epoch:      number;
  votes:      number;
  poolLabel:  string;
}

interface BribeToken {
  mint:   PublicKey;
  symbol: string;
  color:  string;
  amount: number; // total_bribed in this vault
}

export function ClaimBribe() {
  const { connection } = useConnection();
  const wallet         = useAnchorWallet();
  const { usdcMint }   = useSoladrome();

  const epoch = currentEpoch();

  const [voteEntries,     setVoteEntries]     = useState<VoteEntry[]>([]);
  const [selected,        setSelected]        = useState<VoteEntry | null>(null);
  const [availableTokens, setAvailableTokens] = useState<BribeToken[]>([]);
  const [selectedMint,    setSelectedMint]    = useState<PublicKey | null>(null);
  const [claimed,         setClaimed]         = useState<Set<string>>(new Set());
  const [loadingEntries,  setLoadingEntries]  = useState(false);
  const [loadingTokens,   setLoadingTokens]   = useState(false);
  const [loading,         setLoading]         = useState(false);
  const [status,          setStatus]          = useState("");
  // Gauge total votes for the currently selected (pool, epoch) — for expected-claim preview
  const [gaugeTotalVotes, setGaugeTotalVotes] = useState<number | null>(null);

  const knownTokens = [
    { symbol: "oSOLA",  mint: new PublicKey("2rAqBLBi2Fjdjqf5za7uzpbYgNiVV74XMDKQ5RdMuEJT"), color: "#bbf7d0" },
    { symbol: "SOLA",   mint: new PublicKey("HENFwJCzmBAo2Qybrszr28tqLtEFYkXwN6h87AD5gS9p"),  color: "#4ade80" },
    { symbol: "hiSOLA", mint: new PublicKey("nc1errcnXjKN4aZYL7AP89op26EMn5a2VcDT82wrTwW"),   color: "#86efac" },
    ...(usdcMint ? [{ symbol: "USDC", mint: usdcMint, color: "#2775ca" }] : []),
  ];

  // ── 1. Load user's past vote receipts ─────────────────────────────────────
  const loadVoteReceipts = useCallback(async () => {
    if (!wallet) return;
    setLoadingEntries(true);
    setVoteEntries([]);
    setSelected(null);
    setAvailableTokens([]);
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);

      // Fetch all UserVoteReceipt where user == wallet (memcmp at offset 8)
      const receipts = await (program.account as any).userVoteReceipt.all([{
        memcmp: { offset: 8, bytes: wallet.publicKey.toBase58() },
      }]);

      // Fetch AmmPool accounts for human-readable labels
      const pools: any[] = await (program.account as any).ammPool.all().catch(() => []);
      const poolLabel = (pk: PublicKey): string => {
        const p = pools.find((x: any) => x.publicKey.equals(pk));
        if (!p) return pk.toBase58().slice(0, 8) + "…";
        const knownSym = (addr: string) =>
          knownTokens.find(t => t.mint.toBase58() === addr)?.symbol ?? addr.slice(0, 4) + "…";
        return `${knownSym(p.account.tokenAMint.toString())}/${knownSym(p.account.tokenBMint.toString())}`;
      };

      const entries: VoteEntry[] = receipts
        .map((r: any) => ({
          pool:      r.account.poolId as PublicKey,
          epoch:     Number(r.account.epoch),
          votes:     Number(r.account.votes) / 1e6,
          poolLabel: poolLabel(r.account.poolId),
        }))
        // Only past epochs (claimable)
        .filter((e: VoteEntry) => e.epoch < epoch)
        .sort((a: VoteEntry, b: VoteEntry) => b.epoch - a.epoch);

      setVoteEntries(entries);

      // Check which (pool, mint, epoch) are already claimed
      const claimedSet = new Set<string>();
      await Promise.all(
        entries.flatMap(e =>
          knownTokens.map(async tok => {
            const pda = claimPda(wallet.publicKey, e.pool, tok.mint, e.epoch);
            const acc = await connection.getAccountInfo(pda);
            if (acc) claimedSet.add(`${e.pool.toBase58()}:${tok.mint.toBase58()}:${e.epoch}`);
          })
        )
      );
      setClaimed(claimedSet);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingEntries(false);
    }
  }, [wallet, connection, epoch]);

  useEffect(() => { loadVoteReceipts(); }, [loadVoteReceipts]);

  // ── 2. When a vote entry is selected, scan ALL BribeVault for that pool ──────
  useEffect(() => {
    if (!selected) { setAvailableTokens([]); setSelectedMint(null); setGaugeTotalVotes(null); return; }
    setLoadingTokens(true);
    setAvailableTokens([]);
    setSelectedMint(null);
    setGaugeTotalVotes(null);

    (async () => {
      try {
        const provider = new AnchorProvider(connection, wallet ?? ({} as any), {});
        const program  = getProgram(provider);

        // Fetch ALL BribeVault accounts where pool_id == selected.pool (memcmp at offset 8)
        const vaults: any[] = await (program.account as any).bribeVault.all([{
          memcmp: { offset: 8, bytes: selected.pool.toBase58() },
        }]);

        // Filter by the selected epoch and non-zero total
        const matching = vaults.filter(v =>
          Number(v.account.epoch) === selected.epoch &&
          Number(v.account.totalBribed) > 0
        );

        const tokens: BribeToken[] = matching.map(v => {
          const mint = v.account.rewardMint as PublicKey;
          const known = knownTokens.find(t => t.mint.toBase58() === mint.toBase58());
          return {
            mint,
            symbol: known?.symbol ?? mint.toBase58().slice(0, 6) + "…",
            color:  known?.color  ?? "#888",
            amount: Number(v.account.totalBribed) / 1e6,
          };
        });

        setAvailableTokens(tokens);

        // Fetch gauge total_votes for expected-claim preview
        const [gaugeAcc] = PublicKey.findProgramAddressSync(
          [Buffer.from("gauge"), selected.pool.toBuffer(), epochBuf(selected.epoch)], PROGRAM_ID
        );
        const gaugeInfo = await connection.getAccountInfo(gaugeAcc);
        if (gaugeInfo) {
          // offset: 8 discriminator + 32 pool_id + 8 epoch = 48
          const raw = gaugeInfo.data.readBigUInt64LE(48);
          setGaugeTotalVotes(Number(raw) / 1e6);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoadingTokens(false);
      }
    })();
  }, [selected, connection]);

  // ── 3. Claim ───────────────────────────────────────────────────────────────
  async function claimBribe() {
    if (!wallet || !selected || !selectedMint) return;
    setLoading(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);
      const { pool, epoch: ep } = selected;
      const bribeVault      = bribeVaultPda(pool, selectedMint, ep);
      const bribeTokenVault = bribeTokensPda(pool, selectedMint, ep);
      const userRewardAta   = getAssociatedTokenAddressSync(selectedMint, wallet.publicKey);
      const gaugeState      = gaugePda(pool, ep);
      const userVoteReceipt = votePda(wallet.publicKey, pool, ep);
      const userBribeClaim  = claimPda(wallet.publicKey, pool, selectedMint, ep);

      const tx = await program.methods
        .claimBribe(new BN(ep))
        .accounts({
          user: wallet.publicKey, poolId: pool, rewardMint: selectedMint,
          bribeVault, bribeTokenVault, userRewardAta,
          gaugeState, userVoteReceipt, userBribeClaim,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any).rpc();

      setStatus(`✅ Bribe claimed — tx: ${tx.slice(0, 16)}…`);
      const key = `${pool.toBase58()}:${selectedMint.toBase58()}:${ep}`;
      setClaimed(prev => new Set([...prev, key]));
      setSelectedMint(null);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.includes("3012") || msg.includes("AccountNotInitialized")) {
        setStatus("❌ No bribe deposited for this pool / token / epoch.");
      } else if (msg.includes("already in use") || msg.includes("0x0")) {
        setStatus("✅ Already claimed for this combination.");
      } else {
        setStatus(`❌ ${msg}`);
      }
    } finally { setLoading(false); }
  }

  const claimKey = selected && selectedMint
    ? `${selected.pool.toBase58()}:${selectedMint.toBase58()}:${selected.epoch}`
    : "";
  const alreadyClaimed = claimed.has(claimKey);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-bold text-white">Claim Voting Rewards</h2>
        {wallet && (
          <button onClick={loadVoteReceipts} disabled={loadingEntries}
            className="text-xs text-gray-500 hover:text-gray-300 border border-brand-border rounded px-2 py-0.5 transition-colors">
            {loadingEntries ? "…" : "↻"}
          </button>
        )}
      </div>
      <p className="text-sm text-gray-400 mb-5">
        Bribes earned for your hiSOLA votes in past epochs.
      </p>

      {!wallet && (
        <p className="text-xs text-gray-500 text-center py-6">Connect your wallet to see your votes.</p>
      )}

      {/* ── Vote receipt list ── */}
      {wallet && !loadingEntries && voteEntries.length === 0 && (
        <p className="text-xs text-gray-500 text-center py-6">No past votes found.</p>
      )}

      {loadingEntries && (
        <p className="text-xs text-gray-500 text-center py-6">Loading votes…</p>
      )}

      {voteEntries.length > 0 && (
        <div className="mb-5">
          <p className="text-xs text-gray-500 mb-2 uppercase tracking-widest">Your past votes</p>
          <div className="flex flex-col gap-1.5">
            {voteEntries.map((entry, i) => {
              const isSelected = selected?.pool.equals(entry.pool) && selected?.epoch === entry.epoch;
              return (
                <button key={i}
                  onClick={() => { setSelected(isSelected ? null : entry); setStatus(""); }}
                  className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                    isSelected
                      ? "border-brand-green bg-brand-green/5"
                      : "border-brand-border hover:border-gray-500"
                  }`}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-200">{entry.poolLabel}</span>
                    <span className="text-xs text-gray-500">{entry.votes.toFixed(2)} votes</span>
                  </div>
                  <span className="text-[11px] text-gray-600">{epochLabel(entry.epoch)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Available bribe tokens for selected entry ── */}
      {selected && (
        <div className="mb-5">
          <p className="text-xs text-gray-500 mb-2 uppercase tracking-widest">
            Available bribes — {selected.poolLabel}
          </p>

          {loadingTokens && (
            <p className="text-xs text-gray-500">Searching for bribes…</p>
          )}

          {!loadingTokens && availableTokens.length === 0 && (
            <p className="text-xs text-gray-500">No bribe deposited for this pool / epoch.</p>
          )}

          {!loadingTokens && availableTokens.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {availableTokens.map(tok => {
                const key = `${selected.pool.toBase58()}:${tok.mint.toBase58()}:${selected.epoch}`;
                const done = claimed.has(key);
                const isSel = selectedMint?.equals(tok.mint) ?? false;
                return (
                  <button key={tok.symbol}
                    onClick={() => !done && setSelectedMint(isSel ? null : tok.mint)}
                    disabled={done}
                    className={`w-full text-left rounded-lg border px-3 py-2 flex items-center justify-between transition-colors ${
                      done    ? "border-brand-border opacity-40 cursor-not-allowed" :
                      isSel   ? "border-brand-green bg-brand-green/5" :
                                "border-brand-border hover:border-gray-500"
                    }`}>
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full" style={{ background: tok.color }} />
                      <span className="text-sm font-semibold text-gray-200">{tok.symbol}</span>
                    </div>
                    <div className="text-right">
                      <span className="text-xs text-gray-400">
                        {tok.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} total
                      </span>
                      {done && <span className="ml-2 text-[11px] text-brand-green">✓ claimed</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Expected claim preview ── */}
      {selected && selectedMint && !alreadyClaimed && (() => {
        const tok = availableTokens.find(t => t.mint.equals(selectedMint!));
        if (!tok || !gaugeTotalVotes || gaugeTotalVotes === 0) return null;
        const userShare = selected.votes / gaugeTotalVotes;
        const expected  = tok.amount * userShare;
        return (
          <div className="rounded-lg bg-brand-dark border border-brand-border px-3 py-2 mb-3 text-xs">
            <div className="flex items-center justify-between mb-1">
              <span className="text-gray-500">Your votes</span>
              <span className="font-mono text-white">
                {selected.votes.toLocaleString(undefined, { maximumFractionDigits: 2 })} hiSOLA
              </span>
            </div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-gray-500">Total gauge votes</span>
              <span className="font-mono text-white">
                {gaugeTotalVotes.toLocaleString(undefined, { maximumFractionDigits: 2 })} hiSOLA
              </span>
            </div>
            <div className="flex items-center justify-between border-t border-brand-border pt-1 mt-1">
              <span className="text-gray-400 font-semibold">Your share ({(userShare * 100).toFixed(1)}%)</span>
              <span className="font-mono font-bold text-brand-green">
                ≈ {expected.toLocaleString(undefined, { maximumFractionDigits: 2 })} {tok.symbol}
              </span>
            </div>
          </div>
        );
      })()}

      {/* ── Claim button ── */}
      {selected && selectedMint && !alreadyClaimed && (
        <button className="btn-primary w-full" onClick={claimBribe} disabled={loading}>
          {loading ? "Claiming…" : "Claim bribes"}
        </button>
      )}

      {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
    </div>
  );
}
