// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";

export type StatusKind = "success" | "error" | "info";

const KIND_CLASS: Record<StatusKind, string> = {
  success: "text-brand-green",
  error:   "text-red-400",
  info:    "text-gray-400",
};

// Every component already prefixes its status string with ✅/❌ — infer the
// kind from that instead of forcing every call site to track it separately.
function inferKind(message: string): StatusKind {
  if (message.startsWith("✅")) return "success";
  if (message.startsWith("❌")) return "error";
  return "info";
}

export function StatusBanner({ message, kind }: { message: string; kind?: StatusKind }) {
  if (!message) return null;
  const resolved = kind ?? inferKind(message);
  return (
    <p className={`mt-3 text-xs break-all ${KIND_CLASS[resolved]}`}>
      {message}
    </p>
  );
}
