// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs

//! Standing compound orders.

use anchor_lang::prelude::*;

/// A user's standing instruction: "when I hold at least `threshold` oSOLA, exercise `chunk` of
/// it and stake the result, as long as it costs no more than `max_cost_per_unit`."
///
/// ☢️ **NO CUSTODY, AND NO ESCROW.** This account holds nothing. The oSOLA and the USDC stay in
/// the user's own token accounts, and the crank moves them as an SPL **delegate** — the user
/// calls `approve` once, for an amount they choose, and `revoke` from their wallet whenever
/// they like. Three consequences worth stating, because they are the whole design:
///
///   · the spending cap is enforced by SPL Token itself (`delegated_amount` decrements on every
///     use), not by a counter in this account that a bug here could get wrong;
///   · the funds never move to an address the protocol controls, so there is no vault to drain
///     and no withdrawal path to get wrong;
///   · revocation is a wallet-native gesture that needs nothing from us, and works even if this
///     program stops being maintained.
///
/// ⚠️ The cost: an SPL token account has exactly ONE delegate. Approving here overwrites any
/// delegation the user had granted elsewhere on the same account, and a later `approve` by
/// another application silently disables this order. The crank then simply fails and the order
/// goes quiet, which is the safe direction.
///
/// PDA: [b"auto", user]
#[account]
pub struct AutoCompound {
    pub owner: Pubkey,
    /// Minimum oSOLA balance in the user's account before a crank is allowed at all. This is
    /// the "when I have 500" of the standing order.
    pub threshold: u64,
    /// How much to exercise per crank. Kept separate from `threshold` so an order can accumulate
    /// to a large trigger and still compound in small bites.
    pub chunk: u64,
    /// ☢️ THE BOUND `exercise_o_sola` DOES NOT HAVE, and the reason this account exists rather
    /// than a pile of pre-signed transactions.
    ///
    /// The exercise fee is a share of the GAIN, priced off the curve **at landing**, so the
    /// USDC a compound costs is not known when the order is placed. A pre-signed transaction
    /// therefore authorises an amount of oSOLA at an unbounded price: the same signed bytes
    /// cost 2.25 USDC at a curve of 1.045 and 50 USDC at a curve of 2.00, and it is whoever
    /// broadcasts them who picks. Here the user states the most they will pay per oSOLA, in
    /// base units, and the crank refuses above it. Nobody can make this order expensive by
    /// choosing its moment.
    pub max_cost_per_unit: u64,
    /// Lifetime USDC spent by this order. Informational: the real cap is the SPL allowance.
    pub usdc_spent: u64,
    /// How many times this order has fired.
    pub rounds: u64,
    /// Unix seconds of the last successful crank.
    pub last_crank_ts: i64,
    /// Shortest gap between two cranks. A permissionless instruction with no clock can be
    /// called in a loop by anyone; each call is individually legitimate, so the protection is
    /// not a permission but a rate. It also bounds how fast an order can consume its allowance.
    pub min_interval: i64,
    /// A disabled order is inert without being closed, so a user can pause without paying rent
    /// again to resume.
    pub enabled: bool,
    pub bump: u8,
}

impl AutoCompound {
    // 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 = 90 used of 128 (38 spare, room for the fields a
    // second recipe will want without a realloc — the lesson of the 3003 devnet brick).
    //
    // ⚠️ LEN EXCLUDES the 8-byte discriminator, as every other account here does, so the `init`
    // that creates this asks for `8 + LEN`. Writing `space = LEN` produces an account eight
    // bytes short: it is created happily and then fails to deserialize on the very next read,
    // with `AccountDidNotDeserialize` (3003) and no hint about where the eight bytes went.
    pub const LEN: usize = 128;

    /// Whether the order may fire right now, given the balance the chain reports and the clock.
    ///
    /// Deliberately a method on the account rather than a block inside the crank: it is the
    /// half of the decision that needs no accounts, which is what makes it testable on its own
    /// and readable next to the fields it reads.
    pub fn ready(&self, o_sola_balance: u64, now: i64) -> bool {
        self.enabled
            && self.chunk > 0
            && o_sola_balance >= self.threshold
            && o_sola_balance >= self.chunk
            && now.saturating_sub(self.last_crank_ts) >= self.min_interval
    }
}
