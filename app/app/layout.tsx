// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
import type { Metadata } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Soladrome — The Eternal Liquidity Engine",
  description: "ve(3,3) liquidity protocol on Solana",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-brand-dark antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
