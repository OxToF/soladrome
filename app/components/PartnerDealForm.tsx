// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
// Register a partner deal in three figures (2026-11-09).
//
// The deal since 2026-11-09 is closed: the partner escrows a bribe schedule, locks LP in the
// protocol's escrow for the whole term, and earns a fixed hiSOLA bag one full epoch at a time.
// Everything the program needs is derived here from what is actually negotiated:
//   1. the liquidity, in dollars          → the bag (degressive tiers) and the LP threshold
//   2. the bribe per epoch, in tokens     → min_bribe_per_epoch
//   3. the term, in epochs                → schedule_epochs, and the bag's pace
// The three addresses (partner, pool, bribe token) are identities, not terms.
import { useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { getProgram, statePda, sendTx, PROGRAM_ID } from "@/lib/program";
import { useSoladrome } from "@/lib/SoladromeContext";
import { fetchJupiterUsdPrices } from "@/lib/prices_external";

const EPOCH_SECS = 604_800;
const MAX_LOCK_SECS = 208 * EPOCH_SECS; // full 4× ve power
const TERMS = [13, 26, 52] as const;

/** Published tiers: dollars of LP → hiSOLA bag. Linear between points, 7 % beyond $1M. */
const TIERS: [number, number][] = [
  [0, 0],
  [100_000, 10_000],
  [250_000, 22_000],
  [500_000, 40_000],
  [1_000_000, 70_000],
];
export function bagForLiquidity(usd: number): number {
  if (!(usd > 0)) return 0;
  for (let i = 1; i < TIERS.length; i++) {
    const [x0, y0] = TIERS[i - 1];
    const [x1, y1] = TIERS[i];
    if (usd <= x1) return Math.floor(y0 + ((usd - x0) * (y1 - y0)) / (x1 - x0));
  }
  const [xl, yl] = TIERS[TIERS.length - 1];
  return Math.floor(yl + (usd - xl) * 0.07);
}

function partnerAllocPda(w: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("partner"), w.toBuffer()], PROGRAM_ID)[0];
}
function parseKey(s: string): PublicKey | null {
  try { return s.trim() ? new PublicKey(s.trim()) : null; } catch { return null; }
}
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

type PoolInfo = { lpMint: PublicKey; lpPriceUsd: number; label: string };

export default function PartnerDealForm({ isAuthority }: { isAuthority: boolean }) {
  const wallet = useAnchorWallet();
  const { connection } = useConnection();
  const { protocolState } = useSoladrome();

  const [partner, setPartner] = useState("");
  const [pool, setPool] = useState("");
  const [bribeMint, setBribeMint] = useState("");
  const [liquidityUsd, setLiquidityUsd] = useState("100000");
  const [bribePerEpoch, setBribePerEpoch] = useState("");
  const [term, setTerm] = useState<number>(26);

  const [poolInfo, setPoolInfo] = useState<PoolInfo | null>(null);
  const [poolErr, setPoolErr] = useState<string | null>(null);
  const [bribeDec, setBribeDec] = useState<number | null>(null);
  const [bribeErr, setBribeErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  // ── Pool → LP mint and the dollar value of one LP ───────────────────────────
  useEffect(() => {
    setPoolInfo(null); setPoolErr(null);
    const key = parseKey(pool);
    if (!pool.trim()) return;
    if (!key) { setPoolErr("Adresse de pool invalide."); return; }
    let cancelled = false;
    (async () => {
      try {
        const program = getProgram(new AnchorProvider(connection, wallet as any, {}));
        const p: any = await (program.account as any).ammPool.fetchNullable(key);
        if (cancelled) return;
        if (!p) { setPoolErr("Ce n'est pas un pool Soladrome."); return; }
        const a = (p.tokenAMint as PublicKey).toBase58();
        const b = (p.tokenBMint as PublicKey).toBase58();
        const [ia, ib] = await Promise.all([
          connection.getParsedAccountInfo(p.tokenAMint),
          connection.getParsedAccountInfo(p.tokenBMint),
        ]);
        const da = (ia.value?.data as any)?.parsed?.info?.decimals ?? 6;
        const db = (ib.value?.data as any)?.parsed?.info?.decimals ?? 6;
        const ra = Number(p.reserveA.toString()) / 10 ** da;
        const rb = Number(p.reserveB.toString()) / 10 ** db;
        const totalLp = Number(p.totalLp.toString()) / 1e6; // LP mints: 6 decimals
        if (!(ra > 0 && rb > 0 && totalLp > 0)) { setPoolErr("Pool vide : impossible de convertir des dollars en LP."); return; }

        // Price: USDC is $1; otherwise Jupiter; a missing side is priced off the pool ratio.
        const usdc = protocolState?.usdcMint?.toBase58?.();
        const ext = await fetchJupiterUsdPrices([a, b]);
        let pa = a === usdc ? 1 : ext[a];
        let pb = b === usdc ? 1 : ext[b];
        if (!pa && pb) pa = (rb * pb) / ra;
        if (!pb && pa) pb = (ra * pa) / rb;
        if (cancelled) return;
        if (!pa || !pb) { setPoolErr("Aucun prix en dollars pour ce pool (ni USDC, ni prix Jupiter)."); return; }
        const tvl = ra * pa + rb * pb;
        setPoolInfo({
          lpMint: p.lpMint as PublicKey,
          lpPriceUsd: tvl / totalLp,
          label: `TVL ≈ $${fmt(tvl)} · 1 LP ≈ $${fmt(tvl / totalLp)}`,
        });
      } catch (e: any) {
        if (!cancelled) setPoolErr(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [pool, connection, wallet, protocolState]);

  // ── Bribe token decimals, read from the chain ───────────────────────────────
  useEffect(() => {
    setBribeDec(null); setBribeErr(null);
    const key = parseKey(bribeMint);
    if (!bribeMint.trim()) return;
    if (!key) { setBribeErr("Adresse de token invalide."); return; }
    let cancelled = false;
    connection.getParsedAccountInfo(key).then((r) => {
      if (cancelled) return;
      const d = (r.value?.data as any)?.parsed?.info?.decimals;
      if (typeof d === "number") setBribeDec(d);
      else setBribeErr("Ce n'est pas un mint SPL.");
    }).catch(() => { if (!cancelled) setBribeErr("Mint illisible."); });
    return () => { cancelled = true; };
  }, [bribeMint, connection]);

  // ── The deal ────────────────────────────────────────────────────────────────
  const deal = useMemo(() => {
    const usd = Number(liquidityUsd);
    const bribe = Number(bribePerEpoch);
    if (!(usd > 0)) return { err: "Indique la liquidité en dollars." };
    if (!(bribe > 0)) return { err: "Indique la bribe par epoch." };
    if (!poolInfo || bribeDec === null) return { err: null };
    const bag = bagForLiquidity(usd);
    const perEpochBase = BigInt(Math.floor((bag * 1e6) / term));
    if (perEpochBase === BigInt(0)) return { err: "Liquidité trop faible pour un sac." };
    const lpBase = BigInt(Math.ceil((usd / poolInfo.lpPriceUsd) * 1e6));
    const bribeBase = BigInt(Math.round(bribe * 10 ** bribeDec));
    return { bag, perEpochBase, lpBase, bribeBase, totalBribe: bribe * term };
  }, [liquidityUsd, bribePerEpoch, term, poolInfo, bribeDec]);
  const ready = !("err" in deal) && parseKey(partner) && parseKey(bribeMint) && poolInfo;

  async function submit() {
    if (!wallet || !ready || "err" in deal) return;
    setBusy(true); setStatus("");
    try {
      const partnerKey = parseKey(partner)!;
      const alloc = partnerAllocPda(partnerKey);
      if (await connection.getAccountInfo(alloc)) {
        setStatus("⚠️ Ce wallet a déjà un deal. Ferme-le d'abord (carte ci-dessous)."); return;
      }
      const program = getProgram(new AnchorProvider(connection, wallet, {}));
      const ix = await program.methods
        .registerPartner(
          parseKey(bribeMint)!,
          poolInfo!.lpMint,
          new BN(deal.lpBase.toString()),
          new BN(deal.perEpochBase.toString()),
          new BN(0),                 // no signature bag: every hiSOLA is earned
          new BN(MAX_LOCK_SECS),
          new BN(term),
          new BN(deal.bribeBase.toString()),
        )
        .accounts({
          authority: wallet.publicKey,
          protocolState: statePda,
          partnerWallet: partnerKey,
          partnerAllocation: alloc,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any)
        .instruction();
      const tx = await sendTx(connection, wallet, [ix]);
      setStatus(`✅ Deal enregistré — tx ${tx.slice(0, 16)}…`);
      setPartner("");
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full bg-brand-dark border border-brand-border rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-green";
  const label = "text-[10px] text-gray-500 uppercase tracking-widest mb-1 block";

  return (
    <div className="card">
      <div className="flex items-center gap-3 mb-4">
        <span className="text-2xl">🤝</span>
        <div>
          <h3 className="text-base font-bold text-white">Nouveau deal partenaire</h3>
          <p className="text-xs text-gray-500">Authority · liquidité bloquée + bribes séquestrées → sac de hiSOLA fixe</p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <label className={label}>Wallet du partenaire</label>
          <input className={input} value={partner} onChange={(e) => setPartner(e.target.value)} placeholder="Adresse Solana" />
        </div>
        <div>
          <label className={label}>Pool où il dépose sa liquidité</label>
          <input className={input} value={pool} onChange={(e) => setPool(e.target.value)} placeholder="Adresse du pool (onglet Pools)" />
          {poolErr && <p className="text-[11px] text-red-400 mt-1">❌ {poolErr}</p>}
          {poolInfo && <p className="text-[11px] text-gray-500 mt-1">{poolInfo.label}</p>}
        </div>
        <div>
          <label className={label}>Token des bribes</label>
          <input className={input} value={bribeMint} onChange={(e) => setBribeMint(e.target.value)} placeholder="Mint (USDC, JTO…)" />
          {bribeErr && <p className="text-[11px] text-red-400 mt-1">❌ {bribeErr}</p>}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className={label}>Liquidité ($)</label>
            <input className={input} inputMode="decimal" value={liquidityUsd} onChange={(e) => setLiquidityUsd(e.target.value)} />
          </div>
          <div>
            <label className={label}>Bribe / epoch</label>
            <input className={input} inputMode="decimal" value={bribePerEpoch} onChange={(e) => setBribePerEpoch(e.target.value)} placeholder="tokens" />
          </div>
          <div>
            <label className={label}>Durée</label>
            <select className={input} value={term} onChange={(e) => setTerm(Number(e.target.value))}>
              {TERMS.map((t) => <option key={t} value={t}>{t} epochs (~{Math.round((t * 7) / 30.4)} mois)</option>)}
            </select>
          </div>
        </div>

        {"err" in deal && deal.err && <p className="text-[11px] text-amber-400">{deal.err}</p>}

        {!("err" in deal) && (
          <div className="rounded-xl border border-brand-border bg-brand-dark/60 p-3 text-xs text-gray-300 leading-relaxed">
            Le partenaire bloque <strong className="text-white">${fmt(Number(liquidityUsd))}</strong> de LP
            pendant <strong className="text-white">{term} epochs</strong> et séquestre{" "}
            <strong className="text-white">{fmt(deal.totalBribe)}</strong> tokens de bribes
            ({fmt(Number(bribePerEpoch))} par epoch). Il reçoit{" "}
            <strong className="text-brand-green">{fmt(deal.bag)} hiSOLA</strong>, crédités par
            1/{term} à chaque epoch complète, bloqués à vie (frais + vote, sans emprunt). Puis le deal s'arrête.
          </div>
        )}

        <button className="btn-primary w-full" onClick={submit} disabled={busy || !isAuthority || !ready}>
          {busy ? "Envoi…" : !isAuthority ? "Wallet authority requis" : "Enregistrer le deal"}
        </button>
        {status && <p className="text-xs text-gray-400 break-all">{status}</p>}
      </div>
    </div>
  );
}

/** The partner's LP escrow PDA — `[b"partner_lp", partner]`. */
export function partnerLpVaultPda(partner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("partner_lp"), partner.toBuffer()], PROGRAM_ID)[0];
}

/** Mirror of `partners.rs::retainer_epochs_earned`: full epochs the LP escrow covered, capped. */
export function retainerEpochsEarned(pa: any, nowEpoch: number): number {
  const since = Number(pa.lpQualifiedSinceTs?.toString() ?? 0);
  if (since <= 0) return 0;
  const firstFull = Math.ceil(since / EPOCH_SECS);
  const withdrawn = Number(pa.lpWithdrawnEpoch?.toString() ?? 0);
  const end = withdrawn !== 0 ? Math.min(withdrawn, nowEpoch) : nowEpoch;
  return Math.min(Math.max(end - firstFull, 0), Number(pa.scheduleEpochs.toString()));
}
