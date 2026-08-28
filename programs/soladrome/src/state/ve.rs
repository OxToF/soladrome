// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Vote-escrow lock positions.

use anchor_lang::prelude::*;

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
    /// Portion of `amount_locked` that can NEVER be unlocked, whatever `lock_end_ts` says.
    /// `unlock_hi_sola` releases at most `amount_locked - permanent_amount`.
    ///
    /// This is what "we sell permanent voting power" means mechanically: the partner
    /// welcome bag (and the team tranche) is unfinanced — no USDC ever entered the floor
    /// vault for it — so letting it reach a wallet would let it be redeemed 1:1 against
    /// backing that real buyers funded. Locking it forever leaves exactly one channel open,
    /// `borrow_against_locked` at 20%, the protocol's drain ceiling for unfinanced supply.
    ///
    /// Appended last and carved from the 47 spare bytes → existing positions read 0, i.e.
    /// fully releasable, which is exactly the pre-2026-07-17 behaviour. No realloc.
    pub permanent_amount: u64,
}
impl VeLockPosition {
    // 32 + 8 + 8 + 1 + 8 = 57 used of 96 (39 spare).
    pub const LEN: usize = 96;
}
