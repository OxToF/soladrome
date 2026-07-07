// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";

export function ButtonHint({ text }: { text?: string | null }) {
  if (!text) return null;
  return <p className="text-xs text-gray-500 mt-2">{text}</p>;
}
