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

### ✅ Running the whole suite locally, without touching devnet
`Anchor.toml` points at devnet, but the suite does **not** need it. `solana-test-validator` is not
on `PATH` by default; it ships with the Agave install:
```bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana-test-validator --reset --quiet --ledger /tmp/test-ledger \
  --bpf-program DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe target/deploy/soladrome.so &
solana --url http://127.0.0.1:8899 airdrop 500 2BhwbPGjRcoYv98jLJpkk6khjZX1oW97kSixUge2xTfB
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$HOME/.config/solana/id.json \
  npx ts-mocha -p ./tsconfig.json -t 1000000 "tests/**/*.ts"
```
⚠️ **Always `--reset`.** Without a fresh ledger, state left by a previous run makes tests pass that
fail from cold — seen on `[founder] burn_o_sola_for_votes`, green only on the second run.

⚠️ **On Node 22.18–23.x, prefix the run with `NODE_OPTIONS=--no-experimental-strip-types`.**
Those versions enable native TypeScript type-stripping by default, and it claims `.ts` before
ts-node's require hook: the file is served as ESM, `require()` fails, mocha retries with
`import()`, and the run dies on `SyntaxError: Named export 'BN' not found` — `@coral-xyz/anchor`
is CommonJS. Node 24 resolves it the other way, so the suite is green there and red on 22 with
no change to the code. CI sets this on both test jobs.

### ⚠️ `anchor test` DEPLOYS TO DEVNET — it is not a localnet run
`Anchor.toml` has `cluster = "devnet"`, so `anchor test` **builds, deploys to the live devnet
program (`4d2SY…`), then runs the suite against accumulated devnet state** — rate-limited by Helius
(expect dozens of 429s) and dependent on the test wallet holding devnet USDC. For a clean run
against a fresh `initialize` (the only way to exercise `INIT_VIRTUAL_*`, since `k` and the virtual
reserves are frozen in `ProtocolState` at init):
```bash
anchor test --provider.cluster localnet
```

### ⚠️ `ProtocolState`: 416 → 448 bytes (migration required, 2026-08-23)
`founder_wallet: Pubkey` needed 32 bytes and the singleton had **9** spare, so unlike every field
before it this one grew `LEN`. Live deployments must run `migrate_protocol_state(founder_wallet)`
— it reallocs (zero-filled), tops up rent, then backfills the address **write-once**: only a still
-default field may be set, and only while `founder_allocated` is false, so the migration can never
redirect a live tranche. Until it runs, `founder_wallet` reads `Pubkey::default()`, which matches
no signer — every founder guard fails **closed**, not open. Growing a live singleton is what caused
the 3003 devnet brick in July; this is why the growth goes through that instruction and nothing else.

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

**Divergence from Beradrome:** `osola_emission_floor_bps` puts a floor under emission decay.
Beradrome has none, so its emissions converge (80k/week × Σ0.99ⁿ = **8M total, ever**).
Soladrome's do not — they reach the floor and then emit `initial × floor_bps` **forever**.
Defensible (each exercised oSOLA adds 1 USDC to the floor), but deliberate, and an auditor
will ask.

**Recalibrated 2026-08-09** — `initialize` now writes **20 000/epoch, −1%/epoch, floor 25%**:
floor at epoch 137 (~2.6 y), ~0.81M in year 1, ~1.5M by the floor, then 0.26M/year in
perpetuity. The previous 800 000/epoch with an 18.75% floor emitted 32.6M in year 1 and
7.8M/year forever — which at $10M TVL is 163% APR on a ×1.5 move and 1 303% at ×5.

The 20 000 start is a deliberate launch pull (4-20% APR at the $2-5M TVL a gated launch
opens with); the decay is what keeps it a *boost* rather than a level. The floor is set in
absolute terms — **5 000 oSOLA/epoch steady-state** — and the ratio (25%) only controls how
fast the boost tapers into it. A 50% floor would have locked 10 000/epoch in forever for no
extra launch effect. Emissions are a **support** yield for partner pools; the partner return
comes from bribes. Full derivation and sensitivity tables: `scripts/emissions/`.

⚠️ History worth keeping, because it recurred: this paragraph and the `state.rs` doc comment
once claimed `1_000` (10%) while `initialize` wrote `1_875` — the published tail was wrong by
nearly 2× for months. It happened again in the other direction, with `scripts/emissions/` and
the whitepaper still on 800 000/epoch a full four days after the recalibration. **Quote the
floor in absolute terms (5 000 oSOLA/epoch), never as a bps ratio**: the ratio is a quotient of
the launch figure, so it silently goes wrong every time the launch figure moves.

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
- `stake_sola` / `unstake_hi_sola`: SOLA ↔ hiSOLA 1:1, SOLA locked in `sola_vault`. **hiSOLA is a non-transferable position (`UserPosition.hi_sola`), not an SPL token** — see the section below
- `claim_fees`: pro-rata share of `market_vault` via reward-per-token accumulator (`PRECISION = 1e12`)
- `borrow_usdc` / `repay_usdc`: hiSOLA collateral → USDC from `floor_vault`, max = `staked_amount.min(hi_sola)`, no interest, no liquidation
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
- Vote allocation: cumulative across pools ≤ `UserPosition.hi_sola` + ve power; `UserVoteReceipt` uses `init` (blocks second vote for same pool). Voting stamps `vote_locked` / `vote_lock_epoch`, which `unstake_hi_sola` and `lock_hi_sola` refuse to go below until the epoch ends

### hiSOLA is a position, not a token (decided 2026-08-21)

`UserPosition.hi_sola` **is** the balance. There is no hiSOLA ATA, no transfer, no mint CPI:
`stake_sola` credits a number and `unstake_hi_sola` debits it. `VeLockPosition.amount_locked`
was already a ledger figure and stays one, so `lock_hi_sola` / `unlock_hi_sola` and the four
allocation claim paths (founder, team, contributor, partner) move numbers between two ledgers
instead of minting into a vault.

**Why.** hiSOLA was a plain SPL token with no freeze authority, so the program was never
invoked on a transfer and could not block one. Two consequences were live on devnet:

- ☢️ **The vote was rentable.** `vote_gauge` priced power on the token balance and never
  consulted `staked_amount`, so hiSOLA bought on a secondary market voted at full weight while
  owing nothing to the floor: buy at a discount, vote, collect the bribes, sell. Dormant only
  for want of a hiSOLA pool — never closed.
- **An external LP silently lost everything.** Moving hiSOLA out of the wallet zeroed the fee
  basis, the borrow capacity and the vote. This is Invictus's failure mode by the outside door.

Everything built to *contain* a transfer is therefore gone, replaced by the thing that
*prevents* it. The vote escrow (a global custody vault, its top-up transfer, and
`withdraw_vote_escrow`) becomes two fields, `vote_locked` / `vote_lock_epoch`, read only
through `UserPosition::vote_locked_now`. **This is the only change that shrinks the audit
surface: 54 instructions unchanged, but −32 account parameters across 13 instructions.**

**Migration — `convert_hi_sola`, holder-called, devnet only.** The program has no freeze
authority and no permanent delegate on the old mint, so it cannot reach into anyone's ATA: the
holder must call it. It burns their old tokens *and* their share of the global escrow vault
(the vault's only remaining exit) and credits `hi_sola` by the same amount. It deliberately
touches nothing else — not `staked_amount`, not `total_hi_sola`, not the accumulator — because
the same stake is being re-expressed in a different unit, not created. A wallet that never
converts simply keeps a token no instruction reads. Covered by `tests/bankrun_convert.ts`,
which fabricates the legacy state with `setAccount`.

⚠️ `UserPosition::LEN` stays **128** and the account size stays 136: the new fields were carved
from spare bytes, so **no realloc migration**. The size guard is asserted against
`INIT_SPACE` (the Borsh wire size, 113 bytes), not `size_of` — the latter pads to the 16-byte
alignment of `fees_debt` and would have forced a second migration for padding that never
reaches the account.

⚠️ **Cost accepted:** hiSOLA no longer appears in Phantom. The Portfolio is now the only place
a holder sees their balance.

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

### ☢️ ONE BINARY — the `devnet` feature is gone (2026-08-23)

**There is no cluster feature any more, and there must never be one again.** `anchor build` is
the only build; devnet and mainnet run the identical artefact. `--no-default-features` no longer
exists — delete it from any script or note that still carries it.

**What it used to be.** `devnet` was a **default** feature, so a plain `anchor build` produced:
throwaway founder key (`J8Ww4yej…`, secret on a laptop, predecessor leaked publicly and forced the
2026-07-21 purge), `VESTING_CLIFF_SECS` 5 s instead of 180 days, `VESTING_DURATION_SECS` 24 h
instead of 720 days, `BASE_BAG_VEST_SECS` 6 h instead of 180 days, `MIN_LOCK_DURATION` 5 s instead
of 7 days — and **one security check compiled out entirely** (the founder vesting lock in
`unstake_hi_sola`). The *safe* build was the one you had to remember a flag for, and nothing in the
build output told the two apart.

The deeper problem was not the direction of the default. It was that **devnet and mainnet ran
different code**, so the artefact under test was never the artefact to be audited or shipped.

**How it was removed.** Every constant now carries its mainnet value unconditionally. The founder
wallet moved out of the binary into `ProtocolState.founder_wallet`, written once by `initialize`
and never writable again (no setter). That move is what made the rest possible: a hardcoded Ledger
address is unsignable by **any** harness, bankrun included, so pinning the real address in the
binary would have returned the 12.25M path to zero coverage — which is exactly why the feature flag
was introduced in the first place.

Trust is unchanged and visibility is better: whoever runs `initialize` is whoever used to run
`anchor build`, but the result is now a public on-chain value anyone can read, instead of a string
you would have to disassemble a binary to verify.

⚠️ **Mainnet deploy** — pass the Ledger `46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4` to
`initialize`, then **read `founder_wallet` back on-chain before calling
`mint_founder_allocation`**. After that call the 12.25M is committed to whatever address is stored.
`Pubkey::default()` is rejected at init, so a zeroed field can only mean an un-migrated legacy
account — and every founder guard fails **closed** in that state, never open.

**Tests that need a 180-day clock live in bankrun.** `tests/bankrun_allocations.ts` covers the
founder cliff, the ve-lock refusal and the partner welcome-bag stream against a warped clock. The
rule going forward: when a path is untestable against a real validator clock, **move the test, not
the constant.**

**Borrow is extraction, not credit.** No interest, no liquidation — a borrow is never repaid in
practice, so every borrowed USDC leaves the floor vault permanently. The cap is therefore not a
risk limit, it is **the drain limit**.

**The rule (settled 2026-07-17): 100% if the collateral is financed, 20% if it is not.**

| Instruction | Cap | Why |
|---|---|---|
| `borrow_usdc` | **100%** of `staked_amount.min(hi_sola)` | An ordinary user bought their SOLA — their USDC *is* in the floor vault. They borrow their own deposit back and drain nobody. Same as Beradrome. The minimum now separates **financed** stake (bought through the curve) from **unfinanced** hiSOLA released by an expired ve lock, which must stay on the 20% channel. Its original job — stopping the same balance being walked wallet to wallet — was made moot by non-transferability, but the split is a distinct rule and the minimum stays (proven in `tests/bankrun_borrow_recycle.ts`). |
| ~~`founder_borrow_usdc`~~ | — | **Removed 2026-07-18** with `FOUNDER_BORROW_CAP_BPS`: the 7M are ve-escrowed → wallet balance 0 → its `new_borrowed <= hi_sola_balance` check could never pass. Use `borrow_against_locked`. |
| ~~`contributor_borrow_usdc`~~ | — | **Removed 2026-07-18** with `CONTRIBUTOR_BORROW_CAP_BPS`, same reason. Use `borrow_against_locked`. |
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

**Partner allocations (reshaped 2026-08-27): a signature bag, then a retainer.**
The 1:1 bribe match is gone — it priced hiSOLA at a base-unit ratio frozen for life with no
oracle, `total_bribed_credited` was a lifetime counter with no clock, and a bad rate was
irrevocable once any claim had happened. What a partner gets now:

- **`base_hi_sola`** — a small signature bag, delivered whole by `claim_partner_allocation` the
  moment they escrow a bribe schedule (`stream_start_ts != 0` is the gate on the whole deal).
- **`retainer_per_epoch`** — hiSOLA credited by `crank_partner_epoch` for every epoch they still
  hold `lp_threshold` of `lp_mint`. No total, no cap, no end date. Tiers: 1M LP → 20K + 3 450/epoch
  · 500K → 7 500 + 1 300 · 200K → 2 000 + 350.

**Both are `permanent_amount`**, so `unlock_hi_sola` releases nothing at any date and the
`sell_sola` drain from partner allocations is **zero**. The releasable bribe-earned tranche that
used to expire into a wallet after 4 years no longer exists. Both also earn protocol fees
(`fee_shares` + a matching `total_hi_sola` increment) — the exposure moved from the floor to the
fee stream, deliberately.

☢️ **`crank_partner_epoch` is one instruction doing two independently-gated things.** The escrowed
bribe tranche is released whether or not the LP condition holds (it is already the voters' money,
and it *slips* if an epoch is missed); the retainer is bought fresh each epoch and **a missed epoch
is lost, not deferred** — the chain keeps no history of an SPL balance, so the crank IS the
attestation. Which also means it only proves the balance existed at that instant: a partner can
add liquidity, crank, and remove it in one transaction. Closing that would need custody of the LP,
which the deal promises not to take — disclosed as reputational, not cryptographic.

**`close_partner_allocation` (2026-08-25, gates rewritten 2026-08-27) is not a revoke.** A retainer
has no promised total to compare against, so the test changed shape: it closes when the bag is
settled (claimed, or `base_hi_sola == 0`) **and** the current epoch is already decided (credited
this epoch, or the LP is now below `lp_threshold`). The guarantee that matters is intact — the
authority cannot take away an epoch the partner is still earning — and the account of a partner who
simply stopped no longer has to stay open forever, because nothing is owed. ⚠️ Closing frees
`[b"partner", wallet]`, so `register_partner` reopens it with zeroed counters and a fresh bag: the
renewal path, the migration path for the old 160-byte layout, and the only way one wallet gets a
second bag.

**`partner_deposit_bribe` was deleted** — without the match it was `deposit_bribe` renamed.
**57 instructions** (−1 for that deletion, +1 for `close_legacy_partner_allocation`). Seventeen
`[partner]`/`[crank]`/`[close]`/`[stream]` cases in `tests/bankrun_allocations.ts`.

⚠️ **`PartnerAllocation` grew 160 → 192, and that needed an escape hatch.** `register_partner`
uses `init`, and a 160-byte account cannot be deserialized as the 192-byte struct — so
`close_partner_allocation`, which takes a typed account, fails at the account level before its
body runs, and the seeds can never be reopened. Without `close_legacy_partner_allocation` the
resize would have **bricked every allocation written before it**, and the "close and
re-register" renewal path the design leans on would not have existed. Its safety is the size
check, not the signature: `require!(data_len() < 8 + LEN)` is structurally unsatisfiable while
the layout stands, so it is inert on every live account rather than merely guarded. `<` and not
`!=`, so that a future *shrink* of LEN could never make readable accounts deletable. Proven by
the `☢️ [close] the legacy escape refuses an account it could have read` case.

**☢️ `fee_shares` — the tranche that earns without being spendable.** Four credit sites
(contributor bag, team 250K, partner bag, partner retainer) plus `lock_hi_sola`. Two rules that
must hold at every one of them:
- **Carry the debt, never re-stamp it.** `fees_debt` is one scalar for the whole basis, so
  `fees_debt = acc` forfeits accrual and leaving it alone hands the new shares a retroactive
  claim. `UserPosition::credit_fee_shares` does `acc − pending × PRECISION / new_basis`.
- **`lock_hi_sola` credits the DROP IN BASIS, not the amount.** Crediting the amount outright
  would let unfinanced hiSOLA (basis 0, because `staked_amount` is 0) manufacture a fee claim by
  locking. `total_hi_sola` then falls by `amount − credited`, which is 0 for financed stake — so
  locking no longer costs a holder their fees, which is the point — and the full amount for
  unfinanced supply, exactly as before. The founder's 7M stays excluded **automatically**: it
  never routes through `lock_hi_sola` and never credits `fee_shares`. That automaticity is the
  reason the fix went through `fee_shares` instead of inverting the `total_hi_sola` default.

### Open items flagged pre-audit (still not fixed)

1. ~~**Stale comments on the founder borrow cap**~~ — **moot since 2026-07-18**: `founder_borrow_usdc`
   and `contributor_borrow_usdc` were deleted with their constants, so there is no 10%-vs-20%
   discrepancy left to fix. `grep -rn "29k" programs/` is empty; the figure now survives only in
   the audit-prep docs, which were corrected 2026-08-13. The single remaining valve is
   `borrow_against_locked` at `PARTNER_BORROW_CAP_BPS` (20%), which about.html already publishes.
2. ~~**`collect_to_pol` over-credits stakers**~~ — **resolved 2026-07-18** (commit `3b32b03`); this entry stayed stale until 2026-08-05. The accumulator now advances on `market_balance - amount` and a solvency guard refuses to skim anything at or below `last_market_vault_balance`, so POL is junior to already-credited fees and senior only within fresh growth. See MAINNET_RUNBOOK §2.
3. ~~The team lock expiry~~ — **resolved 2026-07-17**: the team tranche is permanently locked (`permanent_amount`), so no expiry ever reopens the drain. Remaining scheduled exposure: partner **bribe-earned** hiSOLA at 4-year expiry, capped per deal.
4. ~~**`PolState.pol_split_bps` is dead state**~~ — **resolved 2026-08-12**: `collect_to_pol` now enforces `amount <= growth × pol_split_bps / 10_000`, the base being uncredited growth (`market_balance − last_market_vault_balance`), not the whole vault. Proven by mutation. The solvency guard is kept alongside it deliberately: the cap is only tighter while `pol_split_bps <= 5_000`, a bound validated in a *different* instruction, whereas the solvency guard depends on nothing else.

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
