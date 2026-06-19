-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (C) 2025 Christophe Hertecant
--
-- Soladrome devnet — Testnet Contributor quest / points system.
-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query → Run).
-- Idempotent: safe to re-run.

-- ── 1. Completions table ────────────────────────────────────────────────────
-- One row per (wallet, quest). The UNIQUE constraint makes every quest a
-- one-time award, so spamming the same action can't inflate a score.
create table if not exists quest_completions (
  id             bigint generated always as identity primary key,
  wallet_address text        not null,
  quest_id       text        not null,
  points         int         not null,
  completed_at   timestamptz not null default now(),
  unique (wallet_address, quest_id)
);

create index if not exists idx_quest_completions_wallet
  on quest_completions (wallet_address);

-- ── 2. record_quest RPC ─────────────────────────────────────────────────────
-- Points are decided SERVER-SIDE here, never trusted from the client, so the
-- frontend can only say "wallet X did quest Y" — not how many points it's worth.
-- Unknown quest ids are silently ignored (return 0 points → no insert).
create or replace function record_quest(p_wallet text, p_quest text)
returns void
language plpgsql
security definer
as $$
declare
  v_points int;
begin
  if p_wallet is null or length(p_wallet) < 32 or length(p_wallet) > 44 then
    return; -- not a plausible base58 Solana pubkey
  end if;

  v_points := case p_quest
    when 'connect'   then 5    -- connect a wallet to the devnet app
    when 'faucet'    then 5    -- claim devnet SOL + test USDC
    when 'swap'      then 10   -- swap USDC -> SOLA
    when 'liquidity' then 20   -- deposit liquidity in an AMM pool
    when 'stake'     then 15   -- stake SOLA -> hiSOLA
    when 'borrow'    then 15   -- borrow USDC against hiSOLA
    when 'repay'     then 10   -- repay USDC debt
    when 'vote'      then 20   -- vote on a gauge for the current epoch
    when 'bug'       then 50   -- verified bug report (awarded manually, bonus)
    when 'follow_x'  then 5    -- social: follow @soladrome on X (honor-system)
    when 'repost'    then 10   -- social: repost the launch thread (honor-system)
    when 'referral'  then 25   -- social: awarded SERVER-SIDE only when a referred
                               -- wallet becomes a verified on-chain Genesis Tester.
                               -- NOT in VALID_QUESTS → can't be self-POSTed.
    else 0
  end;

  if v_points = 0 then
    return;
  end if;

  insert into quest_completions (wallet_address, quest_id, points)
  values (p_wallet, p_quest, v_points)
  on conflict (wallet_address, quest_id) do nothing;
end;
$$;

-- ── 3. Public leaderboard view ──────────────────────────────────────────────
-- Aggregated per wallet. Ties broken by who got there first (last_active asc).
-- ANTI-SYBIL: only wallets with at least one ON-CHAIN-VERIFIED quest
-- (stake/borrow/vote) appear. Those quests are checked against chain state at
-- write time (app/api/track-quest), so they can't be forged — whereas
-- connect/faucet/swap/etc. are cheap and bot-spammable. This keeps pure
-- connect/faucet bots off the board for good, with no per-request RPC.
create or replace view leaderboard as
  select wallet_address,
         sum(points)::int   as points,
         count(*)::int      as quests,
         max(completed_at)  as last_active
  from quest_completions
  group by wallet_address
  having bool_or(quest_id in ('stake', 'borrow', 'vote'))
  order by points desc, last_active asc;

-- ── 4. Row Level Security ───────────────────────────────────────────────────
-- The anon key must NOT be able to write completions directly (it would let
-- anyone forge points). All writes go through record_quest via the service key
-- in the API route. We expose only read access to the leaderboard.
alter table quest_completions enable row level security;

drop policy if exists "leaderboard read" on quest_completions;
create policy "leaderboard read"
  on quest_completions
  for select
  using (true);

-- record_quest runs as SECURITY DEFINER (table owner), so the API service key
-- can write through it even with RLS on. No INSERT policy is granted to anon.

-- ── 5. Referrals ────────────────────────────────────────────────────────────
-- One referrer per referred wallet, immutable (first-touch). A wallet can't
-- refer itself. Written by the API (service key) at register time. The referrer
-- only EARNS the +25 'referral' quest once one of their referred wallets becomes
-- a verified on-chain Genesis Tester (has stake+borrow+vote, which are gated) —
-- enforced in app/api/track-quest. RLS on, no anon access (service key only).
create table if not exists referrals (
  referred_wallet text        primary key,
  referrer_wallet text        not null,
  rewarded        boolean      not null default false,
  created_at      timestamptz  not null default now(),
  check (referred_wallet <> referrer_wallet)
);
create index if not exists idx_referrals_referrer on referrals (referrer_wallet);
alter table referrals enable row level security; -- no policy → service key only
