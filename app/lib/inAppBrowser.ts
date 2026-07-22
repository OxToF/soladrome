// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// Social apps (X above all) open shared links in their own in-app WebView, and
// no Solana wallet can be reached from there: no extension injects, and the
// wallet adapters' own escape hatches don't fire.
//
// The reason is a single predicate in @solana/wallet-adapter-base,
// `isIosAndRedirectable()`, which gates the Phantom/Solflare universal links on
// `(iphone|ipad) && userAgent.includes('safari')`. X's iOS WebView reports
// `... Mobile/21E236 Twitter for iPhone/11.x` — no "safari" token — so Phantom
// stays NotDetected, and tapping it lands on `window.open('https://phantom.app')`
// (WalletProviderBase) i.e. the App Store page. The visitor sees a normal wallet
// button that leads nowhere.
//
// Android is the mirror image: X's WebView carries the `wv` token, so
// providers.tsx keeps Phantom/Solflare in the list, and the Mobile Wallet
// Adapter is offered too (its `getIsSupported()` only tests
// `isSecureContext && /android/i` — it does NOT detect WebViews, contrary to
// what the comment in providers.tsx used to claim) while its association intent
// can't leave the host WebView.
//
// So we detect the in-app browser ourselves and hand the user the universal
// link the adapters refused to build.

export type InAppBrowser = "ios" | "android" | null;

/**
 * Returns which flavour of in-app WebView we're in, or null for a real browser.
 * Pure and UA-only — always pair it with a capability check (see ConnectButton:
 * a wallet's own in-app browser is also a WebView, but there a wallet IS
 * injected and the normal flow works).
 */
export function detectInAppBrowser(ua: string): InAppBrowser {
  const u = ua.toLowerCase();

  // Every genuine iOS browser (Safari, Chrome/CriOS, Firefox/FxiOS, Edge/EdgiOS)
  // keeps the "safari" token; WKWebView-based in-app browsers drop it.
  if (/iphone|ipad|ipod/.test(u)) return u.includes("safari") ? null : "ios";

  // Android WebViews are identified by the `wv` token, which survives the
  // Android 16 UA reduction. Chrome Custom Tabs (a real browser) have no `wv`.
  if (/android/.test(u) && /\bwv\b/.test(u)) return "android";

  return null;
}

/**
 * Phantom's universal link: opens the current page inside Phantom's own
 * browser, where the provider injects and the normal connect flow resumes.
 * Same URL shape the Phantom adapter uses on iOS Safari — we just also fire it
 * where its own detection gives up. Pass the live href so the ?ref= referral
 * param captured from the shared link survives the hop.
 */
export function phantomBrowseUrl(href: string, origin: string): string {
  return `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}`;
}

/** Solflare's equivalent universal link. */
export function solflareBrowseUrl(href: string, origin: string): string {
  return `https://solflare.com/ul/v1/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}`;
}
