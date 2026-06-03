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
Each `claim_founder_hi_sola` call mints SOLA to `sola_vault` AND hiSOLA 1:1 to the founder wallet. The primary liquidity path is `founder_borrow_usdc` (USDC borrowed against hiSOLA collateral, 0% interest), capped at **10% of cumulative claimed hiSOLA** (`FOUNDER_BORROW_CAP_BPS = 1000`). With ~291k hiSOLA/month after the 6-month cliff, the monthly borrow ceiling is ~29k USDC — sufficient for operational costs while the floor vault grows organically.

**Options tranche (5M oSOLA):**
Each exercise of `exercise_o_sola` adds 1 USDC to `floor_vault` — every option conversion structurally strengthens the floor for all users.

**Liquid tranche (250k SOLA):**
Provides operational income (KOL rewards, community managers, contest prizes) during the 6-month vesting cliff. Distributed by direct SPL transfers — no on-chain vesting required for these small amounts.

### 2.2 Protocol Partner Allocations

On-chain instruction: `register_partner` (authority-only) + `claim_partner_allocation` (partner-called).
PDA: `[b"partner", partner_wallet]`

| Partner | hiSOLA | Lock duration | ve-power at claim | Borrow during lock |
|---|---|---|---|---|
| Jito | 100,000 | 12 months (52 epochs) | ~200,000 (2×) | ❌ blocked |
| Marinade | 100,000 | 12 months | ~200,000 | ❌ blocked |
| Solayer | 100,000 | 12 months | ~200,000 | ❌ blocked |
| **Total** | **300,000** | — | **~600,000 ve-power** | — |

**Mechanism:**
hiSOLA is minted **directly into the partner's `ve_lock_vault`** — the wallet never receives it. This means:
- **Voting power is immediate** (full ve-multiplier from day one of the lock).
- **No dump risk**: wallet hiSOLA balance = 0 throughout the lock; `borrow_usdc` check (`new_borrowed ≤ hi_sola_balance`) naturally blocks borrowing.
- **No fee dilution**: `total_hi_sola` is NOT incremented (locked hiSOLA excluded from fee pool, matching `lock_hi_sola` semantics). Existing stakers retain their full fee share during the lock period.
- **After lock expiry**: `unlock_hi_sola` → hiSOLA back to wallet → standard rules apply (fee share, standard borrow with 75% floor buffer).

**Voting power growth via rewards flywheel:**
Partners earn oSOLA through LP emissions on their pools (JitoSOL/SOLA, mSOL/SOLA, etc.). They can burn oSOLA during `vote_gauge` calls to earn uncapped `o_sola_bonus` voting power on top of their ve-locked allocation. Each oSOLA burned also strengthens the floor vault — an aligned incentive structure.

### 2.3 Ecosystem Allocation — 1,750,000 SOLA

One-time, authority-only, minted at launch via `mint_ecosystem_allocation`. Distributed as liquid SOLA by direct SPL transfers from the authority wallet. No on-chain vesting (amounts are small relative to total supply).

| Phase | Amount | Timing |
|---|---|---|
| Community airdrop (claim-based) | ~500,000 SOLA | At TGE |
| LP incentive reserve | ~500,000 SOLA | Progressive post-launch |
| Marketing & future partnerships | ~750,000 SOLA | Held in reserve |

Distribution is claim-based (not pushed) to filter for genuine interest.

### 2.4 Contributor / Service Provider Allocation

On-chain instruction: `register_contributor` (authority-only) + `claim_contributor_hi_sola` / `claim_contributor_vesting`.
PDA: `[b"contributor", contributor_wallet]`

For long-term service providers (developers, designers, community managers with ongoing roles):

| Tranche | Cliff | Vesting | Borrow cap |
|---|---|---|---|
| hiSOLA | 1 month | 12 months linear | 10% of claimed |
| oSOLA | 1 month | 12 months linear | N/A |

The contributor allocation is used sparingly — only for individuals with ongoing, meaningful protocol contributions. KOLs and contest winners receive liquid SOLA from the founder's operational tranche (direct transfers, no vesting needed for these small amounts).

### 2.5 Summary Table

| Category | SOLA | hiSOLA | oSOLA | Notes |
|---|---|---|---|---|
| User purchases (curve) | Unlimited | — | — | 100% floor-backed |
| Founder liquid | 250,000 | — | — | KOLs, operational |
| Founder governance | — | 7,000,000 | — | 6m cliff / 24m vest |
| Founder options | — | — | 5,000,000 | 6m cliff / 24m vest |
| Ecosystem / airdrop | 1,750,000 | — | — | Direct distribution |
| Protocol partners | — | 300,000 | — | Auto-locked 12m |
| Contributors | — | TBD | TBD | 1m cliff / 12m vest |
| LP emissions (oSOLA) | — | — | Ongoing | Masterchef + epoch |

*Reference supply at full founder/partner vest: ~14.5M SOLA pre-mine + unlimited organic.*

---

## 3. Revenue Flows

```
User buys SOLA
  └─► floor_amount USDC → floor_vault (floor backing)
  └─► (usdc_in - floor_amount) USDC → market_vault (fee premium)

AMM swap
  └─► swap_fee × protocol_fee_share → market_vault

borrow_usdc / founder_borrow_usdc / contributor_borrow_usdc
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

**Masterchef (continuous, per-pool):**
- `OSOLA_EMISSION_PER_SEC` per pool per second — calibrated at mainnet deploy
- Distributed proportionally to LP share within each pool
- Updates lazily on every add/remove/claim interaction

**Epoch-based (governance-weighted, decaying):**
- Initial emission: `osola_emission_initial` — default 10,000 oSOLA/epoch total
- Split across pools proportionally to hiSOLA gauge vote weight
- **Automatic exponential decay** each epoch: `emission × (osola_emission_decay_bps / 10_000)`
  - Default: 9,900 bps = −1 %/epoch (≈ −40 %/year)
  - Floor: `osola_emission_floor_bps` % of initial — default 10 % (emissions never reach zero)
- Authority can reset the curve at any time via `configure_emissions` (Squads multisig)

**Emission schedule (800,000 oSOLA launch, −1 %/epoch, floor 150,000):**

| Epoch | Timeline | oSOLA / epoch | Per pool (5 pools, equal votes) | APR equiv. ($5M TVL, oSOLA $0.10) |
|---|---|---|---|---|
| 0 | Launch | 800,000 | 160,000 | ~8.3% |
| 13 | 3 months | 701,000 | 140,000 | ~7.3% |
| 26 | 6 months | 616,000 | 123,000 | ~6.4% |
| 52 | 1 year | 474,000 | 95,000 | ~4.9% |
| 104 | 2 years | 351,000 | 70,000 | ~3.6% |
| ~166 | ~3.2 years | 150,000 (floor) | 30,000 | ~1.6% |

Early LPs capture the highest yield. The floor of 150,000 oSOLA/epoch guarantees perpetual incentives. Override via `configure_emissions` (Squads multisig) at any time.

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

**Partner ve-power at claim (100k hiSOLA, 12-month lock):**
```
ve_power = 100,000 × (52 epochs / 104 max) × 4 = 200,000 per partner
```

This decays linearly to 0 at lock expiry. Partners replenish by unlocking → re-locking (with oSOLA-earned hiSOLA added) or by burning oSOLA for uncapped epoch bonus.

---

## 7. Protocol-Owned Liquidity

POL is funded by diverting a fraction of `market_vault` fees. Once deployed, POL LP tokens are **permanently locked** — they cannot be withdrawn by any address, including the protocol authority. This creates:

- Permanent baseline liquidity in the target pool
- Ongoing fee income to `pol_lp_vault`
- Reduced dependence on mercenary liquidity

POL accumulates over time as the protocol generates fee revenue.

---

## 8. Governance

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

## 9. Competitive Differentiation

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
| Partner auto-lock (voting from day 1) | ✅ | ❌ | ❌ |

---

*Copyright © 2026 Soladrome Labs. Prior art disclosure as of Git commit timestamp.*
*Program ID: `4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd`*
