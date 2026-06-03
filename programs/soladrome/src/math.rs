// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Christophe Hertecant

use crate::errors::SoladromeError;
use crate::state::{MAX_LOCK_DURATION, MAX_VE_MULTIPLIER, PRECISION};
use anchor_lang::prelude::*;

/// SOLA out when buying with `usdc_in`.
/// Curve: (vU + usdc_in) * (vS - sola_out) = K
/// Both USDC and SOLA use 6 decimals → floor = 1:1 in base units.
pub fn sola_out(virtual_usdc: u64, virtual_sola: u64, k: u128, usdc_in: u64) -> Result<u64> {
    require!(usdc_in > 0, SoladromeError::InvalidAmount);
    let new_vu = (virtual_usdc as u128)
        .checked_add(usdc_in as u128)
        .ok_or(SoladromeError::Overflow)?;
    let new_vs = k.checked_div(new_vu).ok_or(SoladromeError::Overflow)?;
    let out = (virtual_sola as u128)
        .checked_sub(new_vs)
        .ok_or(SoladromeError::Overflow)?;
    if out > u64::MAX as u128 {
        return Err(error!(SoladromeError::Overflow));
    }
    Ok(out as u64)
}

/// Advance the global fee accumulator with any new fees in market_vault.
/// Returns updated fees_per_hi_sola.
pub fn advance_accumulator(
    fees_per_hi_sola: u128,
    market_vault_balance: u64,
    last_market_vault_balance: u64,
    total_hi_sola: u64,
) -> u128 {
    if market_vault_balance <= last_market_vault_balance || total_hi_sola == 0 {
        return fees_per_hi_sola;
    }
    let new_fees = market_vault_balance.saturating_sub(last_market_vault_balance) as u128;
    // M-09 NOTE: new_fees ≤ u64::MAX ≈ 1.8e19; PRECISION = 1e12.
    // new_fees * PRECISION ≤ 1.8e31 << u128::MAX ≈ 3.4e38 → multiplication
    // cannot overflow u128 in practice. saturating_mul is kept as a compile-time
    // guarantee; saturating_add on fees_per_hi_sola is similarly safe given that
    // the accumulator only resets to u128::MAX at astronomically high fee volumes.
    fees_per_hi_sola.saturating_add(new_fees.saturating_mul(PRECISION) / total_hi_sola as u128)
}

/// Pending claimable USDC for a user (rounded down).
pub fn pending_fees(fees_per_hi_sola: u128, fees_debt: u128, hi_sola_balance: u64) -> u64 {
    let delta = fees_per_hi_sola.saturating_sub(fees_debt);
    ((delta * hi_sola_balance as u128) / PRECISION) as u64
}

/// Epoch oSOLA emission after applying exponential decay.
///
/// Formula : emission = initial × (decay_bps / 10_000) ^ elapsed
/// Floor   : max(emission, initial × floor_bps / 10_000)
///
/// Uses fixed-point exponentiation-by-squaring (O(log elapsed)) so it stays
/// within compute budget even after hundreds of epochs.
///
/// Special cases:
/// - elapsed = 0       → initial (no decay yet)
/// - decay_bps = 10_000 → initial forever (identity, no decay configured)
pub fn decayed_emission(
    initial: u64,
    decay_bps: u16,  // e.g. 9_900 = 99 % = −1 % per epoch
    elapsed: u64,    // epochs since osola_emission_start_epoch
    floor_bps: u16,  // e.g. 1_000 = 10 % of initial as minimum
) -> u64 {
    if elapsed == 0 || decay_bps >= 10_000 {
        return initial;
    }

    // Fixed-point precision: PREC = 1e12.
    // base = decay_bps / 10_000  expressed as a fixed-point integer.
    // PREC / 10_000 = 1e8, so base = decay_bps × 1e8.
    // Maximum intermediate: base^2 / PREC ≤ (1e12)^2 / 1e12 = 1e12 — fits u128.
    const PREC: u128 = 1_000_000_000_000;
    let base: u128 = (decay_bps as u128).saturating_mul(PREC / 10_000);

    let mut result: u128 = PREC; // 1.0
    let mut b: u128 = base;
    let mut n: u64 = elapsed;

    while n > 0 {
        if n & 1 == 1 {
            result = result.saturating_mul(b) / PREC;
        }
        b = b.saturating_mul(b) / PREC;
        n >>= 1;
    }

    let decayed = ((initial as u128).saturating_mul(result) / PREC) as u64;
    let floor = ((initial as u128).saturating_mul(floor_bps as u128) / 10_000) as u64;
    decayed.max(floor)
}

/// Ve voting power for a lock position at `current_ts`.
/// Decays linearly from `amount_locked × MAX_VE_MULTIPLIER` at full lock to 0 at expiry.
/// Returns 0 if the lock is expired or empty.
pub fn ve_power(amount_locked: u64, lock_end_ts: i64, current_ts: i64) -> u64 {
    if amount_locked == 0 || current_ts >= lock_end_ts {
        return 0;
    }
    let remaining = (lock_end_ts - current_ts) as u64;
    // power = amount * remaining * MAX_MULTIPLIER / MAX_DURATION  (saturating u128 muldiv)
    ((amount_locked as u128)
        .saturating_mul(remaining as u128)
        .saturating_mul(MAX_VE_MULTIPLIER as u128)
        / MAX_LOCK_DURATION as u128) as u64
}
