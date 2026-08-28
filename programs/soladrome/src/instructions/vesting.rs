// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Founder, team, ecosystem and contributor allocations.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, Token, TokenAccount},
};

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::math;
use crate::state::*;

// One-time initialisation of founder vesting schedules.
// Does NOT mint any tokens — all minting is deferred to claim instructions.
// Protected by `founder_allocated` flag (callable once).
pub fn mint_founder_allocation(ctx: Context<MintFounderAllocation>) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.founder_allocated,
        SoladromeError::AlreadyAllocated
    );

    let clock = Clock::get()?;

    // ── hiSOLA progressive vesting (7M, cliff + linear) ─────────────────
    // Tokens are minted epoch-by-epoch via claim_founder_hi_sola.
    // Each claim mints SOLA to sola_vault + hiSOLA to founder simultaneously,
    // giving the protocol time to build floor_vault from user purchases.
    let hiv = &mut ctx.accounts.founder_hi_vesting;
    hiv.total_amount = FOUNDER_STAKE;
    hiv.claimed = 0;
    hiv.start_ts = clock.unix_timestamp;
    hiv.bump = ctx.bumps.founder_hi_vesting;

    // ── oSOLA progressive vesting (5M, cliff + linear) ──────────────────
    // Founder claims oSOLA linearly. To convert to USDC:
    //   exercise_o_sola (pay 1 USDC → floor_vault, mint 1 SOLA) → sell on AMM.
    // Each exercise is ADDITIVE to floor_vault (net positive for protocol).
    let ov = &mut ctx.accounts.founder_vesting;
    ov.total_amount = FOUNDER_LIQUID;
    ov.claimed = 0;
    ov.start_ts = clock.unix_timestamp;
    ov.bump = ctx.bumps.founder_vesting;

    ctx.accounts.protocol_state.founder_allocated = true;
    Ok(())
}

// One-time team allocation: 250 000 hiSOLA → TEAM_WALLET, locked for life, earning fees.
//
// ⚠️ The name is the last trace of what this used to be. It minted 2 M liquid SOLA into the
// authority's wallet for "marketing & airdrop" until 2026-07-17, which was the single
// largest floor-drain vector in the protocol; the ecosystem budget moved to oSOLA via
// `distribute_o_sola` and this header went on describing the version that was deleted. The
// body's own comment has contradicted it fifteen lines down ever since.
//
// Protected by `ecosystem_allocated`; entirely separate from the founder allocation.
pub fn mint_ecosystem_allocation(ctx: Context<MintEcosystemAllocation>) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(
        !ctx.accounts.protocol_state.ecosystem_allocated,
        SoladromeError::AlreadyAllocated
    );

    let bump = ctx.accounts.protocol_state.bump;
    let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

    // ── The 1.75M ecosystem budget is NOT minted here (changed 2026-07-17) ──
    // It used to be minted as liquid SOLA into the authority's ATA, which made it the
    // single largest floor-drain vector: 1.75M of supply never added to
    // `total_purchased_sola`, yet redeemable 1:1 against a floor funded by real buyers.
    // The budget is now issued as **oSOLA** via `distribute_o_sola`, capped by
    // ECOSYSTEM_TOTAL. Recipients pay 1 USDC into the floor to exercise, so every SOLA
    // that reaches circulation through this path is financed. Same as Beradrome (oBERO).

    // ── 250 000 → TEAM_WALLET, as hiSOLA locked FOR LIFE (never liquid SOLA) ──
    // Pays the people who worked unpaid until launch. Wallet balance stays 0 → borrow_usdc
    // is blind to it (the 20% cap is not sidesteppable), never liquid SOLA → sell_sola is
    // unreachable → it cannot drain the floor. permanent_amount covers the whole tranche,
    // so unlock_hi_sola can never release it. Unlike the 7M it DOES vote (up to 4×): the
    // vote guard keys on the founder wallet, and this is a distinct one.
    //
    // ☢️ And since 2026-08-27 it earns fees. It did not, for the same reason the
    // contributor bag did not: locked for life means `hi_sola` is 0, unfinanced means
    // `staked_amount` is 0, so `fee_basis` was 0 and could never become anything else.
    // A tranche whose whole purpose is to pay people paid them nothing — governance rights
    // and no yield. `fee_shares` fixes that, matched by an increment to `total_hi_sola`.
    let now_ts = Clock::get()?.unix_timestamp;
    let team_lock_end_ts = (now_ts as u64)
        .checked_add(MAX_LOCK_DURATION)
        .ok_or(SoladromeError::Overflow)? as i64;

    // Snapshot the accumulator before any hiSOLA supply change (stake_sola invariant).
    let market_balance = ctx.accounts.market_vault.amount;
    let acc = math::advance_accumulator(
        ctx.accounts.protocol_state.fees_per_hi_sola,
        market_balance,
        ctx.accounts.protocol_state.last_market_vault_balance,
        ctx.accounts.protocol_state.total_hi_sola,
    );

    // SOLA backing for the hiSOLA, locked in sola_vault.
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.sola_mint.to_account_info(),
                to: ctx.accounts.sola_vault.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[seeds],
        ),
        FOUNDER_IMMEDIATE_SOLA,
    )?;

    // The hiSOLA side is now purely the lock entry written below — there is no token to
    // mint and no vault to mint it into. The SOLA backing above is unchanged: it is a
    // real token and still goes to `sola_vault`.

    {
        let lock = &mut ctx.accounts.team_lock_position;
        lock.owner = ctx.accounts.team_wallet.key();
        lock.bump = ctx.bumps.team_lock_position;
        lock.amount_locked = lock
            .amount_locked
            .checked_add(FOUNDER_IMMEDIATE_SOLA)
            .ok_or(SoladromeError::Overflow)?;
        lock.lock_end_ts = team_lock_end_ts;
        // Locked for LIFE: the whole tranche is permanent, so the deferred drain
        // (unlock → unstake → sell_sola) is closed for good. Only borrow_against_locked
        // at 20% remains. Voting stays fully active (wallet ≠ FOUNDER_WALLET).
        lock.permanent_amount = FOUNDER_IMMEDIATE_SOLA;
    }

    // The tranche's fee share, with the accrual carried across — see
    // `UserPosition::credit_fee_shares`.
    {
        let pos = &mut ctx.accounts.team_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.team_wallet.key();
            pos.bump = ctx.bumps.team_position;
        }
        pos.credit_fee_shares(acc, FOUNDER_IMMEDIATE_SOLA)?;
    }

    let s = &mut ctx.accounts.protocol_state;
    s.fees_per_hi_sola = acc;
    s.last_market_vault_balance = market_balance;
    // The counterpart of the credit above: a real share of the fee stream, taken from the
    // existing holders in exactly the amount the team receives.
    s.total_hi_sola = s
        .total_hi_sola
        .checked_add(FOUNDER_IMMEDIATE_SOLA)
        .ok_or(SoladromeError::Overflow)?;
    s.total_sola = s
        .total_sola
        .checked_add(FOUNDER_IMMEDIATE_SOLA)
        .ok_or(SoladromeError::Overflow)?;
    s.ecosystem_allocated = true;

    Ok(())
}

// Claim linearly-vested hiSOLA (7M tranche).
// Each call mints `claimable` SOLA to sola_vault + `claimable` hiSOLA to founder.
// total_sola grows gradually, giving floor_vault time to accumulate from user buys.
// Founder uses borrow_usdc against hiSOLA for immediate liquidity (no token selling needed).
pub fn claim_founder_hi_sola(ctx: Context<ClaimFounderHiSola>) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    let clock = Clock::get()?;
    let vesting = &ctx.accounts.founder_hi_vesting;
    let elapsed = ((clock.unix_timestamp - vesting.start_ts).max(0)) as u64;

    require!(
        elapsed >= VESTING_CLIFF_SECS,
        SoladromeError::VestingCliffNotReached
    );
    require!(
        vesting.claimed < vesting.total_amount,
        SoladromeError::VestingFullyClaimed
    );

    let vested_amount = if elapsed >= VESTING_DURATION_SECS {
        vesting.total_amount
    } else {
        (vesting.total_amount as u128)
            .checked_mul(elapsed as u128)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(VESTING_DURATION_SECS as u128)
            .ok_or(SoladromeError::Overflow)? as u64
    };

    let claimable = vested_amount
        .checked_sub(vesting.claimed)
        .ok_or(SoladromeError::Overflow)?;
    require!(claimable > 0, SoladromeError::NothingToClaim);

    // Advance accumulator before adding hiSOLA (same pattern as stake_sola).
    let market_balance = ctx.accounts.market_vault.amount;
    let acc = math::advance_accumulator(
        ctx.accounts.protocol_state.fees_per_hi_sola,
        market_balance,
        ctx.accounts.protocol_state.last_market_vault_balance,
        ctx.accounts.protocol_state.total_hi_sola,
    );

    let bump = ctx.accounts.protocol_state.bump;
    let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

    // Mint SOLA to sola_vault (locked backing for hiSOLA)
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.sola_mint.to_account_info(),
                to: ctx.accounts.sola_vault.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[seeds],
        ),
        claimable,
    )?;

    // ── The hiSOLA goes straight into the lock, never a balance ──────────
    // Identical to claim_partner_allocation. `user_position.hi_sola` stays 0, which is
    // what makes the reserve inert: borrow_usdc cannot see it (so the 20% cap is not
    // bypassable), and unstake → sell_sola is unreachable. Combined with the
    // FOUNDER_WALLET guards on vote_gauge / replay_vote / burn_o_sola_for_votes and on
    // unlock_hi_sola, the 7M cannot vote, cannot earn, cannot be sold. Liquidity comes
    // solely from borrow_against_locked (20%, any ve-locker).
    //
    // Under the token model this was a mint into a vault the wallet did not control.
    // The guarantee is now structural rather than custodial: `amount_locked` is the only
    // record of this hiSOLA, and the sole instruction that can move it to a spendable
    // balance is `unlock_hi_sola`, which `permanent_amount` blocks for this tranche.

    // ── Create / extend the VeLockPosition ────────────────────────────────
    // MAX_LOCK_DURATION (4 y) is the ve ceiling; "locked for life" is enforced by the
    // FOUNDER_WALLET guard in unlock_hi_sola, not by this timestamp.
    let lock_end_ts = (clock.unix_timestamp as u64)
        .checked_add(MAX_LOCK_DURATION)
        .ok_or(SoladromeError::Overflow)? as i64;
    {
        let lock = &mut ctx.accounts.lock_position;
        if lock.owner == Pubkey::default() {
            lock.owner = ctx.accounts.founder.key();
            lock.bump = ctx.bumps.lock_position;
        }
        lock.amount_locked = lock
            .amount_locked
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;
        lock.lock_end_ts = lock_end_ts;
    }

    // Init/update founder position debt snapshot
    let pos = &mut ctx.accounts.founder_position;
    if pos.owner == Pubkey::default() {
        pos.owner = ctx.accounts.founder.key();
        pos.bump = ctx.bumps.founder_position;
    }
    pos.fees_debt = acc;

    // total_hi_sola: UNCHANGED — locked hiSOLA is excluded from the fee accumulator
    // denominator, matching claim_partner_allocation and lock_hi_sola. This is what
    // stops the 7M from capturing ~89% of protocol fees.
    let s = &mut ctx.accounts.protocol_state;
    s.fees_per_hi_sola = acc;
    s.last_market_vault_balance = market_balance;
    s.total_sola = s
        .total_sola
        .checked_add(claimable)
        .ok_or(SoladromeError::Overflow)?;

    ctx.accounts.founder_hi_vesting.claimed = ctx
        .accounts
        .founder_hi_vesting
        .claimed
        .checked_add(claimable)
        .ok_or(SoladromeError::Overflow)?;

    Ok(())
}

// Claim linearly-vested oSOLA (5M tranche).
// Mints oSOLA directly to founder — no floor impact.
// To realise USDC: exercise_o_sola (pay 1 USDC → floor_vault) → sell SOLA on AMM.
// Each exercise is net positive for the floor vault.
pub fn claim_founder_vesting(ctx: Context<ClaimFounderVesting>) -> Result<()> {
    let clock = Clock::get()?;
    let vesting = &ctx.accounts.founder_vesting;
    let elapsed = ((clock.unix_timestamp - vesting.start_ts).max(0)) as u64;

    require!(
        elapsed >= VESTING_CLIFF_SECS,
        SoladromeError::VestingCliffNotReached
    );
    require!(
        vesting.claimed < vesting.total_amount,
        SoladromeError::VestingFullyClaimed
    );

    let vested_amount = if elapsed >= VESTING_DURATION_SECS {
        vesting.total_amount
    } else {
        (vesting.total_amount as u128)
            .checked_mul(elapsed as u128)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(VESTING_DURATION_SECS as u128)
            .ok_or(SoladromeError::Overflow)? as u64
    };

    let claimable = vested_amount
        .checked_sub(vesting.claimed)
        .ok_or(SoladromeError::Overflow)?;
    require!(claimable > 0, SoladromeError::NothingToClaim);

    // Mint oSOLA to founder — floor-neutral until exercised
    let bump = ctx.accounts.protocol_state.bump;
    let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.o_sola_mint.to_account_info(),
                to: ctx.accounts.founder_o_sola.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[seeds],
        ),
        claimable,
    )?;

    ctx.accounts.founder_vesting.claimed = ctx
        .accounts
        .founder_vesting
        .claimed
        .checked_add(claimable)
        .ok_or(SoladromeError::Overflow)?;

    Ok(())
}

/// Authority-only: register a contributor wallet with a dual hiSOLA + oSOLA allocation.
///
/// ⚠️ There is no vesting, despite the account being named `ContributorVesting`. The cliff
/// and linear schedule were removed on 2026-07-18 and both tranches are now claimable in
/// full immediately; `start_ts` is kept as a record of when the deal was struck and is read
/// by nothing. This comment claimed otherwise until 2026-08-25, as did the two claim
/// instructions below — the account name is the last trace of a mechanism that is gone.
///
/// The two sides are not the same kind of thing:
/// - **hiSOLA** goes into a LIFETIME ve lock (`permanent_amount` covers the whole tranche),
///   so it can never be unlocked or sold. It votes forever, borrows at 20 %, and earns a
///   real share of protocol fees through `fee_shares` (since 2026-08-25).
/// - **oSOLA** is an option, not a payment: exercising burns it and pays 1 USDC per unit
///   into the floor, so the contributor funds every SOLA they take. It is worth nothing at
///   or below the floor.
///
/// Note this oSOLA is NOT drawn against `ecosystem_o_sola_minted` — `ECOSYSTEM_TOTAL` caps
/// `distribute_o_sola` only. Its bound is `CONTRIBUTOR_O_SOLA_CAP`, enforced below.
///
/// ☢️ Two `require!`s were added on 2026-08-27, and both matter more than they look:
/// - **A cumulative cap.** There was none: the only limit on what could be promised to
///   contributors was the form field the authority typed into. That was survivable while
///   the tranche earned nothing; now that it earns protocol fees it is unbounded dilution
///   of every staker — exactly the kind of promise that has to live in code to exist.
/// - **The 50/50 split.** The two sides are not interchangeable. hiSOLA is permanent
///   governance plus a real share of revenue; oSOLA is an option the holder pays 1 USDC a
///   unit to exercise, financing the floor as they do. Letting one side run without the
///   other turns compensation into either pure dilution or a pure lottery ticket.
pub fn register_contributor(
    ctx: Context<RegisterContributor>,
    hi_sola_amount: u64,
    o_sola_amount: u64,
) -> Result<()> {
    require!(
        hi_sola_amount > 0 || o_sola_amount > 0,
        SoladromeError::InvalidAmount
    );
    require!(
        hi_sola_amount == o_sola_amount,
        SoladromeError::ContributorSplitMismatch
    );

    // Cumulative across every contributor ever registered. `init` on the vesting PDA means
    // one wallet cannot be registered twice, so these totals cannot double-count.
    {
        let reg = &mut ctx.accounts.contributor_registry;
        if reg.bump == 0 {
            reg.bump = ctx.bumps.contributor_registry;
        }
        let hi_total = reg
            .hi_sola_allocated
            .checked_add(hi_sola_amount)
            .ok_or(SoladromeError::Overflow)?;
        let o_total = reg
            .o_sola_allocated
            .checked_add(o_sola_amount)
            .ok_or(SoladromeError::Overflow)?;
        require!(
            hi_total <= CONTRIBUTOR_HI_SOLA_CAP && o_total <= CONTRIBUTOR_O_SOLA_CAP,
            SoladromeError::ContributorCapExceeded
        );
        reg.hi_sola_allocated = hi_total;
        reg.o_sola_allocated = o_total;
        msg!(
            "Contributor budget: {} / {} hiSOLA · {} / {} oSOLA",
            hi_total,
            CONTRIBUTOR_HI_SOLA_CAP,
            o_total,
            CONTRIBUTOR_O_SOLA_CAP,
        );
    }

    let v = &mut ctx.accounts.contributor_vesting;
    v.contributor = ctx.accounts.contributor_wallet.key();
    v.hi_sola_amount = hi_sola_amount;
    v.o_sola_amount = o_sola_amount;
    v.hi_sola_claimed = 0;
    v.o_sola_claimed = 0;
    v.start_ts = Clock::get()?.unix_timestamp;
    v.bump = ctx.bumps.contributor_vesting;
    msg!(
        "Contributor registered: {} | {} hiSOLA + {} oSOLA | start_ts={}",
        v.contributor,
        v.hi_sola_amount,
        v.o_sola_amount,
        v.start_ts
    );
    Ok(())
}

/// Contributor-only: claim the whole hiSOLA tranche at once into a LIFETIME ve lock.
///
/// ⚠️ Not "25 % TGE + 75 % linear over 6 months", which is what this said until 2026-08-25
/// and has not been true since the schedule was removed on 2026-07-18. There is no cliff
/// and no vesting: `claimable` is the entire unclaimed remainder.
///
/// Mints SOLA to sola_vault as 1:1 backing and records the hiSOLA as `permanent_amount`,
/// so `unlock_hi_sola` can never release any of it. `total_hi_sola` is NOT incremented and
/// never will be, which means this tranche earns no protocol fees at any point — it buys
/// permanent voting power and a 20 % borrow valve, nothing else.
pub fn claim_contributor_hi_sola(ctx: Context<ClaimContributorHiSola>) -> Result<()> {
    let clock = Clock::get()?;
    let vesting = &ctx.accounts.contributor_vesting;

    require!(
        vesting.hi_sola_claimed < vesting.hi_sola_amount,
        SoladromeError::VestingFullyClaimed
    );

    // Claimed all at once (no cliff, no vesting) — a contributor is a first-class
    // member of the project. The hiSOLA is minted straight into a lifetime ve lock
    // (team/partner-bag pattern): wallet balance stays 0, so it earns no fees, cannot
    // be sold, and cannot drain the floor; it votes (up to 4×) and borrows 20% via
    // borrow_against_locked. This is unfinanced supply, so locking it for life keeps
    // the only exposure at the protocol's 20% ceiling.
    let claimable = vesting
        .hi_sola_amount
        .saturating_sub(vesting.hi_sola_claimed);
    require!(claimable > 0, SoladromeError::NothingToClaim);

    // Advance accumulator before adding to hiSOLA supply (same pattern as stake_sola)
    let market_balance = ctx.accounts.market_vault.amount;
    let acc = math::advance_accumulator(
        ctx.accounts.protocol_state.fees_per_hi_sola,
        market_balance,
        ctx.accounts.protocol_state.last_market_vault_balance,
        ctx.accounts.protocol_state.total_hi_sola,
    );

    let bump = ctx.accounts.protocol_state.bump;
    let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

    let lock_end_ts = (clock.unix_timestamp as u64)
        .checked_add(MAX_LOCK_DURATION)
        .ok_or(SoladromeError::Overflow)? as i64;

    // Mint SOLA to sola_vault (backing the hiSOLA 1:1)
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.sola_mint.to_account_info(),
                to: ctx.accounts.sola_vault.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[seeds],
        ),
        claimable,
    )?;

    // The hiSOLA side is the lock entry below — no token, no vault, no wallet balance.

    // Create the lifetime ve lock — permanent_amount covers the whole tranche.
    {
        let lock = &mut ctx.accounts.lock_position;
        if lock.owner == Pubkey::default() {
            lock.owner = ctx.accounts.contributor.key();
            lock.bump = ctx.bumps.lock_position;
        }
        lock.amount_locked = lock
            .amount_locked
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;
        lock.lock_end_ts = lock_end_ts;
        lock.permanent_amount = lock
            .permanent_amount
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;
    }

    // ── The bag earns fees ───────────────────────────────────────────────
    // It did not until 2026-08-25, and that made it worthless as compensation. The tranche
    // is locked for life, so `hi_sola` stays 0; it was never bought through the curve, so
    // `staked_amount` stays 0. `fee_basis` is the min of the two, so a contributor's basis
    // was 0 and — the lock being permanent — could never become anything else. Someone who
    // funds an audit would have received governance and no yield whatsoever.
    let pos = &mut ctx.accounts.contributor_position;
    if pos.owner == Pubkey::default() {
        pos.owner = ctx.accounts.contributor.key();
        pos.bump = ctx.bumps.contributor_position;
    }

    // Adding to the basis while `fees_debt` is a single scalar would hand the new shares a
    // retroactive claim on fees accrued before they existed. Re-stamping to `acc` instead
    // would forfeit whatever this position had already accrued — harmless for a fresh
    // contributor, real for one who was already staking. So carry the accrual across
    // exactly: pick the debt that reproduces the same pending amount against the new,
    // larger basis. Rounds down, i.e. never in the claimant's favour.
    let old_basis = math::fee_basis(pos.staked_amount, pos.hi_sola, pos.fee_shares);
    let pending = math::pending_fees(acc, pos.fees_debt, old_basis);
    pos.fee_shares = pos
        .fee_shares
        .checked_add(claimable)
        .ok_or(SoladromeError::Overflow)?;
    let new_basis = math::fee_basis(pos.staked_amount, pos.hi_sola, pos.fee_shares);
    pos.fees_debt = if pending == 0 || new_basis == 0 {
        acc
    } else {
        acc.saturating_sub((pending as u128 * PRECISION) / new_basis as u128)
    };

    // total_hi_sola GROWS by the tranche — the counterpart of the line above. The share is
    // real, not printed: existing holders are diluted by exactly what the contributor now
    // receives, which is the honest way to pay someone out of the fee stream.
    let s = &mut ctx.accounts.protocol_state;
    s.fees_per_hi_sola = acc;
    s.last_market_vault_balance = market_balance;
    s.total_hi_sola = s
        .total_hi_sola
        .checked_add(claimable)
        .ok_or(SoladromeError::Overflow)?;
    s.total_sola = s
        .total_sola
        .checked_add(claimable)
        .ok_or(SoladromeError::Overflow)?;

    ctx.accounts.contributor_vesting.hi_sola_claimed = vesting
        .hi_sola_claimed
        .checked_add(claimable)
        .ok_or(SoladromeError::Overflow)?;

    Ok(())
}

/// Contributor-only: claim the full oSOLA tranche at once (no cliff, no vesting).
/// Mints oSOLA to the contributor wallet — floor-neutral until exercised, like the
/// founder's 5M oSOLA. Exercising pays 1 USDC into the floor, so it is self-financing.
pub fn claim_contributor_vesting(ctx: Context<ClaimContributorVesting>) -> Result<()> {
    let vesting = &ctx.accounts.contributor_vesting;

    require!(
        vesting.o_sola_claimed < vesting.o_sola_amount,
        SoladromeError::VestingFullyClaimed
    );

    let claimable = vesting.o_sola_amount.saturating_sub(vesting.o_sola_claimed);
    require!(claimable > 0, SoladromeError::NothingToClaim);

    let bump = ctx.accounts.protocol_state.bump;
    let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.o_sola_mint.to_account_info(),
                to: ctx.accounts.contributor_o_sola.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[seeds],
        ),
        claimable,
    )?;

    ctx.accounts.contributor_vesting.o_sola_claimed = vesting
        .o_sola_claimed
        .checked_add(claimable)
        .ok_or(SoladromeError::Overflow)?;

    Ok(())
}

// Mint oSOLA to a recipient as LP reward. Authority-only.
pub fn distribute_o_sola(ctx: Context<DistributeOSola>, amount: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(amount > 0, SoladromeError::InvalidAmount);

    // ── ECOSYSTEM_TOTAL cap ───────────────────────────────────────────────
    // This is the ecosystem/airdrop budget, issued as oSOLA rather than SOLA so it
    // is self-financing: the recipient pays 1 USDC into the floor to exercise, so no
    // unfinanced supply can ever be redeemed against backing it never contributed.
    // Until 2026-07-17 the only check here was `amount > 0` — the published 1.75M was
    // a constant that constrained nothing, and the authority could dilute without limit.
    let minted = ctx
        .accounts
        .protocol_state
        .ecosystem_o_sola_minted
        .checked_add(amount)
        .ok_or(SoladromeError::Overflow)?;
    require!(
        minted <= ECOSYSTEM_TOTAL,
        SoladromeError::EcosystemBudgetExceeded
    );

    let bump = ctx.accounts.protocol_state.bump;

    let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.o_sola_mint.to_account_info(),
                to: ctx.accounts.recipient_o_sola.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    ctx.accounts.protocol_state.ecosystem_o_sola_minted = minted;
    Ok(())
}

// ── MintFounderAllocation ─────────────────────────────────────────────────────
// Initialises vesting schedules only — zero tokens minted here.
#[derive(Accounts)]
pub struct MintFounderAllocation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [STATE_SEED],
        bump = protocol_state.bump,
        has_one = authority @ SoladromeError::Unauthorized,
    )]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// Founder wallet — pinned to the address `initialize` wrote, cannot be substituted.
    #[account(
        address = protocol_state.founder_wallet @ SoladromeError::Unauthorized,
    )]
    pub founder: SystemAccount<'info>,

    /// hiSOLA progressive vesting schedule (7M, cliff + linear).
    #[account(
        init,
        payer = authority,
        space = 8 + FounderHiSolaVesting::LEN,
        seeds = [FOUNDER_HI_VESTING_SEED],
        bump,
    )]
    pub founder_hi_vesting: Account<'info, FounderHiSolaVesting>,

    /// oSOLA progressive vesting schedule (5M, cliff + linear).
    #[account(
        init,
        payer = authority,
        space = 8 + FounderVesting::LEN,
        seeds = [b"founder_vesting"],
        bump,
    )]
    pub founder_vesting: Account<'info, FounderVesting>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MintEcosystemAllocation<'info> {
    #[account(mut, address = protocol_state.authority @ SoladromeError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    /// Receives the SOLA backing the team's locked hiSOLA.
    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only — accumulator snapshot before the hiSOLA supply changes.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: hardcoded team wallet — receives the 250K tranche as a lifetime ve lock.
    /// Distinct from FOUNDER_WALLET by design: the vote_gauge guard keys on FOUNDER_WALLET,
    /// so this tranche votes as an ordinary user.
    #[account(address = TEAM_WALLET.parse::<Pubkey>().unwrap() @ SoladromeError::Unauthorized)]
    pub team_wallet: UncheckedAccount<'info>,

    /// Team ve lock metadata. Mirrors ClaimPartnerAllocation.
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + VeLockPosition::LEN,
        seeds = [VELOCK_SEED, team_wallet.key().as_ref()],
        bump,
    )]
    pub team_lock_position: Box<Account<'info, VeLockPosition>>,

    /// Team fee-share position — fees_debt snapshotted at allocation.
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, team_wallet.key().as_ref()],
        bump,
    )]
    pub team_position: Box<Account<'info, UserPosition>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ClaimFounderHiSola<'info> {
    // ⚠️ `protocol_state` is declared FIRST on purpose: the `founder` constraint below reads
    // `protocol_state.founder_wallet`, and Anchor resolves constraints in declaration order.
    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// Only the founder wallet recorded at `initialize` may call this.
    #[account(
        mut,
        address = protocol_state.founder_wallet @ SoladromeError::Unauthorized,
    )]
    pub founder: Signer<'info>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    /// Receives freshly locked SOLA backing the claimed hiSOLA.
    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only — needed for accumulator snapshot before hiSOLA supply changes.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// Lifetime ve lock metadata — created on first claim. Mirrors ClaimPartnerAllocation.
    #[account(
        init_if_needed,
        payer = founder,
        space = 8 + VeLockPosition::LEN,
        seeds = [VELOCK_SEED, founder.key().as_ref()],
        bump,
    )]
    pub lock_position: Box<Account<'info, VeLockPosition>>,

    /// Founder's fee-share position — fees_debt snapshotted at claim. The reserve never
    /// unlocks, so this never becomes a fee claim; it exists for symmetry with partners.
    #[account(
        init_if_needed,
        payer = founder,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, founder.key().as_ref()],
        bump,
    )]
    pub founder_position: Account<'info, UserPosition>,

    #[account(
        mut,
        seeds = [FOUNDER_HI_VESTING_SEED],
        bump = founder_hi_vesting.bump,
    )]
    pub founder_hi_vesting: Account<'info, FounderHiSolaVesting>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimFounderVesting<'info> {
    // ⚠️ `protocol_state` first — the `founder` constraint reads `founder_wallet` from it and
    // Anchor resolves constraints in declaration order.
    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Only the founder wallet recorded at `initialize` may call this.
    #[account(
        mut,
        address = protocol_state.founder_wallet @ SoladromeError::Unauthorized,
    )]
    pub founder: Signer<'info>,

    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"founder_vesting"],
        bump = founder_vesting.bump,
    )]
    pub founder_vesting: Account<'info, FounderVesting>,

    /// Founder's oSOLA ATA — created on first claim if needed.
    #[account(
        init_if_needed,
        payer = founder,
        associated_token::mint = o_sola_mint,
        associated_token::authority = founder,
    )]
    pub founder_o_sola: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Authority registers a contributor wallet with hiSOLA + oSOLA allocations.
/// Called once per contributor (at launch). Vesting starts immediately.
#[derive(Accounts)]
pub struct RegisterContributor<'info> {
    #[account(
        mut,
        address = protocol_state.authority @ SoladromeError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    /// CHECK: The beneficiary wallet — identity enforced by PDA seeds.
    pub contributor_wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + ContributorVesting::LEN,
        seeds = [CONTRIBUTOR_SEED, contributor_wallet.key().as_ref()],
        bump,
    )]
    pub contributor_vesting: Account<'info, ContributorVesting>,

    /// The running total the cap is enforced against. Opened by the first registration.
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + ContributorRegistry::LEN,
        seeds = [CONTRIBUTOR_REGISTRY_SEED],
        bump,
    )]
    pub contributor_registry: Account<'info, ContributorRegistry>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Contributor claims vested hiSOLA (governance + borrow collateral tranche).
/// Mints SOLA to sola_vault + hiSOLA to contributor 1:1. Advances fee accumulator.
#[derive(Accounts)]
pub struct ClaimContributorHiSola<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only — needed for accumulator snapshot before hiSOLA supply changes.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// Lifetime ve lock metadata — created on claim. Mirrors the team/partner pattern.
    #[account(
        init_if_needed,
        payer = contributor,
        space = 8 + VeLockPosition::LEN,
        seeds = [VELOCK_SEED, contributor.key().as_ref()],
        bump,
    )]
    pub lock_position: Box<Account<'info, VeLockPosition>>,

    /// Fee-share position — init on first claim; tracks fees_debt.
    #[account(
        init_if_needed,
        payer = contributor,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, contributor.key().as_ref()],
        bump,
    )]
    pub contributor_position: Account<'info, UserPosition>,

    #[account(
        mut,
        seeds = [CONTRIBUTOR_SEED, contributor.key().as_ref()],
        bump = contributor_vesting.bump,
        constraint = contributor_vesting.contributor == contributor.key() @ SoladromeError::Unauthorized,
    )]
    pub contributor_vesting: Account<'info, ContributorVesting>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Contributor claims vested oSOLA (liquid options tranche).
/// Mints oSOLA to contributor — floor-neutral until exercised.
#[derive(Accounts)]
pub struct ClaimContributorVesting<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [CONTRIBUTOR_SEED, contributor.key().as_ref()],
        bump = contributor_vesting.bump,
        constraint = contributor_vesting.contributor == contributor.key() @ SoladromeError::Unauthorized,
    )]
    pub contributor_vesting: Account<'info, ContributorVesting>,

    /// Contributor's oSOLA ATA — created on first claim if needed.
    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint      = o_sola_mint,
        associated_token::authority = contributor,
    )]
    pub contributor_o_sola: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DistributeOSola<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Recipient wallet — validated implicitly by ATA derivation below.
    pub recipient: UncheckedAccount<'info>,

    /// `mut` is load-bearing: without it Anchor never serializes the account back, so
    /// `ecosystem_o_sola_minted` would silently stay 0 and the ECOSYSTEM_TOTAL cap would
    /// never fire — a cap reading a counter that never increments.
    #[account(
        mut,
        seeds = [STATE_SEED],
        bump = protocol_state.bump,
        has_one = authority @ SoladromeError::Unauthorized,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = o_sola_mint,
        associated_token::authority = recipient,
    )]
    pub recipient_o_sola: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
