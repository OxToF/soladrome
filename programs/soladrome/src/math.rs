use crate::errors::SoladromeError;
use crate::state::PRECISION;
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
        .ok_or(SoladromeError::Overflow)? as u64;
    Ok(out)
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
    let new_fees = (market_vault_balance
        .checked_sub(last_market_vault_balance)
        .unwrap_or(0)) as u128;
    fees_per_hi_sola
        .saturating_add(new_fees.saturating_mul(PRECISION) / total_hi_sola as u128)
}

/// Pending claimable USDC for a user (rounded down).
pub fn pending_fees(fees_per_hi_sola: u128, fees_debt: u128, hi_sola_balance: u64) -> u64 {
    let delta = fees_per_hi_sola.saturating_sub(fees_debt);
    ((delta * hi_sola_balance as u128) / PRECISION) as u64
}
