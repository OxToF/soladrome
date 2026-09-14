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

/// Amount out for a volatile xy=k swap, after fees have been deducted from amount_in.
/// amount_in_net = amount_in - total_fee (already deducted by caller)
pub fn swap_out(reserve_in: u64, reserve_out: u64, amount_in_net: u64) -> Result<u64> {
    require!(
        reserve_in > 0 && reserve_out > 0,
        SoladromeError::InsufficientLiquidity
    );
    require!(amount_in_net > 0, SoladromeError::InvalidAmount);

    let ri = reserve_in as u128;
    let ro = reserve_out as u128;
    let ai = amount_in_net as u128;

    // out = reserve_out * amount_in_net / (reserve_in + amount_in_net)
    let numerator = ro.checked_mul(ai).ok_or(SoladromeError::Overflow)?;
    let denominator = ri.checked_add(ai).ok_or(SoladromeError::Overflow)?;
    let out = numerator
        .checked_div(denominator)
        .ok_or(SoladromeError::Overflow)?;

    require!(out > 0 && out <= ro, SoladromeError::InsufficientLiquidity);
    Ok(out as u64)
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
}
