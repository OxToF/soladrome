// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Christophe Hertecant

use anchor_lang::prelude::*;

/// Scaling factor for fee-per-token accumulator (avoids fractional USDC loss).
pub const PRECISION: u128 = 1_000_000_000_000; // 1e12

// ── Epoch helpers ─────────────────────────────────────────────────────────────
//
// ⚠️  TIME-SENSITIVE CONSTANTS — compile-time gated by the "devnet" feature.
//
//   Build for devnet  : anchor build                   (default = ["devnet"])
//   Build for mainnet : anchor build --no-default-features
//
// Never deploy the "devnet" build to mainnet — all durations are dramatically
// shorter for testing and would allow instant cliff bypasses in production.

/// Epoch length: 7 days on both devnet and mainnet.
pub const EPOCH_DURATION: u64 = 7 * 24 * 60 * 60; // 604 800 s

// ── Founder vesting schedule ──────────────────────────────────────────────────

/// Cliff before any founder tokens unlock.
/// devnet: 6 h  |  mainnet: 6 months
#[cfg(feature = "devnet")]
pub const VESTING_CLIFF_SECS: u64 = 6 * 3_600;
#[cfg(not(feature = "devnet"))]
pub const VESTING_CLIFF_SECS: u64 = 180 * 24 * 3_600;

/// Linear vesting window that starts after the cliff.
/// devnet: 24 h  |  mainnet: 24 months
#[cfg(feature = "devnet")]
pub const VESTING_DURATION_SECS: u64 = 24 * 3_600;
#[cfg(not(feature = "devnet"))]
pub const VESTING_DURATION_SECS: u64 = 720 * 24 * 3_600;

// ── Contributor vesting schedule ──────────────────────────────────────────────

/// Fraction of contributor allocation unlocked immediately at TGE (25%).
/// Remaining 75 % vests linearly over CONTRIBUTOR_DURATION_SECS.
pub const CONTRIBUTOR_TGE_BPS: u64 = 2_500;

/// Linear vesting window for the remaining 75 % of contributor allocation.
/// devnet: 6 h  |  mainnet: 6 months
#[cfg(feature = "devnet")]
pub const CONTRIBUTOR_DURATION_SECS: u64 = 6 * 3_600;
#[cfg(not(feature = "devnet"))]
pub const CONTRIBUTOR_DURATION_SECS: u64 = 6 * 30 * 24 * 3_600;

// ── Ve-layer constants ────────────────────────────────────────────────────────
/// Minimum lock duration: 1 epoch.
pub const MIN_LOCK_DURATION: u64 = EPOCH_DURATION;
/// Maximum lock duration: 104 epochs.
pub const MAX_LOCK_DURATION: u64 = 104 * EPOCH_DURATION;
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

pub fn current_epoch(unix_ts: i64) -> u64 {
    (unix_ts.max(0) as u64) / EPOCH_DURATION
}

#[account]
pub struct ProtocolState {
    pub authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub sola_mint: Pubkey,
    pub hi_sola_mint: Pubkey,
    pub o_sola_mint: Pubkey,
    pub floor_vault: Pubkey,  // USDC: 1 USDC per SOLA in supply
    pub market_vault: Pubkey, // USDC: excess above floor (fee revenue)
    pub sola_vault: Pubkey,   // locked SOLA from stakers
    pub virtual_usdc: u64,    // virtual USDC in bonding curve
    pub virtual_sola: u64,    // virtual SOLA in bonding curve
    pub k: u128,              // constant product = virtual_usdc * virtual_sola
    pub total_sola: u64,      // real SOLA minted (not virtual)
    pub total_hi_sola: u64,
    pub accumulated_fees: u64,          // lifetime market vault inflows
    pub fees_per_hi_sola: u128,         // cumulative USDC-per-hiSOLA × PRECISION
    pub last_market_vault_balance: u64, // snapshot used to detect new fees
    pub bump: u8,
    /// Prevents mint_founder_allocation from being called more than once.
    pub founder_allocated: bool,
    /// Prevents mint_ecosystem_allocation from being called more than once.
    pub ecosystem_allocated: bool,
    /// Sum of all outstanding USDC borrows across all users.
    /// Invariant: floor_vault + total_usdc_borrowed >= total_sola at all times.
    pub total_usdc_borrowed: u64,
    /// SOLA minted exclusively via buy_sola or exercise_o_sola (floor-backed supply).
    /// Used as the invariant denominator in sell_sola, replacing total_sola which
    /// includes unfinanced founder/ecosystem allocations.
    pub total_purchased_sola: u64,
    /// Emergency pause flag — set by authority via `pause` instruction.
    /// When true, all state-mutating entry instructions revert with ProtocolPaused.
    /// Exit paths (sell_sola, unstake, repay, remove_liquidity, claim_*, unlock)
    /// are intentionally excluded so users can always withdraw their funds.
    pub paused: bool,

    // ── Epoch oSOLA emission decay ────────────────────────────────────────────
    /// Starting emission for the epoch-based gauge system (oSOLA per epoch).
    /// Set at `initialize`; overridable via `configure_emissions`.
    pub osola_emission_initial: u64,
    /// Decay factor applied each epoch (basis points, 10 000 = no decay).
    /// Default: 9 900 (−1 %/epoch ≈ −40 %/year).
    pub osola_emission_decay_bps: u16,
    /// Minimum emission as % of initial (basis points).
    /// Default: 1 000 (10 % floor — emissions never reach zero).
    pub osola_emission_floor_bps: u16,
    /// Epoch at which the decay clock started (reset by `configure_emissions`).
    pub osola_emission_start_epoch: u64,
}

impl ProtocolState {
    // Total account space INCLUDING the 8-byte Anchor discriminator.
    // Base:     8×Pubkey(256) + u64×6(48) + u128×2(32) + u8(1) + bool×3(3) + u64×2(16) = 356
    // Emission: u64(8) + u16(2) + u16(2) + u64(8) = 20
    // Total: 376 data + 8 discriminator = 384 bytes; 16 spare to 400.
    // ⚠️ Update this value whenever a field is added or removed.
    pub const LEN: usize = 400;
}

// Compile-time guard: if ProtocolState grows past LEN the program will fail to
// deploy rather than silently corrupting accounts at runtime.
const _: () = assert!(
    ProtocolState::LEN >= 8 + std::mem::size_of::<ProtocolState>(),
    "ProtocolState::LEN is too small — update it to fit the struct"
);

#[account]
#[derive(Default)]
pub struct UserPosition {
    pub owner: Pubkey,
    pub usdc_borrowed: u64,
    pub fees_debt: u128, // fees_per_hi_sola at last claim / entry point
    pub bump: u8,
    /// Slot at which the most recent borrow was executed.
    /// repay_usdc requires current_slot > last_borrow_slot — blocks same-tx
    /// flash-borrow attacks where USDC is borrowed and repaid atomically.
    pub last_borrow_slot: u64,
}

impl UserPosition {
    pub const LEN: usize = 128; // still fits: 32+8+16+1+8 = 65 bytes used, 63 spare
}

// ── Bribe system ──────────────────────────────────────────────────────────────

/// Bribe pot for one (pool_id, reward_mint, epoch) triplet.
/// Permissionless — any protocol can deposit. Multiple deposits per epoch are additive.
/// PDA: [b"bribe_vault", pool_id, reward_mint, epoch_le8]
#[account]
pub struct BribeVault {
    pub pool_id: Pubkey,     // External pool being incentivised (label only)
    pub reward_mint: Pubkey, // Token offered as bribe
    pub epoch: u64,          // Epoch this bribe applies to
    pub total_bribed: u64,   // Cumulative amount deposited this epoch
    pub bump: u8,
}
impl BribeVault {
    pub const LEN: usize = 128;
}

/// Aggregate hiSOLA vote-weight directed at a pool for one epoch.
/// PDA: [b"gauge", pool_id, epoch_le8]
#[account]
pub struct GaugeState {
    pub pool_id: Pubkey,
    pub epoch: u64,
    pub total_votes: u64,
    pub bump: u8,
}
impl GaugeState {
    pub const LEN: usize = 96;
}

/// Records one user's vote for a specific (pool, epoch) pair.
/// Created with `init` — immutable once written, prevents double-voting for same pool.
/// PDA: [b"vote", user, pool_id, epoch_le8]
#[account]
pub struct UserVoteReceipt {
    pub user: Pubkey,
    pub pool_id: Pubkey,
    pub epoch: u64,
    pub votes: u64, // hiSOLA weight committed to this pool
    pub bump: u8,
}
impl UserVoteReceipt {
    pub const LEN: usize = 128;
}

/// Tracks total vote-weight already allocated by one user in an epoch (across all pools).
/// Prevents voting more than the user's hiSOLA balance.
///
/// `total_power_snapshot` is captured on the **first** vote of the epoch (hiSOLA + ve-power
/// at that exact moment). All subsequent votes in the same epoch are checked against this
/// snapshot — preventing a user from over-spending if their lock expires or they transfer
/// hiSOLA between two separate `vote_gauge` calls.
///
/// PDA: [b"uev", user, epoch_le8]
#[account]
pub struct UserEpochVotes {
    pub epoch: u64,
    pub allocated: u64, // cumulative votes cast this epoch across all pools
    pub total_power_snapshot: u64, // hiSOLA + ve-power at time of first vote (immutable after init)
    /// Extra voting power earned by burning oSOLA this epoch.
    /// Resets every epoch (new PDA). Not subject to the 30% hiSOLA cap —
    /// burning oSOLA is a deflationary act that justifies uncapped influence.
    pub o_sola_bonus: u64,
    pub bump: u8,
}
impl UserEpochVotes {
    pub const LEN: usize = 64;
} // 8+8+8+8+1 = 33 bytes used, 31 spare

/// Created during claim_bribe — its existence proves the claim was made.
/// PDA: [b"bribe_claim", user, pool_id, reward_mint, epoch_le8]
#[account]
pub struct UserBribeClaim {
    pub bump: u8,
}
impl UserBribeClaim {
    pub const LEN: usize = 32;
}

// ── Ve-layer ──────────────────────────────────────────────────────────────────

/// Per-user lock state for ve-weighted governance.
///
/// Locking hiSOLA transfers tokens to ve_lock_vault and removes them from the
/// fee accumulator denominator. Locked hiSOLA earns ve voting power instead.
/// PDA: [b"velock", user]
#[account]
pub struct VeLockPosition {
    pub owner: Pubkey,
    pub amount_locked: u64, // hiSOLA held in ve_lock_vault
    pub lock_end_ts: i64,   // Unix timestamp when lock expires
    pub bump: u8,
}
impl VeLockPosition {
    pub const LEN: usize = 96;
}

// ── LP Emission checkpointing ─────────────────────────────────────────────────

/// Total hiSOLA vote-weight cast across ALL pools in one epoch.
/// Used as denominator when splitting LP_EMISSION_PER_EPOCH across pools.
/// PDA: [b"epoch_votes", epoch_le8]
#[account]
pub struct GlobalEpochVotes {
    pub epoch: u64,
    pub total_votes: u64,
    pub bump: u8,
}
impl GlobalEpochVotes {
    pub const LEN: usize = 32;
}

/// Continuous time-weighted LP balance for one (user, pool) pair.
/// Accumulates: weighted_balance += lp_balance × elapsed_secs each checkpoint.
/// Reset to 0 at the start of each new epoch.
/// PDA: [b"lp_ckpt", pool, user]
#[account]
pub struct LpUserCheckpoint {
    pub user: Pubkey,
    pub pool: Pubkey,
    pub weighted_balance: u128, // sum(lp_balance × elapsed_secs) for last_epoch
    pub last_update_ts: i64,
    pub last_epoch: u64,
    pub bump: u8,
}
impl LpUserCheckpoint {
    pub const LEN: usize = 32 + 32 + 16 + 8 + 8 + 1 + 7;
}

/// Time-weighted total LP supply for one pool in one epoch.
/// Finalized by emit_pool_rewards after epoch ends; records oSOLA allocation.
/// PDA: [b"lp_pool_epoch", pool, epoch_le8]
#[account]
pub struct LpPoolEpochAccum {
    pub pool: Pubkey,
    pub epoch: u64,
    pub total_weighted_supply: u128,
    pub last_update_ts: i64,
    pub last_lp_supply: u64,
    pub osola_allocated: u64,
    pub finalized: bool,
    pub bump: u8,
}
impl LpPoolEpochAccum {
    pub const LEN: usize = 32 + 8 + 16 + 8 + 8 + 8 + 1 + 1 + 18;
}

/// Proof-of-claim for LP emissions — created by claim_lp_emissions, blocks replay.
/// PDA: [b"lp_claim", user, pool, epoch_le8]
#[account]
pub struct LpEpochClaim {
    pub bump: u8,
}
impl LpEpochClaim {
    pub const LEN: usize = 32;
}

// ── Continuous LP reward tracking (Masterchef-style) ─────────────────────────

/// Per-user oSOLA reward state for one (user, pool) pair.
/// Created on first add_liquidity, claim_lp_rewards, or remove_liquidity.
/// PDA: [b"lp_user", pool, user]
#[account]
#[derive(Default)]
pub struct LpUserInfo {
    pub reward_debt: u128, // pool.osola_reward_per_lp snapshot at last interaction
    pub bump: u8,
}
impl LpUserInfo {
    pub const LEN: usize = 16 + 1 + 15; // = 32 with padding
}

// ── Founder vesting ───────────────────────────────────────────────────────────

/// Progressive hiSOLA distribution for the founder (7 M stake tranche).
/// Minting is deferred — no SOLA enters total_sola until claim_founder_hi_sola.
/// Each claim mints claimable SOLA to sola_vault + hiSOLA to founder 1:1.
/// PDA: [b"founder_hi_vesting"]
#[account]
pub struct FounderHiSolaVesting {
    pub total_amount: u64, // FOUNDER_STAKE = 7 000 000 SOLA (6 dec)
    pub claimed: u64,      // hiSOLA already minted to founder
    pub start_ts: i64,     // unix ts when mint_founder_allocation was executed
    pub bump: u8,
}
impl FounderHiSolaVesting {
    pub const LEN: usize = 8 + 8 + 8 + 1 + 7; // = 32 bytes
}

/// Progressive oSOLA vesting for the founder (5 M liquid tranche).
/// Founder claims oSOLA linearly; exercises via exercise_o_sola to get SOLA
/// at floor price — each exercise ADDS 1 USDC to floor_vault (net positive).
///
/// Vesting formula (after cliff):
///   total_vested = total_amount × min(elapsed, VESTING_DURATION_SECS) / VESTING_DURATION_SECS
///   claimable    = total_vested − already_claimed
///
/// PDA: [b"founder_vesting"]
#[account]
pub struct FounderVesting {
    /// Total oSOLA under vesting (= FOUNDER_LIQUID = 5 000 000).
    pub total_amount: u64,
    /// Cumulative oSOLA already minted to the founder.
    pub claimed: u64,
    /// Unix timestamp when `mint_founder_allocation` was executed.
    pub start_ts: i64,
    pub bump: u8,
}
impl FounderVesting {
    pub const LEN: usize = 8 + 8 + 8 + 1 + 7; // = 32 bytes with padding
}

// ── Persistent vote config (carry-over) ──────────────────────────────────────

/// Persistent gauge vote allocation for a hiSOLA holder.
///
/// Once set with `auto_replay = true`, any caller (keeper, partner, cron bot)
/// can invoke `replay_vote` each epoch to carry forward these preferences
/// without requiring the owner to sign — enabling fully passive participation,
/// identical to Beradrome / Velodrome auto-rolling vote behaviour.
///
/// The vote weight is recalculated from the owner's **current** hiSOLA balance
/// + ve-power each epoch, so the allocation scales correctly as positions change.
/// The 30% per-address anti-whale cap applies on every replay, same as `vote_gauge`.
///
/// PDA: [b"vote_config", user]
#[account]
pub struct UserVoteConfig {
    /// Pools to vote for — unused slots hold Pubkey::default().
    pub pools: [Pubkey; 5],
    /// Basis points per pool (active entries must sum to exactly 10 000).
    pub bps: [u16; 5],
    /// Number of active entries (1–5).
    pub n_pools: u8,
    /// When true, `replay_vote` is allowed by any caller.
    /// When false, the owner must call `vote_gauge` manually each epoch.
    pub auto_replay: bool,
    pub bump: u8,
}
impl UserVoteConfig {
    pub const MAX_POOLS: usize = 5;
    // 5×32 + 5×2 + 1 + 1 + 1 = 173 bytes used; 19 spare
    pub const LEN: usize = 192;
}

// ── Protocol Partner allocation ───────────────────────────────────────────────

/// One-time locked hiSOLA allocation for a protocol partner (Jito, Marinade, Solayer…).
///
/// Unlike the contributor system (cliff + linear vesting), the partner receives their
/// full allocation in a single `claim_partner_allocation` call — but hiSOLA is minted
/// DIRECTLY into their ve_lock_vault, bypassing the wallet entirely.
///
/// Consequences:
/// - Voting power is immediate via VeLockPosition (up to 4× ve multiplier).
/// - Borrow is naturally blocked: wallet hiSOLA balance = 0 during the lock
///   (`borrow_usdc` guard: `new_borrowed <= hi_sola_balance` always fails).
/// - `total_hi_sola` is NOT incremented — locked hiSOLA is excluded from the
///   fee accumulator denominator (same semantics as `lock_hi_sola`).
/// - After lock expiry: `unlock_hi_sola` → hiSOLA back to wallet → standard rules.
///
/// PDA: [b"partner", partner_wallet]
#[account]
pub struct PartnerAllocation {
    pub partner: Pubkey,         // beneficiary wallet (immutable after init)
    pub hi_sola_amount: u64,     // total hiSOLA to mint at claim time
    pub lock_duration_secs: u64, // lock duration (validated ≤ MAX_LOCK_DURATION at register)
    pub claimed: bool,           // true after claim_partner_allocation is called (one-shot)
    pub start_ts: i64,           // unix timestamp when register_partner was executed
    pub bump: u8,
}
impl PartnerAllocation {
    // 32 + 8 + 8 + 1 + 8 + 1 = 58 bytes used; 38 spare
    pub const LEN: usize = 96;
}

// ── Protocol-Owned Liquidity ──────────────────────────────────────────────────

/// Singleton PDA controlling protocol-owned liquidity.
/// PDA: [b"pol"]
#[account]
pub struct PolState {
    /// Suggested % of market_vault fees to divert (informational, enforced off-chain).
    pub pol_split_bps: u16,
    /// AmmPool PDA that receives POL liquidity deposits.
    pub target_pool: Pubkey,
    /// Lifetime USDC routed through collect_to_pol.
    pub usdc_accumulated: u64,
    pub bump: u8,
}
impl PolState {
    pub const LEN: usize = 96;
}

// ── Contributor / Marketing vesting ──────────────────────────────────────────

/// Per-contributor dual vesting schedule (marketing, community, service providers).
///
/// Mirrors the founder allocation — two tranches per contributor:
///   • hiSOLA: governance rights + borrow collateral (mints SOLA to sola_vault 1:1)
///   • oSOLA:  liquid options (exercisable at floor price via exercise_o_sola)
///
/// Borrow cap: 10 % of the monthly hiSOLA installment (hi_sola_amount / 12 × 10%).
/// Flash-borrow guard: same slot-based defence as regular `borrow_usdc`.
/// Repay:      uses the standard `repay_usdc` instruction (same UserPosition PDA).
///
/// PDA: [b"contributor", contributor_wallet]
#[account]
pub struct ContributorVesting {
    pub contributor: Pubkey,  // Beneficiary wallet (immutable after init)
    pub hi_sola_amount: u64,  // Total hiSOLA allocated
    pub o_sola_amount: u64,   // Total oSOLA allocated
    pub hi_sola_claimed: u64, // hiSOLA already minted
    pub o_sola_claimed: u64,  // oSOLA already minted
    pub start_ts: i64,        // Unix timestamp when register_contributor was called
    pub bump: u8,
}
impl ContributorVesting {
    pub const LEN: usize = 32 + 8 + 8 + 8 + 8 + 8 + 1 + 7; // = 80 bytes
}
