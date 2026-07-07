-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (C) 2025 Soladrome Labs
--
-- Soladrome — sybil verdict cache, refreshed by scripts/sybil_scan.mjs.
-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query → Run).
-- Idempotent: safe to re-run.
--
-- One row per wallet, upserted every time sybil_scan.mjs runs. The public
-- leaderboard (app/api/leaderboard/route.ts) reads this to hide wallets that
-- look scripted (LIKELY_BOT / SUSPECT) without deleting their underlying
-- quest_completions history — the verdict is a display filter, not a
-- destructive action. Airdrop eligibility (eligible_candidates.json) is a
-- separate, stricter decision made at snapshot time and doesn't depend on
-- this table.

create table if not exists wallet_verdicts (
  wallet_address text        primary key,
  verdict        text        not null, -- HUMAN_LIKE | SUSPECT | LIKELY_BOT | SHALLOW
  scanned_at     timestamptz not null default now()
);

alter table wallet_verdicts enable row level security;

drop policy if exists "wallet verdicts read" on wallet_verdicts;
create policy "wallet verdicts read"
  on wallet_verdicts
  for select
  using (true);
-- No insert/update/delete policy → service key only (same pattern as
-- quest_completions writes going only through record_quest / the service key).
