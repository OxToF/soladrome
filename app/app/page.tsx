// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useAnchorWallet } from "@solana/wallet-adapter-react";

// ssr: false évite la hydration mismatch liée à l'icône <i> du wallet adapter
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);
import { Vote }         from "@/components/Vote";
import { Gauge }        from "@/components/Gauge";
import { ClaimFees }    from "@/components/ClaimFees";
import { ClaimBribe }   from "@/components/ClaimBribe";
import { Stats }        from "@/components/Stats";
import { Pools }        from "@/components/Pools";
import { ActionPanel }  from "@/components/ActionPanel";
import { Portfolio }    from "@/components/Portfolio";
import { FlashArb }     from "@/components/FlashArb";
import { FounderPanel }      from "@/components/FounderPanel";
import { ContributorPanel, contributorVestingPda } from "@/components/ContributorPanel";
import { PartnerPanel, partnerAllocationPda }      from "@/components/PartnerPanel";
import { Bridge }          from "@/components/Bridge";
import { Airdrop }         from "@/components/Airdrop";
import { useConnection }   from "@solana/wallet-adapter-react";

// Founder wallet — must match FOUNDER_WALLET in programs/soladrome/src/lib.rs
const FOUNDER_WALLET = "46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4";

type Page = "home" | "pools" | "vote" | "bribe" | "claim" | "arb" | "bridge" | "airdrop" | "founder" | "contributor" | "partner";

const NAV: { id: Page; label: string; founderOnly?: boolean; contributorOnly?: boolean; partnerOnly?: boolean }[] = [
  { id: "home",        label: "Home"        },
  { id: "pools",       label: "Pools"       },
  { id: "vote",        label: "Vote"        },
  { id: "bribe",       label: "Bribe"       },
  { id: "claim",       label: "Claim"       },
  { id: "arb",         label: "Arb"          },
  { id: "bridge",      label: "Bridge"       },
  { id: "airdrop",     label: "Airdrop"      },
  { id: "founder",     label: "Founder",     founderOnly: true      },
  { id: "contributor", label: "Allocation",  contributorOnly: true  },
  { id: "partner",     label: "Partner",     partnerOnly: true      },
];

// Legacy page ids that used to be standalone tabs — redirect them to home
const HOME_ALIASES = new Set(["swap", "stake", "borrow", "osola", "liquidity"]);

const DOCS_URL = "/about.html";
const DISCORD_URL = "https://discord.com/channels/1506249630218715218/1506249803451994132";
const X_URL = "https://x.com/soladrome";
const TELEGRAM_URL = "https://t.me/+SW4sVvoypbRkZTQ0";
const EMAIL = "info@soladrome.finance";

export default function Home() {
  const wallet         = useAnchorWallet();
  const { connection } = useConnection();
  const [page, setPage]           = useState<Page>("home");
  const [isContributor, setIsContributor] = useState(false);
  const [isPartner,     setIsPartner]     = useState(false);

  const isFounder = wallet?.publicKey.toBase58() === FOUNDER_WALLET;

  // Detect ContributorVesting PDA
  useEffect(() => {
    if (!wallet) { setIsContributor(false); return; }
    connection.getAccountInfo(contributorVestingPda(wallet.publicKey))
      .then((info) => setIsContributor(info !== null))
      .catch(() => setIsContributor(false));
  }, [wallet?.publicKey.toBase58(), connection]);

  // Detect PartnerAllocation PDA
  useEffect(() => {
    if (!wallet) { setIsPartner(false); return; }
    connection.getAccountInfo(partnerAllocationPda(wallet.publicKey))
      .then((info) => setIsPartner(info !== null))
      .catch(() => setIsPartner(false));
  }, [wallet?.publicKey.toBase58(), connection]);

  // Visible nav: hide role-specific entries unless applicable
  const visibleNav = NAV.filter((n) => {
    if (n.founderOnly)     return isFounder;
    if (n.contributorOnly) return isContributor;
    if (n.partnerOnly)     return isPartner;
    return true;
  });

  // First-touch referral capture: stash ?ref=<wallet> once, before any connect.
  useEffect(() => {
    try {
      const ref = new URLSearchParams(window.location.search).get("ref");
      if (ref && ref.length >= 32 && ref.length <= 44 && !localStorage.getItem("soladrome_ref")) {
        localStorage.setItem("soladrome_ref", ref);
      }
    } catch { /* no-op */ }
  }, []);

  // Enregistre le wallet dans Supabase à chaque connexion (+ attribution referral)
  useEffect(() => {
    if (!wallet?.publicKey) return;
    const me = wallet.publicKey.toBase58();
    let ref: string | null = null;
    try { ref = localStorage.getItem("soladrome_ref"); } catch { /* no-op */ }
    fetch("/api/register-wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: me, ref: ref && ref !== me ? ref : undefined }),
    }).catch(() => {}); // silencieux — ne bloque jamais l'UX
  }, [wallet?.publicKey?.toBase58()]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (HOME_ALIASES.has(detail)) {
        setPage("home");
      } else if (NAV.some((n) => n.id === detail)) {
        setPage(detail as Page);
      }
    };
    window.addEventListener("nav", handler);
    return () => window.removeEventListener("nav", handler);
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-brand-border/60 bg-brand-dark/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-5 h-15 flex items-center justify-between gap-4" style={{height:"60px"}}>
          {/* Logo */}
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-xl font-black tracking-tight">
              <span className="text-white">SOLA</span><span className="text-brand-green">DROME</span>
            </span>
            <span className="badge-green">Devnet</span>
          </div>

          {/* Nav */}
          <nav className="hidden md:flex items-center gap-0.5">
            {visibleNav.map(({ id, label, founderOnly, partnerOnly, contributorOnly }) => (
              <button
                key={id}
                onClick={() => setPage(id)}
                className={`relative px-3.5 py-2 rounded-lg text-sm font-medium transition-all duration-150 ${
                  page === id
                    ? "text-brand-green bg-brand-green/8"
                    : "text-brand-muted hover:text-gray-200 hover:bg-white/4"
                }`}
              >
                {label}
                {(founderOnly || partnerOnly || contributorOnly) && (
                  <span className="absolute top-1.5 right-1.5 w-1 h-1 rounded-full bg-brand-green opacity-70" />
                )}
              </button>
            ))}
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="px-3.5 py-2 rounded-lg text-sm font-medium text-brand-muted hover:text-gray-200 transition-all duration-150 hover:bg-white/4 flex items-center gap-1"
            >
              Docs
              <svg className="w-3 h-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noreferrer"
              className="px-3.5 py-2 rounded-lg text-sm font-medium text-brand-muted hover:text-[#5865F2] transition-all duration-150 hover:bg-white/4 flex items-center gap-1.5"
              title="Soladrome Labs Discord"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
              </svg>
              Discord
            </a>
            <a
              href={X_URL}
              target="_blank"
              rel="noreferrer"
              className="px-3.5 py-2 rounded-lg text-sm font-medium text-brand-muted hover:text-white transition-all duration-150 hover:bg-white/4 flex items-center gap-1.5"
              title="Soladrome on X"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.737-8.835L2.25 2.25h6.919l4.259 5.632 5.816-5.632zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
              X
            </a>
            <a
              href={TELEGRAM_URL}
              target="_blank"
              rel="noreferrer"
              className="px-3.5 py-2 rounded-lg text-sm font-medium text-brand-muted hover:text-[#2AABEE] transition-all duration-150 hover:bg-white/4 flex items-center gap-1.5"
              title="Soladrome Telegram"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
              </svg>
              Telegram
            </a>
          </nav>

          <WalletMultiButton className="!bg-brand-green !text-black !rounded-xl !font-bold !text-sm shrink-0" />
        </div>
      </header>

      {/* ── Public Airdrop page (visible without a wallet) ─────── */}
      {page === "airdrop" && (
        <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-8">
          <Airdrop />
        </main>
      )}

      {/* ── Hero (not connected) ───────────────────────────────── */}
      {!wallet && page !== "airdrop" && (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-24">
          <h1 className="text-5xl md:text-7xl font-black mb-4 leading-tight">
            <span className="text-white">The Eternal</span>
            <br />
            <span className="text-brand-green">Liquidity Engine</span>
          </h1>
          <p className="text-gray-400 max-w-xl mb-10 text-lg">
            Bonding curve · Floor price · No liquidation<br />
            Powered by ve(3,3) tokenomics on Solana.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <WalletMultiButton className="!bg-brand-green !text-black !rounded-xl !font-bold !px-8 !py-3" />
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="btn-secondary"
            >
              Read the Docs
            </a>
            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noreferrer"
              className="btn-secondary flex items-center gap-2 justify-center"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
              </svg>
              Discord
            </a>
            <a
              href={X_URL}
              target="_blank"
              rel="noreferrer"
              className="btn-secondary flex items-center gap-2 justify-center"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.737-8.835L2.25 2.25h6.919l4.259 5.632 5.816-5.632zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
              X
            </a>
            <a
              href={TELEGRAM_URL}
              target="_blank"
              rel="noreferrer"
              className="btn-secondary flex items-center gap-2 justify-center hover:text-[#2AABEE]"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
              </svg>
              Telegram
            </a>
          </div>
        </div>
      )}

      {/* ── App (connected) ───────────────────────────────────── */}
      {wallet && page !== "airdrop" && (
        <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-8">
          <Stats />

          {/* Mobile nav */}
          <div className="flex md:hidden gap-1.5 mb-6 overflow-x-auto pb-1 scrollbar-none">
            {visibleNav.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setPage(id)}
                className={`shrink-0 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 ${
                  page === id
                    ? "bg-brand-green/10 text-brand-green border border-brand-green/25"
                    : "text-brand-muted border border-brand-border hover:text-gray-200"
                }`}
              >
                {label}
              </button>
            ))}
            <a href={DOCS_URL} target="_blank" rel="noreferrer"
              className="shrink-0 px-3 py-2 rounded-lg text-sm font-medium text-gray-400 border border-brand-border">
              Docs ↗
            </a>
            <a href={DISCORD_URL} target="_blank" rel="noreferrer"
              className="shrink-0 px-3 py-2 rounded-lg text-sm font-medium text-gray-400 border border-brand-border hover:text-[#5865F2]">
              Discord
            </a>
            <a href={X_URL} target="_blank" rel="noreferrer"
              className="shrink-0 px-3 py-2 rounded-lg text-sm font-medium text-gray-400 border border-brand-border hover:text-white">
              X
            </a>
            <a href={TELEGRAM_URL} target="_blank" rel="noreferrer"
              className="shrink-0 px-3 py-2 rounded-lg text-sm font-medium text-gray-400 border border-brand-border hover:text-[#2AABEE]">
              Telegram
            </a>
          </div>

          {/* ── Home — Beradrome-style layout ─────────────────── */}
          {page === "home" && (
            <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-6 items-start">
              <Portfolio />
              <ActionPanel />
            </div>
          )}

          {/* ── Dedicated pages ───────────────────────────────── */}
          {page === "pools" && <Pools />}
          {page === "vote"  && <div className="max-w-xl mx-auto"><Vote /></div>}
          {page === "bribe" && <div className="max-w-xl mx-auto"><Gauge /></div>}
          {page === "arb"   && <div className="max-w-xl mx-auto"><FlashArb /></div>}
          {page === "claim" && (
            <div className="max-w-xl mx-auto flex flex-col gap-6">
              <ClaimFees />
              <ClaimBribe />
            </div>
          )}
          {page === "bridge"      && <div className="max-w-xl mx-auto"><Bridge /></div>}
          {page === "founder"     && <FounderPanel />}
          {page === "contributor" && <ContributorPanel />}
          {page === "partner"     && <PartnerPanel />}
        </main>
      )}

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer className="border-t border-brand-border mt-auto py-6 text-center text-xs text-gray-600">
        Soladrome · ve(3,3) on Solana ·{" "}
        <a href={DOCS_URL} target="_blank" rel="noreferrer"
          className="hover:text-brand-green transition-colors">Docs</a>
        {" · "}
        <a href={DISCORD_URL} target="_blank" rel="noreferrer"
          className="hover:text-[#5865F2] transition-colors">Discord</a>
        {" · "}
        <a href={X_URL} target="_blank" rel="noreferrer"
          className="hover:text-white transition-colors">X</a>
        {" · "}
        <a href={TELEGRAM_URL} target="_blank" rel="noreferrer"
          className="hover:text-[#2AABEE] transition-colors">Telegram</a>
        {" · "}
        <a href={`mailto:${EMAIL}`} className="hover:text-brand-green transition-colors">{EMAIL}</a>
      </footer>
    </div>
  );
}
