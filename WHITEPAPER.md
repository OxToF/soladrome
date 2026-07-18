# Soladrome — White Paper
**Version 1.2 — 2026-06-03T00:00:00Z**
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
Minted 1:1 when SOLA is staked, or allocated via the founder/team/contributor/partner systems (ve-locked). Represents:
- **Governance rights** — voting power in the gauge system
- **Fee share** — pro-rata claim on `market_vault` fees from bonding curve activity and AMM swaps
- **Borrow rights** — collateral for borrowing USDC from `floor_vault` (1:1, no interest, no liquidation)
- **ve-locking eligibility** — lock hiSOLA to amplify governance power up to 4×

hiSOLA is a standard SPL token. It is economically irrational to transfer (unstaking returns SOLA at 1:1), but technically transferable.

**Note on locked hiSOLA:** When hiSOLA is in a `ve_lock_vault` (via `lock_hi_sola` or a partner allocation claim), it is excluded from the fee accumulator denominator (`total_hi_sola` is not incremented). Existing stakers are not diluted during lock periods. The locked hiSOLA re-enters the fee pool only after `unlock_hi_sola` is called.

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
- `V_usdc = 1,000,000,000,000` (1,000,000 USDC virtual, 6 dec) — initial
- `V_sola = 1,000,000,000,000` (1,000,000 SOLA virtual, 6 dec) — initial
- `K = V_usdc × V_sola = 10²⁴` — fixed forever

The depth `N = 1,000,000` sizes price discovery, not supply (exercise mints outside the
curve): a 2× price move requires ~414k USDC of cumulative buys, a 10× requires ~2.16M
(`price = (1 + U/N)²` with `U` = cumulative USDC bought).

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

`buy_sola` is additionally gated by the `curve_enabled` phase flag: the curve stays closed during the partner-only launch window and opens at the public event, together with the TGE and airdrop (see §14.3). `sell_sola` is never gated.

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

hiSOLA can be locked for a duration `[1 epoch, 208 epochs]` (1 week to 4 years with `EPOCH_DURATION = 604,800 s`). Locking yields veSOLA voting power:

```
ve_power = amount × remaining_lock / max_lock × MAX_VE_MULTIPLIER
```

Where `MAX_VE_MULTIPLIER = 4`. A hiSOLA holder locking for the maximum duration gets 4× voting weight in the gauge system.

### 6.2 Yield Trade-off

Locked hiSOLA is **removed** from the fee accumulator denominator (`total_hi_sola` decreases). This means lockers trade fee income for governance power — aligned with ve-tokenomics design. The protocol benefits from longer-term aligned voters; lockers benefit from amplified bribe income.

---

## 7. Strategic Allocations

Soladrome distinguishes between three types of non-user token allocations, each with a different on-chain enforcement mechanism:

### 7.1 Founder Allocation (`mint_founder_allocation`)

One-time instruction creating two progressive vesting schedules:
- **7M hiSOLA:** 6-month cliff → 24-month linear vest via `claim_founder_hi_sola`. Each claim mints SOLA to `sola_vault` (permanent backing) and hiSOLA **directly into a lifetime ve escrow** — the founder's wallet never holds it. Three structural guarantees follow from the escrow itself (they are consequences of where the tokens live, not bolt-on checks):
  1. **No exit, ever** — `unlock_hi_sola` categorically rejects the founder wallet (`FounderVestingLocked`). The reserve can never return to a wallet, so the unstake → `sell_sola` path is unreachable rather than merely guarded.
  2. **No fee capture** — escrowed hiSOLA is excluded from `total_hi_sola`, the fee-accumulator denominator. The reserve earns nothing; 100% of protocol fees go to real stakers.
  3. **No voting, on any path** — `vote_gauge`, `replay_vote` **and** `burn_o_sola_for_votes` all reject the founder wallet (`founder_voting_enabled = false` by default): the 7M is a dormant anti-capture reserve, not governance power. Authority may flip it via `set_founder_voting` only as a break-glass measure against a detected takeover.
  Liquidity path: `borrow_against_locked`, capped at **20% of claimed** — the same cap that applies to every unfinanced allocation (contributor, partner, team). The 75% floor buffer still bounds total drawdown.
- **5M oSOLA:** same schedule via `claim_founder_vesting`. Each exercise adds 1 USDC to `floor_vault`.
- **250k hiSOLA (team tranche):** delivered at launch to the team wallet as hiSOLA minted **directly into a lifetime ve-lock** (`permanent_amount` covers the full tranche — `unlock_hi_sola` can never release it) — never liquid SOLA. Compensates contributors who worked unpaid pre-launch. Votes as an ordinary user (distinct wallet from the founder reserve, by design), borrows up to 20% via `borrow_against_locked`, earns no fees while locked. Does not affect `total_purchased_sola`.

### 7.2 Protocol Partner Allocations (`register_partner` / `partner_deposit_bribe` / `claim_partner_allocation`)

A dedicated allocation system for ecosystem protocols (the "Flight School" anchor-partner program). A partner does **not** receive a lump allocation, and there is **no enforced liquidity minimum** — a partner naturally deposits liquidity because a bribe needs a live gauge to incentivize, but nothing gates on it: the deal self-scales (deposit little and bribe little → earn little). The bribe stream itself is the alignment mechanism; qualification is a recurring **bribe commitment**, and the tier (250K / 175K / 100K) sizes the deal to the commitment brought. Each partner gets two things: a one-time **welcome bag** (`base_hi_sola`, by tier — 250K / 175K / 100K) that streams in over the first 6 months and is **locked for life** (`VeLockPosition.permanent_amount` — permanent voting power, never releasable, borrowable at 20%), and ongoing **1:1 earned** locked hiSOLA in proportion to the bribes they actually deposit, bounded by a negotiated cap — this earned portion carries a normal 4-year lock, releasable and re-lockable at expiry. This is the Beradrome "Real Deal" (commit bribes → receive locked governance) made structural and enforced on-chain.

```
base_vested  = base_hi_sola × min(elapsed, BASE_BAG_VEST_SECS) / BASE_BAG_VEST_SECS   // welcome bag, streams over 6 months
bribe_earned = min(cap_hi_sola, total_bribed_credited × rate_num / rate_den)           // ongoing, 1:1
entitled     = base_vested + bribe_earned
claimable    = entitled − hi_sola_claimed
```

**Mechanism:**
1. `register_partner` (authority-only) sets the partner's `bribe_mint`, conversion `rate`, `cap_hi_sola`, welcome-bag `base_hi_sola`, and lock duration. No tokens are minted at this step.
2. `partner_deposit_bribe` (partner) deposits the committed `bribe_mint` into the normal bribe vault — **voters of that gauge claim it exactly as with `deposit_bribe`** — while `total_bribed_credited` is incremented atomically with the transfer. Only the committed mint credits.
3. `claim_partner_allocation` (partner, callable repeatedly) mints the newly-earned tranche **directly into the partner's `ve_lock_vault`** (bypassing their wallet) and locks it. This produces:

   - **Voting power that scales with commitment** — the welcome bag streams in over 6 months and ve-power then grows as bribes are deposited, up to the cap. Locked for the maximum **4 years** (208 epochs), a position yields full `4×` ve-power: e.g. `1,000,000 × (208/208) × 4 = 4,000,000 ve-power` at a tier-1 cap. Stop bribing → the stream stops.
   - **Liquidity without selling** — wallet hiSOLA balance = 0, so the wallet `borrow_usdc` path does not apply. Instead, `borrow_against_locked` lets the partner borrow up to **20%** (`PARTNER_BORROW_CAP_BPS = 2000`) of their locked position from `floor_vault` (2% fee, 75% floor buffer, repayable, no liquidation) — working capital without ever selling.
   - **No fee dilution** — `total_hi_sola` is NOT incremented (locked hiSOLA excluded from the fee accumulator denominator, mirroring `lock_hi_sola`). Existing stakers retain their full fee share throughout.
   - **Self-aligning** — if a partner stops bribing, they simply stop accruing; what they earned stays locked. The protocol never gives away governance against an unenforced promise.

After lock expiry (4 years): `unlock_hi_sola` → hiSOLA returns to wallet → standard rules apply (fee share, wallet borrow subject to 75% floor buffer, re-lock for renewed ve-power).

**Voting power growth flywheel:**
Protocol partners earn oSOLA via LP emissions on their native pools (JitoSOL/SOLA, mSOL/SOLA, etc.). This oSOLA can be burned during `vote_gauge` calls, adding `o_sola_bonus` — uncapped extra voting power for that epoch. Each burn is permanent and floor-positive. Partners who actively participate in the ecosystem progressively increase their governance influence without any additional allocation from the protocol.

### 7.3 Contributor / Service Provider Allocation (`register_contributor`)

For the people who worked unpaid until launch and keep contributing — first-class members of the project. Each contributor gets a dual allocation, claimed **all at once at launch** (no cliff, no vesting):
- **hiSOLA:** minted directly into a **lifetime ve-lock** (`permanent_amount` = full tranche — `unlock_hi_sola` can never release it). Never liquid SOLA: the wallet balance stays 0, so it earns no fees and cannot be sold; it votes (up to 4×) and borrows up to 20% via `borrow_against_locked`. Same pattern as the team tranche and the partner welcome bag.
- **oSOLA:** minted to the wallet, exercisable at the floor price (each exercise pays 1 USDC into the floor — self-financing).

Used sparingly — a handful of individuals, small amounts (single-digit thousands each). Amounts are set per wallet at `register_contributor` by the authority. Small one-time rewards (KOLs, contest winners) are paid in **oSOLA** via `distribute_o_sola`, drawing on the capped ecosystem budget below.

### 7.4 Ecosystem / Airdrop Allocation — issued as oSOLA, never as SOLA

The 1,750,000-token ecosystem budget is **not minted as SOLA**. It is issued exclusively as **oSOLA** through `distribute_o_sola`, with the cumulative total enforced on-chain by `ProtocolState.ecosystem_o_sola_minted` — the program refuses any distribution that would exceed `ECOSYSTEM_TOTAL` (`EcosystemBudgetExceeded`). Indicative split, in oSOLA (matches the public breakdown):
- **875,000 (50%):** Community airdrop, claim-based at TGE
- **437,500 (25%):** Marketing reserve for partnerships and campaigns
- **218,750 (12.5%):** Trading contests and community programs
- **218,750 (12.5%):** Reserve

There is **no separate operations fund** (a 175K "Operations & Management Fund" was considered
2026-07-14 and dropped 2026-07-18): operational costs ride the team tranche's 20% borrow line and,
post-launch, oSOLA-denominated payments from the marketing/reserve slices above.

Why oSOLA: an airdropped SOLA would be unbacked supply, redeemable 1:1 against a floor vault funded entirely by real buyers — a structural drain. An oSOLA is an option: the recipient pays 1 USDC into `floor_vault` to exercise, so **every SOLA that reaches circulation through this budget is fully floor-backed the moment it exists**. The drain is eliminated by construction, not deferred by a lock. (This mirrors Beradrome, which airdropped oBERO to its community — never BERO.)

---

## 8. Cross-Chain Infrastructure

**Why this is Soladrome's core advantage.** ve(3,3) liquidity today is fragmented — Aerodrome on Base, Velodrome on Optimism, Beradrome on Berachain, fBOMB across ten EVM chains, and a growing set of Solana venues — each an island with its own gauges, bribes and mercenary capital. Soladrome's bridges turn it into the **interoperability layer that unifies ve(3,3) liquidity across chains**:

- **Inbound** — any ve(3,3) protocol, on any chain, can route its governance token and bribes into Soladrome gauges (Wormhole Token Bridge for assets, LayerZero V2 for bribes), reaching Solana-native liquidity without migrating a treasury.
- **Outbound** — SOLA itself, floor-backed, can be bridged to EVM as wSOLA to seed pairs on those same ve(3,3) venues, exporting Soladrome's guaranteed-floor liquidity outward.

The result is a two-way clearing hub: bribes and liquidity from every ve(3,3) ecosystem can converge on Soladrome, and Soladrome's floor-backed liquidity can flow back out to them. **The bridges are not a feature — they are the moat.** The rest of this section details the rails.

### 8.1 Wormhole Token Bridge (LIVE)

Soladrome integrates the Wormhole Token Bridge to bring external DeFi liquidity into the Solana ecosystem. The bridge is accessible via the **Token Bridge** page in the frontend.

**Supported routes (live at mainnet):**

| Origin token | Origin chain | Wormhole-wrapped SPL | SPL mint address |
|---|---|---|---|
| AERO | Base | wAERO | `AXYvFSKMPwt9adL1eBZhrDNCvT29HXnhNQuPxNwDZin` |
| VELO | Optimism | wVELO | `GaLBL77CzH9XSzStkNPmCkWhuXwkDU38du2ainTGrEMN` |
| SOL | Solana | wSOL → Base | (canonical wSOL, bridged out) |

Both wAERO and wVELO were attested on Wormhole before going live. Attestation anchors the SPL mint address permanently — any AERO locked on Base releases wAERO on Solana at the attested mint, and vice versa. wSOL follows the same mechanism in the Base-bound direction.

**Use within Soladrome:** wAERO and wVELO are valid SPL tokens and can be deposited as bribe tokens in Soladrome gauges via `deposit_bribe`. This extends the bribe economy to include yield-bearing governance tokens from Base and Optimism without requiring custodians or synthetic wrappers.

---

### 8.2 Cross-Chain Bribe Bridge — LayerZero V2 (In Development)

The cross-chain bribe bridge removes the requirement for external protocols to hold assets on Solana before bribing. Any EVM-native protocol can submit a bribe from their home chain; the bridge delivers it to the correct Soladrome gauge atomically.

**Repository:** https://github.com/OxToF/soladrome-bridge

**Architecture:**

```
EVM chain (Base / Optimism / Arbitrum / …)
  │
  │  SoladromeBribeRouter.sol   (LayerZero V2 OApp)
  │    ├── takes ERC-20 bribe token + pool/epoch params
  │    ├── encodes message + calls LayerZero endpoint
  │    └── emits BribeSent event
  │
  ▼  LayerZero V2 cross-chain message
  │
Solana
  │  bridge-receiver (Anchor program)
  │    ├── receives LZ message via LayerZero DVN relayers
  │    ├── verifies pool, epoch, and token parameters
  │    ├── calls deposit_bribe CPI → BribeVault PDA
  │    └── Astralane sub-slot execution for <1-slot finality
  │
  ▼  Soladrome gauge (on-chain)
     └── bribe available for hiSOLA voters at epoch end
```

**Execution layer:** The bridge-receiver is integrated with **Astralane** sub-slot transaction execution, which targets landing transactions within a specific slot range. This eliminates front-running of bribe deposits and ensures predictable epoch-slot alignment for the receiving CPI.

**SDK:** A TypeScript SDK is published alongside the bridge repository. External protocols import `SoladromeBribeSDK` to construct and submit cross-chain bribe transactions in two calls: `approveBribeToken()` and `sendBribe(poolId, epochOffset, amount)`.

---

### 8.3 MLCB DAO — First External Bribe Partner (In Progress)

**MLCB DAO** is the first external protocol actively building toward bribing Soladrome gauges. Key facts:

- **Treasury:** fBOMB token, ~$35M treasury across multiple EVM chains (Base, Optimism, and others)
- **Existing positions:** Significant veAERO and veVELO holdings on Base and Optimism respectively — deep familiarity with gauge-bribe mechanics
- **Concrete work underway:** MLCB is building an **SPL version of fBOMB (LayerZero OFT)** — the technical prerequisite for bribing in fBOMB on Solana and for fBOMB-SOL liquidity. This is their entry path into the Solana ecosystem, with Soladrome as the venue.
- **Bridge usage:** once the OFT is live, MLCB can deploy fBOMB from their EVM treasury through `SoladromeBribeRouter.sol` without moving assets to Solana manually
- **Alignment:** Bribe flow → hiSOLA voters direct emissions toward MLCB-preferred pools → MLCB earns deeper liquidity for their protocol → cycle repeats each epoch

Commercial terms (bribe amounts, tier) are being negotiated and will be finalized around mainnet; the engineering groundwork is being laid on both sides in parallel.

---

### 8.4 wSOLA — Exporting Floor-Backed Liquidity to Other ve(3,3)s (Roadmap)

Interoperability runs both ways. **wSOLA** is SOLA bridged to EVM as an ERC-20, backed 1:1 by the same floor reserve. Because every wSOLA is redeemable against the floor, it carries Soladrome's defining property — bounded downside — onto chains where ve(3,3) already has deep liquidity.

This unlocks SOLA pairs on external ve(3,3) venues — e.g. a wSOLA/AERO pool on Aerodrome or wSOLA/VELO on Velodrome — letting Soladrome:

- **Normalise bribes EVM-side** — protocols can bribe wSOLA-paired gauges on their home chain, and that value routes back through the bridge into the Soladrome economy.
- **Extend the flywheel outward** — Soladrome's gauge/bribe loop and floor protection become reachable from Aerodrome/Velodrome liquidity, not only from Solana.
- **Preserve the floor** — oSOLA is exercised (paying floor USDC) before bridging out, so wSOLA in circulation is always fully floor-backed; the floor reserve is never weakened by the outbound leg.

Combined with §8.1–8.3, this makes Soladrome a hub that any ve(3,3) protocol can plug into **from either direction** — the foundation of cross-chain ve(3,3) liquidity interoperability.

---

## 9. Gauge and Bribe System

### 9.1 Epoch Structure

`EPOCH_DURATION = 604,800 s` (7 days). The current epoch is:
```
current_epoch = unix_timestamp / EPOCH_DURATION
```

All gauges, bribes, votes, and claims are keyed to epoch numbers stored as 8-byte little-endian seeds in PDAs.

### 9.2 Voting (`vote_gauge`)

hiSOLA holders allocate voting power across AMM pools per epoch. Constraints:
- Cumulative votes across pools ≤ `hi_sola_balance`
- One vote receipt per pool per epoch (replay-proof via `init` PDA)
- Per-address vote cap: 30% of total epoch votes (anti-whale)

### 9.3 Passive Vote Carry-Over (`set_vote_config` / `replay_vote`)

hiSOLA holders set a persistent vote allocation once via `set_vote_config`, specifying up to 5 pools and their respective basis-point weights. With `auto_replay = true`, any external caller — a keeper bot, a partner protocol, or the holder themselves — can invoke `replay_vote` each epoch without requiring the owner's signature.

`replay_vote` is functionally identical to `vote_gauge`: it creates the standard `UserVoteReceipt` and `UserEpochVotes` PDAs, applies the 30% anti-whale cap, and updates `GaugeState` and `GlobalEpochVotes`. The vote weight is recalculated from the owner's **live** hiSOLA balance + ve-power at replay time — it scales automatically as positions change.

This mirrors the behaviour of Beradrome and Velodrome v2, where passive veToken holders earn bribe rewards without weekly re-signing. The `UserVoteReceipt` `init` guard ensures replay and manual `vote_gauge` for the same pool in the same epoch are mutually exclusive.

### 9.4 Bribe Deposits (`deposit_bribe`)

Any external protocol or individual can deposit arbitrary SPL tokens as a bribe for a specific pool and epoch. Bribes are locked in a PDA vault until the epoch ends. Accepted bribe tokens include native Solana SPL tokens as well as Wormhole-wrapped tokens (wAERO, wVELO) bridged from EVM chains, and tokens delivered via the cross-chain bribe bridge (LayerZero V2).

### 9.5 Bribe Claims (`claim_bribe`)

After an epoch ends, voters claim pro-rata bribes:
```
claimable = total_bribed × user_votes / total_votes
```

Anti-double-claim: `UserBribeClaim` PDA is created with `init` on first claim (idempotent replay protection).

### 9.6 Rollover (`rollover_bribe`)

Unclaimed bribes from ended epochs can be rolled over to the next epoch:
- **Zero-vote pools**: immediate rollover after epoch ends
- **Voted pools**: `ROLLOVER_DELAY_EPOCHS = 2` grace period (14 days mainnet)

Rollover is permissionless — anyone can call it.

---

## 10. Permissionless AMM

### 10.1 Pool Creation

Any two distinct SPL token mints can be paired. Mints are sorted lexicographically before PDA derivation, ensuring (A,B) and (B,A) map to the same pool regardless of input order.

```
pool_pda = PDA([b"amm_pool", mint_a, mint_b])  // mints sorted lex
```

Pool parameters set at creation:
- `swap_fee_bps` (max 1000 = 10%)
- `protocol_fee_share_bps` (max 5000 = 50% of swap fee → `market_vault`)

### 10.2 Liquidity (xy=k)

First deposit locks `MINIMUM_LIQUIDITY = 1,000` LP tokens to the System Program (dead address), permanently removing them from circulation. Subsequent deposits rebalance to the limiting token side via `lp_for_deposit()`.

### 10.3 Emissions (Two Systems)

**Masterchef-style (continuous):** Per-second accumulator in `AmmPool`. `OSOLA_EMISSION_PER_SEC` oSOLA distributed to LP stakers proportionally to their share. Updated lazily on every interaction.

**Epoch-based (decaying, governance-weighted):** `checkpoint_lp` → `emit_pool_rewards` → `claim_lp_emissions`. Time-weighted LP balances per epoch; oSOLA allocation per epoch follows an exponential decay curve stored in `ProtocolState`:

```
epoch_emission = osola_emission_initial × (osola_emission_decay_bps / 10_000) ^ elapsed_epochs
                 capped below by osola_emission_floor_bps % of initial
```

This creates early-LP urgency while guaranteeing perpetual incentives above the floor. The `configure_emissions` instruction (authority-only, Squads multisig) resets the curve at any time.

---

## 11. Protocol-Owned Liquidity (POL)

### 11.1 Collection (`collect_to_pol`)

A configurable fraction (`pol_split_bps`, max 50%) of `market_vault` fees is diverted to `pol_usdc_vault`.

### 11.2 Deployment (`deploy_pol`)

Two-phase atomic operation:
1. Buy SOLA via bonding curve using POL USDC → SOLA lands in `pol_sola_ata`
2. Add SOLA + remaining USDC as liquidity to `target_pool` → LP tokens held permanently in `pol_lp_vault`

POL LP tokens are never redeemable — they are protocol-owned forever, providing permanent baseline liquidity and ongoing fee income.

---

## 12. Flash Arbitrage

`flash_arbitrage` atomically exploits price divergence between the AMM and the bonding curve:

1. Exercise oSOLA at floor price (burn oSOLA + pay 1 USDC → receive 1 SOLA)
2. Sell SOLA on the AMM for USDC (if AMM price > floor price)
3. Buy back SOLA via bonding curve if needed

Profit split:
- **10%** (`CALLER_ARB_SHARE_BPS = 1000`) → caller (incentive)
- **90%** → `market_vault` → hiSOLA stakers

This creates a permissionless arbitrage mechanism that self-corrects AMM prices while rewarding stakers with 90% of MEV.

Because step 1 is an oSOLA exercise, `flash_arbitrage` honors the same `exercise_enabled` phase flag as `exercise_o_sola` (§14.3) — otherwise the closed-launch exercise gate would be bypassable through this path.

---

## 13. Tokenomics

*See also: `TOKENOMICS.md` in this repository for full allocation tables and gauge economics.*

### 13.1 Supply

| Tranche | Amount | Mechanism | Floor backing |
|---|---|---|---|
| User purchases | Unlimited (curve-bound) | `buy_sola` | ✅ 1:1 |
| Founder hiSOLA | 7,000,000 | 6-month cliff, 24-month linear vest · **lifetime ve escrow** — no exit, no vote, no fee share | ❌ locked for life |
| Founder oSOLA | 5,000,000 | 6-month cliff, 24-month linear vest | ✅ on exercise |
| Team hiSOLA | 250,000 | Lifetime ve-lock at launch — votes, borrows 20%, never liquid SOLA | ❌ locked for life |
| Protocol partners | bags 250K / 175K / 100K by tier + per-deal bribe caps | Welcome bag **locked for life** · bribe-earned streamed vs bribes, 4-year lock | ❌ locked |
| Contributors | small, per-wallet | hiSOLA lifetime ve-lock + oSOLA, claimed at launch | ❌ hiSOLA locked for life |
| Ecosystem / airdrop | 1,750,000 **oSOLA** | `distribute_o_sola`, hard-capped on-chain | ✅ on exercise |

**All SOLA purchased by users is individually floor-backed at 1:1.** Unfinanced allocations never reach a wallet as liquid SOLA: the founder reserve, the team tranche and partner welcome bags are permanently escrowed, and the ecosystem budget only enters circulation through oSOLA exercise (which pays the floor). The single liquidity valve on all of them is `borrow_against_locked`, capped at **20%** — so the protocol's maximum exposure to unfinanced supply is 20% of the sum of those allocations, and the 75% floor buffer bounds it further. The one scheduled exception: partner **bribe-earned** hiSOLA becomes releasable when its 4-year lock expires — a capped, per-deal, published exposure.

### 13.2 Inflation

The only new SOLA entering circulation is:
- User `buy_sola` activity (each unit 100% floor-backed)
- Allocation claims — founder, team, contributor, partner (SOLA minted to `sola_vault`, hiSOLA locked in a ve vault)
- oSOLA exercises (each unit adds 1 USDC to `floor_vault` — net positive)

There is no protocol-controlled inflation. oSOLA is the primary incentive token; its value is derived from the right to acquire SOLA at floor price.

### 13.3 Revenue Model

Protocol revenue flows to `market_vault`:
- **Bonding curve premium** — spread between purchase price and floor price
- **AMM protocol fees** — `protocol_fee_share_bps` of each swap
- **Borrow origination fees** — 2% of each `borrow_usdc` / `borrow_against_locked`
- **Flash arbitrage** — 90% of arb profit

All `market_vault` revenue is distributed pro-rata to hiSOLA stakers via the reward-per-token accumulator.

---

## 14. Security Model

### 14.1 On-Chain Authority

At launch, the protocol authority is the deployer wallet. Post-launch, authority is transferred to a Squads v4 multisig vault (1-of-2) with two distinct Ledger hardware wallets. All admin instructions (`pause`, `unpause`, `initialize_pol`, `transfer_authority`) require multisig approval after this transfer.

### 14.2 Emergency Pause

`pause` / `unpause` freeze all entry instructions while preserving all exit paths:

**Always blocked when paused:** `buy_sola`, `stake_sola`, `borrow_usdc`, `exercise_o_sola`, `flash_arbitrage`, `deposit_bribe`, `vote_gauge`, `checkpoint_lp`, `lock_hi_sola`, `create_pool`, `add_liquidity`, `amm_swap`, `collect_to_pol`, `deploy_pol`

**Always accessible (exit paths):** `sell_sola`, `unstake_hi_sola`, `repay_usdc`, `remove_liquidity`, `unlock_hi_sola`, `claim_fees`, `claim_bribe`, `claim_lp_rewards`, `claim_lp_emissions`

Users can never be trapped. The worst case in a pause scenario is that entry is blocked; all exits remain open.

### 14.3 Launch Phase Gating (`set_phase_flags`)

Mainnet launches in two stages, enforced on-chain by five independent feature flags on `ProtocolState` (all `false` at `initialize`, each toggled individually by the authority via `set_phase_flags`):

| Flag | Gates |
|---|---|
| `lp_enabled` | `create_pool` |
| `bribes_enabled` | `deposit_bribe`, `partner_deposit_bribe` |
| `voting_enabled` | `vote_gauge` |
| `exercise_enabled` | `exercise_o_sola`, `flash_arbitrage` |
| `curve_enabled` | `buy_sola` |

**Stage 1 — partner-only window.** Founding partners are onboarded via `register_partner`, seed their pools, configure gauges, and begin accumulating locked hiSOLA before public access. The bonding curve stays closed (`curve_enabled = false`): the curve price is monotonically increasing, so an open curve before the public event would let snipers buy the cheapest SOLA ahead of the community airdrop. Partners do not need the curve — their hiSOLA is minted through the partner program and their liquidity sits in non-SOLA pools.

**Stage 2 — public open.** The authority flips `curve_enabled`; curve opening, TGE, and the on-chain airdrop distribution happen as a single event, on a protocol that already has liquidity depth and active incentives.

As with the emergency pause, gating applies to entry paths only. `sell_sola` (floor redemption) and every other exit path are never gated by any phase flag.

### 14.4 Floor Invariant

The core invariant checked after every `sell_sola`:
```
floor_vault_post + total_usdc_borrowed >= total_purchased_sola
```

This invariant is enforced on-chain and cannot be bypassed. If violated, the instruction reverts with `InsufficientFloorReserve`.

### 14.5 Hardcoded Addresses

Critical addresses are compile-time constants:
- `FOUNDER_WALLET` — Ledger Nano S, immutable in bytecode
- `SQUADS_VAULT` — transfer_authority target

Neither can be changed without a program upgrade. Program upgrade authority is held by the Squads multisig after deploy.

### 14.6 Security Testing

Prior to mainnet:
- Manual code review (10 findings, all resolved)
- Trident fuzzing: `fuzz_0` (bonding curve invariants, ~200k calls, 0 violations) and `fuzz_1` (flash arb invariants, ~200k calls, 0 violations)

---

## 15. PDA Architecture

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
| FounderHiSolaVesting | `[b"founder_hi_vesting"]` |
| FounderVesting | `[b"founder_vesting"]` |
| ContributorVesting | `[b"contributor", contributor_wallet]` |
| **PartnerAllocation** | `[b"partner", partner_wallet]` |
| **UserVoteConfig** | `[b"vote_config", user]` |

---

## 16. Instruction Set

Complete list of on-chain instructions (program ID: `4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd`):

**Core bonding curve:** `initialize` · `buy_sola` · `sell_sola`

**Staking & fees:** `stake_sola` · `unstake_hi_sola` · `claim_fees`

**Borrowing:** `borrow_usdc` · `repay_usdc` · `borrow_against_locked` (the sole path for ve-locked, unfinanced allocations — founder, team, contributor, partner — capped at 20%)

**oSOLA:** `exercise_o_sola` · `distribute_o_sola`

**Founder vesting:** `mint_founder_allocation` · `claim_founder_hi_sola` · `claim_founder_vesting`

**Ecosystem:** `mint_ecosystem_allocation`

**Contributor allocation (claimed at launch):** `register_contributor` · `claim_contributor_hi_sola` · `claim_contributor_vesting`

**Protocol partners:** `register_partner` · `partner_deposit_bribe` · `claim_partner_allocation`

**Gauge & bribes:** `deposit_bribe` · `vote_gauge` · `claim_bribe` · `rollover_bribe`

**Vote carry-over:** `set_vote_config` · `replay_vote`

**Emission control:** `configure_emissions`

**LP emissions:** `checkpoint_lp` · `emit_pool_rewards` · `claim_lp_emissions` · `claim_lp_rewards`

**AMM:** `create_pool` · `add_liquidity` · `remove_liquidity` · `amm_swap`

**Protocol-Owned Liquidity:** `initialize_pol` · `collect_to_pol` · `deploy_pol`

**veSOLA:** `lock_hi_sola` · `unlock_hi_sola`

**Flash arbitrage:** `flash_arbitrage`

**Admin:** `pause` · `unpause` · `set_phase_flags` · `set_founder_voting` · `configure_continuous_emissions` · `set_pool_rewards` · `transfer_authority` · `migrate_user_position`

---

## 17. Roadmap

| Phase | Status | Description |
|---|---|---|
| Devnet | ✅ Complete | Full protocol deployed and tested |
| Security review | ✅ Complete | Code review + Trident fuzzing (200k calls, 0 violations) |
| Squads multisig | ✅ Complete | 1-of-2 Ledger multisig (`BxYTiKyDxWpK4hPDZEiYVW9qBj8YpzhSHEBCWpaZbWQ4`) |
| Strategic allocations | ✅ Complete | Founder vesting, contributor system, partner auto-lock system |
| Wormhole Token Bridge | ✅ Live | wAERO (Base→Solana), wVELO (Optimism→Solana), wSOL (Solana→Base) |
| MLCB DAO partnership | In progress | MLCB building an SPL OFT of fBOMB — their entry path to Solana, with Soladrome as the venue; terms finalized around mainnet (§8.3) |
| Mainnet stage 1 — partner-only window | Upcoming | Founding partners seed pools, configure gauges, and accumulate locked hiSOLA; bonding curve closed (`curve_enabled = false`, §14.3) |
| Mainnet stage 2 — public open | Upcoming | `curve_enabled` flipped: curve opening + TGE + on-chain airdrop as one event, a fixed number of epochs after stage 1 |
| Cross-chain bribe bridge | In development | LayerZero V2 EVM→Solana bribe routing; testnet contracts deployed, endpoint-level DVN verification in progress (soladrome-bridge repo) |
| wSOLA outbound | Roadmap | SOLA → EVM (floor-backed) → wSOLA pairs on Aerodrome / Velodrome (§8.4) |
| Partner onboarding | Upcoming | Flight School program: bribe-indexed 1:1 hiSOLA streaming, tiered welcome bags and caps, 4-year lock (§7.2) — deployed and tested on devnet |
| Community airdrop | Upcoming | 200k SOLA Genesis Airdrop, distributed on-chain at TGE (no manual claim), sybil-filtered devnet testers |
| Audit | Pre-mainnet | Independent security audit — blocking prerequisite before mainnet deploy; quotes in hand |
| Jito partnership | In discussion | jitoSOL-SOL pool + gauge integration |
| Marinade partnership | In discussion | mSOL-SOL pool + bribe program |
| Solayer partnership | Planned | sSOL-SOL pool + gauge integration |

---

## 18. Related Work

- **Velodrome / Aerodrome** — ve(3,3) gauge-bribe architecture (inspiration for the gauge system)
- **Uniswap v2** — constant-product AMM (inspiration for pool mechanics)
- **Synthetix** — reward-per-token accumulator (inspiration for fee distribution)
- **Beradrome** — oToken model (inspiration for oSOLA exercise mechanics)
- **Compound** — collateral borrowing (inspiration for hiSOLA borrow system)

Soladrome's novel contribution is the combination of a **guaranteed floor-price bonding curve** with a **ve-gauge bribe system** on a single protocol, where floor backing is a provable on-chain invariant rather than a governance-dependent promise.

---

## Appendix A — Key Constants (Mainnet)

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
| `osola_emission_initial` | 800,000 oSOLA | Starting epoch LP rewards — calibrated for ~8% APR on $5M TVL pool |
| `osola_emission_decay_bps` | 9,900 | −1 % per epoch (≈ −40 %/year) |
| `osola_emission_floor_bps` | 1,875 | Floor = 150,000 oSOLA/epoch (18.75 % of initial, reached ~epoch 166) |
| `MINIMUM_LIQUIDITY` | 1,000 | Locked LP tokens on first deposit |
| `PRECISION` | 1e12 | Accumulator precision |

---

## Appendix B — Strategic Allocation Summary

| Beneficiary | Token | Amount | Cliff | Vesting / Lock | Borrow rights | On-chain mechanism |
|---|---|---|---|---|---|---|
| Founder | hiSOLA | 7,000,000 | 6 months | Lifetime ve escrow (no exit, no vote, no fees) | 20% of claimed (`borrow_against_locked`) | `claim_founder_hi_sola` |
| Founder | oSOLA | 5,000,000 | 6 months | 24 months linear | None | `claim_founder_vesting` |
| Team | hiSOLA | 250,000 | None | Lifetime ve-lock (votes as ordinary user) | 20% (`borrow_against_locked`) | `mint_ecosystem_allocation` |
| Jito (Tier 1) | hiSOLA | 250,000 | None | Bag: locked for life · bribe-earned: 4-year lock | 20% (`borrow_against_locked`) | `claim_partner_allocation` |
| Marinade (Tier 2) | hiSOLA | 175,000 | None | Bag: locked for life · bribe-earned: 4-year lock | 20% (`borrow_against_locked`) | `claim_partner_allocation` |
| Solayer (Tier 3) | hiSOLA | 100,000 | None | Bag: locked for life · bribe-earned: 4-year lock | 20% (`borrow_against_locked`) | `claim_partner_allocation` |
| Contributors | hiSOLA + oSOLA | small, per-wallet | None | hiSOLA lifetime ve-lock + oSOLA, claimed at launch | 20% (`borrow_against_locked`) | `claim_contributor_hi_sola` |
| Community airdrop | oSOLA | 875,000 | None | Claim at TGE — exercise pays 1 USDC to floor | None | `distribute_o_sola` (capped) |
| Marketing reserve | oSOLA | 437,500 | None | Exercise pays 1 USDC to floor | None | `distribute_o_sola` (capped) |
| Contests / community | oSOLA | 218,750 | None | Exercise pays 1 USDC to floor | None | `distribute_o_sola` (capped) |
| Reserve | oSOLA | 218,750 | None | Exercise pays 1 USDC to floor | None | `distribute_o_sola` (capped) |

*All hiSOLA allocations mint SOLA to `sola_vault` as 1:1 backing. None enter `total_purchased_sola` — the floor vault is exclusively funded by user `buy_sola` and oSOLA exercise activity.*

---

*Copyright © 2026 Soladrome Labs. Source code licensed under BUSL-1.1.*
*This document constitutes prior art disclosure as of its Git commit timestamp.*
*Program ID: `4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd` on Solana mainnet-beta.*
