// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Christophe Hertecant

use anchor_lang::prelude::*;
use crate::errors::SoladromeError;

pub const MINIMUM_LIQUIDITY: u64 = 1_000;

/// Integer square root (floor) using Newton-Raphson, no floating point.
pub fn isqrt(n: u128) -> u64 {
    if n == 0 { return 0; }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x as u64
}

/// Amount out for a volatile xy=k swap, after fees have been deducted from amount_in.
/// amount_in_net = amount_in - total_fee (already deducted by caller)
pub fn swap_out(reserve_in: u64, reserve_out: u64, amount_in_net: u64) -> Result<u64> {
    require!(reserve_in > 0 && reserve_out > 0, SoladromeError::InsufficientLiquidity);
    require!(amount_in_net > 0, SoladromeError::InvalidAmount);

    let ri = reserve_in as u128;
    let ro = reserve_out as u128;
    let ai = amount_in_net as u128;

    // out = reserve_out * amount_in_net / (reserve_in + amount_in_net)
    let numerator   = ro.checked_mul(ai).ok_or(SoladromeError::Overflow)?;
    let denominator = ri.checked_add(ai).ok_or(SoladromeError::Overflow)?;
    let out = numerator.checked_div(denominator).ok_or(SoladromeError::Overflow)?;

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
    total_lp:  u64,
    amount_a:  u64,
    amount_b:  u64,
) -> Result<(u64, u64, u64)> {
    require!(amount_a > 0 && amount_b > 0, SoladromeError::ZeroLiquidity);

    if total_lp == 0 {
        // First deposit
        let lp_raw = isqrt((amount_a as u128).checked_mul(amount_b as u128).ok_or(SoladromeError::Overflow)?);
        require!(lp_raw > MINIMUM_LIQUIDITY, SoladromeError::ZeroLiquidity);
        let lp_out = lp_raw - MINIMUM_LIQUIDITY;
        Ok((lp_out, amount_a, amount_b))
    } else {
        // Subsequent deposit — proportional
        let ra = reserve_a as u128;
        let rb = reserve_b as u128;
        let tl = total_lp  as u128;
        let aa = amount_a  as u128;
        let ab = amount_b  as u128;

        // lp if we use all of A: lp_a = amount_a * total_lp / reserve_a
        // lp if we use all of B: lp_b = amount_b * total_lp / reserve_b
        let lp_a = aa.checked_mul(tl).ok_or(SoladromeError::Overflow)?
                     .checked_div(ra).ok_or(SoladromeError::Overflow)?;
        let lp_b = ab.checked_mul(tl).ok_or(SoladromeError::Overflow)?
                     .checked_div(rb).ok_or(SoladromeError::Overflow)?;

        let (lp_out, actual_a, actual_b) = if lp_a <= lp_b {
            // A is the limiting side; compute optimal B
            let optimal_b = lp_a.checked_mul(rb).ok_or(SoladromeError::Overflow)?
                                 .checked_div(tl).ok_or(SoladromeError::Overflow)?;
            (lp_a, aa, optimal_b)
        } else {
            // B is the limiting side; compute optimal A
            let optimal_a = lp_b.checked_mul(ra).ok_or(SoladromeError::Overflow)?
                                 .checked_div(tl).ok_or(SoladromeError::Overflow)?;
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
    total_lp:  u64,
    lp_amount: u64,
) -> Result<(u64, u64)> {
    require!(total_lp > 0, SoladromeError::InsufficientLiquidity);
    require!(lp_amount > 0 && lp_amount <= total_lp, SoladromeError::InvalidAmount);

    let ra = reserve_a as u128;
    let rb = reserve_b as u128;
    let tl = total_lp  as u128;
    let lp = lp_amount as u128;

    let a = ra.checked_mul(lp).ok_or(SoladromeError::Overflow)?
              .checked_div(tl).ok_or(SoladromeError::Overflow)?;
    let b = rb.checked_mul(lp).ok_or(SoladromeError::Overflow)?
              .checked_div(tl).ok_or(SoladromeError::Overflow)?;

    require!(a > 0 && b > 0, SoladromeError::ZeroLiquidity);
    Ok((a as u64, b as u64))
}
