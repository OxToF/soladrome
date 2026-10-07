// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs

use crate::constants::{EPOCH_DURATION, MAX_LOCK_DURATION, MAX_VE_MULTIPLIER, PRECISION};
use crate::errors::SoladromeError;
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

/// A purchase on the curve, split three ways.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurveBuy {
    /// To `market_vault`: the stakers' fee, taken before the curve prices anything.
    pub fee: u64,
    /// SOLA minted. Also the USDC that goes to `floor_vault`, 1 per SOLA.
    pub sola_out: u64,
    /// To the market reserve: what the buyer paid above the floor, owed back to sellers.
    pub premium: u64,
    /// The curve after the trade.
    pub new_vu: u64,
    pub new_vs: u64,
}

/// Price a purchase of `usdc_in`: the fee first, then the rest through the curve.
///
/// `premium` moves `vu + vs` by exactly its own amount (Δvu = net, Δvs = −sola_out), which is what
/// keeps the market reserve equal to `reserve_required` without any rounding drift.
pub fn curve_buy(vu: u64, vs: u64, k: u128, usdc_in: u64, fee_bps: u64) -> Result<CurveBuy> {
    let fee = ((usdc_in as u128) * (fee_bps as u128) / 10_000) as u64;
    let net = usdc_in.checked_sub(fee).ok_or(SoladromeError::Overflow)?;
    let sola_out = sola_out(vu, vs, k, net)?;
    // The curve never prices SOLA below the floor: `vs` only falls below its start through buys,
    // so the average price of any purchase is at least 1 and `net >= sola_out`.
    let premium = net.checked_sub(sola_out).ok_or(SoladromeError::Overflow)?;
    Ok(CurveBuy {
        fee,
        sola_out,
        premium,
        new_vu: vu.checked_add(net).ok_or(SoladromeError::Overflow)?,
        new_vs: vs.checked_sub(sola_out).ok_or(SoladromeError::Overflow)?,
    })
}

/// A sale back to the protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurveSell {
    /// From `floor_vault`, 1 per SOLA sold — on the curve or below it.
    pub from_floor: u64,
    /// From the market reserve to the seller: the premium of the curve part, less the fee.
    pub from_reserve: u64,
    /// From the market reserve to `market_vault`.
    pub fee: u64,
    /// SOLA sold back down the curve; the rest of the sale is redeemed at the floor.
    pub on_curve: u64,
    pub new_vu: u64,
    pub new_vs: u64,
}

impl CurveSell {
    /// What the seller receives in all.
    pub fn usdc_out(&self) -> u64 {
        self.from_floor.saturating_add(self.from_reserve)
    }
    /// What leaves the market reserve in all (seller's share and fee).
    pub fn reserve_out(&self) -> u64 {
        self.from_reserve.saturating_add(self.fee)
    }
}

/// Price a sale of `sola_amount` back to the protocol, the exact mirror of `curve_buy`.
///
/// The SOLA goes back down the curve while the curve is above its starting point (`vs < init_vs`,
/// i.e. price above 1): the seller gets the curve's price, 1 of it from the floor and the rest —
/// the premium earlier buyers paid — from the market reserve. Whatever is left once the curve is
/// back at its start is redeemed at the floor, 1:1, as before.
///
/// ☢️ The fee is charged on the curve proceeds but capped at the premium: near the bottom of the
/// curve 1 % of the proceeds exceeds the premium, and charging it would pay a SOLA less than the
/// floor — the one promise this protocol makes. The floor part is never charged.
///
/// Rounding: `vs` rounds down on a buy (`sola_out`) and the new `vu` rounds UP here, so a sale
/// never extracts more than the curve holds. If that rounding leaves the curve proceeds a unit
/// short of the SOLA sold at the very bottom, they are lifted to it (premium 0): the seller still
/// gets the floor, and `vu + vs` still moves by exactly −premium.
pub fn curve_sell(
    vu: u64,
    vs: u64,
    k: u128,
    init_vs: u64,
    sola_amount: u64,
    fee_bps: u64,
) -> Result<CurveSell> {
    require!(sola_amount > 0, SoladromeError::InvalidAmount);
    let on_curve = sola_amount.min(init_vs.saturating_sub(vs));
    let (proceeds, new_vu, new_vs) = if on_curve == 0 {
        (0u64, vu, vs)
    } else {
        let new_vs = vs.checked_add(on_curve).ok_or(SoladromeError::Overflow)?;
        let vu_after = k
            .checked_add(new_vs as u128 - 1)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(new_vs as u128)
            .ok_or(SoladromeError::Overflow)?; // ceil(k / new_vs)
        let raw = (vu as u128).saturating_sub(vu_after) as u64;
        let proceeds = raw.max(on_curve);
        let new_vu = vu.checked_sub(proceeds).ok_or(SoladromeError::Overflow)?;
        (proceeds, new_vu, new_vs)
    };
    let premium = proceeds - on_curve.min(proceeds);
    let fee = (((proceeds as u128) * (fee_bps as u128) / 10_000) as u64).min(premium);
    Ok(CurveSell {
        from_floor: sola_amount,
        from_reserve: premium - fee,
        fee,
        on_curve,
        new_vu,
        new_vs,
    })
}

/// What the market reserve must hold for the curve to be sold all the way back to its start:
/// `vu + vs − (init_vu + init_vs)`, every premium paid and not yet returned. Never negative in
/// practice; floored at 0 against the unit of rounding at the bottom.
pub fn reserve_required(vu: u64, vs: u64, init_vu: u64, init_vs: u64) -> u64 {
    ((vu as u128 + vs as u128).saturating_sub(init_vu as u128 + init_vs as u128)) as u64
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

/// Fee basis for a staker: the financed part of their hiSOLA position.
///
/// WHY THE MINIMUM. Fees are paid to stake that financed the floor. `staked_amount` is
/// written only by `stake_sola`, so it counts exactly the hiSOLA bought through the curve;
/// `hi_sola` also carries the unfinanced supply that `unlock_hi_sola` releases from an
/// expired ve lock (partner bribe-earned tranches — nobody ever paid USDC into the floor for
/// those). The minimum pays on the overlap and nothing else.
///
/// Historical note: under the token model this minimum did double duty, since hiSOLA was a
/// transferable SPL token with no freeze authority and a balance could land in a wallet whose
/// `fees_debt` baseline was older than the tokens themselves — a position stamped at 0 was
/// measured claiming 5 576 222 718 496 against a `market_vault` of 385 829 347 023, fourteen
/// times the vault. Non-transferability removes that half of the job; the financed/unfinanced
/// half remains, and is why the minimum stays.
///
/// Voting no longer enters this calculation at all: a vote immobilises the balance
/// (`vote_locked`) without moving it, so there is nothing to add back.
pub fn fee_basis(staked_amount: u64, hi_sola: u64, fee_shares: u64) -> u64 {
    // `min` is the financed-stake rule: fees follow USDC that actually reached the floor, so
    // hiSOLA released by an expired ve lock cannot collect on a deposit it never made.
    //
    // `fee_shares` is the deliberate exception, and it is added rather than min-ed because it
    // is not a balance at all — it is hiSOLA locked for life that the protocol has decided
    // earns fees anyway. A contributor who funds an audit paid in a currency the floor never
    // saw; refusing them the yield their bag generates would make the bag worthless as
    // compensation, which is what it is for. See `claim_contributor_hi_sola`.
    staked_amount.min(hi_sola).saturating_add(fee_shares)
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
    decay_bps: u16, // e.g. 9_900 = 99 % = −1 % per epoch
    elapsed: u64,   // epochs since osola_emission_start_epoch
    floor_bps: u16, // e.g. 1_000 = 10 % of initial as minimum
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
    // Clamp to u64::MAX instead of truncating: a `as u64` cast on an out-of-range
    // u128 would silently wrap and *understate* a whale's voting power. Saturating
    // is defense-in-depth; the bonding curve makes such a balance unreachable today.
    ((amount_locked as u128)
        .saturating_mul(remaining as u128)
        .saturating_mul(MAX_VE_MULTIPLIER as u128)
        / MAX_LOCK_DURATION as u128)
        .min(u64::MAX as u128) as u64
}

// ── Epochs ────────────────────────────────────────────────────────────────

pub fn current_epoch(unix_ts: i64) -> u64 {
    (unix_ts.max(0) as u64) / EPOCH_DURATION
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assert_err;
    use crate::constants::{INIT_VIRTUAL_SOLA, INIT_VIRTUAL_USDC};

    /// `k` as `initialize` writes it: INIT_VIRTUAL_USDC × INIT_VIRTUAL_SOLA, set once and never
    /// recomputed. Every curve test below prices against this exact number.
    fn init_k() -> u128 {
        (INIT_VIRTUAL_USDC as u128) * (INIT_VIRTUAL_SOLA as u128)
    }

    // ── sola_out ──────────────────────────────────────────────────────────

    #[test]
    fn the_curve_opens_at_exactly_one_sola_per_usdc() {
        // ☢️ The invariant that makes the floor meaningful: start price == floor price == 1:1
        // in base units. It holds only while INIT_VIRTUAL_USDC == INIT_VIRTUAL_SOLA, which is
        // why that equality is a stated constraint and not a coincidence.
        assert_eq!(
            INIT_VIRTUAL_USDC, INIT_VIRTUAL_SOLA,
            "the curve's two virtual sides must be seeded equal"
        );
        let out = sola_out(INIT_VIRTUAL_USDC, INIT_VIRTUAL_SOLA, init_k(), 1_000_000).unwrap();
        assert_eq!(out, 1_000_000, "1 USDC must buy exactly 1 SOLA at genesis");
    }

    #[test]
    fn each_purchase_raises_the_price_for_the_next() {
        let k = init_k();
        let (mut vu, mut vs) = (INIT_VIRTUAL_USDC, INIT_VIRTUAL_SOLA);
        let mut previous = u64::MAX;

        for _ in 0..5 {
            let out = sola_out(vu, vs, k, 1_000_000).unwrap();
            assert!(
                out < previous,
                "an identical buy returned {out}, not less than the previous {previous}"
            );
            previous = out;
            vu += 1_000_000;
            vs -= out;
        }
    }

    #[test]
    fn the_curve_can_never_mint_more_than_its_virtual_sola() {
        // Exercise mints outside the curve; the curve itself is bounded by INIT_VIRTUAL_SOLA.
        // A buy large enough to overflow that bound must clamp, not wrap.
        let out = sola_out(INIT_VIRTUAL_USDC, INIT_VIRTUAL_SOLA, init_k(), u64::MAX).unwrap();
        assert!(
            out < INIT_VIRTUAL_SOLA,
            "buy of u64::MAX emitted {out}, at or beyond the virtual side {INIT_VIRTUAL_SOLA}"
        );
    }

    #[test]
    fn sola_out_refuses_a_zero_buy() {
        assert_err!(
            sola_out(INIT_VIRTUAL_USDC, INIT_VIRTUAL_SOLA, init_k(), 0),
            SoladromeError::InvalidAmount
        );
    }

    // ── advance_accumulator ───────────────────────────────────────────────

    #[test]
    fn the_accumulator_does_not_divide_by_zero_before_anyone_stakes() {
        // ☢️ `total_hi_sola == 0` is the live state between `initialize` and the first
        // `stake_sola`. Fees arriving in that window must leave the accumulator untouched —
        // dividing here would abort every swap that routes a protocol fee.
        assert_eq!(advance_accumulator(0, 1_000_000, 0, 0), 0);
        assert_eq!(advance_accumulator(42, 1_000_000, 0, 0), 42);
    }

    #[test]
    fn the_accumulator_ignores_a_vault_that_has_not_grown() {
        assert_eq!(advance_accumulator(7, 1_000, 1_000, 500), 7, "flat balance");
        assert_eq!(
            advance_accumulator(7, 999, 1_000, 500),
            7,
            "a shrinking vault must not underflow"
        );
    }

    #[test]
    fn the_accumulator_credits_new_fees_pro_rata() {
        // 1 USDC of new fees over 1 SOLA of stake = PRECISION per unit.
        assert_eq!(
            advance_accumulator(0, 1_000_000, 0, 1_000_000),
            PRECISION,
            "one unit of fees per unit of stake must be exactly PRECISION"
        );
        // The accumulator is cumulative, not absolute.
        assert_eq!(
            advance_accumulator(PRECISION, 2_000_000, 1_000_000, 1_000_000),
            2 * PRECISION
        );
    }

    // ── fee_basis ─────────────────────────────────────────────────────────

    #[test]
    fn unfinanced_hi_sola_earns_no_fees() {
        // ☢️ The financed-stake rule. A holder whose hiSOLA came out of an expired ve lock
        // (partner bribe tranches: nobody ever paid USDC into the floor for them) has
        // staked_amount = 0, so their basis is 0 however large the balance.
        assert_eq!(fee_basis(0, 5_000_000, 0), 0);
        // Partly financed: fees follow the USDC that actually reached the floor, nothing more.
        assert_eq!(fee_basis(1_000, 5_000, 0), 1_000);
    }

    #[test]
    fn the_basis_never_exceeds_the_balance_actually_held() {
        // The other direction of the minimum: stake recorded but hiSOLA since spent down
        // (locked into ve, say) cannot keep collecting on what is gone.
        assert_eq!(fee_basis(5_000, 1_000, 0), 1_000);
    }

    #[test]
    fn fee_shares_are_added_on_top_and_not_capped_by_the_balance() {
        // ☢️ The deliberate exception: `fee_shares` is hiSOLA locked for life that the protocol
        // has decided earns anyway — a contributor paid in a currency the floor never saw.
        // It is *added*, never min-ed, or the bag would be worthless as compensation.
        assert_eq!(fee_basis(0, 0, 200), 200);
        assert_eq!(fee_basis(1_000, 5_000, 200), 1_200);
    }

    #[test]
    fn fee_basis_saturates_instead_of_wrapping() {
        assert_eq!(fee_basis(u64::MAX, u64::MAX, u64::MAX), u64::MAX);
    }

    // ── pending_fees ──────────────────────────────────────────────────────

    #[test]
    fn pending_fees_pays_the_delta_since_the_last_claim() {
        assert_eq!(pending_fees(PRECISION, 0, 1_000_000), 1_000_000);
        // Half the accrual already claimed → half the payout.
        assert_eq!(pending_fees(PRECISION, PRECISION / 2, 1_000_000), 500_000);
    }

    #[test]
    fn a_debt_ahead_of_the_accumulator_pays_zero_rather_than_underflowing() {
        // ☢️ `credit_fee_shares` moves `fees_debt` forward without touching the accumulator,
        // so a debt momentarily above it is a reachable state, not a corrupt one. Saturating
        // here is what keeps it a zero payout instead of a u128-sized one.
        assert_eq!(pending_fees(0, PRECISION, 1_000_000), 0);
        assert_eq!(pending_fees(PRECISION, u128::MAX, u64::MAX), 0);
    }

    #[test]
    fn pending_fees_rounds_down() {
        // Anything left by the rounding stays in the vault for the other stakers.
        assert_eq!(pending_fees(PRECISION + 1, 0, 1), 1);
        assert_eq!(pending_fees(PRECISION - 1, 0, 1), 0);
    }

    // ── decayed_emission ──────────────────────────────────────────────────

    #[test]
    fn emission_does_not_decay_before_the_first_epoch_elapses() {
        assert_eq!(decayed_emission(20_000, 9_900, 0, 2_500), 20_000);
    }

    #[test]
    fn a_decay_of_ten_thousand_bps_is_the_identity() {
        // 10_000 bps = 100% retained = no decay configured. Guards against a misread config
        // silently emitting the floor forever.
        assert_eq!(decayed_emission(20_000, 10_000, 500, 2_500), 20_000);
    }

    #[test]
    fn one_epoch_of_decay_is_one_percent() {
        assert_eq!(decayed_emission(20_000, 9_900, 1, 2_500), 19_800);
        assert_eq!(decayed_emission(20_000, 9_900, 2, 2_500), 19_602);
    }

    #[test]
    fn emission_settles_on_five_thousand_per_epoch_forever() {
        // ☢️ The number the protocol publishes in absolute terms — 5 000 oSOLA/epoch
        // steady-state — rather than as a bps ratio, because the ratio is a quotient of the
        // launch figure and goes silently wrong every time that figure moves.
        const INITIAL: u64 = 20_000;
        const DECAY: u16 = 9_900;
        const FLOOR_BPS: u16 = 2_500;
        const FLOOR: u64 = 5_000;

        assert!(
            decayed_emission(INITIAL, DECAY, 137, FLOOR_BPS) > FLOOR,
            "the floor must not bind before epoch 137"
        );
        assert_eq!(
            decayed_emission(INITIAL, DECAY, 138, FLOOR_BPS),
            FLOOR,
            "the published crossover is epoch 138 (~2.6 years)"
        );
        // And then it never moves again, however long the protocol runs.
        for elapsed in [200u64, 1_000, 10_000, u64::MAX] {
            assert_eq!(decayed_emission(INITIAL, DECAY, elapsed, FLOOR_BPS), FLOOR);
        }
    }

    #[test]
    fn emission_decay_is_monotonically_decreasing() {
        let mut previous = u64::MAX;
        for elapsed in 0..140u64 {
            let e = decayed_emission(20_000, 9_900, elapsed, 2_500);
            assert!(
                e <= previous,
                "emission rose at epoch {elapsed}: {previous} → {e}"
            );
            previous = e;
        }
    }

    #[test]
    fn a_zero_floor_lets_emission_reach_zero() {
        assert_eq!(decayed_emission(20_000, 9_900, u64::MAX, 0), 0);
        // A total decay collapses to the floor on the first epoch.
        assert_eq!(decayed_emission(20_000, 0, 1, 2_500), 5_000);
    }

    // ── ve_power ──────────────────────────────────────────────────────────

    #[test]
    fn a_full_length_lock_votes_at_the_maximum_multiplier() {
        let now = 1_700_000_000i64;
        let end = now + MAX_LOCK_DURATION as i64;
        assert_eq!(
            ve_power(1_000, end, now),
            1_000 * MAX_VE_MULTIPLIER,
            "a max-duration lock must vote at exactly {MAX_VE_MULTIPLIER}×"
        );
    }

    #[test]
    fn voting_power_decays_linearly_to_zero() {
        let now = 1_700_000_000i64;
        let full = now + MAX_LOCK_DURATION as i64;
        let half = now + (MAX_LOCK_DURATION / 2) as i64;
        assert_eq!(
            ve_power(1_000, half, now),
            2_000,
            "half the term, half the power"
        );
        assert!(ve_power(1_000, full, now) > ve_power(1_000, half, now));
    }

    #[test]
    fn an_expired_or_empty_lock_has_no_power() {
        let now = 1_700_000_000i64;
        assert_eq!(ve_power(1_000, now, now), 0, "expiry is exclusive");
        assert_eq!(ve_power(1_000, now - 1, now), 0);
        assert_eq!(ve_power(0, now + 1_000, now), 0);
    }

    #[test]
    fn an_impossible_whale_clamps_instead_of_wrapping() {
        // ☢️ `as u64` on an out-of-range u128 would wrap and *understate* the balance, which
        // is the dangerous direction: it hands a whale a cheap vote. Unreachable through the
        // bonding curve today; pinned because the cast is not.
        let now = 0i64;
        let end = MAX_LOCK_DURATION as i64;
        assert_eq!(ve_power(u64::MAX, end, now), u64::MAX);
    }

    // ── current_epoch ─────────────────────────────────────────────────────

    #[test]
    fn epochs_are_seven_day_buckets_from_the_unix_origin() {
        assert_eq!(EPOCH_DURATION, 604_800);
        assert_eq!(current_epoch(0), 0);
        assert_eq!(current_epoch(EPOCH_DURATION as i64 - 1), 0);
        assert_eq!(current_epoch(EPOCH_DURATION as i64), 1);
        assert_eq!(current_epoch(2 * EPOCH_DURATION as i64), 2);
    }

    #[test]
    fn a_negative_clock_reads_as_epoch_zero() {
        // ☢️ `unix_ts` comes from the sysvar as i64. Casting a negative straight to u64 would
        // produce an astronomically high epoch, past every `init` seed the program uses.
        assert_eq!(current_epoch(-1), 0);
        assert_eq!(current_epoch(i64::MIN), 0);
    }

    // ── curve_buy / curve_sell: the curve both ways (2026-10-07) ────────────

    const N: u64 = INIT_VIRTUAL_SOLA;
    const NU: u64 = INIT_VIRTUAL_USDC;
    const FEE: u64 = crate::constants::CURVE_FEE_BPS;

    #[test]
    fn a_buy_splits_into_fee_floor_and_premium_and_nothing_else() {
        let b = curve_buy(NU, N, init_k(), 100_000_000_000, FEE).unwrap(); // 100 000 USDC
        assert_eq!(b.fee, 1_000_000_000, "1 % before the curve");
        assert_eq!(b.fee + b.sola_out + b.premium, 100_000_000_000);
        assert!(b.premium > 0);
        assert_eq!(
            reserve_required(b.new_vu, b.new_vs, NU, N),
            b.premium,
            "the reserve owed is exactly the premium paid"
        );
    }

    #[test]
    fn selling_what_was_bought_returns_the_purchase_less_the_two_fees() {
        // The bug this replaces: a SOLA bought above 1 sold back for exactly 1.
        let usdc_in = 500_000_000_000; // 500 000 USDC, price ≈ 2.2
        let b = curve_buy(NU, N, init_k(), usdc_in, FEE).unwrap();
        let s = curve_sell(b.new_vu, b.new_vs, init_k(), N, b.sola_out, FEE).unwrap();
        assert_eq!(s.on_curve, b.sola_out, "all of it goes back down the curve");
        assert_eq!(s.from_floor, b.sola_out);
        let back = s.usdc_out() as f64 / usdc_in as f64;
        assert!(back > 0.979 && back < 0.981, "≈ 0.99 × 0.99, got {back}");
        // Average price of this purchase ≈ 1.49 (2.2 is the marginal price at the top).
        assert!(
            s.usdc_out() > b.sola_out * 14 / 10,
            "far above the floor, not 1 per SOLA"
        );
        assert_eq!(
            s.reserve_out(),
            b.premium,
            "the reserve pays back exactly what it took"
        );
        assert_eq!(
            (s.new_vu, s.new_vs),
            (NU, N),
            "the curve is back at its start"
        );
    }

    #[test]
    fn a_sale_past_the_bottom_of_the_curve_is_redeemed_at_the_floor() {
        let b = curve_buy(NU, N, init_k(), 10_000_000_000, FEE).unwrap();
        let extra = 5_000_000_000; // exercised SOLA, never bought on the curve
        let s = curve_sell(b.new_vu, b.new_vs, init_k(), N, b.sola_out + extra, FEE).unwrap();
        assert_eq!(s.on_curve, b.sola_out);
        assert_eq!(
            s.from_floor,
            b.sola_out + extra,
            "1 per SOLA from the floor, curve or not"
        );
        assert_eq!(s.new_vs, N, "never below the start");
        assert_eq!(s.reserve_out(), b.premium);
    }

    #[test]
    fn a_sale_at_the_bottom_pays_exactly_the_floor_and_no_fee() {
        let s = curve_sell(NU, N, init_k(), N, 1_000_000, FEE).unwrap();
        assert_eq!(
            (s.on_curve, s.from_floor, s.from_reserve, s.fee),
            (0, 1_000_000, 0, 0)
        );
    }

    #[test]
    fn the_fee_never_takes_a_sale_below_the_floor() {
        // Just above 1: 1 % of the proceeds would exceed the premium.
        let b = curve_buy(NU, N, init_k(), 1_000_000, FEE).unwrap(); // 1 USDC
        let s = curve_sell(b.new_vu, b.new_vs, init_k(), N, b.sola_out, FEE).unwrap();
        assert!(s.usdc_out() >= b.sola_out, "never less than 1 per SOLA");
        assert!(s.fee <= s.reserve_out());
    }

    #[test]
    fn many_round_trips_never_leave_the_reserve_short() {
        // The reserve moves by exactly ±premium and `vu + vs` by the same amount, every trade.
        let (mut vu, mut vs, mut reserve) = (NU, N, 0u64);
        for i in 1..200u64 {
            let b = curve_buy(vu, vs, init_k(), i * 7_919_000 + 13, FEE).unwrap();
            reserve += b.premium;
            vu = b.new_vu;
            vs = b.new_vs;
            let s = curve_sell(vu, vs, init_k(), N, b.sola_out / 3 + 1, FEE).unwrap();
            reserve -= s.reserve_out();
            vu = s.new_vu;
            vs = s.new_vs;
            assert!(
                reserve >= reserve_required(vu, vs, NU, N),
                "short at round {i}"
            );
        }
    }
}
