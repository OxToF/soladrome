// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Soladrome Labs
"use client";

export function EmptyState({ icon, title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="text-center py-6">
      {icon && <p className="text-2xl mb-2">{icon}</p>}
      <p className="text-xs text-gray-500">{title}</p>
      {hint && <p className="text-xs text-gray-600 mt-1">{hint}</p>}
    </div>
  );
}
