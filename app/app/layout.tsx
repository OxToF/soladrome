// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Providers } from "./providers";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Soladrome — The Eternal Liquidity Engine",
  description: "ve(3,3) liquidity protocol on Solana",
  applicationName: "Soladrome",
  icons: {
    icon: "/icons/favicon-32.png",
    apple: "/icons/apple-touch-icon.png",
  },
  // Lets iOS add the site to the home screen as a standalone app.
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Soladrome",
  },
};

export const viewport: Viewport = {
  themeColor: "#09090f",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen bg-brand-dark antialiased font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
