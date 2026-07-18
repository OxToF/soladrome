# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Smart contract (root)
```bash
anchor build                        # compile + regenerate IDL (target/idl/soladrome.json)
anchor test                         # build + localnet validator + run tests
yarn run ts-mocha -p ./tsconfig.json -t 1000000 "tests/**/*.ts"  # tests only (no rebuild)
yarn lint                           # check formatting (prettier)
yarn lint:fix                       # auto-fix formatting
```

### ⚠️ Devnet deploy requires SBPFv3 — plain `anchor deploy` FAILS
Devnet runs Agave 4.1+ with `SIMD-0500` active (deployment of SBPF v0/v1/v2 **disabled**)
and `SIMD-0178` active (SBPFv3 **enabled**). The default `anchor build`/`anchor deploy`
emits a too-new arch and is rejected with *"Detected sbpf_version ... not enabled"*.
Build the `.so` explicitly as **SBPFv3** and deploy with `solana program deploy`:
```bash
# Toolchain must match devnet (Agave 4.1.x): agave-install init 4.1.0-beta.1
rm -f target/{deploy,sbf-solana-solana/release}/soladrome.so   # force clean if cached
cargo build-sbf --arch v3                                      # SBPFv3 (~1.6 MB .so)
RPC=$(grep ^NEXT_PUBLIC_RPC_URL= app/.env.local | cut -d= -f2-)  # Helius (public RPC times out)
solana program deploy target/deploy/soladrome.so \
  --program-id target/deploy/soladrome-keypair.json \
  --upgrade-authority ~/.config/solana/id.json --url "$RPC"
# After struct/IDL changes: run `anchor build` once for the IDL, then cp target/idl/soladrome.json app/lib/
# Failed deploys leave a buffer (~12 SOL) — reclaim: solana program close --buffers --url https://api.devnet.solana.com
```

### ⚠️ `anchor test` DEPLOYS TO DEVNET — it is not a localnet run
`Anchor.toml` has `cluster = "devnet"`, so `anchor test` **builds, deploys to the live devnet
program (`4d2SY…`), then runs the suite against accumulated devnet state** — rate-limited by Helius
(expect dozens of 429s) and dependent on the test wallet holding devnet USDC. For a clean run
against a fresh `initialize` (the only way to exercise `INIT_VIRTUAL_*`, since `k` and the virtual
reserves are frozen in `ProtocolState` at init):
```bash
anchor test --provider.cluster localnet
```

### Legacy `UserPosition`: 128 → 136 bytes (migration required)
The flash-borrow guard added `last_borrow_slot: u64`, growing `UserPosition` from 128 to 136 bytes.
Accounts created by earlier program versions are 128 and fail `init_if_needed` with
**`ConstraintSpace, Left: 136, Right: 128`**. The fix already exists: `migrate_user_position`
(realloc, zeroed) — the frontend prepends it in `Borrow`, `Stake`, `ClaimFees`, `FounderPanel`,
`PartnerPanel`. **`ContributorPanel.tsx` does NOT** — legacy contributor positions will fail there.
The **test suite doesn't call it either**, which is why borrow/lock tests fail on devnet.

### Frontend (`app/`)
```bash
yarn dev    # dev server on :3000
yarn build  # production build
```

### Devnet config
```bash
solana config get                   # verify cluster = devnet
solana balance                      # check deployer wallet SOL
solana program show 4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd
```

`app/.env.local` must have `NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com` for devnet testing. The default may be set to `http://127.0.0.1:8899` (localnet).

## Architecture

### Lineage — Soladrome is a Solana adaptation of Beradrome

Read this first: the economic design is **not** original. It ports [Beradrome](https://docs.beradrome.com)
(Berachain) to Solana, mint-for-mint:

| Beradrome | Soladrome |
|---|---|
| BERO / hiBERO / oBERO | SOLA / hiSOLA / oSOLA |
| HONEY (base) | USDC (base) |
| Floor Reserves — floor 1 HONEY, unlimited capacity | `floor_vault` — floor 1 USDC, unlimited via `exercise_o_sola` |
| Market Reserves — virtual bonding curve | `virtual_usdc` / `virtual_sola` / `k` |
| Borrow against hiBERO, 2% origination, no interest | `borrow_usdc`, `BORROW_FEE_BPS = 200` |
| oBERO emissions, −1%/week | `osola_emission_decay_bps = 9_900`, −1%/epoch (epoch = 7 d) |
| Real Deal (1M hiBERO to partner DAOs) | partner system (`PARTNER_SEED`, `register_partner`) |

**Two-stage architecture (inherited):** the *market curve* prices SOLA and is bounded by
`INIT_VIRTUAL_SOLA`; the *floor reserve* mints SOLA without limit at 1 USDC via `exercise_o_sola`
(which does **not** touch the virtual reserves). Emissions are a **separate schedule** — they are
not the curve. Confusing the two leads to wrong conclusions about supply caps.

**Divergence from Beradrome:** `osola_emission_floor_bps = 1_000` puts a 10% floor under emission
decay. Beradrome has none, so its emissions converge (80k/week × Σ0.99ⁿ = **8M total, ever**).
Soladrome's reach the floor at ~epoch 229 (≈4.4 y) and then emit `initial × 0.10` **forever** —
supply does not converge. Defensible (each exercised oSOLA adds 1 USDC to the floor), but it is a
deliberate choice and an auditor will ask.

### Program layout (`programs/soladrome/src/`)

| File | Role |
|---|---|
| `lib.rs` | All instruction entry points + every `#[derive(Accounts)]` context |
| `state.rs` | On-chain account structs: `ProtocolState`, `UserPosition`, bribe/gauge PDAs |
| `math.rs` | Bonding curve math: `sola_out()`, `advance_accumulator()`, `pending_fees()` |
| `errors.rs` | `SoladromeError` enum |
| `amm.rs` | AMM instruction logic + account contexts (`CreatePool`, `AddLiquidity`, `RemoveLiquidity`, `Swap`) |
| `amm_state.rs` | `AmmPool` struct, `sort_mints()` |
| `amm_math.rs` | `swap_out()`, `lp_for_deposit()`, `tokens_for_lp()`, `isqrt()`, `MINIMUM_LIQUIDITY` |

### Two separate systems share one codebase

**System 1 — Bonding curve + floor reserve (SOLA/hiSOLA/oSOLA)**
- Single global `ProtocolState` PDA `[b"state"]`
- `buy_sola`: USDC in → split between `floor_vault` (1:1 backing) and `market_vault` (excess = fees)
- `sell_sola`: burn SOLA → redeem 1:1 from `floor_vault` only (never touches curve)
- `stake_sola` / `unstake_hi_sola`: SOLA ↔ hiSOLA 1:1, SOLA locked in `sola_vault`
- `claim_fees`: pro-rata share of `market_vault` via reward-per-token accumulator (`PRECISION = 1e12`)
- `borrow_usdc` / `repay_usdc`: hiSOLA collateral → USDC from `floor_vault`, max = hiSOLA balance, no interest, no liquidation
- `exercise_o_sola`: burn oSOLA + pay floor USDC → mint SOLA (strengthens floor)

**System 2 — Permissionless AMM multi-pool**
- Each pool is an `AmmPool` PDA; mints are sorted lexicographically before seeding so (A,B) and (B,A) map to the same pool
- Protocol fee from swaps routes to the global `market_vault` → feeds hiSOLA stakers
- First LP deposit locks `MINIMUM_LIQUIDITY = 1_000` to `LP_DEAD_PUBKEY` (System Program)
- `lp_for_deposit()` auto-rebalances to the limiting token side on subsequent deposits

**Gauge / Bribe system**
- 7-day epochs (`EPOCH_DURATION = 604_800 s`); `current_epoch = unix_ts / EPOCH_DURATION`
- **Who gets paid what** (code-verified 2026-07-17, a recurring point of confusion):
  **bribes → voters** (`claim_bribe`: `total_bribed × user_votes / total_votes`, basis =
  `UserVoteReceipt` — LP balance appears nowhere) · **oSOLA emissions → LPs** (vote-directed) ·
  **protocol fees → all hiSOLA stakers** (`claim_fees`, no voting required) · **LP-side swap
  fees → LPs** (stay in the pool). Same axis as Beradrome (bribes buy votes), so a partner
  dominating their own pool's LP recaptures none of their own bribe.
- Bribes deposited during epoch N; claims only open after epoch N ends
- Double-claim guard: `UserBribeClaim` PDA created with `init` (fails on replay)
- Vote allocation: cumulative across pools ≤ hiSOLA balance; `UserVoteReceipt` uses `init` (blocks second vote for same pool)

### Critical invariants

- **All tokens use 6 decimals** — floor price is always 1:1 in base units (1 USDC = 1 SOLA at floor)
- **`k` is never recomputed** — set once at `initialize` (`1e12 × 1e12 = 1e24`, i.e. N = 1M tokens at 6 dec); virtual reserves drift, `k` stays fixed. It is the only irreversible number in the protocol — see the curve-depth section below
- **`sell_sola` does not move virtual reserves** — only `buy_sola` updates `virtual_usdc` / `virtual_sola`
- **Accumulator must be advanced before changing `total_hi_sola`** — both `stake_sola` and `mint_founder_allocation` snapshot the accumulator first
- **Founder allocation is one-time** — guarded by `founder_allocated` flag on `ProtocolState`; hardcoded wallet `46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4` (Ledger Nano S, dedicated Soladrome wallet)

### Tokenomics — the numbers (all in `lib.rs:60-130`, `state.rs`)

**Founder allocation — 12.25M SOLA in three tranches** (`FOUNDER_TOTAL`, reference only, never a cap):

| Tranche | Amount | Constant | Regime |
|---|---|---|---|
| hiSOLA governance | 7,000,000 | `FOUNDER_STAKE` | ve escrow, **locked for life**, no vote, no fees |
| oSOLA vesting | 5,000,000 | `FOUNDER_LIQUID` | vesting vault, linear after cliff |
| team tranche | 250,000 | `FOUNDER_IMMEDIATE_SOLA` | → `TEAM_WALLET`, hiSOLA in a **lifetime** ve lock (`permanent_amount` covers the full tranche — decision 2026-07-17, upgraded from 4 years). **Votes** (up to 4×) — a distinct wallet from FOUNDER_WALLET by design, since the vote guard keys on the latter. Borrows 20% via `borrow_against_locked`. Pays contributors who worked unpaid pre-launch. |

The **1.75M ecosystem budget is no longer minted as SOLA** (changed 2026-07-17). It is issued as
oSOLA through `distribute_o_sola`, capped by `ProtocolState.ecosystem_o_sola_minted` — see the
floor-drain section below.

`VESTING_CLIFF_SECS` = 180 d (prod) / 6 h (test), then linear vesting over 2 y. The 7M hiSOLA are a
dormant anti-capture reserve: `founder_voting_enabled = false` by default, flipped via
`set_founder_voting` only as a break-glass against governance capture. `ECOSYSTEM_TOTAL` = 1.75M.

**☢️ `FOUNDER_WALLET` is feature-gated (added 2026-07-17)** — `devnet` is a **default** feature, so
a plain `anchor build` resolves the founder to `DJZFZSBGCuo3X79hEVqPjzdkKF5aVDVNCaFyW8g5QS6i`,
whose key is committed at `tests/keys/founder-devnet.json`. Shipping that build to mainnet hands
12.25M to anyone who reads the repo. `VESTING_CLIFF_SECS` rides the same flag (5 s vs 180 days), so
a wrong build gives away the wallet *and* the timelock together.

```
anchor build --no-default-features   ← mainnet: real Ledger 46Aqf…, 180-day cliff
anchor build                         ← devnet/localnet: throwaway key, 5 s cliff
```

This gate is what made the founder path testable at all (the mainnet wallet is a Ledger no test can
sign for) — before it, the entire 12.25M allocation had **zero** coverage. Consider inverting the
default so the safe build is the unflagged one.

**Borrow is extraction, not credit.** No interest, no liquidation — a borrow is never repaid in
practice, so every borrowed USDC leaves the floor vault permanently. The cap is therefore not a
risk limit, it is **the drain limit**.

**The rule (settled 2026-07-17): 100% if the collateral is financed, 20% if it is not.**

| Instruction | Cap | Why |
|---|---|---|
| `borrow_usdc` | **100%** of `user_hi_sola.amount` | An ordinary user bought their SOLA — their USDC *is* in the floor vault. They borrow their own deposit back and drain nobody. Same as Beradrome. |
| `founder_borrow_usdc` | `claimed × FOUNDER_BORROW_CAP_BPS` (**20%**) | Unfinanced allocation. ⚠️ Likely dead code since the 7M are ve-escrowed → wallet balance 0 → its `new_borrowed <= hi_sola_balance` check can't pass. Use `borrow_against_locked`. |
| `contributor_borrow_usdc` | `hi_sola_claimed × CONTRIBUTOR_BORROW_CAP_BPS` (**20%**) | Unfinanced. Was 10% until 2026-07-17; aligned. |
| `borrow_against_locked` | `PARTNER_BORROW_CAP_BPS` (**20%**) | Unfinanced. Open to **any** ve-locker, so it also serves the founder's 7M and the team's 250K. |

**Consequence worth publishing:** for any allocation that never paid into the floor, locking it does
not stop the drain — it switches the channel from `sell_sola` (100%) to `borrow_against_locked`
(20%). So the protocol's total exposure to unfinanced supply is

> **20% × Σ(unfinanced allocations)** ≈ 1.4M (founder 7M) + 50K (team 250K) + 20% of partner bags.

Publish that single number, not the individual caps.

All paths are additionally bounded by `floor_vault.amount >= usdc_amount` and the 75% buffer
(`FLOOR_RESERVE_MIN_BPS = 7_500`), making **borrowable ≈ 25% of `total_purchased_sola`** — gated on
real buy volume, not on allocation size. Below ~5.6M of purchased SOLA the buffer binds before the
20% cap ever does. `BORROW_FEE_BPS = 200` (2%, one-time, → `market_vault`).

### Economic constants — curve depth `N` (set 2026-07-16)

```rust
pub const INIT_VIRTUAL_USDC: u64 = 1_000_000_000_000; // 1 000 000 USDC (6 dec)
pub const INIT_VIRTUAL_SOLA: u64 = 1_000_000_000_000; // 1 000 000 SOLA (6 dec)
// k = INIT_VIRTUAL_USDC * INIT_VIRTUAL_SOLA = 1e24, set once at `initialize`, NEVER recomputed
```

`N = 1M` was chosen 2026-07-16. The previous `100_000_000` (= 100 / 100) was **Beradrome's
documentation example verbatim** ("100 virtual HONEY × 100 BERO = 10,000") — which their own docs
call illustrative, not a protocol maximum. It never looked like a TODO, which is why it survived to
the eve of audit. At N = 100, $10k of buys priced SOLA at $10,201 against a $1 floor, putting every
oSOLA 10,000× in the money → mass exercise minting unbounded SOLA at $1 without moving the curve
(exercise doesn't touch the virtual reserves). The economy detached within a few hundred dollars.

**Both constants must stay equal** so the start price = floor = 1 USDC/SOLA. Because exercise mints
outside the curve, **N sizes price-discovery depth, not supply**: `price = (1 + U/N)²`,
`SOLA emitted = N × (1 − 1/√price)`, `U` = cumulative USDC bought through the curve.

| At N = 1M | USDC in (`U`) | SOLA emitted | Borrowable (25% of purchased) |
|---|---|---|---|
| price ×1.24 | 114 k | 102 k | **25 k** ← founder runway target |
| price ×2 | 414 k | 293 k | 73 k |
| price ×10 | 2.16 M | 684 k | 171 k |

`k` is the only truly irreversible number in the protocol — it cannot be changed after `initialize`.
By contrast `osola_emission_initial` is adjustable post-launch via `configure_emissions`.

### The floor drain via unfinanced allocations — closed 2026-07-17

**The defect.** `sell_sola`'s comment claimed founder/ecosystem SOLA "cannot be redeemed at floor
price (this check enforces that)". It cannot: the check is `total_purchased_sola >= sola_amount`,
which is *aggregate*, and SOLA is fungible, so it cannot tell holders apart. Walk it: buyers
purchase 1M (floor = 1M, `total_purchased_sola` = 1M); 250K unfinanced is minted (never added to
`total_purchased_sola`); it is sold → the check passes, floor → 750K, `total_purchased_sola` → 750K,
and the post-invariant `backed >= total_purchased_sola` **still holds**. Result: 1M of real SOLA
backed by 750K of USDC. The accounting stays self-consistent while the backing is gone, because an
unfinanced burn decremented a counter it never incremented. Exposure was ~2M (250K + 1.75M).

**How each tranche was closed:**

| Tranche | Before | Now |
|---|---|---|
| Team 250K | liquid SOLA → wallet, sellable at floor day 1 | hiSOLA in a **lifetime** ve lock (`permanent_amount` = full tranche) — **closed**: `unlock_hi_sola` can never release it, only the 20% borrow channel remains. |
| Ecosystem 1.75M | liquid SOLA → authority ATA (the largest vector) | **eliminated** — issued as oSOLA via `distribute_o_sola`, capped by `ecosystem_o_sola_minted`. The holder pays 1 USDC into the floor to exercise, so every SOLA reaching circulation is financed. Same as Beradrome, which airdropped oBERO and never BERO. |

Ve-locking the ecosystem was considered and rejected: it would make the airdrop impossible while
only deferring the drain. **Only financing removes it.**

**Partner allocations (settled 2026-07-17): the welcome bag is permanent voting power.**
`VeLockPosition.permanent_amount` (new field, carved from spare bytes — legacy positions read 0)
marks the portion `unlock_hi_sola` can never release: releasable = `amount_locked −
permanent_amount`. `claim_partner_allocation` sets `permanent_amount = base_vested`, so the
welcome bag never reaches a wallet (it is unfinanced — no USDC ever entered the floor for it),
while the **bribe-earned** portion stays under the normal 4-year lock, releasable and re-lockable
at expiry. Note the bribe-earned tranche is *also* unfinanced (partner bribes pay voters, not the
floor) — releasing it at expiry is an accepted, capped exposure (`cap_hi_sola` per deal). What the
protocol sells a partner is: permanent voting power on the bag + a 20% borrow valve
(`borrow_against_locked`) + a releasable bribe-earned tranche. Covered by the `[partner]` test.

### Open items flagged pre-audit (still not fixed)

1. **Stale comments**: `lib.rs` founder-borrow doc and the "~29k USDC/month" figure assume a 10%
   founder cap; the constant is 20% (real figure ~58k/month). about.html publishes "20%" as a
   guarantee the code did not enforce until the ve escrow landed.
2. **`collect_to_pol` over-credits stakers** — see MAINNET_RUNBOOK §2. Same class as the drain above.
3. ~~The team lock expiry~~ — **resolved 2026-07-17**: the team tranche is permanently locked (`permanent_amount`), so no expiry ever reopens the drain. Remaining scheduled exposure: partner **bribe-earned** hiSOLA at 4-year expiry, capped per deal.

Root cause shared by all of these: **fungibility defeats per-tranche rules**. Tranche restrictions must
live in state or escrow, never in a token balance.

### PDA seeds quick reference

```
ProtocolState    → [b"state"]
UserPosition     → [b"position", user_pubkey]
floor_vault      → [b"floor_vault"]
market_vault     → [b"market_vault"]
sola_vault       → [b"sola_vault"]
sola_mint        → [b"sola_mint"]
hi_sola_mint     → [b"hi_sola_mint"]
o_sola_mint      → [b"o_sola_mint"]
AmmPool          → [b"amm_pool", mint_a, mint_b]  (mints sorted lex)
LP mint          → [b"lp_mint", pool_pubkey]
vault_a / vault_b→ [b"vault_a" | b"vault_b", pool_pubkey]
BribeVault       → [b"bribe_vault", pool_id, reward_mint, epoch_le8]
bribe_token_vault→ [b"bribe_tokens", pool_id, reward_mint, epoch_le8]
GaugeState       → [b"gauge", pool_id, epoch_le8]
UserVoteReceipt  → [b"vote", user, pool_id, epoch_le8]
UserEpochVotes   → [b"uev", user, epoch_le8]
UserBribeClaim   → [b"bribe_claim", user, pool_id, reward_mint, epoch_le8]
```

### Frontend (`app/`)

- `app/lib/SoladromeContext.tsx` — global React context; fetches `ProtocolState` on-chain, derives all mint/vault addresses from it (no hardcoded env vars for mints)
- `app/lib/program.ts` — builds the Anchor `Program` client from the IDL
- `app/lib/soladrome.json` — IDL (regenerated by `anchor build`)
- `app/lib/tokens.ts` — shared token registry (includes wSOL) for the AMM pool selector
- One component per feature: `BuySell`, `AmmSwap`, `Pools`, `Stake`, `Borrow`, `ClaimFees`, `Gauge`, `Vote`, `Liquidity`, `Stats`
- Navigation is client-side only (single page, `useState<Page>`)
- Inter-component navigation uses a custom `window.dispatchEvent(new CustomEvent("nav", { detail: pageId }))` pattern
