-- SPDX-License-Identifier: GPL-3.0-or-later
-- Copyright (C) 2025 Soladrome Labs
--
-- Soladrome — Phase 2 Points (off-chain LP accrual). See POINTS_PHASE2_DESIGN.md.
-- Run once in the Supabase SQL editor. Idempotent: safe to re-run.
--
-- Design invariants enforced here:
--   • Points are decided SERVER-SIDE. The anon key can never write points; all
--     mutations go through SECURITY DEFINER RPCs called with the service key
--     (same pattern as quests.sql/record_quest). Public gets read-only views.
--   • Accrual is idempotent+resumable: each (wallet,pool) row carries
--     last_snapshot_at, so a missed snapshot only widens the next interval and a
--     duplicated run is rejected by the snapshot lock (§ below) — no double credit.

-- ── 1. Per-pool interim multiplier ───────────────────────────────────────────
-- The Gigadex-style steering knob: authority-curated, read by the snapshot job.
-- Absent row = 1.00× (DEFAULT_MULTIPLIER_BPS in app/lib/points.ts). Retired at
-- Genesis when real gauge voting takes over.
create table if not exists pool_multipliers (
  pool_address text primary key,
  multiplier_bps int not null default 10000 check (multiplier_bps >= 0 and multiplier_bps <= 1000000),
  label        text,
  updated_at   timestamptz not null default now()
);

-- ── 2. Accrual ledger — one row per (wallet, pool) ───────────────────────────
-- points_accrued is the running total; last_* make each snapshot idempotent and
-- resumable (elapsed is computed from last_snapshot_at, never trusted from client).
create table if not exists lp_points (
  wallet_address   text not null,
  pool_address     text not null,
  points_accrued   double precision not null default 0,
  last_value_usd   double precision not null default 0,
  last_snapshot_at timestamptz not null default now(),
  primary key (wallet_address, pool_address)
);
create index if not exists idx_lp_points_wallet on lp_points (wallet_address);

-- ── 3. Snapshot audit log — one row per indexer run ──────────────────────────
create table if not exists lp_snapshots (
  id            bigint generated always as identity primary key,
  snapshot_at   timestamptz not null default now(),
  wallets_seen  int not null default 0,
  pools_seen    int not null default 0,
  total_tvl_usd double precision not null default 0,
  points_added  double precision not null default 0,
  ok            boolean not null default true,
  note          text
);

-- ── 4. Single-flight snapshot lock ───────────────────────────────────────────
-- Row-based (NOT pg_advisory — Supabase pooling is transaction-mode, so session
-- advisory locks don't hold across statements). acquire_snapshot_lock returns
-- true only if the previous lease has expired; the job aborts on false, so two
-- overlapping cron runs can never both accrue the same interval.
create table if not exists points_locks (
  name         text primary key,
  locked_until timestamptz not null default now()
);

create or replace function acquire_snapshot_lock(p_ttl_seconds int)
returns boolean language plpgsql security definer as $$
declare
  v_ok boolean;
begin
  insert into points_locks (name, locked_until)
  values ('lp_snapshot', now() + make_interval(secs => greatest(p_ttl_seconds, 1)))
  on conflict (name) do update
    set locked_until = excluded.locked_until
    where points_locks.locked_until < now()   -- only steal an EXPIRED lease
  returning true into v_ok;
  return coalesce(v_ok, false);
end; $$;

create or replace function release_snapshot_lock()
returns void language plpgsql security definer as $$
begin
  update points_locks set locked_until = now() where name = 'lp_snapshot';
end; $$;

-- ── 5. Mutations (service key only) ──────────────────────────────────────────
-- Upsert a pool multiplier.
create or replace function set_pool_multiplier(p_pool text, p_bps int, p_label text)
returns void language plpgsql security definer as $$
begin
  if p_pool is null or length(p_pool) < 32 or length(p_pool) > 44 then return; end if;
  if p_bps is null or p_bps < 0 then return; end if;
  insert into pool_multipliers (pool_address, multiplier_bps, label, updated_at)
  values (p_pool, p_bps, p_label, now())
  on conflict (pool_address) do update
    set multiplier_bps = excluded.multiplier_bps,
        label          = coalesce(excluded.label, pool_multipliers.label),
        updated_at     = now();
end; $$;

-- Add `p_add` points to a (wallet,pool) and stamp the snapshot time. `p_add` is
-- computed server-side by the snapshot job from on-chain value × elapsed ×
-- multiplier — this RPC only persists it, clamping negatives to 0.
create or replace function accrue_lp_points(
  p_wallet text, p_pool text, p_add double precision, p_value_usd double precision
) returns void language plpgsql security definer as $$
begin
  if p_wallet is null or length(p_wallet) < 32 or length(p_wallet) > 44 then return; end if;
  if p_pool   is null or length(p_pool)   < 32 or length(p_pool)   > 44 then return; end if;
  if p_add is null or p_add < 0 then p_add := 0; end if;
  insert into lp_points (wallet_address, pool_address, points_accrued, last_value_usd, last_snapshot_at)
  values (p_wallet, p_pool, p_add, coalesce(p_value_usd, 0), now())
  on conflict (wallet_address, pool_address) do update
    set points_accrued  = lp_points.points_accrued + p_add,
        last_value_usd   = coalesce(p_value_usd, 0),
        last_snapshot_at = now();
end; $$;

-- Record one snapshot-run audit row.
create or replace function record_lp_snapshot(
  p_wallets int, p_pools int, p_tvl double precision, p_added double precision,
  p_ok boolean, p_note text
) returns void language plpgsql security definer as $$
begin
  insert into lp_snapshots (wallets_seen, pools_seen, total_tvl_usd, points_added, ok, note)
  values (coalesce(p_wallets,0), coalesce(p_pools,0), coalesce(p_tvl,0),
          coalesce(p_added,0), coalesce(p_ok,true), p_note);
end; $$;

-- ── 6. Public read surface ───────────────────────────────────────────────────
-- Combined points = genesis-mission quests (quest_completions) + LP accrual.
-- No migration of genesis points: they already live in quest_completions.
create or replace view points_total as
  select w.wallet_address,
         coalesce(q.genesis_points, 0)               as genesis_points,
         coalesce(l.lp_points, 0)                     as lp_points,
         coalesce(q.genesis_points, 0) + coalesce(l.lp_points, 0) as total_points,
         l.pools                                      as lp_pools
  from (select wallet_address from lp_points
        union select wallet_address from quest_completions) w
  left join (select wallet_address, sum(points)::int as genesis_points
             from quest_completions group by wallet_address) q using (wallet_address)
  left join (select wallet_address, sum(points_accrued) as lp_points, count(*)::int as pools
             from lp_points group by wallet_address) l using (wallet_address)
  order by total_points desc;

-- Per-pool multiplier board (public — feeds the Points page "boosted pools").
create or replace view pool_multiplier_board as
  select pool_address, multiplier_bps, label, updated_at
  from pool_multipliers
  order by multiplier_bps desc, updated_at desc;

-- ── 7. Row Level Security ─────────────────────────────────────────────────────
-- Tables: no anon write policy → writes only via the SECURITY DEFINER RPCs with
-- the service key. Views are read by the API; expose read on the underlying rows
-- that feed public views, nothing that lets a client forge points.
alter table pool_multipliers enable row level security;
alter table lp_points        enable row level security;
alter table lp_snapshots     enable row level security;
alter table points_locks     enable row level security;

drop policy if exists "lp_points read"       on lp_points;
create policy "lp_points read"       on lp_points       for select using (true);
drop policy if exists "pool_mult read"       on pool_multipliers;
create policy "pool_mult read"       on pool_multipliers for select using (true);
-- lp_snapshots / points_locks: no policy → service key only (internal telemetry).
