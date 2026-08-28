// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Protocol-owned-liquidity singleton.

use anchor_lang::prelude::*;

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
