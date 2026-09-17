// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
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
import { getProgram, sendTx, getMintProgram } from "@/lib/program";
import { symbolByMint } from "@/lib/tokens";
import { describeBribes, expectedClaim, fmtRaw, type BribeToken } from "@/lib/bribes";
import { trackQuest } from "@/lib/quests";
import { useSoladrome } from "@/lib/SoladromeContext";
import { StatusBanner } from "./ui/StatusBanner";
import { currentEpoch, epochLabel } from "@/lib/epoch";

const PROGRAM_ID = new PublicKey("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");

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
  /** `UserVoteReceipt.votes`, base units. hiSOLA is always 6 decimals; kept raw for the preview. */
  votesRaw:   bigint;
  poolLabel:  string;
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
  // Gauge total votes for the currently selected (pool, epoch) — for expected-claim preview.
  // Raw base units: it is the denominator of the on-chain muldiv, so it stays a bigint.
  const [gaugeTotalVotes, setGaugeTotalVotes] = useState<bigint | null>(null);

  // ── 1. Load user's past vote receipts ─────────────────────────────────────
  const loadVoteReceipts = useCallback(async () => {
    if (!wallet) return;
    // Nothing is cleared up front. A reload that blanks the list and drops the selection makes
    // the open card close under the user — which is what the 10 s context poll was doing until
    // `usdcMint` stopped changing identity, and what the ↻ button still did on demand. The list
    // stays on screen while the new one loads, and the selection is re-pointed below.
    setLoadingEntries(true);
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);

      // Fetch all UserVoteReceipt where user == wallet (memcmp at offset 8)
      const receipts = await (program.account as any).userVoteReceipt.all([{
        memcmp: { offset: 8, bytes: wallet.publicKey.toBase58() },
      }]);

      // Fetch AmmPool accounts for human-readable labels.
      //
      // Through the shared registry, which carries the derived protocol mints, wSOL and the
      // devnet xStock fixtures. This screen used to hold its own table of three hardcoded
      // mints, all of them pre-rotation, so a USDC/SOLA pool read `USDC/CaGH…` and every
      // xStock pair `USDC/7Kq6…` — the exact symptom Gauge.tsx was fixed for on 2026-09-15.
      const pools: any[] = await (program.account as any).ammPool.all().catch(() => []);
      const poolLabel = (pk: PublicKey): string => {
        const p = pools.find((x: any) => x.publicKey.equals(pk));
        if (!p) return pk.toBase58().slice(0, 8) + "…";
        const symA = symbolByMint(p.account.tokenAMint.toString(), usdcMint);
        const symB = symbolByMint(p.account.tokenBMint.toString(), usdcMint);
        return `${symA}/${symB}`;
      };

      const entries: VoteEntry[] = receipts
        .map((r: any) => ({
          pool:      r.account.poolId as PublicKey,
          epoch:     Number(r.account.epoch),
          votesRaw:  BigInt(r.account.votes.toString()),
          poolLabel: poolLabel(r.account.poolId),
        }))
        // Only past epochs (claimable)
        .filter((e: VoteEntry) => e.epoch < epoch)
        .sort((a: VoteEntry, b: VoteEntry) => b.epoch - a.epoch);

      setVoteEntries(entries);
      // Keep the open card open: re-point the selection at the same (pool, epoch) in the new
      // list, and drop it only if that vote is genuinely gone. Read through the updater so the
      // callback never depends on `selected` — depending on it would rebuild this function on
      // every click, refire the effect that calls it, and reload on every selection.
      setSelected((prev) => {
        if (!prev) return null;
        const match = entries.find((e) => e.pool.equals(prev.pool) && e.epoch === prev.epoch);
        if (!match) return null;
        // Hand back the SAME object when nothing about it changed. `selected` is a dependency
        // of the bribe-discovery effect below, so an equal-but-new object would clear the
        // token list and the chosen mint on every reload — the same flicker one level down.
        // A past epoch's receipt is immutable on chain, so only the label can legitimately
        // move (when the registry resolves a symbol it could not resolve on first render).
        return match.poolLabel === prev.poolLabel && match.votesRaw === prev.votesRaw
          ? prev : match;
      });
      // Claim receipts are probed per selection now (see the effect below), against the mints
      // the chain actually holds a vault for. Probing a fixed token table here was both the
      // N×M RPC burst and a correctness hole: an xStock bribe was in no table, so its "✓
      // claimed" never appeared and the button stayed live on a bribe already taken.
      setClaimed(new Set());
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingEntries(false);
    }
  }, [wallet, connection, epoch, usdcMint]);

  useEffect(() => { loadVoteReceipts(); }, [loadVoteReceipts]);

  // ── 2. When a vote entry is selected, scan ALL BribeVault for that pool ──────
  useEffect(() => {
    if (!selected) { setAvailableTokens([]); setSelectedMint(null); setGaugeTotalVotes(null); return; }
    setLoadingTokens(true);
    setAvailableTokens([]);
    setSelectedMint(null);
    setGaugeTotalVotes(null);

    let cancelled = false;
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
          BigInt(v.account.totalBribed.toString()) > 0n
        );

        // Symbols from the shared registry, decimals from each mint account. `total_bribed` is
        // denominated in the reward mint, which is arbitrary — the `/ 1e6` that stood here
        // showed a 301.31 TSLAx pot as 30 131.0981.
        const tokens = await describeBribes(
          connection,
          matching.map(v => ({
            mint: v.account.rewardMint as PublicKey,
            raw:  BigInt(v.account.totalBribed.toString()),
          })),
          usdcMint,
        );
        if (cancelled) return;
        setAvailableTokens(tokens);

        // Which of THESE are already claimed — one batched call over the mints that actually
        // have a vault, instead of a fixed token table that could never contain an xStock.
        if (wallet && tokens.length > 0) {
          const infos = await connection.getMultipleAccountsInfo(
            tokens.map(t => claimPda(wallet.publicKey, selected.pool, t.mint, selected.epoch))
          );
          if (cancelled) return;
          const done = new Set<string>();
          tokens.forEach((t, i) => {
            if (infos[i]) done.add(`${selected.pool.toBase58()}:${t.mint.toBase58()}:${selected.epoch}`);
          });
          setClaimed(done);
        }

        // Fetch gauge total_votes for expected-claim preview
        const [gaugeAcc] = PublicKey.findProgramAddressSync(
          [Buffer.from("gauge"), selected.pool.toBuffer(), epochBuf(selected.epoch)], PROGRAM_ID
        );
        const gaugeInfo = await connection.getAccountInfo(gaugeAcc);
        if (gaugeInfo && !cancelled) {
          // offset: 8 discriminator + 32 pool_id + 8 epoch = 48
          setGaugeTotalVotes(gaugeInfo.data.readBigUInt64LE(48));
        }
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setLoadingTokens(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selected, connection, wallet, usdcMint]);

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
      // The reward mint is the briber's choice, so it may be Token-2022 — and the ATA the
      // program will create for the claimer is seeded with that program, not Tokenkeg.
      const rewardProgram   = await getMintProgram(connection, selectedMint);
      const userRewardAta   = getAssociatedTokenAddressSync(selectedMint, wallet.publicKey, false, rewardProgram);
      const gaugeState      = gaugePda(pool, ep);
      const userVoteReceipt = votePda(wallet.publicKey, pool, ep);
      const userBribeClaim  = claimPda(wallet.publicKey, pool, selectedMint, ep);

      const ix = await program.methods
        .claimBribe(new BN(ep))
        .accounts({
          user: wallet.publicKey, poolId: pool, rewardMint: selectedMint,
          bribeVault, bribeTokenVault, userRewardAta,
          gaugeState, userVoteReceipt, userBribeClaim,
          tokenProgram: rewardProgram,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any).instruction();
      const tx = await sendTx(connection, wallet, [ix]);

      setStatus(`✅ Bribe claimed — tx: ${tx.slice(0, 16)}…`);
      // meta = which UserBribeClaim receipt PDA the server should verify exists
      // (the account only stores its bump; the claimer is only in the seeds).
      trackQuest(wallet.publicKey.toBase58(), "claim_bribe", {
        pool: pool.toBase58(), rewardMint: selectedMint.toBase58(), epoch: ep,
      });
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
                    <span className="text-xs text-gray-500">{(Number(entry.votesRaw) / 1e6).toFixed(2)} votes</span>
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
                  <button key={tok.mint.toBase58()}
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
                        {fmtRaw(tok.raw, tok.decimals)} total
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
        if (!tok || gaugeTotalVotes === null || gaugeTotalVotes === 0n) return null;
        // Mirrors `claim_bribe` exactly — a truncating u128 muldiv on base units, not a float
        // product of two already-scaled numbers.
        const expected  = expectedClaim(tok.raw, selected.votesRaw, gaugeTotalVotes);
        const userShare = Number(selected.votesRaw) / Number(gaugeTotalVotes);
        return (
          <div className="rounded-lg bg-brand-dark border border-brand-border px-3 py-2 mb-3 text-xs">
            <div className="flex items-center justify-between mb-1">
              <span className="text-gray-500">Your votes</span>
              <span className="font-mono text-white">
                {fmtRaw(selected.votesRaw, 6, 2)} hiSOLA
              </span>
            </div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-gray-500">Total gauge votes</span>
              <span className="font-mono text-white">
                {fmtRaw(gaugeTotalVotes, 6, 2)} hiSOLA
              </span>
            </div>
            <div className="flex items-center justify-between border-t border-brand-border pt-1 mt-1">
              <span className="text-gray-400 font-semibold">Your share ({(userShare * 100).toFixed(1)}%)</span>
              <span className="font-mono font-bold text-brand-green">
                ≈ {fmtRaw(expected, tok.decimals, 2)} {tok.symbol}
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

      <StatusBanner message={status} />
    </div>
  );
}
