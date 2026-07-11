-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (C) 2025 Soladrome Labs
--
-- Soladrome devnet — Founding Contributor Whitelist.
-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query → Run).
-- Idempotent: safe to re-run.

-- ── 1. Signups table ────────────────────────────────────────────────────────
-- One row per wallet that has connected + signed the whitelist message.
-- Being in this table only means "signed up" — see whitelist_eligible below
-- for who actually counts as "whitelisted" (real on-chain usage required).
create table if not exists whitelist_signups (
  wallet_address text primary key,
  email          text,
  signature      text        not null, -- base58 signature, proves wallet ownership
  message        text        not null, -- exact signed message (embeds the timestamp used for replay protection)
  created_at     timestamptz not null default now()
);
create index if not exists idx_whitelist_created on whitelist_signups (created_at);
alter table whitelist_signups enable row level security;
-- No anon policy: all reads/writes go through API routes using the service key
-- (mirrors quest_completions — never let the anon key touch this table directly).

-- ── 2. join_whitelist RPC ────────────────────────────────────────────────────
-- Signature/message are verified by the API route (tweetnacl) BEFORE this is
-- called — this function just persists the result. Re-signing updates the row
-- (email can be added/changed later without losing the original signup date).
create or replace function join_whitelist(p_wallet text, p_email text, p_signature text, p_message text)
returns void
language plpgsql
security definer
as $$
begin
  if p_wallet is null or length(p_wallet) < 32 or length(p_wallet) > 44 then
    return; -- not a plausible base58 Solana pubkey
  end if;

  insert into whitelist_signups (wallet_address, email, signature, message)
  values (p_wallet, p_email, p_signature, p_message)
  on conflict (wallet_address) do update
    set email     = coalesce(excluded.email, whitelist_signups.email),
        signature = excluded.signature,
        message   = excluded.message;
end;
$$;

-- ── 3. Eligibility view ──────────────────────────────────────────────────────
-- "Whitelisted" = signed up AND has at least one ON-CHAIN-VERIFIED quest
-- (same set the `leaderboard` view in quests.sql already trusts). This is what
-- the primary goal actually needs: real bonding-curve usage, not just a
-- connected wallet. A wallet that only signs up without ever staking/borrowing/
-- voting stays "pending" — it never inflates the public whitelisted count.
create or replace view whitelist_eligible as
  select w.wallet_address, w.email, w.created_at
  from whitelist_signups w
  where exists (
    select 1 from quest_completions qc
    where qc.wallet_address = w.wallet_address
      and qc.quest_id in ('stake', 'borrow', 'vote', 'vote_again', 'borrow_again')
  );

-- ── 4. Row Level Security ───────────────────────────────────────────────────
-- No anon SELECT policy on whitelist_signups — the count/status API routes
-- use the service key (RLS bypass), same pattern as leaderboard/track-quest.
