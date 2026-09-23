// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs

use crate::errors::SoladromeError;
use anchor_lang::prelude::*;

pub const MINIMUM_LIQUIDITY: u64 = 1_000;

/// Integer square root (floor) using Newton-Raphson, no floating point.
pub fn isqrt(n: u128) -> u64 {
    if n == 0 {
        return 0;
    }
    let mut x = n;
    let mut y = x.div_ceil(2);
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x as u64
}

/// The fee split of a swap of `amount_in`: `(fee_total, fee_protocol, amount_net)`.
///
/// ☢️ THE ONE PLACE THIS ARITHMETIC LIVES. `amm::quote_swap` prices every public swap and the
/// arbitrage path with it, and `zap_in` prices its virtual swap with it. A zap that rounded its
/// fee differently from the public `swap` would be a route that pays a different rate than the
/// pool quotes — the exact defect `quote_swap` was extracted to end.
pub fn split_fee(amount_in: u64, fee_rate: u16, protocol_fee_bps: u16) -> (u64, u64, u64) {
    let fee_total = amount_in as u128 * fee_rate as u128 / 10_000;
    let fee_protocol = fee_total * protocol_fee_bps as u128 / 10_000;
    // `fee_rate <= MAX_FEE_RATE` (10 %) is enforced at pool creation, so this cannot underflow.
    let amount_net = amount_in as u128 - fee_total;
    (fee_total as u64, fee_protocol as u64, amount_net as u64)
}

/// `reserve_out * amount_in_net / (reserve_in + amount_in_net)`, floored, refusing nothing.
///
/// The formula `swap_out` guards. Split out so `zap_in` can evaluate trial sizes whose output
/// rounds to zero — a legitimate intermediate point of its search, and not a trade anybody
/// executes — without the refusal that protects a real swapper from paying for nothing.
fn raw_swap_out(reserve_in: u64, reserve_out: u64, amount_in_net: u64) -> Result<u64> {
    let ri = reserve_in as u128;
    let ro = reserve_out as u128;
    let ai = amount_in_net as u128;
    // Both factors are u64, so the product is at most (2^64 - 1)^2 < u128::MAX.
    let numerator = ro * ai;
    let denominator = ri.checked_add(ai).ok_or(SoladromeError::Overflow)?;
    Ok((numerator / denominator) as u64)
}

/// Amount out for a volatile xy=k swap, after fees have been deducted from amount_in.
/// amount_in_net = amount_in - total_fee (already deducted by caller)
pub fn swap_out(reserve_in: u64, reserve_out: u64, amount_in_net: u64) -> Result<u64> {
    require!(
        reserve_in > 0 && reserve_out > 0,
        SoladromeError::InsufficientLiquidity
    );
    require!(amount_in_net > 0, SoladromeError::InvalidAmount);

    let out = raw_swap_out(reserve_in, reserve_out, amount_in_net)?;

    require!(
        out > 0 && out <= reserve_out,
        SoladromeError::InsufficientLiquidity
    );
    Ok(out)
}

/// LP tokens to mint and actual token amounts consumed for a deposit.
/// Returns (lp_out, actual_a, actual_b).
/// For the first deposit: lp_out = isqrt(a * b) - MINIMUM_LIQUIDITY.
/// For subsequent deposits: proportional, rebalances smaller side.
pub fn lp_for_deposit(
    reserve_a: u64,
    reserve_b: u64,
    total_lp: u64,
    amount_a: u64,
    amount_b: u64,
) -> Result<(u64, u64, u64)> {
    require!(amount_a > 0 && amount_b > 0, SoladromeError::ZeroLiquidity);

    if total_lp == 0 {
        // First deposit
        let lp_raw = isqrt(
            (amount_a as u128)
                .checked_mul(amount_b as u128)
                .ok_or(SoladromeError::Overflow)?,
        );
        require!(lp_raw > MINIMUM_LIQUIDITY, SoladromeError::ZeroLiquidity);
        let lp_out = lp_raw - MINIMUM_LIQUIDITY;
        Ok((lp_out, amount_a, amount_b))
    } else {
        // Subsequent deposit — proportional
        let ra = reserve_a as u128;
        let rb = reserve_b as u128;
        let tl = total_lp as u128;
        let aa = amount_a as u128;
        let ab = amount_b as u128;

        // lp if we use all of A: lp_a = amount_a * total_lp / reserve_a
        // lp if we use all of B: lp_b = amount_b * total_lp / reserve_b
        let lp_a = aa
            .checked_mul(tl)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(ra)
            .ok_or(SoladromeError::Overflow)?;
        let lp_b = ab
            .checked_mul(tl)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(rb)
            .ok_or(SoladromeError::Overflow)?;

        let (lp_out, actual_a, actual_b) = if lp_a <= lp_b {
            // A is the limiting side; compute optimal B
            let optimal_b = lp_a
                .checked_mul(rb)
                .ok_or(SoladromeError::Overflow)?
                .checked_div(tl)
                .ok_or(SoladromeError::Overflow)?;
            (lp_a, aa, optimal_b)
        } else {
            // B is the limiting side; compute optimal A
            let optimal_a = lp_b
                .checked_mul(ra)
                .ok_or(SoladromeError::Overflow)?
                .checked_div(tl)
                .ok_or(SoladromeError::Overflow)?;
            (lp_b, optimal_a, ab)
        };

        require!(lp_out > 0, SoladromeError::ZeroLiquidity);
        Ok((lp_out as u64, actual_a as u64, actual_b as u64))
    }
}

/// A single-sided deposit, priced as "swap part of it, then add both sides", with nothing but
/// the input ever moving.
#[cfg_attr(test, derive(Debug))]
pub struct ZapQuote {
    /// How much of the input the virtual swap sells.
    pub swap_in: u64,
    /// The protocol's share of the virtual swap's fee that the caller must move out of the input
    /// vault to `market_vault`. Zero when the caller does not route the protocol fee.
    pub fee_routed: u64,
    /// What the virtual swap would have paid out. It never leaves the vault.
    pub swap_out: u64,
    /// LP to mint to the depositor.
    pub lp_out: u64,
    /// What the input reserve grows by: the whole deposit, less the routed fee. The output
    /// reserve does not change, because no output token ever left.
    pub reserve_in_delta: u64,
}

/// Price a deposit of `amount_in` of ONE side of a pool that already has liquidity.
///
/// Economically this is exactly the two public steps a user would take by hand — `swap` part of
/// the input, then `add_liquidity` with what they hold — using the same fee split, the same
/// constant-product quote and the same `lp_for_deposit`. The difference is only in what moves.
/// By hand, the swapped-out tokens leave the vault and come straight back in; here they never
/// leave. So the input vault grows by the whole deposit and the output vault not at all, and a
/// deposit into a Token-2022 side never touches that mint: no hook, no transfer fee, nothing to
/// reason about.
///
/// ☢️ **WHAT THE DEPOSITOR DOES NOT GET BACK IS DONATED, NEVER MINTED.** By hand, rounding leaves
/// a few units of one side in the user's wallet. Here those units are already in the vault and
/// stay there, so they accrue to every LP in proportion — the depositor included. `lp_out` is
/// the figure `lp_for_deposit` returns for the two amounts the manual path would offer, so the
/// depositor can never be credited with more than that path would have minted, and whatever the
/// search leaves unused is value for the pool rather than for them.
///
/// The swap size is found by bisection on the pool's own integer quote, not by the closed-form
/// square root. The closed form squares the reserve and multiplies by `(2 − fee)²`: at 9 decimals
/// a pool of a million wSOL puts that past `u128`. The bisection only ever multiplies two u64s,
/// and it lands on the integer the real quote would produce, rather than on a real number that
/// then has to be rounded in some direction someone must argue about.
///
/// `route_protocol_fee` mirrors `swap`: the protocol's share of the fee leaves the pool only
/// when the input is USDC, and otherwise stays in the reserves as LP revenue.
pub fn zap_in(
    reserve_in: u64,
    reserve_out: u64,
    total_lp: u64,
    amount_in: u64,
    fee_rate: u16,
    protocol_fee_bps: u16,
    route_protocol_fee: bool,
) -> Result<ZapQuote> {
    // A first deposit sets the pool's price, which a single side cannot do.
    require!(
        total_lp > 0 && reserve_in > 0 && reserve_out > 0,
        SoladromeError::InsufficientLiquidity
    );
    require!(amount_in > 0, SoladromeError::InvalidAmount);

    // The state of the pool after a virtual swap of `s`: the reserves the deposit is priced
    // against, the output the swap produced, and the fee that left.
    let after = |s: u64| -> Result<(u64, u64, u64, u64)> {
        let (_, fee_protocol, net) = split_fee(s, fee_rate, protocol_fee_bps);
        let routed = if route_protocol_fee { fee_protocol } else { 0 };
        let out = raw_swap_out(reserve_in, reserve_out, net)?;
        let r_in = reserve_in
            .checked_add(s - routed)
            .ok_or(SoladromeError::Overflow)?;
        // `raw_swap_out` is strictly below `reserve_out` for any finite input.
        let r_out = reserve_out - out;
        Ok((r_in, r_out, out, routed))
    };

    // The deposit is balanced when what is left of the input matches the output at the pool's
    // post-swap ratio. Selling more always lowers the left-hand side and raises the right, so
    // "still at least balanced" is monotone in `s` and a bisection finds its last true point.
    let input_side_in_excess = |s: u64| -> Result<bool> {
        let (r_in, r_out, out, _) = after(s)?;
        Ok((amount_in - s) as u128 * r_out as u128 >= out as u128 * r_in as u128)
    };

    // Invariant: `lo` satisfies the predicate (s = 0 swaps nothing and trivially does), `hi`
    // does not (s = amount_in leaves nothing on the input side to pair with).
    let (mut lo, mut hi) = (0u64, amount_in);
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if input_side_in_excess(mid)? {
            lo = mid;
        } else {
            hi = mid;
        }
    }

    // `lo` is limited by the output side and `hi` by the input side; the optimum is whichever
    // of the two neighbours mints more. A candidate that cannot mint at all is simply skipped.
    let mut best: Option<(u64, u64, u64, u64)> = None; // (s, lp, out, routed)
    for s in [lo, hi] {
        let (r_in, r_out, out, routed) = after(s)?;
        if s == amount_in || out == 0 {
            continue;
        }
        if let Ok((lp, _, _)) = lp_for_deposit(r_in, r_out, total_lp, amount_in - s, out) {
            if best.is_none_or(|b| lp > b.1) {
                best = Some((s, lp, out, routed));
            }
        }
    }
    let (swap_in, lp_out, swap_out, fee_routed) = best.ok_or(SoladromeError::ZeroLiquidity)?;

    Ok(ZapQuote {
        swap_in,
        fee_routed,
        swap_out,
        lp_out,
        reserve_in_delta: amount_in - fee_routed,
    })
}

/// Token amounts returned when burning lp_amount LP tokens.
/// Returns (amount_a, amount_b).
pub fn tokens_for_lp(
    reserve_a: u64,
    reserve_b: u64,
    total_lp: u64,
    lp_amount: u64,
) -> Result<(u64, u64)> {
    require!(total_lp > 0, SoladromeError::InsufficientLiquidity);
    require!(
        lp_amount > 0 && lp_amount <= total_lp,
        SoladromeError::InvalidAmount
    );

    let ra = reserve_a as u128;
    let rb = reserve_b as u128;
    let tl = total_lp as u128;
    let lp = lp_amount as u128;

    let a = ra
        .checked_mul(lp)
        .ok_or(SoladromeError::Overflow)?
        .checked_div(tl)
        .ok_or(SoladromeError::Overflow)?;
    let b = rb
        .checked_mul(lp)
        .ok_or(SoladromeError::Overflow)?
        .checked_div(tl)
        .ok_or(SoladromeError::Overflow)?;

    require!(a > 0 && b > 0, SoladromeError::ZeroLiquidity);
    Ok((a as u64, b as u64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assert_err;

    // ── isqrt ─────────────────────────────────────────────────────────────

    #[test]
    fn isqrt_floors_and_never_truncates_on_cast() {
        assert_eq!(isqrt(0), 0);
        assert_eq!(isqrt(1), 1);
        assert_eq!(isqrt(4), 2);
        assert_eq!(isqrt(8), 2, "must floor, not round");
        assert_eq!(isqrt(9), 3);
        assert_eq!(isqrt(1_000_000_000_000), 1_000_000);

        // `isqrt` returns `x as u64`, an unchecked cast. It is safe only because
        // floor(sqrt(u128::MAX)) == u64::MAX exactly — one more and the cast would wrap and
        // hand a first depositor an LP figure smaller than their deposit.
        assert_eq!(isqrt(u128::MAX), u64::MAX);

        // The only caller squares two u64s, so this is the real worst case it can produce.
        let max_product = (u64::MAX as u128) * (u64::MAX as u128);
        assert_eq!(isqrt(max_product), u64::MAX);
    }

    #[test]
    fn isqrt_satisfies_its_defining_property() {
        for n in [2u128, 3, 15, 99, 1_000, 999_999, 1 << 40, (1u128 << 80) + 7] {
            let r = isqrt(n) as u128;
            assert!(r * r <= n, "isqrt({n}) = {r} overshoots");
            assert!((r + 1) * (r + 1) > n, "isqrt({n}) = {r} undershoots");
        }
    }

    // ── swap_out ──────────────────────────────────────────────────────────

    #[test]
    fn swap_out_matches_the_constant_product_formula() {
        // out = reserve_out * amount_in / (reserve_in + amount_in)
        //     = 1_000e6 * 1e6 / (1_000e6 + 1e6) = 999_000 (floored)
        let out = swap_out(1_000_000_000, 1_000_000_000, 1_000_000).unwrap();
        assert_eq!(out, 999_000);
    }

    #[test]
    fn swap_out_rounds_down_in_the_pool_s_favour() {
        // Exact quotient is 90.909…; a swapper must never receive the 91st unit.
        let out = swap_out(1_000, 1_000, 100).unwrap();
        assert_eq!(out, 90);
    }

    #[test]
    fn swap_out_can_never_drain_the_pool() {
        // ☢️ The invariant the whole AMM rests on: out is strictly less than reserve_out for
        // *any* input, so no single swap can empty a side. `out <= ro` in the guard is
        // therefore belt-and-braces — this proves the belt holds on its own.
        for amount_in in [1_000u64, 1_000_000, u64::MAX / 2, u64::MAX] {
            let out = swap_out(1_000_000, 1_000_000, amount_in).unwrap();
            assert!(
                out < 1_000_000,
                "amount_in {amount_in} drained the pool: out = {out}"
            );
        }
    }

    #[test]
    fn swap_out_never_overflows_at_the_u64_ceiling() {
        // reserve_out * amount_in peaks at (2^64-1)^2 < u128::MAX, so `checked_mul` can never
        // fire. Worth pinning: if either side ever widens, this test is what notices.
        let out = swap_out(u64::MAX, u64::MAX, u64::MAX).unwrap();
        assert!(out < u64::MAX);
    }

    #[test]
    fn swap_out_price_impact_is_monotonic() {
        // Twice the input must never yield twice the output — that is the slippage.
        let small = swap_out(1_000_000, 1_000_000, 1_000).unwrap();
        let large = swap_out(1_000_000, 1_000_000, 2_000).unwrap();
        assert!(large > small);
        assert!(large < small * 2, "no price impact: {small} → {large}");
    }

    #[test]
    fn swap_out_refuses_an_empty_or_zero_trade() {
        assert_err!(
            swap_out(0, 1_000, 100),
            SoladromeError::InsufficientLiquidity
        );
        assert_err!(
            swap_out(1_000, 0, 100),
            SoladromeError::InsufficientLiquidity
        );
        assert_err!(swap_out(1_000, 1_000, 0), SoladromeError::InvalidAmount);
        // Dust against a deep pool rounds to zero out, which must be refused rather than
        // silently taking the input for nothing.
        assert_err!(
            swap_out(1_000_000_000_000, 1_000, 1),
            SoladromeError::InsufficientLiquidity
        );
    }

    // ── lp_for_deposit: first deposit ─────────────────────────────────────

    #[test]
    fn first_deposit_burns_the_minimum_liquidity() {
        let (lp, a, b) = lp_for_deposit(0, 0, 0, 1_000_000, 1_000_000).unwrap();
        assert_eq!(lp, 1_000_000 - MINIMUM_LIQUIDITY);
        assert_eq!((a, b), (1_000_000, 1_000_000));
    }

    #[test]
    fn first_deposit_is_the_geometric_mean_of_the_two_sides() {
        // isqrt(4e6 * 1e6) = 2e6 — an unbalanced first deposit prices itself at the mean,
        // not at either side.
        let (lp, _, _) = lp_for_deposit(0, 0, 0, 4_000_000, 1_000_000).unwrap();
        assert_eq!(lp, 2_000_000 - MINIMUM_LIQUIDITY);
    }

    #[test]
    fn first_deposit_refuses_a_dust_pool() {
        // ☢️ The inflation-attack guard. sqrt(a*b) must exceed MINIMUM_LIQUIDITY strictly:
        // at exactly 1_000 the subtraction would yield zero LP for a real deposit, handing
        // the pool to whoever donates next.
        assert_err!(
            lp_for_deposit(0, 0, 0, 1_000, 1_000),
            SoladromeError::ZeroLiquidity
        );
        assert_err!(
            lp_for_deposit(0, 0, 0, 500, 500),
            SoladromeError::ZeroLiquidity
        );
        // The threshold bites on the geometric mean, not on either side: 1_002 × 1_000 is
        // still isqrt 1_000 (1_001² = 1_002_001, one above the product) and is refused.
        assert_err!(
            lp_for_deposit(0, 0, 0, 1_002, 1_000),
            SoladromeError::ZeroLiquidity
        );
        // 1_001 × 1_002 clears 1_001² and is the first accepted deposit, worth 1 LP.
        let (lp, _, _) = lp_for_deposit(0, 0, 0, 1_001, 1_002).unwrap();
        assert_eq!(lp, 1);
    }

    #[test]
    fn deposit_refuses_a_zero_side() {
        assert_err!(
            lp_for_deposit(0, 0, 0, 0, 1_000_000),
            SoladromeError::ZeroLiquidity
        );
        assert_err!(
            lp_for_deposit(1_000, 1_000, 1_000, 1_000, 0),
            SoladromeError::ZeroLiquidity
        );
    }

    // ── lp_for_deposit: subsequent deposits ───────────────────────────────

    #[test]
    fn subsequent_deposit_rebalances_to_the_limiting_side() {
        // Pool is 1:1. Offering twice as much B as A must consume only the matching A-worth
        // of B and price the LP on A.
        let (lp, a, b) = lp_for_deposit(1_000_000, 1_000_000, 1_000_000, 100_000, 200_000).unwrap();
        assert_eq!(lp, 100_000);
        assert_eq!((a, b), (100_000, 100_000), "excess B must not be consumed");

        // Same in the other direction.
        let (lp, a, b) = lp_for_deposit(1_000_000, 1_000_000, 1_000_000, 200_000, 100_000).unwrap();
        assert_eq!(lp, 100_000);
        assert_eq!((a, b), (100_000, 100_000), "excess A must not be consumed");
    }

    #[test]
    fn subsequent_deposit_respects_a_skewed_pool_ratio() {
        // Pool holds 1 A for every 4 B. A depositor offering a 1:1 ratio is limited by B.
        let (lp, a, b) = lp_for_deposit(1_000_000, 4_000_000, 2_000_000, 500_000, 500_000).unwrap();
        // lp_a = 500_000 * 2e6 / 1e6 = 1_000_000 ; lp_b = 500_000 * 2e6 / 4e6 = 250_000 → B limits.
        assert_eq!(lp, 250_000);
        assert_eq!(b, 500_000);
        assert_eq!(a, 125_000, "A must be scaled down to the pool ratio");
    }

    #[test]
    fn subsequent_deposit_refuses_a_deposit_too_small_to_mint() {
        // A deposit that rounds to zero LP against a deep pool must revert, not silently
        // donate the tokens.
        assert_err!(
            lp_for_deposit(1_000_000_000_000, 1_000_000_000_000, 1_000, 1, 1),
            SoladromeError::ZeroLiquidity
        );
    }

    // ── tokens_for_lp ─────────────────────────────────────────────────────

    #[test]
    fn burning_all_lp_returns_the_whole_pool() {
        let (a, b) = tokens_for_lp(1_000_000, 4_000_000, 2_000_000, 2_000_000).unwrap();
        assert_eq!((a, b), (1_000_000, 4_000_000));
    }

    #[test]
    fn burning_half_the_lp_returns_half_of_each_side() {
        let (a, b) = tokens_for_lp(1_000_000, 4_000_000, 2_000_000, 1_000_000).unwrap();
        assert_eq!((a, b), (500_000, 2_000_000));
    }

    #[test]
    fn withdrawal_rounds_down_in_the_pool_s_favour() {
        // 100 * 2 / 3 = 66.67 — the LP must receive 66, with the remainder left behind for
        // the holders who stay.
        let (a, b) = tokens_for_lp(100, 100, 3, 2).unwrap();
        assert_eq!((a, b), (66, 66));
    }

    #[test]
    fn deposit_then_withdraw_never_creates_value() {
        // ☢️ Round-trip safety: the rounding must always favour the pool, never the LP.
        // A single round trip that returned more than it consumed would be a free mint.
        let (reserve_a, reserve_b, total_lp) = (1_000_003u64, 4_000_007u64, 2_000_011u64);
        for (offer_a, offer_b) in [(1u64, 1u64), (999, 1_001), (123_457, 987_659)] {
            let Ok((lp, used_a, used_b)) =
                lp_for_deposit(reserve_a, reserve_b, total_lp, offer_a, offer_b)
            else {
                continue; // too small to mint; covered elsewhere
            };
            let (back_a, back_b) =
                tokens_for_lp(reserve_a + used_a, reserve_b + used_b, total_lp + lp, lp).unwrap();
            assert!(
                back_a <= used_a && back_b <= used_b,
                "round trip created value: put in ({used_a}, {used_b}), got back ({back_a}, {back_b})"
            );
        }
    }

    #[test]
    fn tokens_for_lp_refuses_impossible_burns() {
        assert_err!(
            tokens_for_lp(1_000, 1_000, 0, 100),
            SoladromeError::InsufficientLiquidity
        );
        assert_err!(
            tokens_for_lp(1_000, 1_000, 1_000, 0),
            SoladromeError::InvalidAmount
        );
        // Burning more LP than exists would over-withdraw the reserves.
        assert_err!(
            tokens_for_lp(1_000, 1_000, 1_000, 1_001),
            SoladromeError::InvalidAmount
        );
    }

    #[test]
    fn tokens_for_lp_refuses_a_burn_that_returns_nothing_on_one_side() {
        // A pool skewed far enough that a small burn rounds one side to zero must revert
        // rather than burn LP for a single-sided payout.
        assert_err!(
            tokens_for_lp(1, 1_000_000, 1_000_000, 1),
            SoladromeError::ZeroLiquidity
        );
    }

    // ── split_fee ─────────────────────────────────────────────────────────

    #[test]
    fn split_fee_is_the_arithmetic_quote_swap_always_used() {
        // 30 bps of 1_000_000 = 3_000 ; 20 % of that to the protocol = 600.
        assert_eq!(split_fee(1_000_000, 30, 2_000), (3_000, 600, 997_000));
        // Both divisions floor: 333 * 30 / 10_000 = 0.999 → no fee at all on dust.
        assert_eq!(split_fee(333, 30, 2_000), (0, 0, 333));
        // The ceiling a pool may be created with (10 %) never takes more than the input.
        assert_eq!(
            split_fee(u64::MAX, 1_000, 5_000).2,
            u64::MAX - u64::MAX / 10
        );
    }

    // ── zap_in ────────────────────────────────────────────────────────────

    /// The manual path the zap replaces: swap `s`, then offer both sides to `lp_for_deposit`.
    /// Returns (lp, used_in, used_out, out), or None when that path could not mint.
    fn by_hand(
        (ri, ro, tl): (u64, u64, u64),
        amount: u64,
        s: u64,
        fee: u16,
        proto: u16,
        route: bool,
    ) -> Option<(u64, u64, u64, u64)> {
        let (_, fp, net) = split_fee(s, fee, proto);
        let out = swap_out(ri, ro, net).ok()?;
        let routed = if route { fp } else { 0 };
        let (lp, ui, uo) = lp_for_deposit(ri + s - routed, ro - out, tl, amount - s, out).ok()?;
        Some((lp, ui, uo, out))
    }

    const POOLS: [(u64, u64, u64); 5] = [
        (1_000_000_000_000, 1_000_000_000_000, 1_000_000_000_000), // 1M / 1M, 6 decimals
        (7_382_195_931, 7_369_411_894, 7_371_055_776),             // devnet SOLA/USDC, 22/09
        (50_000_000_000, 7_500_000_000_000, 600_000_000_000),      // skewed 1 : 150
        (2_000_000_000_000_000, 300_000_000_000, 24_000_000_000_000), // wSOL 9 dec vs USDC
        (1_001_000, 1_002_000, 1_001_000),                         // a barely-seeded pool
    ];

    #[test]
    fn zap_mints_exactly_what_swapping_then_adding_by_hand_would() {
        for pool in POOLS {
            for amount in [pool.0 / 10_000, pool.0 / 100, pool.0 / 7] {
                for route in [false, true] {
                    let Ok(q) = zap_in(pool.0, pool.1, pool.2, amount, 30, 2_000, route) else {
                        continue;
                    };
                    let (lp, _, _, out) =
                        by_hand(pool, amount, q.swap_in, 30, 2_000, route).unwrap();
                    assert_eq!(q.lp_out, lp, "pool {pool:?} amount {amount}");
                    assert_eq!(q.swap_out, out);
                    let (_, fp, _) = split_fee(q.swap_in, 30, 2_000);
                    assert_eq!(q.fee_routed, if route { fp } else { 0 });
                    assert_eq!(q.reserve_in_delta, amount - q.fee_routed);
                }
            }
        }
    }

    #[test]
    fn zap_picks_the_swap_size_that_mints_the_most() {
        // The bisection must land on the integer optimum, not merely near it. Check every size
        // in a window around it, and a coarse sweep of the whole range for a second peak.
        for pool in POOLS {
            let amount = pool.0 / 100;
            let q = zap_in(pool.0, pool.1, pool.2, amount, 30, 2_000, false).unwrap();
            let lo = q.swap_in.saturating_sub(200);
            let hi = (q.swap_in + 200).min(amount - 1);
            let sweep = (1..100).map(|i| amount / 100 * i);
            for s in (lo..=hi).chain(sweep) {
                if let Some((lp, ..)) = by_hand(pool, amount, s, 30, 2_000, false) {
                    assert!(
                        lp <= q.lp_out,
                        "pool {pool:?}: swapping {s} mints {lp} > zap's {} at {}",
                        q.lp_out,
                        q.swap_in
                    );
                }
            }
        }
    }

    #[test]
    fn zap_is_optimal_on_random_pools_too() {
        // The five hand-picked pools above never exercise the case where the bisection's upper
        // neighbour beats its lower one — removing that comparison survived them. Random pools
        // do exercise it. Deterministic xorshift, so a failure reproduces.
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        for _ in 0..20_000 {
            let ri = 1_000 + next() % 1_000_000_000;
            let ro = 1_000 + next() % 1_000_000_000;
            let tl = 1_000 + next() % 1_000_000_000;
            let amount = 1 + next() % (ri / 2 + 1);
            let Ok(q) = zap_in(ri, ro, tl, amount, 30, 2_000, false) else {
                continue;
            };
            let lo = q.swap_in.saturating_sub(3);
            let hi = (q.swap_in + 3).min(amount - 1);
            for s in lo..=hi {
                if let Some((lp, ..)) = by_hand((ri, ro, tl), amount, s, 30, 2_000, false) {
                    assert!(
                        lp <= q.lp_out,
                        "({ri}, {ro}, {tl}) amount {amount}: swapping {s} mints {lp} > {}",
                        q.lp_out
                    );
                }
            }
        }
    }

    #[test]
    fn zap_never_dilutes_the_lps_already_in_the_pool() {
        // ☢️ The property that makes it safe to let a permissionless crank call this: the value
        // of one existing LP share — sqrt(k) / total_lp — can only grow. A zap that credited
        // even one unit too many would move value from every holder to the depositor.
        for pool in POOLS {
            for amount in [pool.0 / 10_000, pool.0 / 100, pool.0 / 3] {
                for route in [false, true] {
                    let Ok(q) = zap_in(pool.0, pool.1, pool.2, amount, 30, 2_000, route) else {
                        continue;
                    };
                    let (ri, ro, tl) = (pool.0 as f64, pool.1 as f64, pool.2 as f64);
                    let before = (ri * ro).sqrt() / tl;
                    let after =
                        ((ri + q.reserve_in_delta as f64) * ro).sqrt() / (tl + q.lp_out as f64);
                    assert!(
                        after >= before * (1.0 - 1e-12),
                        "pool {pool:?} amount {amount}: share value {before} → {after}"
                    );
                }
            }
        }
    }

    #[test]
    fn zap_then_exit_never_returns_more_than_went_in() {
        // The round trip anyone could actually execute: zap in, burn the LP straight back out,
        // sell the output side back to the pool for the input. Coming out ahead would be a mint
        // out of thin air.
        //
        // ⚠️ Valuing the burnt output side at the post-zap SPOT price instead is the tempting
        // shortcut, and it is wrong: the virtual swap pushed that price up, so the depositor
        // bought the output below the mark and the mark then flatters them — by about 0.1 % on a
        // 1 % deposit. The manual swap-then-add path lands in the identical state and would
        // "fail" the same way. Only a realisable exit measures value.
        for pool in POOLS {
            for amount in [pool.0 / 10_000, pool.0 / 100, pool.0 / 3] {
                for route in [false, true] {
                    let Ok(q) = zap_in(pool.0, pool.1, pool.2, amount, 30, 2_000, route) else {
                        continue;
                    };
                    let (r_in, r_out, tl) =
                        (pool.0 + q.reserve_in_delta, pool.1, pool.2 + q.lp_out);
                    let (a, b) = tokens_for_lp(r_in, r_out, tl, q.lp_out).unwrap();
                    let (_, _, net) = split_fee(b, 30, 2_000);
                    let back = swap_out(r_out - b, r_in - a, net).unwrap_or(0);
                    assert!(
                        a as u128 + back as u128 <= amount as u128,
                        "pool {pool:?}: put in {amount}, got back {} + {back}",
                        a
                    );
                }
            }
        }
    }

    #[test]
    fn zap_donates_only_rounding_dust() {
        // What the manual path would hand back to the user stays in the vault instead. It must
        // be rounding, not a slice of the deposit: at most a millionth of it, plus a few units.
        for pool in POOLS {
            let amount = pool.0 / 100;
            let q = zap_in(pool.0, pool.1, pool.2, amount, 30, 2_000, false).unwrap();
            let (_, used_in, used_out, out) =
                by_hand(pool, amount, q.swap_in, 30, 2_000, false).unwrap();
            let left_in = amount - q.swap_in - used_in;
            let left_out = out - used_out;
            let left_out_in_input = left_out as u128 * pool.0 as u128 / pool.1 as u128;
            let donated = left_in as u128 + left_out_in_input;
            assert!(
                donated <= amount as u128 / 1_000_000 + 3,
                "pool {pool:?}: {donated} of {amount} donated"
            );
        }
    }

    #[test]
    fn zap_does_not_overflow_at_nine_decimals() {
        // The case the closed-form sqrt could not survive: a million wSOL (1e15 base units)
        // against a billion USDC, and a reserve near the u64 ceiling.
        let q = zap_in(
            1_000_000_000_000_000,
            1_000_000_000_000_000,
            1_000_000_000_000_000,
            10_000_000_000_000,
            30,
            2_000,
            true,
        )
        .unwrap();
        assert!(q.lp_out > 0);
        let q = zap_in(
            u64::MAX / 4,
            u64::MAX / 4,
            u64::MAX / 4,
            u64::MAX / 1_000,
            30,
            2_000,
            true,
        )
        .unwrap();
        assert!(q.lp_out > 0);
    }

    #[test]
    fn zap_refuses_what_it_cannot_price() {
        // No first deposit through a zap: one side alone cannot set a pool's price.
        assert_err!(
            zap_in(0, 0, 0, 1_000_000, 30, 2_000, false),
            SoladromeError::InsufficientLiquidity
        );
        assert_err!(
            zap_in(1_000_000, 1_000_000, 0, 1_000, 30, 2_000, false),
            SoladromeError::InsufficientLiquidity
        );
        assert_err!(
            zap_in(1_000_000, 1_000_000, 1_000_000, 0, 30, 2_000, false),
            SoladromeError::InvalidAmount
        );
        // Dust that cannot mint a single LP unit is refused, not silently donated.
        assert_err!(
            zap_in(
                1_000_000_000_000,
                1_000_000_000_000,
                1_000,
                1,
                30,
                2_000,
                false
            ),
            SoladromeError::ZeroLiquidity
        );
    }
}
