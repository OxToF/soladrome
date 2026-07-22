// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";
import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import {
  detectInAppBrowser,
  phantomBrowseUrl,
  solflareBrowseUrl,
  type InAppBrowser,
} from "@/lib/inAppBrowser";

// ssr: false évite la hydration mismatch liée à l'icône <i> du wallet adapter
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

// Adapters set readyState synchronously on injection, but give the polling
// detection a beat before we conclude no wallet can be reached — otherwise a
// visitor arriving in Phantom's own browser sees the escape screen flash.
const DETECTION_GRACE_MS = 700;

/**
 * The connect button, with an escape hatch for social-app in-app browsers.
 *
 * In a real browser this is just `WalletMultiButton`. Inside an in-app WebView
 * with no wallet reachable (see lib/inAppBrowser.ts) the wallet modal is a dead
 * end, so we replace it with the universal link that gets the user out.
 */
export function ConnectButton({ variant, className }: { variant: "header" | "hero"; className?: string }) {
  const { wallets } = useWallet();
  const [inApp, setInApp] = useState<InAppBrowser>(null);
  const [graceOver, setGraceOver] = useState(false);
  const [copied, setCopied] = useState(false);

  // UA read in an effect, never during render: the server has no navigator, and
  // branching on it at render time would desync hydration.
  useEffect(() => {
    setInApp(detectInAppBrowser(navigator.userAgent));
    const t = setTimeout(() => setGraceOver(true), DETECTION_GRACE_MS);
    return () => clearTimeout(t);
  }, []);

  // Capability check, and the reason UA sniffing alone is not enough: a wallet's
  // own in-app browser is a WebView too (Phantom on Android carries `wv`, and on
  // iOS may drop the "safari" token), but there a provider IS injected and the
  // normal flow works — so never gate on the UA when a wallet is present.
  const walletReachable = wallets.some((w) => w.readyState === WalletReadyState.Installed);
  const stranded = inApp !== null && graceOver && !walletReachable;

  if (!stranded) return <WalletMultiButton className={className} />;

  const open = (build: (href: string, origin: string) => string) => () => {
    // Read the URL at click time so the ?ref= referral captured from the shared
    // link rides along into the wallet browser.
    window.location.href = build(window.location.href, window.location.origin);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked in this WebView — the user can still long-press the URL bar */ }
  };

  // Header label kept short on purpose: "Open in Phantom" overflows the 375px
  // header, which is exactly the width these visitors arrive on.
  if (variant === "header") {
    return (
      <button
        onClick={open(phantomBrowseUrl)}
        className="btn-primary shrink-0 whitespace-nowrap !text-xs !px-3 sm:!text-sm sm:!px-4"
      >
        Open Phantom
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 w-full max-w-xs">
      <p className="text-xs text-gray-400 leading-relaxed">
        You&apos;re browsing inside an app that can&apos;t reach your Solana wallet.
        Open Soladrome in your wallet&apos;s browser to continue.
      </p>
      <button onClick={open(phantomBrowseUrl)} className="btn-primary w-full">
        Open in Phantom
      </button>
      <button onClick={open(solflareBrowseUrl)} className="btn-secondary w-full">
        Open in Solflare
      </button>
      <button onClick={copyLink} className="btn-secondary w-full">
        {copied ? "Link copied" : "Copy link for your browser"}
      </button>
    </div>
  );
}
