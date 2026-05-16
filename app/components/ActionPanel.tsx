// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Christophe Hertecant
"use client";
import { useState } from "react";
import { AmmSwap }  from "./AmmSwap";
import { Exercise } from "./Exercise";
import { Stake }    from "./Stake";
import { Borrow }   from "./Borrow";

type ActionTab = "swap" | "options" | "earn" | "lend";

const TABS: { id: ActionTab; label: string; hint: string }[] = [
  { id: "swap",    label: "Swap",    hint: "AMM multi-pools" },
  { id: "options", label: "Options", hint: "Exercer oSOLA"   },
  { id: "earn",    label: "Earn",    hint: "Stake → hiSOLA"  },
  { id: "lend",    label: "Lend",    hint: "Borrow USDC"     },
];

export function ActionPanel() {
  const [tab, setTab] = useState<ActionTab>("swap");

  return (
    <div className="card glow">
      {/* ── Tab bar ─────────────────────────────────────── */}
      <div className="flex gap-0 mb-6 border-b border-brand-border -mx-6 px-6">
        {TABS.map(({ id, label, hint }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            title={hint}
            className={`relative px-4 py-3 text-sm font-semibold transition-colors ${
              tab === id
                ? "text-brand-green after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-brand-green after:rounded-t"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Tab content ─────────────────────────────────── */}
      {tab === "swap"    && <AmmSwap  embedded />}
      {tab === "options" && <Exercise embedded />}
      {tab === "earn"    && <Stake    embedded />}
      {tab === "lend"    && <Borrow   embedded />}
    </div>
  );
}
