# Soladrome — White Paper
**Version 1.0 — 2026-06-02T21:10:14Z**
*Prior art disclosure. All rights reserved. Licensed under BUSL-1.1.*

---

## Abstract

Soladrome is a decentralized protocol on Solana that combines a floor-price bonding curve with a gauge-weighted bribe system, a permissionless AMM, protocol-owned liquidity, and veSOLA-style governance. The core innovation is a **guaranteed minimum redemption price** for the native token SOLA: for every SOLA minted, exactly 1 USDC is locked in an immutable on-chain floor vault, redeemable at any time by burning SOLA. This floor backing is enforced by on-chain invariants and cannot be altered by any authority, including the protocol deployer. On top of this price floor, Soladrome layers a full DeFi stack — staking, borrowing, options, liquidity provisioning, gauge voting, and permissionless bribe markets — creating a self-reinforcing flywheel modeled after Velodrome/Aerodrome but anchored to a mathematically guaranteed downside.

---

## 1. Introduction

DeFi protocols face a fundamental tension: high yields attract capital, but unsustainable tokenomics erode value over time. Users have learned to distrust protocols that promise high APYs without a clear backing mechanism. The result is a market dominated by mercenary liquidity — capital that exits the moment emissions slow.

Soladrome addresses this by making the price floor of its native token a **protocol invariant** rather than a social promise. The 1:1 USDC backing of SOLA is not a peg, a reserve ratio, or a governance vote — it is enforced by the on-chain program and cannot be violated. This creates a class of users who can participate in governance and yield generation without being exposed to uncapped downside: the worst case is always 1 USDC per SOLA.

The gauge-bribe system extends this foundation: external protocols compete for governance votes by depositing arbitrary reward tokens (bribes) into on-chain vaults. hiSOLA holders vote, earn bribes, and direct SOLA emissions toward pools they favor. This creates a sustainable cycle where protocol adoption drives bribe revenue, bribe revenue attracts stakers, and stakers provide governance legitimacy.

---

## 2. Token Architecture

Soladrome uses three native tokens, all with 6 decimals, all as SPL tokens on Solana:

### 2.1 SOLA
The base protocol token. Minted exclusively via the bonding curve (`buy_sola`) or as collateral backing (`exercise_o_sola`). Every SOLA in existence has exactly 1 USDC of floor backing in the `floor_vault`. Burned irreversibly when redeemed at floor price via `sell_sola`.

### 2.2 hiSOLA (Staked SOLA)
Minted 1:1 when SOLA is staked. Represents:
- **Governance rights** — voting power in the gauge system
- **Fee share** — pro-rata claim on `market_vault` fees from bonding curve activity and AMM swaps
- **Borrow rights** — collateral for borrowing USDC from `floor_vault` (1:1, no interest, no liquidation)
- **ve-locking eligibility** — lock hiSOLA to amplify governance power up to 4×

hiSOLA is a standard SPL token. It is economically irrational to transfer (unstaking returns SOLA at 1:1), but technically transferable.

### 2.3 oSOLA (Option SOLA)
A call-option token distributed to liquidity providers and, progressively, to the founder. Exercising oSOLA requires burning it and paying 1 USDC to `floor_vault`, receiving 1 SOLA in return. Each exercise:
1. Adds 1 USDC to the floor vault (strengthens the backing for all SOLA holders)
2. Mints 1 SOLA
3. Burns 1 oSOLA

This mechanism incentivizes LPs while structurally increasing the floor reserve with every redemption.

---

## 3. Bonding Curve

### 3.1 Constant-Product Formula

The bonding curve uses a virtual constant-product invariant:

```
(V_usdc + usdc_in) × (V_sola - sola_out) = K
```

Where:
- `V_usdc = 100,000,000` (100 USDC virtual, 6 dec) — initial
- `V_sola = 100,000,000` (100 SOLA virtual, 6 dec) — initial
- `K = V_usdc × V_sola = 10,000,000,000,000,000` — fixed forever

**K is computed once at `initialize` and never recomputed.** Virtual reserves drift as SOLA is purchased; K remains constant. This is identical to Uniswap v2's constant-product invariant but applied to a one-sided minting curve rather than a pool.

### 3.2 Buy Mechanics (`buy_sola`)

When a user sends `usdc_in` USDC:

```
sola_out = V_sola - K / (V_usdc + usdc_in)
floor_amount = sola_out          # 1 USDC per SOLA → floor_vault
market_amount = usdc_in - floor_amount  # excess → market_vault (fees)
```

- `floor_vault` receives exactly `sola_out` USDC (maintaining 1:1 backing)
- `market_vault` receives the price premium above floor (the "market fee")
- `virtual_usdc` increases by `usdc_in`; `virtual_sola` decreases by `sola_out`
- `total_purchased_sola` increments by `sola_out`

The split ensures the floor backing is always maintained regardless of curve position.

### 3.3 Sell Mechanics (`sell_sola`)

Selling does **not** use the bonding curve. It redeems directly at floor price:

```
usdc_out = sola_amount  # exactly 1:1
```

- `sola_amount` SOLA is burned
- `sola_amount` USDC is transferred from `floor_vault` to the user
- Virtual reserves are **not updated** (sell_sola does not affect the curve)
- `total_purchased_sola` decrements by `sola_amount`

**Critical invariant enforced on every sell:**
```
total_purchased_sola >= sola_amount           // sell guard
floor_vault_post + total_usdc_borrowed >= total_purchased_sola  // floor invariant
```

Only SOLA minted via `buy_sola` or `exercise_o_sola` is tracked in `total_purchased_sola`. Founder and ecosystem allocations are excluded — they cannot be redeemed at floor price and do not affect the floor backing calculation.

### 3.4 Price Behavior

At initialization, the spot price is:
```
spot_price = V_usdc / V_sola = 1.0 USDC/SOLA
```

As users buy, `V_usdc` increases and `V_sola` decreases, raising the spot price. The floor price remains 1.0 USDC/SOLA forever — the gap between spot and floor is the market premium that flows to stakers.

---

## 4. Staking and Fee Distribution

### 4.1 Staking (`stake_sola`)

Users lock SOLA into `sola_vault` and receive hiSOLA 1:1. The `market_vault` accumulator is advanced before each staking event, ensuring new stakers only claim fees earned after their stake entry.

### 4.2 Fee Accumulator

```
accumulator += market_vault_delta / total_hi_sola
pending_fees(user) = (accumulator - user.fees_debt) × user.hi_sola_balance / PRECISION
```

`PRECISION = 1e12` prevents fractional USDC loss. This is a standard reward-per-token accumulator identical to Synthetix's staking rewards contract.

### 4.3 Unstaking (`unstake_hi_sola`)

Requires `hi_sola_balance - debt >= unstake_amount` (cannot unstake collateral backing outstanding borrows). Returns SOLA 1:1.

---

## 5. Borrowing

hiSOLA holders can borrow USDC from `floor_vault` using their hiSOLA as collateral:

- **Max borrow** = hiSOLA balance (1:1 collateral ratio)
- **Interest** = 0%
- **Liquidation** = none (floor vault is always solvent at 1:1)
- **Origination fee** = 2% of borrowed amount → `market_vault` (rewards stakers)
- **Floor reserve buffer** = borrowing is blocked if post-borrow `floor_vault < 75% × total_purchased_sola` (`FLOOR_RESERVE_MIN_BPS = 7500`)

The 75% buffer ensures that even under maximum borrow utilization, 75% of all outstanding SOLA can be redeemed at floor price at any time. The remaining 25% is temporarily lent but recoverable when loans are repaid.

---

## 6. veSOLA Locking

### 6.1 Mechanics

hiSOLA can be locked for a duration `[1 epoch, 104 epochs]` (1 week to 2 years with `EPOCH_DURATION = 604,800 s`). Locking yields veSOLA voting power:

```
ve_power = amount × remaining_lock / max_lock × MAX_VE_MULTIPLIER
```

Where `MAX_VE_MULTIPLIER = 4`. A hiSOLA holder locking for the maximum duration gets 4× voting weight in the gauge system.

### 6.2 Yield Trade-off

Locked hiSOLA is **removed** from the fee accumulator denominator (`total_hi_sola` decreases). This means lockers trade fee income for governance power — aligned with ve-tokenomics design. The protocol benefits from longer-term aligned voters; lockers benefit from amplified bribe income.

---

## 7. Gauge and Bribe System

### 7.1 Epoch Structure

`EPOCH_DURATION = 604,800 s` (7 days). The current epoch is:
```
current_epoch = unix_timestamp / EPOCH_DURATION
```

All gauges, bribes, votes, and claims are keyed to epoch numbers stored as 8-byte little-endian seeds in PDAs.

### 7.2 Voting (`vote_gauge`)

hiSOLA holders allocate voting power across AMM pools per epoch. Constraints:
- Cumulative votes across pools ≤ `hi_sola_balance`
- One vote receipt per pool per epoch (replay-proof via `init` PDA)
- Per-address vote cap: 30% of total epoch votes (anti-whale)

### 7.3 Bribe Deposits (`deposit_bribe`)

Any external protocol or individual can deposit arbitrary SPL tokens as a bribe for a specific pool and epoch. Bribes are locked in a PDA vault until the epoch ends.

### 7.4 Bribe Claims (`claim_bribe`)

After an epoch ends, voters claim pro-rata bribes:
```
claimable = total_bribed × user_votes / total_votes
```

Anti-double-claim: `UserBribeClaim` PDA is created with `init` on first claim (idempotent replay protection).

### 7.5 Rollover (`rollover_bribe`)

Unclaimed bribes from ended epochs can be rolled over to the next epoch:
- **Zero-vote pools**: immediate rollover after epoch ends
- **Voted pools**: `ROLLOVER_DELAY_EPOCHS = 2` grace period (14 days mainnet)

Rollover is permissionless — anyone can call it.

---

## 8. Permissionless AMM

### 8.1 Pool Creation

Any two distinct SPL token mints can be paired. Mints are sorted lexicographically before PDA derivation, ensuring (A,B) and (B,A) map to the same pool regardless of input order.

```
pool_pda = PDA([b"amm_pool", mint_a, mint_b])  // mints sorted lex
```

Pool parameters set at creation:
- `swap_fee_bps` (max 1000 = 10%)
- `protocol_fee_share_bps` (max 5000 = 50% of swap fee → `market_vault`)

### 8.2 Liquidity (xy=k)

First deposit locks `MINIMUM_LIQUIDITY = 1,000` LP tokens to the System Program (dead address), permanently removing them from circulation. Subsequent deposits rebalance to the limiting token side via `lp_for_deposit()`.

### 8.3 Emissions (Two Systems)

**Masterchef-style (continuous):** Per-second accumulator in `AmmPool`. `OSOLA_EMISSION_PER_SEC` oSOLA distributed to LP stakers proportionally to their share. Updated lazily on every interaction.

**Epoch-based (legacy):** `checkpoint_lp` → `emit_pool_rewards` → `claim_lp_emissions`. Time-weighted LP balances per epoch, `LP_EMISSION_PER_EPOCH = 10,000 oSOLA` split across pools by vote weight.

---

## 9. Protocol-Owned Liquidity (POL)

### 9.1 Collection (`collect_to_pol`)

A configurable fraction (`pol_split_bps`, max 50%) of `market_vault` fees is diverted to `pol_usdc_vault`.

### 9.2 Deployment (`deploy_pol`)

Two-phase atomic operation:
1. Buy SOLA via bonding curve using POL USDC → SOLA lands in `pol_sola_ata`
2. Add SOLA + remaining USDC as liquidity to `target_pool` → LP tokens held permanently in `pol_lp_vault`

POL LP tokens are never redeemable — they are protocol-owned forever, providing permanent baseline liquidity and ongoing fee income.

---

## 10. Flash Arbitrage

`flash_arbitrage` atomically exploits price divergence between the AMM and the bonding curve:

1. Exercise oSOLA at floor price (burn oSOLA + pay 1 USDC → receive 1 SOLA)
2. Sell SOLA on the AMM for USDC (if AMM price > floor price)
3. Buy back SOLA via bonding curve if needed

Profit split:
- **10%** (`CALLER_ARB_SHARE_BPS = 1000`) → caller (incentive)
- **90%** → `market_vault` → hiSOLA stakers

This creates a permissionless arbitrage mechanism that self-corrects AMM prices while rewarding stakers with 90% of MEV.

---

## 11. Tokenomics

*See also: `TOKENOMICS.md` in this repository.*

### 11.1 Supply

| Tranche | Amount | Mechanism |
|---|---|---|
| User purchases | Unlimited (curve-bound) | `buy_sola` |
| Founder hiSOLA | 7,000,000 SOLA | Progressive vesting, 6-month cliff, 24-month linear |
| Founder oSOLA | 5,000,000 oSOLA | Progressive vesting, 6-month cliff, 24-month linear |
| Founder liquid | 250,000 SOLA | Immediate at launch (`mint_ecosystem_allocation`) |
| Ecosystem / marketing | 1,750,000 SOLA | One-time (`mint_ecosystem_allocation`) |

**There is no pre-mine, no ICO, no presale.** All SOLA purchased by users is individually floor-backed at 1:1. The founder's 7M hiSOLA vesting mints SOLA to `sola_vault` (not `floor_vault`) and does not create selling pressure against the floor.

### 11.2 Inflation

The only new SOLA entering circulation is:
- User `buy_sola` activity (each unit is 100% floor-backed)
- Founder vesting claims (minted to `sola_vault`, locked as hiSOLA)
- oSOLA exercises (each unit adds 1 USDC to `floor_vault` — net neutral)

There is no protocol-controlled inflation. oSOLA is the primary incentive token; its value is derived from the right to acquire SOLA at floor price.

### 11.3 Revenue Model

Protocol revenue flows to `market_vault`:
- **Bonding curve premium** — the spread between user purchase price and floor price
- **AMM protocol fees** — `protocol_fee_share_bps` of each swap
- **Borrow origination fees** — 2% of each `borrow_usdc` call
- **Flash arbitrage** — 90% of arb profit

All `market_vault` revenue is distributed pro-rata to hiSOLA stakers via the reward-per-token accumulator.

---

## 12. Security Model

### 12.1 On-Chain Authority

At launch, the protocol authority is the deployer wallet. Post-launch, authority is transferred to a Squads v4 multisig vault (1-of-2) with two distinct Ledger hardware wallets. All admin instructions (`pause`, `unpause`, `initialize_pol`, `transfer_authority`) require multisig approval after this transfer.

### 12.2 Emergency Pause

`pause` / `unpause` freeze all entry instructions while preserving all exit paths:

**Always blocked when paused:** `buy_sola`, `stake_sola`, `borrow_usdc`, `exercise_o_sola`, `flash_arbitrage`, `deposit_bribe`, `vote_gauge`, `checkpoint_lp`, `lock_hi_sola`, `create_pool`, `add_liquidity`, `amm_swap`, `collect_to_pol`, `deploy_pol`

**Always accessible (exit paths):** `sell_sola`, `unstake_hi_sola`, `repay_usdc`, `remove_liquidity`, `unlock_hi_sola`, `claim_fees`, `claim_bribe`, `claim_lp_rewards`, `claim_lp_emissions`

Users can never be trapped. The worst case in a pause scenario is that entry is blocked; all exits remain open.

### 12.3 Floor Invariant

The core invariant checked after every `sell_sola`:
```
floor_vault_post + total_usdc_borrowed >= total_purchased_sola
```

This invariant is enforced on-chain and cannot be bypassed. If violated, the instruction reverts with `InsufficientFloorReserve`.

### 12.4 Hardcoded Addresses

Critical addresses are compile-time constants:
- `FOUNDER_WALLET` — Ledger Nano S, immutable in bytecode
- `SQUADS_VAULT` — transfer_authority target

Neither can be changed without a program upgrade. Program upgrade authority is held by the Squads multisig after deploy.

### 12.5 Security Testing

Prior to mainnet:
- Manual code review (10 findings, all resolved)
- Trident fuzzing: `fuzz_0` (bonding curve invariants, ~200k calls, 0 violations) and `fuzz_1` (flash arb invariants, ~200k calls, 0 violations)

---

## 13. PDA Architecture

All on-chain state is held in program-derived accounts. No mutable authority accounts. Every PDA is deterministically derived from fixed seeds:

| Account | Seeds |
|---|---|
| ProtocolState | `[b"state"]` |
| UserPosition | `[b"position", user]` |
| floor_vault | `[b"floor_vault"]` |
| market_vault | `[b"market_vault"]` |
| sola_vault | `[b"sola_vault"]` |
| sola_mint | `[b"sola_mint"]` |
| hi_sola_mint | `[b"hi_sola_mint"]` |
| o_sola_mint | `[b"o_sola_mint"]` |
| AmmPool | `[b"amm_pool", mint_a, mint_b]` (sorted lex) |
| LP mint | `[b"lp_mint", pool]` |
| vault_a / vault_b | `[b"vault_a" \| b"vault_b", pool]` |
| BribeVault | `[b"bribe_vault", pool, reward_mint, epoch_le8]` |
| bribe_token_vault | `[b"bribe_tokens", pool, reward_mint, epoch_le8]` |
| GaugeState | `[b"gauge", pool, epoch_le8]` |
| UserVoteReceipt | `[b"vote", user, pool, epoch_le8]` |
| UserEpochVotes | `[b"uev", user, epoch_le8]` |
| GlobalEpochVotes | `[b"epoch_votes", epoch_le8]` |
| UserBribeClaim | `[b"bribe_claim", user, pool, reward_mint, epoch_le8]` |
| VeLockPosition | `[b"velock", user]` |
| ve_lock_vault | `[b"ve_vault", user]` |
| PolState | `[b"pol"]` |
| pol_usdc_vault | `[b"pol_usdc_vault"]` |
| LpUserInfo | `[b"lp_user", pool, user]` |
| LpUserCheckpoint | `[b"lp_ckpt", pool, user]` |

---

## 14. Instruction Set

Complete list of on-chain instructions (program ID: `4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd`):

`initialize` · `buy_sola` · `sell_sola` · `stake_sola` · `unstake_hi_sola` · `borrow_usdc` · `repay_usdc` · `exercise_o_sola` · `claim_fees` · `mint_founder_allocation` · `mint_ecosystem_allocation` · `claim_founder_hi_sola` · `claim_founder_vesting` · `deposit_bribe` · `vote_gauge` · `checkpoint_lp` · `emit_pool_rewards` · `claim_lp_emissions` · `claim_bribe` · `rollover_bribe` · `create_pool` · `add_liquidity` · `remove_liquidity` · `claim_lp_rewards` · `amm_swap` · `distribute_o_sola` · `initialize_pol` · `collect_to_pol` · `deploy_pol` · `lock_hi_sola` · `unlock_hi_sola` · `flash_arbitrage` · `pause` · `unpause` · `transfer_authority`

---

## 15. Roadmap

| Phase | Status | Description |
|---|---|---|
| Devnet | ✅ Complete | Full protocol deployed and tested |
| Security review | ✅ Complete | Code review + Trident fuzzing |
| Squads multisig | ✅ Complete | 1-of-2 Ledger multisig created |
| Mainnet deploy | Upcoming | `anchor build --no-default-features && anchor deploy` |
| Audit | Post-launch | Independent security audit |
| Jito partnership | In progress | JitoSOL/SOL pool + gauge integration |
| Solana Foundation Grant | Submitted | $35,000 grant application |

---

## 16. Related Work

- **Velodrome / Aerodrome** — ve(3,3) gauge-bribe architecture (inspiration for the gauge system)
- **Uniswap v2** — constant-product AMM (inspiration for pool mechanics)
- **Synthetix** — reward-per-token accumulator (inspiration for fee distribution)
- **Beradrome** — oToken model (inspiration for oSOLA exercise mechanics)
- **Compound** — collateral borrowing (inspiration for hiSOLA borrow system)

Soladrome's novel contribution is the combination of a **guaranteed floor-price bonding curve** with a **ve-gauge bribe system** on a single protocol, where floor backing is a provable on-chain invariant rather than a governance-dependent promise.

---

## Appendix — Key Constants (Mainnet)

| Constant | Value | Description |
|---|---|---|
| `INIT_VIRTUAL_USDC` | 100,000,000 | 100 USDC virtual reserve |
| `INIT_VIRTUAL_SOLA` | 100,000,000 | 100 SOLA virtual reserve |
| `EPOCH_DURATION` | 604,800 s | 7 days |
| `MIN_LOCK_DURATION` | 604,800 s | 1 epoch |
| `MAX_LOCK_DURATION` | 62,899,200 s | 104 epochs (~2 years) |
| `MAX_VE_MULTIPLIER` | 4 | Max voting power boost |
| `FLOOR_RESERVE_MIN_BPS` | 7,500 | 75% floor reserve buffer |
| `CALLER_ARB_SHARE_BPS` | 1,000 | 10% flash arb caller reward |
| `BORROW_FEE_BPS` | 200 | 2% origination fee |
| `FOUNDER_BORROW_CAP_BPS` | 1,000 | 10% borrow cap on founder |
| `ROLLOVER_DELAY_EPOCHS` | 2 | 14-day rollover grace period |
| `LP_EMISSION_PER_EPOCH` | 10,000 oSOLA | Epoch LP rewards |
| `MINIMUM_LIQUIDITY` | 1,000 | Locked LP tokens on first deposit |
| `PRECISION` | 1e12 | Accumulator precision |

---

*Copyright © 2026 Soladrome Labs. Source code licensed under BUSL-1.1.*
*This document constitutes prior art disclosure as of its Git commit timestamp.*
*Program ID: `4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd` on Solana mainnet-beta.*
