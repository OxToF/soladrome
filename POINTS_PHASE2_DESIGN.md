# Soladrome — Phase 2 Points (off-chain LP accrual)

> Status: **Design phase — not started in code.** Reference doc for the
> Gigadex-style points program that bootstraps mainnet liquidity BEFORE the
> ve(3,3) surface (vote/bribe/emissions) is armed. Off-chain by decision
> (2026-07-24): zero smart-contract risk, the AMM is the only on-chain surface
> that custodies user funds and it is audited independently.

---

## 0. What this is (and is not)

**The model (from Gigadex, adapted):** the community deposits real liquidity
into the AMM and farms **points** — no token is live yet. Points convert to the
Genesis airdrop allocation. Governance (vote/bribe/lock/claim) stays hidden
until Genesis; emissions stay disarmed on-chain (`emissions_enabled = false`,
see `set_phase_flags`). This lets us launch mainnet with community-seeded depth
and *without* waiting on bribe/LP partners — they join a market that is already
liquid.

**Not a ve(3,3) clone of Gigadex.** Gigadex permanently removed gauge votes and
bribe markets; Soladrome only **defers** them to Genesis. This points phase is a
temporary front-door, not a redesign of the token model. The interim steering
knob (§4, pool multipliers) is a centralized stand-in for gauge voting that we
hand back to the community at Genesis.

**Off-chain.** Points live in Supabase, computed by an indexer from on-chain LP
state. The frontend never decides points; a server job does, from chain truth.
The only thing this touches on-chain is *reading* pool/LP accounts.

---

## 1. What already exists — reuse, do not rebuild

Verified in the codebase (2026-07-24):

- **Points engine** — `supabase/quests.sql`: `quest_completions` table, the
  server-side `record_quest(wallet, quest)` RPC (points decided server-side,
  never trusted from client), RLS (writes only via the service key), and the
  `leaderboard` view with a built-in anti-sybil filter (only wallets with ≥1
  on-chain-verified quest surface). **Genesis-mission points already live here**
  → phase-2 carryover is free; we accrue on top, we do not migrate.
- **API pattern** — `app/app/api/track-quest/route.ts` reads on-chain state with
  the Anchor client + service-key Supabase write. `register-wallet`,
  `leaderboard`, `x-verify`, `discord` follow the same fire-and-forget, no-session
  shape. Copy this for the new routes; do not add a new Supabase client.
- **On-chain LP readability** — `app/lib/program.ts` exposes `poolPda`,
  `lpMintPda`, `vaultAPda`, `vaultBPda`; `LpUserInfo` PDA is `[b"lp_user", pool,
  user]` (see the `liquidity` quest in `track-quest`). `(program.account as
  any).ammPool.all()` enumerates pools. `app/lib/prices.ts` gives USD prices for
  TVL. **Everything the indexer needs to value LP is already derivable.**
- **Sybil tooling** — `app/sybil_report.json` + the existing wallet-verdict flow
  (`supabase/wallet_verdicts.sql`) are reusable for the value-weighted phase.

**The one true gap:** current points are **one-time binary awards**
(`unique(wallet, quest_id)`, e.g. `liquidity` = 20 pts once). Gigadex points are
**continuous, proportional to LP value × time × pool multiplier.** That accrual
engine (§2–§3) is the ~70% of net-new work.

---

## 2. Data model — three new tables (idempotent `supabase/points_phase2.sql`)

```sql
-- 2.1 Per-pool interim multiplier (the §4 steering knob). Authority-curated,
-- read by the snapshot job. Absent row = 1.0×.
create table if not exists pool_multipliers (
  pool_address text primary key,
  multiplier_bps int not null default 10000,   -- 10000 = 1.00×
  label        text,                            -- e.g. "jitoSOL-SOL launch boost"
  updated_at   timestamptz not null default now()
);

-- 2.2 The accrual ledger — one row per (wallet, pool), incremented each snapshot.
-- points_accrued is the running total; last_* let a snapshot be idempotent and
-- resumable (a crashed/duplicated run cannot double-credit an interval).
create table if not exists lp_points (
  wallet_address   text not null,
  pool_address     text not null,
  points_accrued   double precision not null default 0,
  last_value_usd   double precision not null default 0,  -- last observed LP value
  last_snapshot_at timestamptz not null default now(),
  primary key (wallet_address, pool_address)
);
create index if not exists idx_lp_points_wallet on lp_points (wallet_address);

-- 2.3 Snapshot audit log — one row per indexer run. Lets us prove the accrual
-- is reproducible for the eventual conversion, and detect gaps/overlaps.
create table if not exists lp_snapshots (
  id            bigint generated always as identity primary key,
  snapshot_at   timestamptz not null default now(),
  wallets_seen  int not null,
  total_tvl_usd double precision not null,
  ok            boolean not null default true,
  note          text
);
alter table pool_multipliers enable row level security;
alter table lp_points        enable row level security;
alter table lp_snapshots     enable row level security;
-- Public read of aggregates only (see the points view); writes via service key.
```

**Aggregate view for the Points page** (points genesis + LP accrual in one place):

```sql
create or replace view points_total as
  select w.wallet_address,
         coalesce(q.quest_points, 0)      as genesis_points,
         coalesce(l.lp_points, 0)         as lp_points,
         coalesce(q.quest_points, 0) + coalesce(l.lp_points, 0) as total_points
  from (select distinct wallet_address from lp_points
        union select distinct wallet_address from quest_completions) w
  left join (select wallet_address, sum(points) quest_points
             from quest_completions group by 1) q using (wallet_address)
  left join (select wallet_address, sum(points_accrued) lp_points
             from lp_points group by 1) l using (wallet_address)
  order by total_points desc;
```

---

## 3. The snapshot job — the core new work

A server job (Vercel Cron → `app/app/api/points/snapshot/route.ts`, or a Supabase
scheduled edge function) runs every **N** (start N = 1 h, matching Gigadex's hourly
rebalance). Each run:

1. **Enumerate pools:** `ammPool.all()`. For each, read `vault_a`/`vault_b`
   balances + the two mints' USD prices (`lib/prices.ts`) → **pool TVL** and
   **price per LP token** = `TVL / lpMint.supply`. Skip pools below a TVL floor.
2. **Enumerate participants sybil-resistantly** (§3.1): for each pool, the set of
   wallets with an `LpUserInfo` PDA. Value each = `lp_user.lp_amount ×
   price_per_lp`, **floored by the wallet's actual LP-token balance** (mirrors
   the on-chain `reward_basis` in `amm.rs`: the min of deposited-through-program
   and currently-held, so transferred-away LP stops earning and dusted LP never
   earns).
3. **Accrue:** for each (wallet, pool),
   `Δpoints = value_usd × elapsed_hours × (multiplier_bps / 10000) × RATE`,
   where `elapsed = now − last_snapshot_at` and `RATE` is a global points/USD/hour
   constant sized so the total distributable ≈ the phase-2 budget over the window
   (§5). Update `points_accrued`, `last_value_usd`, `last_snapshot_at`.
4. **Log** one `lp_snapshots` row. If the job overlaps a previous run (lock via a
   single-row advisory lock or `select … for update`), abort — never double-credit.

**Correctness invariant:** points are a function of `∫ value dt`. Because each
row carries `last_snapshot_at`, a missed run just means a longer `elapsed` next
time (no loss); a duplicated run is rejected by the lock (no double credit).
This is what makes the accrual reproducible for conversion.

### 3.1 Sybil-resistance — the part to get right

LP tokens are **freely transferable and stakable** (the on-chain code flags this
exact risk). So value-weighted points cannot be based on raw LP-token balance.
Layers, cheapest first:

- **Basis = `min(LpUserInfo.lp_amount, wallet LP-token balance) × price_per_lp`** —
  same trick the program already uses; the same tokens can't satisfy the min in
  two wallets at once, and dusted-in LP (balance without a deposit) yields 0.
- **Per-wallet cap** on `value_usd` counted per pool (dampens whale/self-LP
  dominance, mirrors the future per-address vote cap).
- **TVL floor per pool** (a pool nobody trades earns nothing — the honest signal,
  like Gigadex weighting by pool revenue).
- **Wash-trade / self-LP screen** — reuse `sybil_report.json` tooling; flag
  wallets that are both the dominant LP and the dominant swapper of a pool.
- **Eligibility gate** — only wallets that pass the existing `leaderboard`
  on-chain-verified filter accrue (keeps pure bots out from day 1).

> ⚠️ This is the section to spend the review budget on. Everything else is wiring;
> this is where points can be farmed if it is wrong. Bias toward under-counting an
> honest LP over letting wash-LP mint points.

---

## 4. Interim steering — the pool multiplier (the Gigadex "vol malin")

`pool_multipliers` lets the authority boost a pool (e.g. a strategic
jitoSOL-SOL pair) without needing a bribe partner — a centralized stand-in for
gauge voting during the points phase. Authority-curated (a tiny admin page or a
SQL update), read by the snapshot job. At Genesis this knob is **retired**: real
gauge voting + bribes take over, and the community/partners steer emissions.
Keep the multiplier history in `lp_snapshots.note` or a small audit table so the
conversion is defensible ("why did pool X earn more").

---

## 5. Budget, carryover & conversion

- **Budget:** carve the phase-2 points pool from the **Airdrop (50)** bucket (do
  not invent a new allocation — see [ops-fund removal] lesson). Size `RATE` so
  `Σ points_accrued` over the window maps cleanly to that bucket.
- **Carryover:** genesis-mission points are already in `quest_completions`; the
  `points_total` view (§2) sums them with LP accrual. No migration.
- **Conversion:** stays a **token decision, announced before Genesis** (exactly
  Gigadex: "redemption details before Genesis"). Do NOT hard-code a conversion
  rate on-chain now. When set, apply **vesting / anti-dump** on the converted
  allocation — a points program with instant liquid conversion farms mercenaries
  who dump at TGE. This is the single most important non-code decision here.

---

## 6. Frontend

- **Points page** (new nav entry, replaces the hidden Governance group in the
  points phase): render `points_total` for the connected wallet — genesis points,
  LP points, breakdown by pool, live pool multipliers, projected share of the
  budget, total distributed. Largely a wiring job over existing
  `Leaderboard.tsx` / `Portfolio.tsx` / `Airdrop.tsx`.
- **Nav gating already shipped** (2026-07-24, `app/app/page.tsx`): Vote/Bribe/
  Claim/Arb are hidden until their on-chain phase flag is armed; a "Governance
  unlocks at Genesis" teaser shows in the points phase. The Points page slots in
  where they were.
- No new wallet primitive required (points are read-only from the user's side).

---

## 7. Work estimate (recap)

| Lot | Effort | Note |
|---|---|---|
| Snapshot/accrual engine (§2–§3) | ~3–4 d | the real work; §3.1 is the risk |
| Pool multiplier + admin (§4) | ~0.5 d | small SQL + optional admin UI |
| Points page (§6) | ~1 d | wiring over existing components |
| Nav gating (§6) | ✅ done | shipped 2026-07-24 |
| Budget/carryover/conversion view (§5) | ~0.5 d | view + formula; conversion = token decision |
| Anti-sybil hardening (§3.1) | ~0.5–1 d | reuse `sybil_report.json` |

**Total ≈ 1–1.5 weeks solo**, dominated by the accrual engine. No contract
change (the `emissions_enabled` gate that keeps emission dormant during this
phase is already in the program — `set_phase_flags`).

---

## 8. Open decisions before coding

1. **Snapshot cadence N** — start hourly (Gigadex parity); can widen to reduce RPC.
2. **`RATE` sizing** — needs the phase-2 budget number and the window length.
3. **Per-wallet value cap** — pick a cap (or a diminishing curve) for §3.1.
4. **Conversion terms + vesting** — token decision, before Genesis, not now.
5. **Points page vs Airdrop page** — merge into one "Points" destination or keep
   Airdrop separate? (Recommend one destination to avoid a confusing split.)
