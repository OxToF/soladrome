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
    /// ☢️ THE BOUND THAT ADAPTS, and the reason `max_cost_per_unit` above is no longer the
    /// headline control.
    ///
    /// `max_cost_per_unit` is an ABSOLUTE amount, so it silently doubles as a bet on the SOLA
    /// price: a round costs the 1 USDC strike plus a share of the gain, so the only way an
    /// absolute ceiling is ever reached is that the price rose. An order therefore stopped
    /// itself precisely when compounding had become most profitable — the strike stays at 1 USDC
    /// while the SOLA received is worth more — and it asked its owner to forecast a price for
    /// the life of the order, which nobody can do.
    ///
    /// The thing actually worth bounding is the RATE: `exercise_fee_bps` is a protocol parameter
    /// the authority may raise as far as `MAX_EXERCISE_FEE_BPS`, and no holder can predict it.
    /// Bounding the rate is price-independent, so the order keeps firing at any price and
    /// refuses only the one change that was never theirs to accept.
    ///
    /// ⚠️ **Zero means UNSET, not "only at zero fee".** Every order written before this field
    /// existed reads 0 out of the account's spare bytes, and reading that as a bound would brick
    /// them all on the next crank. The degenerate preference it costs us — "compound only while
    /// there is no fee at all" — is one nobody wants; bricking live orders is not.
    pub max_fee_bps: u16,
    /// ☢️ THE DESTINATION: the AMM pool this order compounds into, or the default key for the
    /// original destination, staking. "Liquidity OR vote" is literally this field.
    ///
    /// One order rather than two because the oSOLA account has exactly ONE delegate: two orders
    /// would share one allowance and race each other for it. And because the crank is
    /// permissionless, the destination cannot be a choice of whoever calls — `crank_auto_compound`
    /// refuses an order that names a pool here, and `crank_auto_compound_lp` refuses one that
    /// names a different pool, so a cranker can neither redirect nor downgrade it.
    ///
    /// Only the target is stored. The rest of the route is derived, never chosen: the oSOLA is
    /// sold on THE oSOLA/USDC pool (a unique PDA), and reaches a pool without USDC through THE
    /// SOL/USDC pool. A route with a free hop would let a cranker steer it through a shallow
    /// pool they had just moved.
    pub lp_target: Pubkey,
    /// ☢️ THE BOUND ON THE SALE: the order sells oSOLA only for at least this share of its
    /// intrinsic value, `(P_curve − 1) × (1 − exercise fee)` per oSOLA.
    ///
    /// The reference is the curve because nobody can push it down: `sell_sola` never touches the
    /// virtual reserves, and only buys move them. So a cranker who sandwiches the sale can
    /// depress the pool price, never the bound. It is a RATE, like `max_fee_bps`, so it follows
    /// the market instead of expiring against it; an absolute minimum price would ask the owner
    /// to forecast. Meaningless (zero) while the destination is staking.
    pub min_intrinsic_bps: u16,
}

impl AutoCompound {
    // 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 2 + 32 + 2 = 126 used of 128. The last two fields
    // are the second recipe the spare bytes were kept for, and they fit WITHOUT a realloc — the
    // lesson of the 3003 devnet brick: an order armed before them reads zeros, which is exactly
    // "destination: staking, no LP bound". Two bytes remain.
    //
    // ☢️ `max_fee_bps`, then `lp_target` and `min_intrinsic_bps`, were appended in 2026-09 and
    // MUST stay last, in that order. Borsh is positional, so a new
    // field is only safe at the END: an account written before it existed then yields the zero
    // bytes `init` left behind, which is exactly the "unset" the field documents. Inserting it
    // anywhere else would reinterpret `enabled` and `bump` on every live order — silently, and
    // with no deserialization error to notice it by, because the length still fits.
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
