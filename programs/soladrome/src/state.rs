// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Christophe Hertecant

use anchor_lang::prelude::*;

/// Scaling factor for fee-per-token accumulator (avoids fractional USDC loss).
pub const PRECISION: u128 = 1_000_000_000_000; // 1e12

// ── Epoch helpers ─────────────────────────────────────────────────────────────
pub const EPOCH_DURATION: u64 = 7 * 24 * 60 * 60; // 604 800 s = 7 days

// ── Ve-layer constants ────────────────────────────────────────────────────────
/// Minimum lock duration: 1 epoch (7 days).
pub const MIN_LOCK_DURATION: u64 = EPOCH_DURATION;
/// Maximum lock duration: 104 epochs (~2 years).
pub const MAX_LOCK_DURATION: u64 = 104 * EPOCH_DURATION; // 62 899 200 s
/// Voting power multiplier at maximum lock (4× raw hiSOLA).
pub const MAX_VE_MULTIPLIER: u64 = 4;

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
    pub floor_vault: Pubkey,          // USDC: 1 USDC per SOLA in supply
    pub market_vault: Pubkey,         // USDC: excess above floor (fee revenue)
    pub sola_vault: Pubkey,           // locked SOLA from stakers
    pub virtual_usdc: u64,            // virtual USDC in bonding curve
    pub virtual_sola: u64,            // virtual SOLA in bonding curve
    pub k: u128,                      // constant product = virtual_usdc * virtual_sola
    pub total_sola: u64,              // real SOLA minted (not virtual)
    pub total_hi_sola: u64,
    pub accumulated_fees: u64,        // lifetime market vault inflows
    pub fees_per_hi_sola: u128,       // cumulative USDC-per-hiSOLA × PRECISION
    pub last_market_vault_balance: u64, // snapshot used to detect new fees
    pub bump: u8,
    /// Prevents mint_founder_allocation from being called more than once.
    pub founder_allocated: bool,
}

impl ProtocolState {
    pub const LEN: usize = 400;
}

#[account]
#[derive(Default)]
pub struct UserPosition {
    pub owner: Pubkey,
    pub usdc_borrowed: u64,
    pub fees_debt: u128,  // fees_per_hi_sola at last claim / entry point
    pub bump: u8,
}

impl UserPosition {
    pub const LEN: usize = 128;
}

// ── Bribe system ──────────────────────────────────────────────────────────────

/// Bribe pot for one (pool_id, reward_mint, epoch) triplet.
/// Permissionless — any protocol can deposit. Multiple deposits per epoch are additive.
/// PDA: [b"bribe_vault", pool_id, reward_mint, epoch_le8]
#[account]
pub struct BribeVault {
    pub pool_id:      Pubkey,  // External pool being incentivised (label only)
    pub reward_mint:  Pubkey,  // Token offered as bribe
    pub epoch:        u64,     // Epoch this bribe applies to
    pub total_bribed: u64,     // Cumulative amount deposited this epoch
    pub bump:         u8,
}
impl BribeVault { pub const LEN: usize = 128; }

/// Aggregate hiSOLA vote-weight directed at a pool for one epoch.
/// PDA: [b"gauge", pool_id, epoch_le8]
#[account]
pub struct GaugeState {
    pub pool_id:     Pubkey,
    pub epoch:       u64,
    pub total_votes: u64,
    pub bump:        u8,
}
impl GaugeState { pub const LEN: usize = 96; }

/// Records one user's vote for a specific (pool, epoch) pair.
/// Created with `init` — immutable once written, prevents double-voting for same pool.
/// PDA: [b"vote", user, pool_id, epoch_le8]
#[account]
pub struct UserVoteReceipt {
    pub user:    Pubkey,
    pub pool_id: Pubkey,
    pub epoch:   u64,
    pub votes:   u64,  // hiSOLA weight committed to this pool
    pub bump:    u8,
}
impl UserVoteReceipt { pub const LEN: usize = 128; }

/// Tracks total vote-weight already allocated by one user in an epoch (across all pools).
/// Prevents voting more than the user's hiSOLA balance.
/// PDA: [b"uev", user, epoch_le8]
#[account]
pub struct UserEpochVotes {
    pub epoch:     u64,
    pub allocated: u64,  // sum of all votes cast this epoch
    pub bump:      u8,
}
impl UserEpochVotes { pub const LEN: usize = 64; }

/// Created during claim_bribe — its existence proves the claim was made.
/// PDA: [b"bribe_claim", user, pool_id, reward_mint, epoch_le8]
#[account]
pub struct UserBribeClaim {
    pub bump: u8,
}
impl UserBribeClaim { pub const LEN: usize = 32; }

// ── Ve-layer ──────────────────────────────────────────────────────────────────

/// Per-user lock state for ve-weighted governance.
///
/// Locking hiSOLA transfers tokens to ve_lock_vault and removes them from the
/// fee accumulator denominator. Locked hiSOLA earns ve voting power instead.
/// PDA: [b"velock", user]
#[account]
pub struct VeLockPosition {
    pub owner:         Pubkey,
    pub amount_locked: u64,  // hiSOLA held in ve_lock_vault
    pub lock_end_ts:   i64,  // Unix timestamp when lock expires
    pub bump:          u8,
}
impl VeLockPosition { pub const LEN: usize = 96; }

// ── LP Emission checkpointing ─────────────────────────────────────────────────

/// Total hiSOLA vote-weight cast across ALL pools in one epoch.
/// Used as denominator when splitting LP_EMISSION_PER_EPOCH across pools.
/// PDA: [b"epoch_votes", epoch_le8]
#[account]
pub struct GlobalEpochVotes {
    pub epoch:       u64,
    pub total_votes: u64,
    pub bump:        u8,
}
impl GlobalEpochVotes { pub const LEN: usize = 32; }

/// Continuous time-weighted LP balance for one (user, pool) pair.
/// Accumulates: weighted_balance += lp_balance × elapsed_secs each checkpoint.
/// Reset to 0 at the start of each new epoch.
/// PDA: [b"lp_ckpt", pool, user]
#[account]
pub struct LpUserCheckpoint {
    pub user:             Pubkey,
    pub pool:             Pubkey,
    pub weighted_balance: u128,  // sum(lp_balance × elapsed_secs) for last_epoch
    pub last_update_ts:   i64,
    pub last_epoch:       u64,
    pub bump:             u8,
}
impl LpUserCheckpoint { pub const LEN: usize = 32+32+16+8+8+1+7; }

/// Time-weighted total LP supply for one pool in one epoch.
/// Finalized by emit_pool_rewards after epoch ends; records oSOLA allocation.
/// PDA: [b"lp_pool_epoch", pool, epoch_le8]
#[account]
pub struct LpPoolEpochAccum {
    pub pool:                  Pubkey,
    pub epoch:                 u64,
    pub total_weighted_supply: u128,
    pub last_update_ts:        i64,
    pub last_lp_supply:        u64,
    pub osola_allocated:       u64,
    pub finalized:             bool,
    pub bump:                  u8,
}
impl LpPoolEpochAccum { pub const LEN: usize = 32+8+16+8+8+8+1+1+18; }

/// Proof-of-claim for LP emissions — created by claim_lp_emissions, blocks replay.
/// PDA: [b"lp_claim", user, pool, epoch_le8]
#[account]
pub struct LpEpochClaim {
    pub bump: u8,
}
impl LpEpochClaim { pub const LEN: usize = 32; }

// ── Continuous LP reward tracking (Masterchef-style) ─────────────────────────

/// Per-user oSOLA reward state for one (user, pool) pair.
/// Created on first add_liquidity, claim_lp_rewards, or remove_liquidity.
/// PDA: [b"lp_user", pool, user]
#[account]
#[derive(Default)]
pub struct LpUserInfo {
    pub reward_debt: u128,  // pool.osola_reward_per_lp snapshot at last interaction
    pub bump:        u8,
}
impl LpUserInfo {
    pub const LEN: usize = 16 + 1 + 15; // = 32 with padding
}

// ── Protocol-Owned Liquidity ──────────────────────────────────────────────────

/// Singleton PDA controlling protocol-owned liquidity.
/// PDA: [b"pol"]
#[account]
pub struct PolState {
    /// Suggested % of market_vault fees to divert (informational, enforced off-chain).
    pub pol_split_bps:    u16,
    /// AmmPool PDA that receives POL liquidity deposits.
    pub target_pool:      Pubkey,
    /// Lifetime USDC routed through collect_to_pol.
    pub usdc_accumulated: u64,
    pub bump:             u8,
}
impl PolState { pub const LEN: usize = 96; }
