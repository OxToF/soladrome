-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (C) 2025 Soladrome Labs
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

  -- Referrals are repeatable: a referrer earns +25 per unique referred wallet,
  -- not once total. quest_completions' unique(wallet, quest_id) constraint would
  -- cap a plain 'referral' id at one row per referrer, so each successful
  -- referral is recorded under its own `referral:<referred_wallet>` id instead
  -- (app/api/track-quest/route.ts, maybeRewardReferrer) — matched here by prefix.
  if p_quest like 'referral:%' then
    v_points := 25;
    insert into quest_completions (wallet_address, quest_id, points)
    values (p_wallet, p_quest, v_points)
    on conflict (wallet_address, quest_id) do nothing;
    return;
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
    when 'like_video'   then 5  -- social: like the genesis video (honor-system)
    when 'repost_video' then 10 -- social: repost the genesis video (honor-system)
    when 'discord'   then 10   -- social: register on the Discord server (honor-system)
    when 'solana_id' then 50   -- ecosystem: minted Solana ID NFT (verified via Score API)
    when 'claim_lp_osola' then 15 -- genesis II: claimed LP's oSOLA emissions
    when 'claim_bribe'    then 15 -- genesis II: claimed a gauge-vote bribe reward
    when 'borrow_again'   then 15 -- genesis II: borrowed again (verified on-chain, see track-quest)
    when 'exercise'       then 20 -- genesis II: exercised oSOLA -> SOLA
    when 'vote_again'     then 20 -- genesis II: voted again (verified on-chain, see track-quest)
    when 'like_video2'    then 5  -- genesis II: like explainer video 2 on X (honor-system)
    when 'repost_video2'  then 10 -- genesis II: repost explainer video 2 on X (honor-system)
    when 'like_bridge'    then 5  -- social: like the ve(3,3) bribe bridge thread (honor-system)
    when 'repost_bridge'  then 10 -- social: quote the bribe bridge thread (x-verified, see x-verify route)
    when 'like_fbomb'     then 5  -- social: like the MLCB x fBOMB alliance post (honor-system)
    when 'repost_fbomb'   then 10 -- social: quote the fBOMB alliance post (x-verified, see x-verify route)
    when 'truemrr'        then 20 -- ecosystem: voted for Soladrome on TrueMRR (honor-system)
    when 'meme_contest'   then 10 -- contest: submitted a Soladrome meme on X (verified via /api/meme-verify).
                                  -- PARTICIPATION points only — the 50 SOLA x5 prize is judged manually
                                  -- (views/engagement/aesthetics) and paid out-of-band, like the bug bounty.
    -- 'referral:<wallet>' (repeatable, one per referred wallet) is handled above,
    -- before this case — awarded SERVER-SIDE only when a referred wallet becomes
    -- a verified on-chain Genesis Tester. Not a POSTable id → can't be self-farmed.
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
-- (stake/borrow/vote/vote_again/borrow_again) appear. Those quests are checked
-- against chain state at write time (app/api/track-quest), so they can't be
-- forged — whereas connect/faucet/swap/etc. are cheap and bot-spammable. This
-- keeps pure connect/faucet bots off the board for good, with no per-request RPC.
create or replace view leaderboard as
  select wallet_address,
         sum(points)::int   as points,
         count(*)::int      as quests,
         max(completed_at)  as last_active
  from quest_completions
  group by wallet_address
  having bool_or(quest_id in ('stake', 'borrow', 'vote', 'vote_again', 'borrow_again'))
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

-- ── 4b. X (Twitter) quote-tweet verification ledger ─────────────────────────
-- Each verified quote tweet is consumed exactly once. Without this, a farmer
-- could put many wallets' deterministic codes into ONE quote tweet and POST the
-- same URL for each wallet — every call would pass oEmbed verification and mint
-- points. Binding the tweet_id to the FIRST wallet that claims it caps a single
-- post at a single wallet, so real per-wallet friction (one genuine post each)
-- is required. Idempotent re-submits by the same wallet still succeed.
create table if not exists x_verifications (
  tweet_id       text        primary key,
  wallet_address text        not null,
  quest_id       text        not null,
  created_at     timestamptz not null default now()
);
alter table x_verifications enable row level security; -- no policy → service key only

-- Claim a tweet for a wallet. Returns true only if the tweet is now bound to
-- THIS wallet (either we just inserted it, or this wallet already owned it).
-- A different wallet having claimed it first returns false → no credit.
create or replace function claim_x_tweet(p_tweet text, p_wallet text, p_quest text)
returns boolean
language plpgsql
security definer
as $$
declare
  v_owner text;
begin
  insert into x_verifications (tweet_id, wallet_address, quest_id)
  values (p_tweet, p_wallet, p_quest)
  on conflict (tweet_id) do nothing;

  select wallet_address into v_owner from x_verifications where tweet_id = p_tweet;
  return v_owner = p_wallet;
end;
$$;

-- ── 4c. Meme contest submissions ────────────────────────────────────────────
-- The meme contest is a JUDGED event, not an auto-credited quest: the tester
-- posts a meme on X tagging @soladrome (that's what wins the 5x 50 SOLA prize,
-- picked manually by views/engagement/aesthetics and paid out-of-band, like the
-- bug bounty) AND shares the image in the #memes-art Discord channel with their
-- wallet. Validation happens on the DISCORD side (app/app/api/meme-verify): an
-- X post can't be checked for a real drawing via keyless oEmbed, but a Discord
-- message can be fetched with the bot token and inspected for an image
-- attachment. This table is the entry ledger the jury reviews.
--
-- An entry now has TWO parts: the X post (judged for the prize) and the Discord
-- image share (validates the drawing + binds the wallet). Both are required and
-- both links are stored: `url` = Discord message link, `x_url` = the X post link.
-- The `tweet_id` column (kept for schema stability) holds the DISCORD MESSAGE id
-- and is the dedup key. Unlike x_verifications (one row per wallet's single
-- quote), a wallet MAY enter several memes, so we keep one row PER message.
-- Points-wise, record_quest('meme_contest') is still one-shot per wallet
-- (quest_completions' unique constraint), so extra memes don't farm points —
-- they just add more contest entries.
--
-- Anti-abuse: the Discord message must carry an image attachment AND the wallet
-- address, and each message id is bound to the FIRST wallet that claims it, so
-- someone else's message can't be re-submitted to credit another wallet. The X
-- post is verified (exists + tags @soladrome) but NOT wallet-bound — final
-- winners are picked manually, so post theft is caught by the jury.
--
-- Jury query (Supabase SQL editor): list every entry newest first —
--   select x_url, url as discord_link, wallet_address, created_at
--   from meme_submissions order by created_at desc;
create table if not exists meme_submissions (
  tweet_id       text        primary key, -- Discord message id (name kept for stability)
  wallet_address text        not null,
  url            text        not null,    -- Discord message link
  x_url          text,                    -- X post link (added 2026-07-28, two-part flow)
  created_at     timestamptz not null default now()
);
create index if not exists idx_meme_submissions_wallet on meme_submissions (wallet_address);
-- Idempotent add for tables created before the two-part flow landed.
alter table meme_submissions add column if not exists x_url text;
alter table meme_submissions enable row level security; -- no policy → service key only

-- Claim a meme entry for a wallet. Returns true only if the message is now bound
-- to THIS wallet (either we just inserted it, or this wallet already owned it). A
-- different wallet having claimed it first returns false → no credit, no entry.
-- Dropped-then-recreated because the arg list grew (added p_x_url) — a bare
-- create-or-replace with new params would make an overload, not a replacement.
drop function if exists claim_meme_submission(text, text, text);
create or replace function claim_meme_submission(p_tweet text, p_wallet text, p_url text, p_x_url text)
returns boolean
language plpgsql
security definer
as $$
declare
  v_owner text;
begin
  insert into meme_submissions (tweet_id, wallet_address, url, x_url)
  values (p_tweet, p_wallet, p_url, p_x_url)
  on conflict (tweet_id) do nothing;

  select wallet_address into v_owner from meme_submissions where tweet_id = p_tweet;
  return v_owner = p_wallet;
end;
$$;

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
