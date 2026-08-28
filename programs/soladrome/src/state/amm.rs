// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! AMM pool layout and the per-(user, pool) continuous-reward state.

use anchor_lang::prelude::*;

#[account]
pub struct AmmPool {
    pub token_a_mint: Pubkey,  // sorted: lexicographically smaller mint
    pub token_b_mint: Pubkey,  // sorted: lexicographically larger mint
    pub token_a_vault: Pubkey, // PDA: seeds=[b"vault_a", pool]
    pub token_b_vault: Pubkey, // PDA: seeds=[b"vault_b", pool]
    pub lp_mint: Pubkey,       // PDA: seeds=[b"lp_mint", pool]
    pub fee_rate: u16,         // swap fee in basis points (e.g. 30 = 0.30%)
    pub protocol_fee_bps: u16, // protocol share of fee in bps (e.g. 2000 = 20% of fee)
    pub total_lp: u64,         // LP tokens in circulation (excludes MINIMUM_LIQUIDITY)
    pub reserve_a: u64,        // cached token A balance
    pub reserve_b: u64,        // cached token B balance
    pub bump: u8,
    // Continuous Masterchef-style oSOLA reward accumulator (fits in old 64-byte padding)
    pub osola_reward_per_lp: u128, // accumulated oSOLA per LP × LP_REWARD_PRECISION
    pub last_reward_ts: i64,       // unix ts of last accumulator update (0 = uninit)
    /// Whether this pool earns continuous oSOLA emissions. Authority-gated and
    /// default false: only curated "house" pools accrue, bounding total emission
    /// to an approved set and preventing unbounded permissionless oSOLA farming
    /// (any pool is created permissionlessly). Carved from the trailing padding,
    /// so existing accounts read 0 = false until the authority enables them.
    pub rewards_enabled: bool,
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
        + 1    // rewards_enabled
        + 39; // remaining padding
}

/// Sort two mints to guarantee a unique PDA per pair regardless of input order.
/// Returns (smaller, larger) by raw bytes comparison.
pub fn sort_mints(a: Pubkey, b: Pubkey) -> (Pubkey, Pubkey) {
    if a.to_bytes() <= b.to_bytes() {
        (a, b)
    } else {
        (b, a)
    }
}

/// Per-user oSOLA reward state for one (user, pool) pair.
/// Created on first add_liquidity, claim_lp_rewards, or remove_liquidity.
/// PDA: [b"lp_user", pool, user]
#[account]
#[derive(Default)]
pub struct LpUserInfo {
    pub reward_debt: u128, // pool.osola_reward_per_lp snapshot at last interaction
    pub bump: u8,
    /// LP tokens this user actually deposited through `add_liquidity`, maintained by the
    /// program (add → +lp_out, remove → −lp_burned). This — not the wallet's LP token
    /// balance — is the basis for every oSOLA reward computation.
    ///
    /// Why: LP tokens are ordinary transferable SPL tokens, while `reward_debt` lives in a
    /// per-wallet PDA that `init_if_needed` creates at 0. Paying on the wallet balance let
    /// anyone move LP to a fresh wallet and claim `osola_reward_per_lp × balance` — the
    /// accumulator since pool creation — then repeat, wallet after wallet: an unbounded
    /// oSOLA mint. Rewards are read as `min(lp_amount, wallet_balance)` so the payout needs
    /// BOTH a program-recorded deposit AND the tokens still in hand; transferred LP earns
    /// on neither side. Same lesson as the founder tranches: a rule enforced on a token
    /// balance is not enforced at all.
    ///
    /// Appended last, carved from the 15 spare bytes → existing accounts read 0 and no
    /// realloc is needed.
    ///
    /// ⚠️ MIGRATION — this is NOT free. The devnet stream is armed (rate 413 360/s, window
    /// open, 5 pools `rewards_enabled`, ~986 `LpUserInfo` live), so the ~986 existing LPs
    /// read `lp_amount = 0` after this upgrade and stop earning until they withdraw and
    /// redeposit. Seeding `lp_amount` from the wallet balance would be the obvious fix and
    /// is exactly the hole being closed — it would hand the full historical accumulator to
    /// anyone holding transferred LP. Decide the migration before deploying.
    pub lp_amount: u64,
    /// Unix seconds of the last `add_liquidity` / `remove_liquidity` by this user on this
    /// pool, as u32 (valid until 2106 — a u64 would not fit the spare bytes, and no realloc
    /// is worth it).
    ///
    /// `checkpoint_lp` starts its accrual window at `max(last checkpoint, this)`, so an
    /// interval is only ever billed at a size held for the whole interval. Without it,
    /// `lp_amount` alone is still gameable in both directions: deposit at epoch start,
    /// checkpoint, withdraw, redeposit and checkpoint at epoch end (the second checkpoint
    /// bills the whole interval at the redeposited size), or simply sit at zero, deposit at
    /// T−ε and checkpoint (the interval is billed at a size held for ε). Either buys a full
    /// epoch of weight with an instant of capital, repeatable wallet by wallet. The rule for
    /// honest LPs is symmetric and simple: checkpoint BEFORE changing your position.
    pub last_change_ts: u32,
}
impl LpUserInfo {
    // 16 + 1 + 8 + 4 = 29 used of 32 (3 spare).
    pub const LEN: usize = 32;
}
