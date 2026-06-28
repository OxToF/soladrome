// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
//
// PWA Web App Manifest (App Router metadata route → served at /manifest.webmanifest).
// Required for installability and for wrapping the site into an Android APK
// (Bubblewrap / PWABuilder) for the Solana dApp Store. See SEEKER_DAPP_STORE.md.
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Soladrome — The Eternal Liquidity Engine",
    short_name: "Soladrome",
    description:
      "ve(3,3) liquidity protocol on Solana — bonding curve, floor price, no liquidation.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#09090f",
    theme_color: "#09090f",
    categories: ["finance"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
