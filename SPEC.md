# Soladrome — Smart Contract Specification
**Version:** 1.0 · **Program ID:** `DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe`  
**Chain:** Solana · **Framework:** Anchor 0.32.1 / Rust 1.89 · **License:** BUSL-1.1

---

## 1. Repo Structure

```
soladrome/
├── programs/soladrome/src/
│   ├── lib.rs          — instruction handlers + all #[derive(Accounts)] contexts
│   ├── state.rs        — on-chain account structs + epoch helpers
│   ├── math.rs         — bonding curve math (sola_out, accumulator, ve_power)
│   ├── errors.rs       — SoladromeError enum
│   ├── amm.rs          — AMM instruction logic + account contexts
│   ├── amm_state.rs    — AmmPool struct, sort_mints()
│   ├── amm_math.rs     — swap_out(), lp_for_deposit(), tokens_for_lp()
│   ├── pol.rs          — Protocol-Owned Liquidity instructions
│   └── ve.rs           — veSOLA lock/unlock instructions
├── app/                — Next.js 14 frontend
│   ├── app/            — Next.js App Router pages + API routes
│   ├── components/     — one component per on-chain feature
│   └── lib/            — program client, IDL, Supabase, token registry
├── tests/              — TypeScript end-to-end tests (localnet)
├── scripts/            — devnet helper scripts
├── .github/workflows/  — CI (cargo-test, anchor-check, frontend-lint)
├── Anchor.toml         — cluster config (devnet + localnet)
├── SPEC.md             — this document
└── GRANT_APPLICATION.md
```

---

## 2. Tokens & Decimals

All tokens use **6 decimals**. The floor price invariant is always 1:1 in base units (1 USDC = 1 SOLA).

| Token | Mint PDA | Role |
|-------|----------|------|
| SOLA | `[b"sola_mint"]` | Protocol token — minted via bonding curve |
| hiSOLA | `[b"hi_sola_mint"]` | Governance + yield — staked SOLA 1:1 |
| oSOLA | `[b"o_sola_mint"]` | LP call-option — exercise at floor price |
| LP-XY | `[b"lp_mint", pool]` | Per-pool AMM LP token |

**External bribe tokens:** `deposit_bribe` accepts any valid SPL token mint as a bribe. This includes Wormhole-wrapped tokens bridged from EVM chains: wAERO (SPL mint `AXYvFSKMPwt9adL1eBZhrDNCvT29HXnhNQuPxNwDZin`, attested from Base) and wVELO (SPL mint `GaLBL77CzH9XSzStkNPmCkWhuXwkDU38du2ainTGrEMN`, attested from Optimism). No program changes are required — the instruction is token-mint-agnostic by design.

---

## 3. Bonding Curve

**Invariant:** `k = virtual_usdc × virtual_sola` (set once at `initialize`, never recomputed)  
**Init values:** `virtual_usdc = virtual_sola = 100_000_000` (100 USDC / 100 SOLA)

### 3.1 Buy (`buy_sola`)

```
sola_out = virtual_sola - k / (virtual_usdc + usdc_in)

USDC split on buy (fee first, then the curve on the rest):
  fee            = usdc_in × CURVE_FEE_BPS / 10 000     // 1 %
  floor_portion  = sola_out                             // 1 USDC per SOLA minted (6-dec base units)
  premium        = usdc_in - fee - floor_portion

floor_vault    += floor_portion      // backs every SOLA 1:1 permanently
market_reserve += premium            // owed back to sellers (§3.2), never distributed
market_vault   += fee                // fee revenue → hiSOLA stakers
virtual_usdc   += usdc_in - fee
virtual_sola   -= sola_out
total_sola   += sola_out
```

**Slippage guard:** caller passes `min_sola_out`; tx reverts if `sola_out < min_sola_out`.

### 3.2 Sell (`sell_sola(sola_amount, min_usdc_out)`)

Since 2026-10-07 a sale goes back **down** the curve (before, it paid 1 USDC per SOLA whatever the curve said):

```
on_curve      = min(sola_amount, INIT_VIRTUAL_SOLA - virtual_sola)
proceeds      = virtual_usdc - ceil(k / (virtual_sola + on_curve))
premium       = proceeds - on_curve
fee           = min(proceeds × 1 %, premium)        // a sale never pays less than the floor
floor_vault    -= sola_amount                       // 1 USDC per SOLA
market_reserve -= premium                           // premium - fee to the seller, fee to market_vault
virtual_usdc   -= proceeds ; virtual_sola += on_curve
burn(sola_amount) ; total_sola -= sola_amount
require(usdc_out >= min_usdc_out)
require(market_reserve_post >= virtual_usdc + virtual_sola - 2N)
```

**Critical invariant:** `floor_vault.amount ≥ total_sola` always holds because every buy deposits exactly 1 USDC per SOLA minted.

---

## 4. Vaults

| Vault PDA | Token | Role |
|-----------|-------|------|
| `[b"floor_vault"]` | USDC | 1:1 SOLA backing — redeemable on sell |
| `[b"market_vault"]` | USDC | Fee revenue — distributed to hiSOLA stakers |
| `[b"sola_vault"]` | SOLA | Locked SOLA from stakers |
| `[b"pol_usdc_vault"]` | USDC | POL accumulation before deployment |
| `[b"pol_token", mint]` | SOL / LST | POL counter-asset bought by `pol_swap`, waiting for `deploy_pol` |
| `[b"pol_lp_vault", pool]` | LP | Permanent POL LP position, one per pool |

All vaults are **PDA token accounts** signed by `ProtocolState`. No admin keypair touches funds.

---

## 5. Staking & Fee Distribution

### 5.1 Stake (`stake_sola` → hiSOLA)

```
advance_accumulator()              // snapshot fees before supply changes
transfer(sola → sola_vault)
mint(hiSOLA → user)
total_hi_sola += amount
user.fees_debt = fees_per_hi_sola  // no retroactive claim
```

### 5.2 Fee Accumulator (reward-per-token, O(1))

```
Δ = market_vault.balance - last_market_vault_balance
fees_per_hi_sola += (Δ × PRECISION) / total_hi_sola   // PRECISION = 1e12

claimable(user) = (fees_per_hi_sola - user.fees_debt) × user.hi_sola_balance / PRECISION
```

Accumulator is advanced **before** every operation that changes `total_hi_sola`.

### 5.3 Borrow (`borrow_usdc`)

```
max_borrow = user.hi_sola_balance - user.usdc_borrowed
transfer(usdc_amount from floor_vault → user)
user.usdc_borrowed += usdc_amount
```

No interest. No liquidation. Unstake is blocked while `usdc_borrowed > 0`.

---

## 6. Flash-Arbitrage Reverse-Profit (FARP)

The protocol's unique MEV-capture primitive. Executed atomically in a single transaction.

```
profit = arb_opportunity(amm_price, bonding_curve_price)

caller_share  = profit × CALLER_ARB_SHARE_BPS / 10_000   // 10% → caller
protocol_share = profit - caller_share                    // 90% → market_vault

transfer(caller_share → caller_token_account)
market_vault += protocol_share
advance_accumulator()    // immediately available to hiSOLA stakers
```

**`CALLER_ARB_SHARE_BPS = 1_000`** (hardcoded — requires program upgrade to change).  
The arb is computed atomically; if the net result is a loss, the transaction reverts.

---

## 7. AMM (xy=k)

Mints are sorted lexicographically before PDA derivation → unique pool per pair regardless of input order.

```
pool PDA = [b"amm_pool", min(mint_a, mint_b), max(mint_a, mint_b)]

swap_out = reserve_out - k_pool / (reserve_in + amount_in_after_fee)
fee = amount_in × swap_fee_bps / 10_000
  └─ lp_portion  = fee × (10_000 - protocol_fee_bps) / 10_000  → stays in reserves
  └─ protocol_portion = fee × protocol_fee_bps / 10_000         → market_vault
```

**Caps:** `swap_fee_bps ≤ 1_000` (10%), `protocol_fee_bps ≤ 5_000` (50% of fee).  
**MINIMUM_LIQUIDITY = 1_000** locked to System Program on first deposit (anti-manipulation).

---

## 8. Key Invariants (auditor checklist)

| # | Invariant | Where enforced |
|---|-----------|----------------|
| I-1 | `floor_vault ≥ total_sola` (6-dec units) | buy_sola split logic |
| I-2 | `k` is never recomputed after initialize | lib.rs — no k assignment outside initialize |
| I-3 | `market_reserve ≥ virtual_usdc + virtual_sola − 2N` (every premium not yet paid back) | sell_sola; holds by construction since every trade moves both sides by the premium |
| I-4 | Accumulator advanced before any `total_hi_sola` change | stake, unstake, mint_founder, mint_ecosystem |
| I-5 | `usdc_borrowed ≤ hi_sola_balance` at all times | borrow_usdc + unstake_hi_sola checks |
| I-6 | One-time allocations guarded by boolean flags | founder_allocated, ecosystem_allocated |
| I-7 | FARP profit is non-negative (tx reverts otherwise) | flash_arbitrage require! |
| I-8 | Double-claim impossible (PDA init guard) | UserBribeClaim, LpEpochClaim |
| I-9 | Lexicographic mint sort → unique pool PDA | sort_mints() called in create_pool + all AMM ctxs |

---

## 9. Error Reference

`SlippageExceeded` · `InsufficientFloorReserve` · `BorrowLimitExceeded` · `OutstandingDebt` ·
`Overflow` · `InvalidAmount` · `Unauthorized` · `NothingToClaim` · `AlreadyAllocated` ·
`WrongEpoch` · `EpochNotEnded` · `VoteOverflow` · `InsufficientLiquidity` ·
`InvalidPoolTokens` · `ZeroLiquidity` · `LockNotExpired`

---

*Scope boundary: this spec covers the bonding curve, vaults, staking, flash-arb splitter, and AMM core.  
POL (pol.rs) and veSOLA (ve.rs) are Phase 2 — documented separately.*
