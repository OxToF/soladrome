# Soladrome — Tokenomics
**Version 1.0 — 2026-06-02T21:10:14Z**
*Prior art disclosure. All rights reserved.*

---

## Overview

Soladrome has three native tokens: **SOLA** (base), **hiSOLA** (staked governance), and **oSOLA** (call-option rewards). There is no pre-mine, no ICO, no presale. All tokens enter circulation through on-chain mechanisms with no off-chain discretion.

---

## 1. SOLA — Supply Mechanics

SOLA is minted through three paths only:

| Path | Mechanism | Floor backing |
|---|---|---|
| User purchase | `buy_sola` — pay USDC, receive SOLA via bonding curve | ✅ 1 USDC per SOLA → `floor_vault` |
| oSOLA exercise | `exercise_o_sola` — burn oSOLA + pay 1 USDC, receive 1 SOLA | ✅ 1 USDC per SOLA → `floor_vault` |
| Founder vesting | `claim_founder_hi_sola` — SOLA minted to `sola_vault`, hiSOLA to founder | ❌ No floor backing (locked as hiSOLA) |

**Total user-purchasable supply:** Unbounded (curve-limited by USDC demand).
**Every user-purchased SOLA is backed 1:1 by USDC in `floor_vault`.**

### 1.1 Bonding Curve Parameters

```
Virtual USDC reserve (init):  100 USDC  (100,000,000 base units)
Virtual SOLA reserve (init):  100 SOLA  (100,000,000 base units)
K = 100e6 × 100e6 = 10,000,000,000,000,000  (fixed forever)

Spot price at init:   1.00 USDC/SOLA (floor)
Spot price at 1k buy: ≈1.01 USDC/SOLA
Spot price at 10k buy: ≈1.10 USDC/SOLA
Spot price at 100k buy: ≈2.00 USDC/SOLA
```

The price premium above 1.0 USDC/SOLA flows entirely to `market_vault` and is distributed to hiSOLA stakers.

---

## 2. Token Allocations

### 2.1 Founder Allocation — 12,250,000 SOLA total

| Tranche | Amount | Token | Cliff | Vesting | Mechanism |
|---|---|---|---|---|---|
| Governance | 7,000,000 | hiSOLA | 6 months | 24 months linear | `claim_founder_hi_sola` |
| Options | 5,000,000 | oSOLA | 6 months | 24 months linear | `claim_founder_vesting` |
| Liquid | 250,000 | SOLA | None | None (immediate) | `mint_ecosystem_allocation` |

**Governance tranche (7M hiSOLA):**
Each `claim_founder_hi_sola` call mints SOLA to `sola_vault` AND hiSOLA 1:1 to the founder wallet. The SOLA is permanently locked — it can only be recovered by unstaking hiSOLA (which requires burning it). The founder's primary liquidity path is `borrow_usdc` (borrow USDC against hiSOLA collateral, 0% interest, repay at will), capped at 10% of cumulative claimed hiSOLA (`FOUNDER_BORROW_CAP_BPS = 1000`).

**Options tranche (5M oSOLA):**
Each `claim_founder_vesting` call mints oSOLA. To monetize, the founder exercises `exercise_o_sola` (pay 1 USDC, receive 1 SOLA) — every exercise adds 1 USDC to `floor_vault`, strengthening the floor for all users. Alternatively, oSOLA can be sold on secondary markets (if available).

**Liquid tranche (250k SOLA):**
Minted once at launch. Provides operational income during the 6-month vesting cliff. Not counted in `total_purchased_sola` — cannot deplete the floor vault via `sell_sola`.

### 2.2 Ecosystem Allocation — 1,750,000 SOLA

One-time, authority-only, minted at launch via `mint_ecosystem_allocation`.

| Use | % | Amount |
|---|---|---|
| Community airdrop | 50% | 875,000 SOLA |
| Marketing & partnerships | 25% | 437,500 SOLA |
| Trading contests & incentives | 12.5% | 218,750 SOLA |
| Ecosystem reserve | 12.5% | 218,750 SOLA |

Distribution is off-chain and discretionary within these categories.

### 2.3 Summary Table

| Category | SOLA | hiSOLA | oSOLA | % of 21.25M ref supply |
|---|---|---|---|---|
| User purchases (curve) | Unlimited | — | — | — |
| Founder liquid | 250,000 | — | — | 1.2% |
| Founder governance | — | 7,000,000 | — | 32.9% |
| Founder options | — | — | 5,000,000 | 23.5% |
| Ecosystem | 1,750,000 | — | — | 8.2% |
| LP emissions (oSOLA) | — | — | Ongoing | — |

*Reference supply of 21.25M used for percentage calculations (founder + ecosystem + reference LP pool).*

---

## 3. Revenue Flows

```
User buys SOLA
  └─► floor_amount USDC → floor_vault (floor backing)
  └─► (usdc_in - floor_amount) USDC → market_vault (fee premium)

AMM swap
  └─► swap_fee × protocol_fee_share → market_vault

borrow_usdc
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

**Floor reserve buffer:** Borrowing is limited so that `floor_vault ≥ 75% × total_purchased_sola` at all times. At most 25% of the floor can be lent out simultaneously.

**Guarantee:** Every holder of user-purchased SOLA can always redeem at minimum floor price (1 USDC). The worst-case scenario where 100% of hiSOLA is borrowed and 25% of the floor is deployed still leaves 75% of SOLA redeemable immediately, with the remainder redeemable as loans are repaid.

---

## 5. oSOLA Emission Schedule

oSOLA is not pre-minted. It is distributed as LP rewards through two mechanisms:

**Masterchef (continuous):**
- `OSOLA_EMISSION_PER_SEC` per pool (calibrated at mainnet deploy)
- Distributed proportionally to LP share
- No epoch boundary required

**Epoch-based (governance-weighted):**
- `LP_EMISSION_PER_EPOCH = 10,000 oSOLA` total per epoch
- Split across pools proportionally to gauge vote weight
- Creates a demand for hiSOLA voting power (and thus for bribe deposits)

---

## 6. Gauge Economics

The gauge system creates a self-reinforcing flywheel:

```
External protocol wants liquidity
  → deposits bribe tokens into gauge
  → hiSOLA holders vote for that pool
  → pool receives more oSOLA emissions
  → LPs provide liquidity to earn oSOLA
  → more liquidity → better execution for the external protocol
  → protocol deposits more bribes next epoch
```

**Vote power distribution:**
- Raw hiSOLA: 1× voting weight
- ve-locked hiSOLA (max duration): 4× voting weight
- Per-address cap: 30% of total epoch votes

**Bribe capture rate (voter yield):**
The USD value of bribes divided by the USD value of voting power determines the "bribe APR" for voters. This rate self-adjusts: higher bribe APR → more hiSOLA locked → more voting power → diluted APR → equilibrium.

---

## 7. Protocol-Owned Liquidity

POL is funded by diverting a fraction of `market_vault` fees. Once deployed, POL LP tokens are **permanently locked** — they cannot be withdrawn by any address, including the protocol authority. This creates:

- Permanent baseline liquidity in the target pool
- Ongoing fee income to `pol_lp_vault`
- Reduced selling pressure from the team

POL accumulates over time as the protocol generates more fee revenue.

---

## 8. Governance

Governance in Soladrome is intentionally minimal at launch:

**Admin actions (via Squads multisig):**
- `pause` / `unpause` — emergency only
- `initialize_pol` — one-time POL setup
- `transfer_authority` — succession planning

**Gauge governance (on-chain, permissionless):**
- hiSOLA holders vote each epoch
- Vote weights determine oSOLA emission distribution
- No admin can override votes

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

---

*Copyright © 2026 Soladrome Labs. Prior art disclosure as of Git commit timestamp.*
*Program ID: `4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd`*
