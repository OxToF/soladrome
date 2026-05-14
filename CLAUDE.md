# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Smart contract (root)
```bash
anchor build                        # compile the program
anchor deploy                       # deploy to configured cluster (devnet)
anchor test                         # build + localnet validator + run tests
yarn run ts-mocha -p ./tsconfig.json -t 1000000 "tests/**/*.ts"  # tests only (no rebuild)
yarn lint                           # check formatting (prettier)
yarn lint:fix                       # auto-fix formatting
```

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
- Bribes deposited during epoch N; claims only open after epoch N ends
- Double-claim guard: `UserBribeClaim` PDA created with `init` (fails on replay)
- Vote allocation: cumulative across pools ≤ hiSOLA balance; `UserVoteReceipt` uses `init` (blocks second vote for same pool)

### Critical invariants

- **All tokens use 6 decimals** — floor price is always 1:1 in base units (1 USDC = 1 SOLA at floor)
- **`k` is never recomputed** — it is set once at `initialize` (`100e6 × 100e6`); virtual reserves drift, `k` stays fixed
- **`sell_sola` does not move virtual reserves** — only `buy_sola` updates `virtual_usdc` / `virtual_sola`
- **Accumulator must be advanced before changing `total_hi_sola`** — both `stake_sola` and `mint_founder_allocation` snapshot the accumulator first
- **Founder allocation is one-time** — guarded by `founder_allocated` flag on `ProtocolState`; hardcoded wallet `CL4yt4Ep6N3AKbbHhQaidjVLNzQrdgT5NobQSE6FGHr3`

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
