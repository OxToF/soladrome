// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  getProgram, statePda, solaM, floorVault, marketVault,
  userAta, commonAccounts, fromUi, toUi, sendTx,
} from "@/lib/program";
import {
  solaOut, usdcOut, effectivePrice, premiumOverFloorPct, minReceived, frontRunHeadroom,
} from "@/lib/curve";
import { useSoladrome } from "@/lib/SoladromeContext";
import { trackQuest } from "@/lib/quests";

type Tab = "buy" | "sell";

const PCT_SHORTCUTS = [25, 50, 75, 100] as const;

// Slippage tolerances offered on the buy side, in basis points.
//
// 50 bps is the default because it is the smallest bound that survives ordinary traffic: at
// the live reserves a 1 000 USDC buy landing ahead of you costs 0.196% of your output, so
// 0.5% absorbs roughly 2 500 USDC of other buying. 10 bps is there for a quiet book, 100 bps
// for a launch window. The card states what each one absorbs rather than leaving the user to
// reason about a bare percentage.
const SLIPPAGE_OPTIONS = [10, 50, 100] as const;
const DEFAULT_SLIPPAGE_BPS = 50;

export function BuySell() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint, protocolState, vaultInfos } = useSoladrome();
  const [tab, setTab] = useState<Tab>("buy");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);

  // The side you spend from: USDC when buying, SOLA when selling.
  const spendMint   = tab === "buy" ? usdcMint : solaM;
  const spendSymbol = tab === "buy" ? "USDC"   : "SOLA";

  const fetchBalance = useCallback(async () => {
    if (!wallet || !spendMint) { setBalance(null); return; }
    try {
      const info = await connection.getTokenAccountBalance(userAta(spendMint, wallet.publicKey));
      setBalance(Number(info.value.uiAmount ?? 0));
    } catch {
      // No ATA yet — a brand-new wallet before its first faucet claim. Zero, not unknown.
      setBalance(0);
    }
  }, [connection, wallet, spendMint]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  // Buy/sell/faucet all dispatch this, and Portfolio and Stats already listen to it, so the
  // card refreshes itself instead of showing a balance the last trade already invalidated.
  useEffect(() => {
    const h = () => { fetchBalance(); };
    window.addEventListener("soladrome:refresh", h);
    return () => window.removeEventListener("soladrome:refresh", h);
  }, [fetchBalance]);

  const insufficient =
    balance !== null && amount !== "" && Number(amount) > balance;

  // ── What you actually receive ──────────────────────────────────────────────
  //
  // The card showed only the amount being spent, so a buyer had no way to know what the
  // curve would mint before signing — and a seller no way to see what the floor would pay.
  // Both sides are quoted here against on-chain reserves that `SoladromeContext` re-fetches
  // every 10 s.
  const quote = useMemo(() => {
    const ui = Number(amount);
    if (!amount || !Number.isFinite(ui) || ui <= 0) return null;

    if (tab === "sell") {
      // Not a curve trade: the floor redeems 1:1 and the virtual reserves never move.
      const solaIn = BigInt(fromUi(ui).toString());
      const out    = usdcOut(solaIn);
      // `sell_sola` requires `floor_vault.amount >= usdc_out`. The vault is an SPL token
      // account; its `amount` is a little-endian u64 at offset 64.
      const floorRaw = vaultInfos[0]
        ? vaultInfos[0]!.data.readBigUInt64LE(64)
        : null;
      return {
        out,
        symbol: "SOLA",
        shortfall: floorRaw !== null && out > floorRaw ? floorRaw : null,
      };
    }

    if (!protocolState) return null;
    const usdcIn = BigInt(fromUi(ui).toString());
    const out = solaOut(
      {
        virtualUsdc: BigInt(protocolState.virtualUsdc.toString()),
        virtualSola: BigInt(protocolState.virtualSola.toString()),
        k:           BigInt(protocolState.k.toString()),
      },
      usdcIn,
    );
    if (out === null) return null;
    return {
      out,
      symbol: "USDC",
      price:   effectivePrice(usdcIn, out),
      premium: premiumOverFloorPct(usdcIn, out),
      // The bound the transaction will actually carry, derived from this same quote.
      minOut:  minReceived(out, slippageBps),
      shortfall: null as bigint | null,
    };
  }, [amount, tab, protocolState, vaultInfos, slippageBps]);

  // A buy with no quote would have to fall back to an unbounded `min_sola_out`, which is the
  // thing being removed. Refuse the trade instead — protocolState only stays null when it has
  // never loaded, since the context keeps stale data through transient RPC errors.
  const quoteUnavailable = tab === "buy" && amount !== "" && Number(amount) > 0 && !quote;

  function applyPct(pct: number) {
    if (balance === null || balance <= 0) return;
    // Floor to 6 decimals — the token precision. Anything finer is dust the input would
    // round anyway, and `Max` must never produce more than the wallet actually holds.
    const v = Math.floor(balance * (pct / 100) * 1e6) / 1e6;
    setAmount(v > 0 ? String(v) : "");
  }

  async function claimFaucet() {
    if (!wallet) return;
    setFaucetLoading(true);
    setStatus("");
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: wallet.publicKey.toBase58() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStatus(`✅ Got ${data.amount} test USDC!`);
      trackQuest(wallet.publicKey.toBase58(), "faucet");
      // Without this the card still reads 0 right after a successful claim, which looks
      // exactly like a failed faucet — the first impression every new tester gets.
      window.dispatchEvent(new CustomEvent("soladrome:refresh"));
    } catch (e: any) {
      setStatus(`❌ Faucet: ${e?.message ?? e}`);
    } finally {
      setFaucetLoading(false);
    }
  }

  async function submit() {
    if (!wallet || !amount || !usdcMint) return;
    setLoading(true);
    setStatus("");
    try {
      const provider = new AnchorProvider(connection, wallet, {});
      const program = getProgram(provider);
      const usdcMintPk = usdcMint;
      const userSola = userAta(solaM, wallet.publicKey);
      const userUsdc = userAta(usdcMintPk, wallet.publicKey);

      if (tab === "buy") {
        // ☢️ This was `new BN(1)` — a floor of one base unit, i.e. the buyer accepting any
        // price the curve happened to offer by the time the transaction landed. The bound now
        // comes from the quote on screen, so what is signed is what was shown, less the
        // tolerance the user picked. Refuse rather than fall back to an unbounded buy: a
        // silent 1 here is exactly the bug being fixed.
        if (!quote?.minOut) throw new Error("No live quote — refusing an unbounded buy.");
        const ix = await program.methods
          .buySola(fromUi(+amount), new BN(quote.minOut.toString()))
          .accounts({
            user: wallet.publicKey,
            protocolState: statePda,
            solaMint: solaM,
            userUsdc,
            userSola,
            floorVault,
            marketVault,
            ...commonAccounts,
          } as any)
          .instruction();
        const tx = await sendTx(connection, wallet, [ix]);
        setStatus(`✅ Bought SOLA — tx: ${tx.slice(0, 16)}…`);
        trackQuest(wallet.publicKey.toBase58(), "swap");
        window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      } else {
        const ix = await program.methods
          .sellSola(fromUi(+amount))
          .accounts({
            user: wallet.publicKey,
            protocolState: statePda,
            solaMint: solaM,
            userSola,
            floorVault,
            userUsdc,
            tokenProgram: commonAccounts.tokenProgram,
          } as any)
          .instruction();
        const tx = await sendTx(connection, wallet, [ix]);
        setStatus(`✅ Sold SOLA — tx: ${tx.slice(0, 16)}…`);
        window.dispatchEvent(new CustomEvent("soladrome:refresh"));
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      // The bound now actually binds, so this is a real outcome rather than an impossible
      // one: someone bought ahead and moved the curve. Say that, instead of showing a raw
      // Anchor code — "SlippageExceeded" reads as a broken app to a first-time tester.
      if (msg.includes("SlippageExceeded") || msg.includes("6000")) {
        setStatus(
          `❌ The curve moved while you were signing — the buy was rejected rather than ` +
          `filled above your ${slippageBps / 100}% tolerance. Nothing was spent. Retry, or ` +
          `raise the tolerance.`,
        );
      } else {
        setStatus(`❌ ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card glow">
      <h2 className="text-lg font-bold mb-4 text-white">
        {tab === "buy" ? "Buy $SOLA" : "Sell $SOLA"}
      </h2>

      {/* Tabs */}
      <div className="flex gap-6 mb-6 border-b border-brand-border">
        {(["buy", "sell"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pb-2 text-sm font-semibold uppercase tracking-wide transition-colors ${
              tab === t ? "tab-active" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between mb-1">
        <label className="text-xs text-gray-400">
          {tab === "buy" ? "USDC amount" : "SOLA amount"}
        </label>
        {balance !== null && (
          <span className="text-xs text-gray-500">
            Balance:{" "}
            <button
              type="button"
              className="text-gray-300 hover:text-brand-green transition-colors font-mono"
              onClick={() => applyPct(100)}
            >
              {balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} {spendSymbol}
            </button>
          </span>
        )}
      </div>
      <input
        className="input"
        type="number"
        min="0"
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />

      <div className="flex gap-2 mt-3 mb-4">
        {PCT_SHORTCUTS.map((pct) => (
          <button
            key={pct}
            type="button"
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

      {/* ── You receive ── */}
      {quote && (
        <div className="rounded-xl border border-brand-border bg-brand-dark px-3 py-2.5 mb-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-gray-400">You receive</span>
            <span className="text-base font-semibold text-brand-green font-mono">
              {toUi(new BN(quote.out.toString())).toLocaleString(undefined, {
                maximumFractionDigits: 6,
              })}{" "}
              <span className="text-xs text-gray-400 font-sans">
                {tab === "buy" ? "SOLA" : "USDC"}
              </span>
            </span>
          </div>
          {tab === "buy" && quote.price !== undefined && (
            <div className="flex items-baseline justify-between gap-2 mt-1.5 pt-1.5 border-t border-brand-border">
              <span className="text-[11px] text-gray-500">Average price</span>
              <span className="text-[11px] text-gray-400 font-mono">
                {quote.price.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC / SOLA
                {/* The premium over the floor, not impact against spot: the floor is what
                    bounds the downside, so it is the number worth showing. */}
                <span className="text-gray-600">
                  {" · "}+{(quote.premium ?? 0).toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })}% over floor
                </span>
              </span>
            </div>
          )}
          {/* What the signed transaction actually guarantees. Below this the chain rejects
              the buy rather than filling it at a worse price. */}
          {tab === "buy" && quote.minOut !== undefined && (
            <div className="flex items-baseline justify-between gap-2 mt-1.5">
              <span className="text-[11px] text-gray-500">Minimum received</span>
              <span className="text-[11px] text-gray-400 font-mono">
                {toUi(new BN(quote.minOut.toString())).toLocaleString(undefined, {
                  maximumFractionDigits: 6,
                })}{" "}
                SOLA
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Slippage tolerance ── */}
      {tab === "buy" && (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] text-gray-500">Max slippage</span>
            {/* The tolerance restated as what it protects against. A bare percentage tells
                the user nothing about the risk; "absorbs ~2 500 USDC of buying ahead of you"
                is the same number in the units of the actual hazard. */}
            {protocolState && (
              <span className="text-[11px] text-gray-600">
                absorbs ~
                {frontRunHeadroom(
                  {
                    virtualUsdc: BigInt(protocolState.virtualUsdc.toString()),
                    virtualSola: BigInt(protocolState.virtualSola.toString()),
                    k:           BigInt(protocolState.k.toString()),
                  },
                  slippageBps,
                ).toLocaleString(undefined, { maximumFractionDigits: 0 })}{" "}
                USDC of buying ahead of you
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {SLIPPAGE_OPTIONS.map((bps) => (
              <button
                key={bps}
                type="button"
                onClick={() => setSlippageBps(bps)}
                className={`flex-1 text-xs py-1 rounded-md border transition-colors ${
                  slippageBps === bps
                    ? "border-brand-green text-brand-green"
                    : "border-brand-border text-gray-400 hover:border-gray-500"
                }`}
              >
                {bps / 100}%
              </button>
            ))}
          </div>
        </div>
      )}

      {/* `sell_sola` fails InsufficientFloorReserve rather than paying out partially, so say
          so before the signature instead of after. */}
      {quote?.shortfall !== null && quote?.shortfall !== undefined && (
        <p className="text-xs text-yellow-500 mb-2">
          Floor vault holds only{" "}
          {toUi(new BN(quote.shortfall.toString())).toLocaleString(undefined, {
            maximumFractionDigits: 2,
          })}{" "}
          USDC — this sell would be rejected on-chain.
        </p>
      )}

      {tab === "buy" && (
        <p className="text-xs text-gray-500 mb-4">
          Floor price: 1 USDC / SOLA · Market price rises with demand
        </p>
      )}
      {tab === "sell" && (
        <p className="text-xs text-gray-500 mb-4">
          Redeem at floor — always receive 1 USDC per SOLA
        </p>
      )}

      {/* Refuse a trade the wallet cannot fund rather than letting the chain reject it —
          an on-chain failure costs the user a signature and reads as a broken app. */}
      {insufficient && (
        <p className="text-xs text-yellow-500 mb-2">
          Not enough {spendSymbol} — you hold{" "}
          {(balance ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })}.
        </p>
      )}

      {quoteUnavailable && (
        <p className="text-xs text-yellow-500 mb-2">
          No live quote from the curve right now — a buy would have to go out unbounded, so
          it is held back. Retry in a moment.
        </p>
      )}

      <button
        className="btn-primary w-full"
        onClick={submit}
        disabled={loading || !wallet || !amount || !usdcMint || insufficient || quoteUnavailable}
      >
        {loading ? "Processing…" : tab === "buy" ? "Buy SOLA" : "Sell SOLA"}
      </button>

      {status && (
        <p className="mt-3 text-xs text-gray-400 break-all">{status}</p>
      )}

      {/* Devnet faucet */}
      <div className="mt-4 pt-4 border-t border-brand-border">
        <p className="text-xs text-gray-500 mb-2">New wallet? Get test USDC</p>
        <button
          className="btn-secondary w-full text-xs"
          onClick={claimFaucet}
          disabled={faucetLoading || !wallet}
        >
          {faucetLoading ? "Sending…" : "Get 500 Test USDC"}
        </button>
        {/* SOL comes from the official faucet — the in-app one only mints our
            custom test USDC (fee SOL via devnet airdrop was rate-limited anyway). */}
        <p className="text-[10px] text-gray-600 mt-2">
          Need SOL for transaction fees?{" "}
          <a
            href="https://faucet.solana.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-400"
          >
            Get devnet SOL at faucet.solana.com
          </a>
        </p>
      </div>
    </div>
  );
}