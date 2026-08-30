# Soladrome — Tokenomics
**Version 1.2 — 2026-06-03**
*Prior art disclosure. All rights reserved.*

---

## Overview

Soladrome has three native tokens: **SOLA** (base), **hiSOLA** (staked governance), and **oSOLA** (call-option rewards). There is no ICO, no presale. All tokens enter circulation through on-chain mechanisms with no off-chain discretion.

Strategic allocations (founder, partners, contributors) are minted via dedicated on-chain instructions with enforced vesting schedules and borrow caps. None of these allocations are added to `total_purchased_sola` — they cannot deplete the floor vault via `sell_sola`.

---

## 1. SOLA — Supply Mechanics

SOLA is minted through four paths:

| Path | Mechanism | Floor backing |
|---|---|---|
| User purchase | `buy_sola` — pay USDC, receive SOLA via bonding curve | ✅ 1 USDC per SOLA → `floor_vault` |
| oSOLA exercise | `exercise_o_sola` — burn oSOLA + pay 1 USDC, receive 1 SOLA | ✅ 1 USDC per SOLA → `floor_vault` |
| Founder / contributor / partner vesting | `claim_founder_hi_sola`, `claim_contributor_hi_sola`, `claim_partner_allocation` — SOLA to `sola_vault`, hiSOLA to beneficiary | ❌ No floor backing (SOLA locked as hiSOLA) |
| Ecosystem / operational | `mint_ecosystem_allocation` — liquid SOLA to authority wallet | ❌ No floor backing |

**Every user-purchased SOLA is backed 1:1 by USDC in `floor_vault`.**

### 1.1 Bonding Curve Parameters

```
Virtual USDC reserve (init):  100 USDC  (100,000,000 base units)
Virtual SOLA reserve (init):  100 SOLA  (100,000,000 base units)
K = 100e6 × 100e6 = 10,000,000,000,000,000  (fixed forever)

Spot price at init:    1.00 USDC/SOLA (floor)
Spot price at 1k buy:  ≈1.01 USDC/SOLA
Spot price at 10k buy: ≈1.10 USDC/SOLA
Spot price at 100k buy:≈2.00 USDC/SOLA
```

The price premium above 1.0 USDC/SOLA flows entirely to `market_vault` and is distributed to hiSOLA stakers.

---

## 2. Token Allocations

### 2.1 Founder Allocation — 12,250,000 SOLA total

| Tranche | Amount | Token | Cliff | Vesting | Mechanism |
|---|---|---|---|---|---|
| Governance | 7,000,000 | hiSOLA | 6 months | 24 months linear | `claim_founder_hi_sola` |
| Options | 5,000,000 | oSOLA | 6 months | 24 months linear | `claim_founder_vesting` |
| Liquid operational | 250,000 | SOLA | None | Immediate | `mint_ecosystem_allocation` |

**Governance tranche (7M hiSOLA):**
Each `claim_founder_hi_sola` call mints SOLA to `sola_vault` AND hiSOLA 1:1 to the founder wallet, which goes straight into a **lifetime ve escrow**. The only liquidity path is `borrow_against_locked` (USDC borrowed against the escrowed position, 0% interest, no liquidation), capped at **20%** (`PARTNER_BORROW_CAP_BPS = 2000`) — the same valve every ve-locker gets, because the tranche is unfinanced supply. Borrowing, not selling, funds operations while the floor vault grows organically.

The dedicated `founder_borrow_usdc` instruction and its `FOUNDER_BORROW_CAP_BPS` constant were **removed on 2026-07-18**: once the 7M are escrowed the founder's wallet balance is zero, so a balance-based cap could never pass anyway. The same applies to `contributor_borrow_usdc`. Any borrow figure derived from those instructions is obsolete.

The founder wallet is also **non-voting by default** (`founder_voting_enabled = false`): the governance tranche is a dormant anti-capture reserve, votable only via the authority break-glass `set_founder_voting`.

**Options tranche (5M oSOLA):**
Each exercise of `exercise_o_sola` adds 1 USDC to `floor_vault` — every option conversion structurally strengthens the floor for all users.

**Team tranche (250k):**
Minted by `mint_ecosystem_allocation` to a **separate team wallet** (`BVaJbgw3NF7Ng28sHorBnzJrHgvu7S3L5wpdB6923LjA`), distinct from the founder wallet.

⚠️ It is **not liquid SOLA** — that was the largest floor-drain vector in the protocol and it was closed on 2026-07-17. It is hiSOLA written straight into a **lifetime ve lock** (`permanent_amount` covers the whole tranche), so `unlock_hi_sola` can never release it and `sell_sola` can never reach it. Being a distinct wallet from the founder's, it **votes** as an ordinary position (up to 4×), it borrows 20% through `borrow_against_locked` — and since 2026-08-27 it **earns protocol fees** (`fee_shares`), because a bag locked for life had a fee basis of zero that could never become anything else, which made a tranche whose whole purpose is to pay people pay them nothing.

### 2.2 Protocol Partner Allocations

On-chain instructions: `register_partner` (authority-only) + `fund_partner_bribe_stream` (partner)
+ `claim_partner_allocation` (partner) + `crank_partner_epoch` (permissionless).
PDAs: `[b"partner", partner_wallet]`, `[b"bribe_stream", partner_wallet]`

**A signature bag, then a retainer (2026-08-27).** The 1:1 bribe match is gone. It priced hiSOLA
against a partner's token at a base-unit ratio **frozen for life** at registration, with no oracle
to correct it and no clock to pace it — `total_bribed_credited` was a lifetime counter, so a year
of committed bribes could all land in week one. And since `close_partner_allocation` rightly
cannot revoke once a claim has happened, a bad rate was permanent.

What replaces it is a different instrument, not a smaller version of the same one:

- **Signature bag** (`base_hi_sola`) — delivered whole, once, the moment the partner escrows their
  bribe schedule. It is the only unconditional part of the deal, which is why it is the small one.
- **Retainer** (`retainer_per_epoch`) — credited one epoch at a time by `crank_partner_epoch`, for
  every epoch the partner still holds `lp_threshold` of `lp_mint`. **No total, no cap, no end
  date.**

A vesting promises a total on day one and releases it in slices; a retainer has no total, only a
rate, and each epoch is bought separately against something verified at that moment. A partner who
leaves after ten epochs has forfeited nothing — there never was a remainder — and one who stays
three years is paid for three years.

| Tier | LP committed | Signature bag | Retainer / epoch | At 52 epochs | Ratio |
|---|---|---|---|---|---|
| 1 | $1M | 20,000 | 3,450 | 199,400 | 19.9% |
| 2 | $500K | 7,500 | 1,300 | 75,100 | 15.0% |
| 3 | $200K | 2,000 | 350 | 20,200 | 10.1% |

Amounts in hiSOLA. **The "at 52 epochs" column is an illustration at one year, not a promised
total.** The previous scale (10 / 24 / 25% of committed LP) was replaced because its gradient was
flat between tiers 1 and 2 — a partner had no reason to double their liquidity.

**Mechanism:**
- `fund_partner_bribe_stream` — the partner escrows `schedule_epochs × amount_per_epoch` of their
  committed `bribe_mint` in one signature. Length and minimum size are terms of the deal, fixed at
  registration (`ScheduleLengthMismatch`, `ScheduleUnderfunded`). **This is the gate:** until it
  runs, `stream_start_ts` is 0 and neither the bag nor a single epoch of retainer accrues.
- `claim_partner_allocation` — delivers the bag, once, into the ve lock as `permanent_amount`.
- `crank_partner_epoch` — permissionless, one call per epoch, and it does both halves:
  - the escrowed **bribe tranche** goes to that epoch's gauge voters, **whether or not** the
    liquidity condition holds — it is money that already belongs to them;
  - the **retainer** is credited only if `partner_lp_token.amount >= lp_threshold`.
- **Fee dilution: yes, and deliberately.** `total_hi_sola` grows by every credit, matched by
  `fee_shares` on the partner's position. The share is real rather than printed: existing holders
  are diluted by exactly what the partner receives.
- **Liquidity without selling**: wallet hiSOLA stays 0, so `borrow_against_locked` draws up to
  **20%** (`PARTNER_BORROW_CAP_BPS = 2000`) of the locked position from `floor_vault` (2% fee, 75%
  floor buffer, repayable, no liquidation).
- **Nothing is ever releasable.** Bag and retainer are both `permanent_amount`, so `unlock_hi_sola`
  releases nothing at any date and unfinanced supply can never be sold at a floor it never funded.

☢️ **A missed epoch is lost, not deferred.** The bribe side slips — the schedule simply runs one
epoch longer — but the retainer cannot: the chain keeps no history of an SPL balance, so it is
impossible to establish afterwards that the LP was present five epochs ago. The crank *is* the
attestation, which is why the front-end fires it.

⚠️ **What the attestation proves, and what it does not.** It proves the balance existed at the
instant of the crank. A partner cranking their own epoch can hold the LP for exactly that
transaction — add liquidity, crank, remove liquidity — and the program cannot tell. Closing that
would require custody of the LP, which is the one thing this deal promises not to take. What
remains is a counterparty the authority registered by hand, a manoeuvre legible on-chain to anyone
reading the pool, and a renewal the authority can decline. **Reputational, not cryptographic.**

**Voting power growth via rewards flywheel:**
Partners earn oSOLA through LP emissions on their pools (JitoSOL/SOLA, mSOL/SOLA, etc.). They can burn oSOLA during `vote_gauge` calls to earn uncapped `o_sola_bonus` voting power on top of their ve-locked allocation. Each oSOLA burned also strengthens the floor vault — an aligned incentive structure.

### 2.3 Ecosystem Allocation — 1,750,000 oSOLA

⚠️ **Not SOLA, and not minted by `mint_ecosystem_allocation`** — both were true until 2026-07-17
and this section said so until 2026-08-27. Liquid SOLA distributed by direct SPL transfer was the
single largest floor-drain vector in the protocol: 1.75M of supply never added to
`total_purchased_sola`, yet redeemable 1:1 against a floor funded entirely by real buyers.

The budget is now issued exclusively as **oSOLA** through `distribute_o_sola`, with the cumulative
total enforced on-chain by `ProtocolState.ecosystem_o_sola_minted` against `ECOSYSTEM_TOTAL`
(`EcosystemBudgetExceeded`). The holder pays 1 USDC into `floor_vault` to exercise, so every SOLA
that reaches circulation through this budget is financed the moment it exists.

| Envelope | Amount | Notes |
|---|---|---|
| Genesis airdrop | 200,000 | Devnet testers, at TGE |
| Farm points | 750,000 | Pre-TGE LP |
| Reserve | 800,000 | Unallocated, V2 |

Split settled 2026-08-26, replacing the 50 / 25 / 12.5 / 12.5 percentages that predated the move to
oSOLA. `ECOSYSTEM_TOTAL` is unchanged at 1.75M — the alternative (200K + 750K + 1.5M = 2.45M) would
have needed the constant raised by 700K, a redeploy, and a full republication of the tokenomics.

There is **no separate operations fund** (a 175K "Operations & Management Fund" was considered
2026-07-14 and dropped 2026-07-18): operational costs ride the team tranche's 20% borrow line and
oSOLA-denominated payments from the envelopes above.

### 2.4 Contributor / Service Provider Allocation

On-chain instruction: `register_contributor` (authority-only) + `claim_contributor_hi_sola` / `claim_contributor_vesting`.
PDAs: `[b"contributor", contributor_wallet]`, `[b"contributor_registry"]`

⚠️ **There is no cliff and no vesting.** The schedule was removed on 2026-07-18 and both tranches
are claimable in full immediately; the table of "1 month cliff / 12 months linear" that stood here
until 2026-08-27 described a mechanism that had not existed for six weeks. `ContributorVesting` is
the last trace of the name.

| Tranche | Delivery | Regime |
|---|---|---|
| hiSOLA | All at once | Lifetime ve lock — votes up to 4×, **earns protocol fees**, borrows 20% |
| oSOLA | All at once | An option: 1 USDC per unit into the floor to exercise |

**Two `require!`s, both added 2026-08-27:**
- **A cumulative cap** — 100,000 hiSOLA and 100,000 oSOLA, summed over every contributor ever
  registered, counted in the `contributor_registry` singleton. There was no bound of any kind
  before: the only limit on what could be promised was the field the authority typed into. That
  was survivable while the tranche earned nothing; now that it earns fees it is unbounded dilution
  of every staker.
- **A 50/50 split** — the two sides are not interchangeable. hiSOLA is permanent governance plus a
  real share of revenue; oSOLA is an option the holder pays 1 USDC a unit to exercise, financing
  the floor as they do. One without the other is either pure dilution or a pure lottery ticket.

The hiSOLA side earning fees is what makes the bag worth anything: it is locked for life, so
`hi_sola` is 0, and it was never bought through the curve, so `staked_amount` is 0 — its fee basis
was 0 and, the lock being permanent, could never become anything else. Someone who funds an audit
would have received governance and no yield whatsoever.

Used sparingly — a handful of individuals, small amounts. KOLs and contest winners are paid in
**oSOLA** via `distribute_o_sola`, drawing on the capped ecosystem budget above.

### 2.5 Summary Table

| Category | hiSOLA | oSOLA | Lock | Vote | Fees | Borrow | Financed |
|---|---|---|---|---|---|---|---|
| User purchases (curve) | Unlimited | — | none | yes | yes | 100% | yes |
| Founder governance | 7,000,000 | — | for life | **no** | **no** | 20% | no |
| Founder options | — | 5,000,000 | 6m cliff / 24m vest | n/a | n/a | n/a | at exercise |
| Team | 250,000 | — | for life | yes, 4× | yes | 20% | no |
| Contributors | ≤ 100,000 | ≤ 100,000 | for life / immediate | yes, 4× | yes | 20% | half |
| Protocol partners | per tier, ~410,000 at a year | — | for life | yes, 4× | yes | 20% | no |
| Ecosystem | — | 1,750,000 | none | n/a | n/a | n/a | at exercise |
| LP emissions | — | Ongoing | none | n/a | n/a | n/a | at exercise |

**Nothing unfinanced is ever liquid SOLA.** Every allocation above that was not paid for through
the curve is locked for life, so the drain via `sell_sola` is **zero** and the only valve is
`borrow_against_locked` at 20%. Aggregate borrow exposure is 20% × Σ(unfinanced) ≈ 1.55M in theory,
but `FLOOR_RESERVE_MIN_BPS` bounds all borrowing to 25% of SOLA actually purchased through the
curve — so it does not bind until ~6.2M has been bought. **Publish that number, not the caps.**

**Fee dilution is the real cost, and it decreases.** After a year of maintained liquidity the
unfinanced allocations that earn fees total ~760,000 of basis (410K partner retainers, 250K team,
100K contributors — the founder's 7M earns nothing). Against a growing organic base that is 72% of
the fee stream at price ×2, 53% at ×10, 28% at 2M purchased, 13% at 5M. The amounts are fixed and
the share falls: a large share of a small pie becoming a small share of a large one. Stated
plainly, an allocation is a call option on the protocol succeeding, paid in dilution rather than in
cash the protocol does not have.

---

## 3. Revenue Flows

```
User buys SOLA
  └─► floor_amount USDC → floor_vault (floor backing)
  └─► (usdc_in - floor_amount) USDC → market_vault (fee premium)

AMM swap
  └─► swap_fee × protocol_fee_share → market_vault

borrow_usdc / borrow_against_locked
  └─► 2% origination fee → market_vault

flash_arbitrage
  └─► 90% of profit → market_vault
  └─► 10% of profit → caller

market_vault
  └─► pro-rata → hiSOLA stakers (reward-per-token accumulator)
  └─► pol_split_bps % → pol_usdc_vault (Protocol-Owned Liquidity)
```

---

## 4. Floor Reserve Mechanics

The floor reserve is the central invariant of Soladrome:

```
floor_vault.balance ≥ total_purchased_sola × (1 - borrow_utilization)
```

More precisely, the on-chain invariant after every sell:
```
floor_vault_post + total_usdc_borrowed ≥ total_purchased_sola
```

**Floor reserve buffer:** Borrowing is limited so that `floor_vault ≥ 75% × total_purchased_sola` at all times (`FLOOR_RESERVE_MIN_BPS = 7500`). At most 25% of the floor can be lent out simultaneously.

**Partner borrow protection:** Partner hiSOLA is locked in `ve_lock_vault` → wallet balance = 0 → standard `borrow_usdc` naturally blocks any borrow for the full lock duration. This is a protocol-level guarantee, not a social promise.

**Guarantee:** Every holder of user-purchased SOLA can always redeem at minimum floor price (1 USDC). The worst-case scenario where 25% of the floor is deployed still leaves 75% of SOLA redeemable immediately.

---

## 5. oSOLA Emission Schedule

oSOLA is not pre-minted (except contributor/partner/founder vesting tranches). It is distributed as LP rewards through two complementary mechanisms:

**Masterchef (continuous, per-pool) — FLAT, it does not decay:**
- `ProtocolState.continuous_rate_per_sec` per approved pool per second, set at runtime by
  `configure_continuous_emissions` and bounded by an on-chain expiry epoch. It is **0 at
  `initialize`**, so the stream is off until the authority turns it on.
- Distributed proportionally to LP share within each pool
- Updates lazily on every add/remove/claim interaction
- ⚠️ **It is a flat rate for as long as it runs — the decay below belongs to the epoch system
  only.** It also **multiplies** with the number of approved pools (`rate × elapsed`, computed
  per pool), where the epoch pot **divides** between them. Two different shapes; do not reason
  about one from the other.
- (This used to be a compile-time `OSOLA_EMISSION_PER_SEC` constant. It is not one any more,
  and there is no constant to look up.)

**Epoch-based (governance-weighted, decaying):**
- Initial emission: `osola_emission_initial` — **20,000 oSOLA/epoch**, written by `initialize`
- Split across pools proportionally to hiSOLA gauge vote weight
- **Automatic exponential decay** each epoch: `emission × (osola_emission_decay_bps / 10_000)`
  - Default: 9,900 bps = −1 %/epoch (≈ −40 %/year)
  - Floor: `osola_emission_floor_bps` % of initial — default 25 % (emissions never reach zero)
- Authority can reset the curve at any time via `configure_emissions` (Squads multisig)

**Emission schedule (20,000 oSOLA launch, −1 %/epoch, floor 5,000):**

| Epoch | Timeline | oSOLA / epoch | Per pool (5 pools, equal votes) |
|---|---|---|---|
| 0 | Launch | 20,000 | 4,000 |
| 13 | 3 months | 17,550 | 3,510 |
| 26 | 6 months | 15,401 | 3,080 |
| 52 | 1 year | 11,859 | 2,372 |
| 104 | 2 years | 7,032 | 1,406 |
| ~137 | ~2.6 years | 5,047 → 5,000 (floor) | ~1,000 |

Early LPs capture the highest yield. The floor of 5,000 oSOLA/epoch guarantees perpetual incentives. Override via `configure_emissions` (Squads multisig) at any time.

**No APR is quoted here on purpose.** An oSOLA is an option, not a token: burning it costs the 1 USDC floor, so its intrinsic value is `P − 1`, not `P`. At launch `P = 1` exactly and oSOLA is worth zero — no emission size produces any yield until the curve moves. Any APR figure is therefore a function of the SOLA price, and quoting one without the price scenario attached is meaningless. The derivation, the grids and the sensitivity to cumulative buy volume live in `scripts/emissions/`.

Emissions are a **support** yield for partner pools. The partner's real return comes from bribes.

---

## 6. Gauge Economics

The gauge system creates a self-reinforcing flywheel:

```
External protocol wants liquidity on Soladrome
  → deposits bribe tokens into gauge
  → hiSOLA holders (+ protocol partners) vote for that pool
  → pool receives more oSOLA emissions
  → LPs provide liquidity to earn oSOLA
  → partners burn oSOLA for o_sola_bonus (uncapped extra votes)
  → more liquidity → better execution for the external protocol
  → protocol deposits more bribes next epoch
```

**Vote power distribution:**
- Raw hiSOLA: 1× voting weight
- ve-locked hiSOLA (max duration): 4× voting weight
- oSOLA burn bonus: uncapped additive power (current epoch only; burns are deflationary)
- Per-address hiSOLA cap: 30% of total epoch votes (anti-whale, does not apply to oSOLA bonus)

**Passive vote carry-over (`set_vote_config` + `replay_vote`):**
hiSOLA holders set a persistent allocation once. Any keeper (or the holder themselves) calls `replay_vote` each epoch — votes are re-cast automatically at the current balance, with no owner signature required. This mirrors Beradrome/Velodrome behaviour: passive holders continue earning bribes without weekly re-voting.

**Partner ve-power once the cap is reached (100k hiSOLA earned, 48-month lock = maximum):**
```
ve_power = 100,000 × (208 epochs / 208 max) × 4 = 400,000 per partner
```

This decays linearly to 0 at lock expiry. Partners replenish by unlocking → re-locking (with oSOLA-earned hiSOLA added) or by burning oSOLA for uncapped epoch bonus.

---

## 7. External Bribe Tokens

**Soladrome's bridges make it an interoperability hub for ve(3,3) liquidity across chains — its core strategic advantage.** Any ve(3,3) protocol (Aerodrome, Velodrome, Beradrome, fBOMB, …) can route bribes in from its home chain, and SOLA can flow outward as floor-backed wSOLA to seed pairs on those same venues (see WHITEPAPER §8). The Wormhole Token Bridge and cross-chain bribe bridge expand the set of tokens that can enter Soladrome bribe vaults far beyond native Solana assets.

### 7.1 Wormhole-Wrapped Tokens

| Token | Origin | SPL mint | Status |
|---|---|---|---|
| wAERO | Base (AERO) | `AXYvFSKMPwt9adL1eBZhrDNCvT29HXnhNQuPxNwDZin` | ✅ Live |
| wVELO | Optimism (VELO) | `GaLBL77CzH9XSzStkNPmCkWhuXwkDU38du2ainTGrEMN` | ✅ Live |

Both mints were attested on Wormhole before launch. They are standard SPL tokens and are accepted by `deposit_bribe` with no special handling. Bribe depositors bridge their AERO or VELO to Solana via the Token Bridge page, then deposit the resulting wAERO or wVELO into the target gauge.

### 7.2 Cross-Chain Bridge Tokens (LayerZero V2)

Once the cross-chain bribe bridge is live, EVM-native tokens can enter bribe vaults without the depositor ever touching Solana directly. The `bridge-receiver` Anchor program performs the `deposit_bribe` CPI on behalf of the EVM sender. Any ERC-20 token supported by the `SoladromeBribeRouter.sol` contract can flow through this path.

**First confirmed token: fBOMB** — the MLCB DAO treasury token. MLCB DAO holds ~$35M in fBOMB spread across Base, Optimism, and other EVM chains. As the first external protocol partner, MLCB will deploy fBOMB bribes each epoch via the cross-chain bridge, with no manual asset migration to Solana required.

### 7.3 Effect on Bribe Economy

Accepting wAERO, wVELO, and future cross-chain tokens:
- Increases total weekly bribe value available to hiSOLA voters
- Attracts EVM protocols (particularly veAERO/veVELO whales) that already operate in the Aerodrome/Velodrome gauge ecosystem
- Creates a direct on-chain link between Base/Optimism governance power and Solana liquidity direction

hiSOLA voters receive these tokens at epoch end via `claim_bribe`, exactly as with any other bribe token. No changes to the on-chain program are required — `deposit_bribe` accepts any valid SPL token mint.

---

## 8. Protocol-Owned Liquidity

POL is funded by diverting a fraction of `market_vault` fees. Once deployed, POL LP tokens are **permanently locked** — they cannot be withdrawn by any address, including the protocol authority. This creates:

- Permanent baseline liquidity in the target pool
- Ongoing fee income to `pol_lp_vault`
- Reduced dependence on mercenary liquidity

POL accumulates over time as the protocol generates fee revenue.

---

## 9. Governance

Governance in Soladrome is intentionally minimal at launch:

**Admin actions (via Squads multisig):**
- `pause` / `unpause` — emergency only
- `initialize_pol` — one-time POL setup
- `transfer_authority` — succession planning
- `register_partner` / `register_contributor` — strategic allocations

**Gauge governance (on-chain, permissionless):**
- hiSOLA holders vote each epoch
- Vote weights determine oSOLA emission distribution
- No admin can override votes
- Protocol partners participate from day one with locked ve-power

There is no general governance voting on protocol parameters. Constants are compile-time and require a program upgrade (which itself requires multisig approval) to change.

---

## 10. Competitive Differentiation

| Feature | Soladrome | Typical ve(3,3) | Typical bonding curve |
|---|---|---|---|
| Floor price guarantee | ✅ On-chain invariant | ❌ | ❌ |
| Gauge-bribe system | ✅ | ✅ | ❌ |
| Zero-interest borrowing | ✅ | ❌ | ❌ |
| oSOLA (strengthens floor on exercise) | ✅ | ❌ | ❌ |
| Protocol-owned liquidity | ✅ | Partial | ❌ |
| Flash arbitrage (90% to stakers) | ✅ | ❌ | ❌ |
| Permissionless AMM | ✅ | ✅ | ❌ |
| No oracle dependency | ✅ | Partial | ✅ |
| No liquidation risk | ✅ | ❌ | ❌ |
| Partner streaming alloc (bribe-indexed, locked) | ✅ | ❌ | ❌ |

---

*Copyright © 2026 Soladrome Labs. Prior art disclosure as of Git commit timestamp.*
*Program ID: `4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd`*
