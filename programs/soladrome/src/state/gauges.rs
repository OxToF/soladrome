// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Gauge voting: per-pool weight, per-user receipts, and the persistent vote config.

use anchor_lang::prelude::*;

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
    /// The ve-weighted share of `total_power_snapshot`, frozen at first vote.
    ///
    /// Splitting the snapshot matters for escrow: ve power is already immobilised in
    /// the ve vault, so only the portion of the allocation exceeding it needs backing
    /// by escrowed hiSOLA. Frozen rather than recomputed because `ve_power` decays
    /// continuously — a live read would make the required escrow creep upward within
    /// the same epoch and fail otherwise-valid votes.
    pub ve_power_snapshot: u64,
    /// Extra voting power earned by burning oSOLA this epoch.
    /// Resets every epoch (new PDA). Not subject to the 30% hiSOLA cap —
    /// burning oSOLA is a deflationary act that justifies uncapped influence.
    pub o_sola_bonus: u64,
    pub bump: u8,
}
impl UserEpochVotes {
    pub const LEN: usize = 64;
} // 8+8+8+8+8+1 = 41 bytes used, 23 spare (ve_power_snapshot added 2026-08-09)

const _: () = assert!(
    UserEpochVotes::LEN >= 8 + std::mem::size_of::<UserEpochVotes>(),
    "UserEpochVotes::LEN is too small — update it to fit the struct"
);

/// Total hiSOLA vote-weight cast across ALL pools in one epoch.
/// Used as denominator when splitting the epoch's oSOLA emission across pools — the amount
/// itself comes from `ProtocolState.osola_emission_initial` and its decay, not a constant.
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
