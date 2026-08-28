// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Bribe pots and the per-voter claim guard.

use anchor_lang::prelude::*;

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

/// Created during claim_bribe — its existence proves the claim was made.
/// PDA: [b"bribe_claim", user, pool_id, reward_mint, epoch_le8]
#[account]
pub struct UserBribeClaim {
    pub bump: u8,
}
impl UserBribeClaim {
    pub const LEN: usize = 32;
}
