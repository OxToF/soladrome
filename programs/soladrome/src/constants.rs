// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Compile-time constants: PDA seeds, allocation sizes, caps and fee rates.
//!
//! Everything here is a value the program never writes. Anything the authority can change at
//! runtime lives in `ProtocolState` instead, not in this file — see `configure_emissions`,
//! `configure_continuous_emissions` and `set_exercise_fee`.

use anchor_lang::prelude::*;

/// Canonical dead address for MINIMUM_LIQUIDITY lock (System Program address).
pub const LP_DEAD_PUBKEY: Pubkey = anchor_lang::system_program::ID;

pub const STATE_SEED: &[u8] = b"state";
pub const POSITION_SEED: &[u8] = b"position";
pub const FLOOR_VAULT_SEED: &[u8] = b"floor_vault";
pub const MARKET_VAULT_SEED: &[u8] = b"market_vault";
pub const SOLA_VAULT_SEED: &[u8] = b"sola_vault";
// (VOTE_ESCROW_SEED removed — the global hiSOLA custody vault it addressed belongs to the
//  token era. Voting marks `UserPosition.vote_locked` instead of moving anything, so there is
//  no vault to derive. Its last reader was `convert_hi_sola`; see `devnet-legacy`.)

// Market-curve depth. Must stay equal so the start price = floor = 1 USDC/SOLA.
// N = 1M sizes price discovery, NOT supply: exercise_o_sola mints outside the curve.
// price = (1 + U/N)² and SOLA emitted = N × (1 − 1/√price), U = cumulative USDC bought.
// At N = 1M: ×2 needs 414k USDC, ×10 needs 2.16M. k = 1e24, set once at `initialize`.
pub const INIT_VIRTUAL_USDC: u64 = 1_000_000_000_000; // 1 000 000 USDC (6 dec)
pub const INIT_VIRTUAL_SOLA: u64 = 1_000_000_000_000; // 1 000 000 SOLA (6 dec)  – floor = 1:1

// (LP_EMISSION_PER_EPOCH removed — a compile-time per-epoch emission was superseded by
//  `ProtocolState.osola_emission_initial`, which `configure_emissions` sets at runtime. The
//  constant had no readers; it only made it look as though 10 000/epoch were fixed in the
//  binary, which would have been the wrong number to audit against.)

/// Maximum voting power any single address may allocate in one epoch,
/// expressed as a fraction of total_hi_sola (basis points, 10 000 = 100%).
/// 3 000 bps = 30% — prevents governance capture by a single actor while
/// remaining more restrictive than Aerodrome/Velodrome (which have no cap).
pub const VOTE_WEIGHT_CAP_BPS: u64 = 3_000;

// Continuous Masterchef-style oSOLA emission is now authority-configured at
// runtime (`ProtocolState.continuous_rate_per_sec`, set via
// `configure_continuous_emissions`) and gated by a per-pool flag + an on-chain
// expiry epoch. The old compile-time `OSOLA_EMISSION_PER_SEC` const was removed.

/// Precision factor for the oSOLA-per-LP accumulator.
pub const LP_REWARD_PRECISION: u128 = 1_000_000_000_000; // 1e12

/// Grace period before unfinished bribe tokens can be rolled to the next epoch.
/// Protects voters who haven't claimed yet from having funds recycled under them.
/// Pools with zero votes are exempt — their tokens are immediately rollable.
/// devnet: 2 epochs = 2 h · mainnet: 2 epochs = 14 days
pub const ROLLOVER_DELAY_EPOCHS: u64 = 2;

// Founder allocation — 12% of reference 100 M-token supply, 7% auto-staked.
// The three tranches below sum to 12.25M. There is deliberately no FOUNDER_TOTAL constant
// holding that sum: it was never used as a cap, and a total that no `require!` reads is a
// number an auditor has to chase to discover it enforces nothing.
pub const FOUNDER_STAKE: u64 = 7_000_000_000_000; //  7 000 000 SOLA → hiSOLA (governance vesting)
/// 5 000 000 oSOLA — held in vesting vault, released linearly after cliff.
pub const FOUNDER_LIQUID: u64 = 5_000_000_000_000; //  5 000 000 oSOLA vesting tranche
pub const ECOSYSTEM_TOTAL: u64 = 1_750_000_000_000; //  1 750 000 SOLA — marketing + airdrop
/// Team tranche, delivered at ecosystem-allocation time as hiSOLA locked FOR LIFE into a ve
/// position (`permanent_amount` = full tranche — never liquid SOLA, see
/// mint_ecosystem_allocation). Pays the people who worked unpaid until launch. Votes as an
/// ordinary user; borrows 20% via borrow_against_locked.
pub const FOUNDER_IMMEDIATE_SOLA: u64 = 250_000_000_000; //    250 000 → hiSOLA, lifetime ve lock
/// One-time origination fee on each borrow (like Beradrome). Sent to market_vault → hiSOLA stakers.
pub const BORROW_FEE_BPS: u64 = 200; //  2 % of borrowed amount

/// Default oSOLA exercise fee — 10 % **of the gain**, not of the notional.
///
/// ⚠️ Do NOT read this as "the same 2 % as BORROW_FEE_BPS with a different number".
/// The two fees have unrelated bases: `BORROW_FEE_BPS` is a share of the amount
/// borrowed, while this is a share of `(curve_price − 1) × amount`, i.e. of the
/// arbitrage spread the option holder captures. At a curve price of 2, 10 % here is
/// 0.10 USDC per SOLA and the exerciser still pays 1.10 for an asset worth 2 (+82 %).
/// The equivalent number on the notional would be ~2 000 bps of the strike.
///
/// Only written by `initialize`; live singletons read 0 (no fee) until the authority
/// calls `set_exercise_fee`.
pub const DEFAULT_EXERCISE_FEE_BPS: u16 = 1_000; // 10 % of the gain
/// Hard ceiling on `exercise_fee_bps`. Below 10 000 exercise stays profitable by
/// construction (the fee is a fraction of the gain), so this is not a solvency bound —
/// it is a guard against an authority setting a value that makes oSOLA worthless as an
/// LP incentive, which would be an economic self-inflicted wound, not an exploit.
pub const MAX_EXERCISE_FEE_BPS: u16 = 5_000; // 50 % of the gain
                                             // (FOUNDER_BORROW_CAP_BPS removed 2026-07-18 with founder_borrow_usdc — the 7M are ve-escrowed,
                                             //  so the founder's only borrow path is borrow_against_locked at PARTNER_BORROW_CAP_BPS, 20%.)

pub const FOUNDER_HI_VESTING_SEED: &[u8] = b"founder_hi_vesting";

// ── The founder wallet is NOT a constant any more (changed 2026-08-23) ───────
//
// It lives in `ProtocolState.founder_wallet`, written once by `initialize` and never
// writable again. What used to be here was the most dangerous constant in the program: two
// `#[cfg]` arms, a throwaway devnet key and the mainnet Ledger, selected by a feature that
// was ON BY DEFAULT. A plain `anchor build` produced the throwaway; shipping it to mainnet
// handed 12 250 000 SOLA to a key whose secret sits on a laptop, with the vesting cliff
// compiled down to 5 seconds in the same stroke.
//
// Inverting the default would only have swapped which mistake was silent. The real defect
// was that devnet and mainnet ran DIFFERENT CODE, so the binary under test was never the
// binary to be audited or deployed. Devnet 2 exists to run the mainnet build.
//
// The constant could not simply be set to the Ledger address either: no test can sign for a
// hardware wallet, in any harness — bankrun cannot forge a signature — so the entire 12.25M
// path would have gone back to zero coverage, which is exactly why the feature flag was
// introduced in the first place. Moving the address into state is what breaks that
// deadlock: one binary, and a test can initialise with a keypair it holds.
//
// The trust assumption is unchanged and the visibility is better. Whoever ran `initialize`
// is whoever used to run `anchor build`; the difference is that the result is now a public
// on-chain value anyone can read and check against the published address, instead of a
// string baked into a binary you would have to disassemble to verify.
//
// ⚠️ MAINNET DEPLOY: `initialize` takes the founder wallet as an argument and it is
// IMMUTABLE afterwards — there is no setter, by design. Passing the wrong address is not
// recoverable except by redeploying the whole protocol before anything is allocated. The
// value to pass is the Ledger Nano S dedicated to Soladrome, never used on another chain:
//
//     46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4
//
// It holds the 7M hiSOLA governance tranche (ve-locked for life, non-voting anti-capture
// reserve) and the 5M oSOLA vesting. Verify it on-chain right after init, before calling
// `mint_founder_allocation`:
//     solana account <ProtocolState PDA>   → founder_wallet must read 46Aqf…

// Team wallet — receives the 250k tranche as hiSOLA locked FOR LIFE (not liquid SOLA).
// Distinct from FOUNDER_WALLET so it can vote as an ordinary user: the founder-voting
// guard blocks only FOUNDER_WALLET, never this one. That asymmetry is deliberate — the 7M
// is a dormant anti-capture reserve, this is contributor compensation.
pub const TEAM_WALLET: &str = "BVaJbgw3NF7Ng28sHorBnzJrHgvu7S3L5wpdB6923LjA";

// ── Contributor / marketing allocation ────────────────────────────────────────
pub const CONTRIBUTOR_SEED: &[u8] = b"contributor";
pub const CONTRIBUTOR_REGISTRY_SEED: &[u8] = b"contributor_registry";
// (CONTRIBUTOR_BORROW_CAP_BPS removed 2026-07-18 with contributor_borrow_usdc — the
//  contributor bag is ve-escrowed, so its only borrow path is borrow_against_locked, 20%.)

/// Ceiling on contributor hiSOLA, summed over every contributor ever registered.
///
/// Until 2026-08-27 there was none: `register_contributor` checked only that one of the two
/// amounts was non-zero, so the published "a handful of people, small amounts" was enforced by
/// the shape of a form field and nothing else. The tranche now earns protocol fees
/// (`fee_shares`), which turns an unbounded field into unbounded dilution of every staker.
///
/// 100 000 of each is what the tranche is supposed to be. It is the one number in the
/// allocation matrix constrained by nothing but intent, which is exactly why it belongs in a
/// `require!` rather than in a document.
pub const CONTRIBUTOR_HI_SOLA_CAP: u64 = 100_000_000_000; // 100 000 hiSOLA (6 dec)
/// Ceiling on contributor oSOLA, summed over every contributor ever registered.
/// Not drawn from `ECOSYSTEM_TOTAL`, which caps `distribute_o_sola` alone.
pub const CONTRIBUTOR_O_SOLA_CAP: u64 = 100_000_000_000; // 100 000 oSOLA (6 dec)

// ── Protocol Partner allocation ───────────────────────────────────────────────
pub const PARTNER_SEED: &[u8] = b"partner";
pub const BRIBE_STREAM_SEED: &[u8] = b"bribe_stream";
pub const STREAM_TOKENS_SEED: &[u8] = b"stream_tokens";
/// Partner borrow cap: max 20 % of their vote-locked hiSOLA position.
/// A partner's bag is locked, so `UserPosition.hi_sola` is 0 for them and the ordinary
/// `borrow_usdc` path sees nothing to lend against. They borrow against
/// `VeLockPosition.amount_locked` via `borrow_against_locked` instead. The 75 % floor buffer
/// still applies.
pub const PARTNER_BORROW_CAP_BPS: u64 = 2_000; // 20 %

// ── Vote carry-over ───────────────────────────────────────────────────────────
pub const VOTE_CONFIG_SEED: &[u8] = b"vote_config";

/// Scaling factor for fee-per-token accumulator (avoids fractional USDC loss).
pub const PRECISION: u128 = 1_000_000_000_000; // 1e12

// ── Epoch helpers ─────────────────────────────────────────────────────────────
//
// ⚠️  TIME-SENSITIVE CONSTANTS — one value each, for every cluster.
//
// These were compile-time gated by a `devnet` feature that was ON BY DEFAULT, so `anchor build`
// produced 5-second cliffs and 5-second minimum locks while the mainnet build needed
// `--no-default-features`. Removed 2026-08-23: devnet and mainnet now run the identical binary,
// and the paths that must cross a 180-day cliff are tested under bankrun's warped clock
// (tests/bankrun_allocations.ts) rather than against shortened numbers.
//
// If a path is ever untestable against a real validator clock again: move the test, not the
// constant.

/// Epoch length: 7 days on both devnet and mainnet.
pub const EPOCH_DURATION: u64 = 7 * 24 * 60 * 60; // 604 800 s

// ── Founder vesting schedule ──────────────────────────────────────────────────

/// Cliff before any founder tokens unlock: 6 months, everywhere.
///
/// ⚠️ Until 2026-08-23 this was 5 s under the `devnet` feature, so that a test could cross
/// it against a real validator clock. That made devnet a different protocol from mainnet on
/// the single most sensitive number in the tokenomics. The cliff is now one value, and the
/// paths that must cross it are exercised under bankrun's warped clock — the test moves, the
/// constant does not.
pub const VESTING_CLIFF_SECS: u64 = 180 * 24 * 3_600;

/// Linear vesting window that starts after the cliff. 24 months.
pub const VESTING_DURATION_SECS: u64 = 720 * 24 * 3_600;

// (BASE_BAG_VEST_SECS removed 2026-08-27 with the streamed welcome bag. The bag is now
//  delivered whole the moment the partner escrows their bribe schedule — it is the signature
//  signal, not the compensation, and it is small for that reason. What used to be the rest of
//  the promised total is now a retainer that is bought one epoch at a time; see
//  `PartnerAllocation`.)

// (Contributor vesting schedule removed 2026-07-18 — contributors now claim their whole
//  allocation at launch: hiSOLA into a lifetime ve lock + oSOLA. No cliff, no linear vest.)

// ── Ve-layer constants ────────────────────────────────────────────────────────
/// Minimum lock duration: 1 epoch (7 days), everywhere.
///
/// ⚠️ Was 5 s under the `devnet` feature, because 7 days made the ve lock/unlock cycle
/// untestable against a real validator — which is why the partner path had zero coverage
/// until 2026-07-17. The answer to "untestable against a real clock" is a warped clock, not
/// a different constant: the lock/unlock cycle now lives in the bankrun suite.
pub const MIN_LOCK_DURATION: u64 = EPOCH_DURATION;
/// Maximum lock duration: 208 epochs (4 years) → full 4× ve-power at max lock.
pub const MAX_LOCK_DURATION: u64 = 208 * EPOCH_DURATION;
/// Voting power multiplier at maximum lock (4× raw hiSOLA).
pub const MAX_VE_MULTIPLIER: u64 = 4;

// ── Flash arbitrage profit split ──────────────────────────────────────────────
/// Caller keeps 10 % of gross profit; remaining 90 % routes to market_vault → hiSOLA stakers.
pub const CALLER_ARB_SHARE_BPS: u64 = 1_000;

// ── Floor reserve buffer ──────────────────────────────────────────────────────
/// After any borrow, the floor vault must hold at least this fraction of
/// total_purchased_sola (floor-backed supply). 7 500 bps = 75 %.
/// At most 25 % of the floor vault can be lent out at once.
/// Guarantees users can always redeem ≥ 75 % of the float via sell_sola.
pub const FLOOR_RESERVE_MIN_BPS: u64 = 7_500;

// ── Ve-layer ──────────────────────────────────────────────────────────────────
pub const VELOCK_SEED: &[u8] = b"velock";
// (VE_VAULT_SEED removed. It DID address real vaults once: while hiSOLA was an SPL token the
//  seed derived a per-user custody account, `[VE_VAULT_SEED, founder | team_wallet | partner]`,
//  that `lock_hi_sola` and the allocation claims actually transferred into. Those vaults went
//  away with transferability — locking now moves a number out of `UserPosition.hi_sola` into
//  `VeLockPosition.amount_locked`, both ledger figures — leaving the seed with no readers. See
//  `instructions/ve.rs::lock_hi_sola`, and `git log -S VE_VAULT_SEED` for the vaults it used
//  to derive.)

// ── Protocol-owned liquidity ──────────────────────────────────────────────────
pub const POL_SEED: &[u8] = b"pol";
pub const POL_USDC_VAULT_SEED: &[u8] = b"pol_usdc_vault";
pub const POL_SOLA_ATA_SEED: &[u8] = b"pol_sola_ata";
pub const POL_LP_VAULT_SEED: &[u8] = b"pol_lp_vault";

// ── AMM ───────────────────────────────────────────────────────────────────────
pub const AMM_POOL_SEED: &[u8] = b"amm_pool";
pub const LP_MINT_SEED: &[u8] = b"lp_mint";
pub const VAULT_A_SEED: &[u8] = b"vault_a";
pub const VAULT_B_SEED: &[u8] = b"vault_b";
pub const MAX_FEE_RATE: u16 = 1_000; // 10% max swap fee
pub const MAX_PROTOCOL_FEE: u16 = 5_000; // 50% of fee max to protocol
