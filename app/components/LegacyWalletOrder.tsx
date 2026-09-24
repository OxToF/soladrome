// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Soladrome Labs
"use client";
// ☢️ THE WALLET ORDER IS RETIRED (2026-09-24). It automated the oSOLA already in the wallet, on its
// own rhythm, next to per-position strategies that already do the job at the source. Two automatic
// systems with two "how often" settings read as one confused one on screen, so the app no longer
// offers it. Wallet oSOLA goes through "Right now, by hand" instead.
//
// This card only exists for orders armed before: their allowances outlive the screen, and the
// keeper still cranks them until the program drops the instructions. It shows nothing otherwise.
import { useCallback, useEffect, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { sendTx } from "@/lib/program";
import { explainRpcRefusal } from "@/lib/txerror";
import { useSoladrome } from "@/lib/SoladromeContext";
import { buildCloseOrderInstruction, buildDisarmInstructions, readStandingOrder } from "@/lib/autocompound";
import { StatusBanner } from "./ui/StatusBanner";

export function LegacyWalletOrder({ voters = 0 }: { voters?: number }) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { usdcMint } = useSoladrome();
  const [exists, setExists] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    if (!wallet || !usdcMint) return;
    try {
      const { order } = await readStandingOrder(connection, wallet, usdcMint);
      setExists(order !== null);
    } catch {
      setExists(false);
    }
  }, [connection, wallet, usdcMint]);
  useEffect(() => { load(); }, [load]);

  async function stop() {
    if (!wallet || !usdcMint) return;
    setBusy(true);
    setStatus("");
    try {
      // ☢️ Keep the USDC allowance when a position votes: it is the same delegate, and revoking it
      // would stop those positions too.
      const ixs = [
        ...(await buildDisarmInstructions(connection, wallet, usdcMint, false, voters > 0)),
        await buildCloseOrderInstruction(connection, wallet),
      ];
      const sig = await sendTx(connection, wallet, ixs);
      setStatus(`✅ Stopped and closed, rent returned. tx: ${sig.slice(0, 16)}…`);
      setTimeout(load, 2000);
    } catch (e: any) {
      setStatus(`❌ ${explainRpcRefusal(e) ?? e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  if (!wallet || (!exists && !status)) return null;

  return (
    <div className="card">
      <h3 className="text-base font-bold text-white">Your old wallet order</h3>
      <p className="mt-1 text-xs leading-relaxed text-gray-500">
        Automating the oSOLA in your wallet is gone: each position now handles its own rewards, above.
        You still have an order from before, and it can keep acting on your wallet&apos;s oSOLA until
        you stop it. Stopping withdraws its oSOLA allowance and closes it.
        {voters > 0 ? " Your voting positions keep their USDC budget." : ""}
      </p>
      {exists && (
        <button onClick={stop} disabled={busy} className="btn-secondary mt-4 w-full disabled:opacity-40">
          {busy ? "Sending…" : "Stop and close it"}
        </button>
      )}
      <StatusBanner message={status} />
    </div>
  );
}
