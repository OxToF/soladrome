// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Christophe Hertecant

use anchor_lang::prelude::*;

#[account]
pub struct AmmPool {
    pub token_a_mint:     Pubkey,  // sorted: lexicographically smaller mint
    pub token_b_mint:     Pubkey,  // sorted: lexicographically larger mint
    pub token_a_vault:    Pubkey,  // PDA: seeds=[b"vault_a", pool]
    pub token_b_vault:    Pubkey,  // PDA: seeds=[b"vault_b", pool]
    pub lp_mint:          Pubkey,  // PDA: seeds=[b"lp_mint", pool]
    pub fee_rate:         u16,     // swap fee in basis points (e.g. 30 = 0.30%)
    pub protocol_fee_bps: u16,     // protocol share of fee in bps (e.g. 2000 = 20% of fee)
    pub total_lp:         u64,     // LP tokens in circulation (excludes MINIMUM_LIQUIDITY)
    pub reserve_a:           u64,     // cached token A balance
    pub reserve_b:           u64,     // cached token B balance
    pub bump:                u8,
    // Continuous Masterchef-style oSOLA reward accumulator (fits in old 64-byte padding)
    pub osola_reward_per_lp: u128,    // accumulated oSOLA per LP × LP_REWARD_PRECISION
    pub last_reward_ts:      i64,     // unix ts of last accumulator update (0 = uninit)
}

impl AmmPool {
    pub const LEN: usize = 8   // discriminator
        + 32   // token_a_mint
        + 32   // token_b_mint
        + 32   // token_a_vault
        + 32   // token_b_vault
        + 32   // lp_mint
        + 2    // fee_rate
        + 2    // protocol_fee_bps
        + 8    // total_lp
        + 8    // reserve_a
        + 8    // reserve_b
        + 1    // bump
        + 16   // osola_reward_per_lp
        + 8    // last_reward_ts
        + 40;  // remaining padding
}

/// Sort two mints to guarantee a unique PDA per pair regardless of input order.
/// Returns (smaller, larger) by raw bytes comparison.
pub fn sort_mints(a: Pubkey, b: Pubkey) -> (Pubkey, Pubkey) {
    if a.to_bytes() <= b.to_bytes() { (a, b) } else { (b, a) }
}
