"use client";
import { useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getProgram, statePda, hiSolaM } from "@/lib/program";

// ── Epoch helpers ─────────────────────────────────────────────────────────────
const EPOCH_S = 7 * 24 * 60 * 60;
function currentEpoch() { return Math.floor(Date.now() / 1000 / EPOCH_S); }
function epochEnd(e: number) { return new Date((e + 1) * EPOCH_S * 1000); }
function timeLeft(d: Date) {
  const s = Math.max(0, Math.floor((d.getTime() - Date.now()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

// ── PDA helpers ───────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
function epochBuf(epoch: number) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(epoch >>> 0, 0);
  b.writeUInt32LE(Math.floor(epoch / 2 ** 32), 4);
  return b;
}
function gaugePda(pool: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("gauge"), pool.toBuffer(), epochBuf(epoch)], PROGRAM_ID
  )[0];
}
function votePda(user: PublicKey, pool: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vote"), user.toBuffer(), pool.toBuffer(), epochBuf(epoch)], PROGRAM_ID
  )[0];
}
function uevPda(user: PublicKey, epoch: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("uev"), user.toBuffer(), epochBuf(epoch)], PROGRAM_ID
  )[0];
}

// ── Popular pools (labels only — devnet/localnet use any pubkey) ──────────────
const SUGGESTED = [
  { label: "SOL/USDC · Raydium",  addr: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWaS3AFKBxQaP" },
  { label: "SOL/USDC · Orca",     addr: "HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ" },
  { label: "SOLA/USDC · Serum",   addr: "So11111111111111111111111111111111111111112"   },
];

export function Vote() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const epoch = currentEpoch();
  const end   = epochEnd(epoch);

  const [poolId, setPoolId] = useState("");
  const [votes,  setVotes]  = useState("");
  const [loading, setLoading] = useState(false);
  const [status,  setStatus]  = useState("");

  function tryPool(): PublicKey | null {
    try { return new PublicKey(poolId); } catch { return null; }
  }

  async function vote() {
    if (!wallet || !votes || !poolId) return;
    const pool = tryPool();
    if (!pool) { setStatus("❌ Adresse de pool invalide"); return; }

    const amt = parseFloat(votes);
    if (isNaN(amt) || amt <= 0) { setStatus("❌ Montant invalide"); return; }

    setLoading(true); setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program  = getProgram(provider);

      const rawVotes     = new BN(Math.floor(amt * 1_000_000));
      const userHiSola   = (await import("@solana/spl-token"))
        .getAssociatedTokenAddressSync(hiSolaM, wallet.publicKey);
      const gaugeState   = gaugePda(pool, epoch);
      const userVoteReceipt = votePda(wallet.publicKey, pool, epoch);
      const userEpochVotes  = uevPda(wallet.publicKey, epoch);

      const tx = await program.methods
        .voteGauge(new BN(epoch), rawVotes)
        .accounts({
          user: wallet.publicKey,
          poolId: pool,
          protocolState: statePda,
          hiSolaMint: hiSolaM,
          userHiSola,
          gaugeState,
          userVoteReceipt,
          userEpochVotes,
          tokenProgram:  TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        } as any)
        .rpc();
      setStatus(`✅ Vote enregistré — tx: ${tx.slice(0, 16)}…`);
      setVotes("");
    } catch (e: any) {
      setStatus(`❌ ${e?.message ?? e}`);
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-6">
      {/* Epoch banner */}
      <div className="card flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-widest">Époque courante</p>
          <p className="text-2xl font-black text-white">#{epoch}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-widest">Se termine dans</p>
          <p className="text-2xl font-black text-brand-green">{timeLeft(end)}</p>
          <p className="text-xs text-gray-500">{end.toLocaleDateString()}</p>
        </div>
        <div className="text-right hidden md:block">
          <p className="text-xs text-gray-500 mb-2">Mécanisme</p>
          <p className="text-xs text-gray-400 max-w-xs">
            Vos hiSOLA votent pour les pools. <br />
            Les bribers rémunèrent les votants de <br />
            la pool qu'ils soutiennent.
          </p>
        </div>
      </div>

      {/* Vote form */}
      <div className="card">
        <h2 className="text-lg font-bold text-white mb-1">Voter pour une pool</h2>
        <p className="text-xs text-gray-500 mb-6">
          Poids de vote = hiSOLA alloué · Plafond = solde hiSOLA par époque · 1 vote par pool
        </p>

        {/* Suggested pools */}
        <p className="text-xs text-gray-500 mb-2 uppercase tracking-widest">Pools suggérées</p>
        <div className="flex flex-wrap gap-2 mb-5">
          {SUGGESTED.map((s) => (
            <button
              key={s.addr}
              onClick={() => setPoolId(s.addr)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                poolId === s.addr
                  ? "border-brand-green text-brand-green bg-brand-green/10"
                  : "border-brand-border text-gray-400 hover:border-gray-500"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <label className="text-xs text-gray-400 mb-1 block">Adresse de la pool (Pubkey)</label>
        <input
          className="input mb-4"
          placeholder="Colle l'adresse ou sélectionne ci-dessus"
          value={poolId}
          onChange={(e) => setPoolId(e.target.value)}
        />

        <label className="text-xs text-gray-400 mb-1 block">hiSOLA à allouer</label>
        <input
          className="input mb-4"
          type="number" min="0" step="0.000001"
          placeholder="0.000000"
          value={votes}
          onChange={(e) => setVotes(e.target.value)}
        />

        <button
          className="btn-primary w-full"
          onClick={vote}
          disabled={loading || !wallet || !votes || !poolId}
        >
          {loading ? "Vote en cours…" : "Voter pour cette pool"}
        </button>

        {status && <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>}
      </div>
    </div>
  );
}
