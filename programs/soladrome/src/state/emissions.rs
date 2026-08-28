// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Per-epoch LP emission checkpointing (the gauge-weighted oSOLA pot).

use anchor_lang::prelude::*;

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
    /// Cumulative oSOLA already minted to LPs for this (pool, epoch). Hard-caps the pot:
    /// `claim_lp_emissions` can never mint more than `osola_allocated` in total, whatever
    /// the sum of user weighted balances happens to be. Defence in depth behind the
    /// checkpoint fix — the invariant "Σ user weights ≤ total_weighted_supply" is an
    /// off-account property nothing on-chain can verify at claim time, so the pot itself
    /// is made the ceiling.
    ///
    /// Appended last, carved from the 18 spare bytes → existing accums read 0, i.e. the
    /// full allocation still claimable. No realloc.
    pub osola_claimed: u64,
}
impl LpPoolEpochAccum {
    // 32 + 8 + 16 + 8 + 8 + 8 + 1 + 1 + 8 = 90 used of 100 (10 spare).
    pub const LEN: usize = 100;
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
