// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::math;
use crate::state::{ProtocolState, UserPosition, VeLockPosition};

// ── Instructions ──────────────────────────────────────────────────────────────

/// Lock hiSOLA for governance voting power.
///
/// ☢️ **Locking no longer costs the holder their fees** (2026-08-27). It used to: the balance
/// moved out of `hi_sola` and `total_hi_sola` was decremented, so a four-year lock meant four
/// years of earning nothing — for everyone, on stake they had financed themselves. The obvious
/// fix would have been to stop decrementing and leave the basis alone, and it would have been a
/// mistake: the founder's 7M is excluded from the fee pool *only* because every lock is, so
/// inverting the default turns that exclusion into a special case whose omission is silent and
/// worth ~89 % of the fee stream.
///
/// So the basis is preserved through `fee_shares` instead — see `UserPosition::lock_balance`,
/// which credits the drop in basis rather than the amount, so unfinanced hiSOLA cannot buy
/// itself a fee share by locking. `claim_founder_hi_sola` never routes through here and never
/// credits `fee_shares`, so the 7M stays excluded automatically, by construction rather than by
/// a name check.
///
/// Side effect, accepted deliberately: the 30 % per-address vote cap is computed against
/// `total_hi_sola`, and locked positions vote at up to 4× while being absent from it. Putting
/// them back does not loosen the cap — it gives it the meaning it advertises.
///
/// Subsequent calls on an existing lock may add more or extend the end date (never shorten).
/// Locking into an expired position resets it.
///
/// Both sides are ledger figures now: `VeLockPosition.amount_locked` always was one, and
/// `UserPosition.hi_sola` became one when hiSOLA stopped being a token. The vault this used
/// to fill is gone.
pub fn lock_hi_sola(ctx: Context<LockHiSola>, amount: u64, lock_duration_secs: u64) -> Result<()> {
    // Pause check lives here (not only in the lib.rs wrapper) so any future
    // internal call-site cannot accidentally bypass the emergency freeze.
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(amount > 0, SoladromeError::InvalidAmount);
    require!(
        lock_duration_secs >= MIN_LOCK_DURATION,
        SoladromeError::InvalidAmount
    );
    require!(
        lock_duration_secs <= MAX_LOCK_DURATION,
        SoladromeError::InvalidAmount
    );

    let clock = Clock::get()?;
    let new_lock_end_ts = (clock.unix_timestamp as u64)
        .checked_add(lock_duration_secs)
        .ok_or(SoladromeError::Overflow)? as i64;

    // If an active (non-expired) lock already exists, new end must be ≥ existing.
    {
        let lock = &ctx.accounts.lock_position;
        if lock.owner != Pubkey::default()
            && lock.amount_locked > 0
            && lock.lock_end_ts > clock.unix_timestamp
        {
            require!(
                new_lock_end_ts >= lock.lock_end_ts,
                SoladromeError::InvalidAmount
            );
        }
    }

    // Advance accumulator before decreasing total_hi_sola.
    let market_balance = ctx.accounts.market_vault.amount;
    let acc = math::advance_accumulator(
        ctx.accounts.protocol_state.fees_per_hi_sola,
        market_balance,
        ctx.accounts.protocol_state.last_market_vault_balance,
        ctx.accounts.protocol_state.total_hi_sola,
    );

    // ── Debit the position ───────────────────────────────────────────────────
    // Same two guards as `unstake_hi_sola`, and for the same reason: locking moves the
    // balance out of `hi_sola`, so without them it would be the way around both. Debt is
    // gated because ve-locked hiSOLA is not collateral `borrow_usdc` can see, and the vote
    // lock because a vote cast this epoch must not be undone by relocating its backing.
    {
        let pos = &ctx.accounts.user_position;
        let remaining = pos
            .hi_sola
            .checked_sub(amount)
            .ok_or(SoladromeError::InvalidAmount)?;
        require!(
            pos.usdc_borrowed <= remaining,
            SoladromeError::OutstandingDebt
        );
        require!(
            remaining >= pos.vote_locked_now(clock.unix_timestamp),
            SoladromeError::VoteEscrowLocked
        );
    }

    // ── Move the balance without moving the fee basis ────────────────────────
    // `fees_debt` is deliberately NOT re-stamped to `acc`. It used to be, and that quietly
    // confiscated everything the position had accrued but not yet claimed — hence the old
    // instruction to "claim before locking", a footgun dressed as documentation. The basis is
    // identical on both sides of `lock_balance`, so pending is identical too, and leaving the
    // debt alone is exactly right.
    let credited = {
        let pos = &mut ctx.accounts.user_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.user.key();
            pos.bump = ctx.bumps.user_position;
        }
        pos.lock_balance(amount)?
        // `staked_amount` is deliberately NOT decremented. It records what this wallet
        // financed, which locking does not undo. The `min(staked_amount, hi_sola)` in
        // `borrow_usdc` still collapses to 0 while the balance is locked — exactly what the
        // emptied ATA used to do — and restores the original cap on unlock, without a second
        // counter that could drift from the first. Allocations that were never financed still
        // read `staked_amount = 0` after unlocking, so the 100% channel stays shut for them and
        // `borrow_against_locked` (20%) remains their only valve.
    };

    // Update lock position.
    {
        let lock = &mut ctx.accounts.lock_position;
        if lock.owner == Pubkey::default() {
            lock.owner = ctx.accounts.user.key();
            lock.bump = ctx.bumps.lock_position;
        }
        lock.amount_locked = lock
            .amount_locked
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;
        lock.lock_end_ts = new_lock_end_ts;
    }

    // Only the part that genuinely left the fee base leaves the denominator. For financed
    // stake `credited == amount` and this is a no-op — the point of the change. For unfinanced
    // hiSOLA `credited == 0` and the full amount comes out, exactly as it always did.
    let s = &mut ctx.accounts.protocol_state;
    s.fees_per_hi_sola = acc;
    s.last_market_vault_balance = market_balance;
    s.total_hi_sola = s
        .total_hi_sola
        .checked_sub(amount.saturating_sub(credited))
        .ok_or(SoladromeError::Overflow)?;

    Ok(())
}

/// Unlock hiSOLA after the lock has expired.
///
/// Returns the balance to `user_position.hi_sola` and to the fee accumulator denominator, so
/// it resumes earning staking fees on the next claim.
pub fn unlock_hi_sola(ctx: Context<UnlockHiSola>) -> Result<()> {
    let clock = Clock::get()?;

    // Only the non-permanent portion may ever be released. `permanent_amount` is the partner
    // welcome bag (see VeLockPosition): unfinanced hiSOLA that must never become a spendable
    // balance, where it could be unstaked and redeemed 1:1 against backing it never funded.
    // Legacy positions read permanent_amount = 0 and behave exactly as before.
    let locked = ctx.accounts.lock_position.amount_locked;
    let permanent = ctx.accounts.lock_position.permanent_amount;
    let amount = locked.saturating_sub(permanent);

    require!(amount > 0, SoladromeError::NothingToClaim);
    require!(
        clock.unix_timestamp >= ctx.accounts.lock_position.lock_end_ts,
        SoladromeError::LockNotExpired
    );

    // Advance accumulator before increasing total_hi_sola.
    let market_balance = ctx.accounts.market_vault.amount;
    let acc = math::advance_accumulator(
        ctx.accounts.protocol_state.fees_per_hi_sola,
        market_balance,
        ctx.accounts.protocol_state.last_market_vault_balance,
        ctx.accounts.protocol_state.total_hi_sola,
    );

    // NOT zero: the permanent portion stays locked and stays counted, so the position keeps
    // its voting power forever and a later unlock can never drain it.
    ctx.accounts.lock_position.amount_locked = permanent;

    // ── Return the balance, hand back the shares that stood in for it ────────
    // The exact inverse of the lock, and `fees_debt` is left alone for the same reason: the
    // basis is unchanged across `unlock_balance`, so nothing is owed differently on either
    // side of it. `staked_amount` is NOT credited: hiSOLA released by an expired lock was
    // never financed through the curve, so it must not open the 100% borrow channel. For a
    // wallet that locked its own financed stake, `staked_amount` was left standing at lock
    // time and simply becomes effective again here.
    let debited = {
        let pos = &mut ctx.accounts.user_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.user.key();
            pos.bump = ctx.bumps.user_position;
        }
        pos.unlock_balance(amount)?
    };

    // Symmetric with the lock: only what re-enters the fee base re-enters the denominator.
    let s = &mut ctx.accounts.protocol_state;
    s.fees_per_hi_sola = acc;
    s.last_market_vault_balance = market_balance;
    s.total_hi_sola = s
        .total_hi_sola
        .checked_add(amount.saturating_sub(debited))
        .ok_or(SoladromeError::Overflow)?;

    Ok(())
}

// ── Ve-power helper ───────────────────────────────────────────────────────────

/// Attempt to read ve_power from an UncheckedAccount.
/// Returns 0 if the account is missing, owned by another program, or expired.
/// Callers pass SystemProgram as a placeholder when not using a ve lock.
pub fn try_load_ve_power(account_info: &AccountInfo, user: &Pubkey, current_ts: i64) -> u64 {
    if account_info.owner != &crate::ID {
        return 0;
    }
    let data = match account_info.try_borrow_data() {
        Ok(d) => d,
        Err(_) => return 0,
    };
    let lock = match VeLockPosition::try_deserialize(&mut &data[..]) {
        Ok(l) => l,
        Err(_) => return 0,
    };
    if &lock.owner != user || lock.amount_locked == 0 {
        return 0;
    }
    math::ve_power(lock.amount_locked, lock.lock_end_ts, current_ts)
}

// ── Account Contexts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct LockHiSola<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [STATE_SEED],
        bump  = protocol_state.bump,
    )]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// Lock metadata PDA. Created on first lock, updated on subsequent ones.
    /// The source of the locked hiSOLA is `user_position.hi_sola`, so there is no token
    /// account on either side any more — and no `ve_lock_vault`.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + VeLockPosition::LEN,
        seeds = [VELOCK_SEED, user.key().as_ref()],
        bump,
    )]
    pub lock_position: Box<Account<'info, VeLockPosition>>,

    /// Read-only market vault snapshot for accumulator advance.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// Fee-share position — updated at lock time so the user cannot claim fees
    /// accumulated by other stakers during their lock period.
    /// Created on first lock if not yet initialised.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UnlockHiSola<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [STATE_SEED],
        bump  = protocol_state.bump,
    )]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(
        mut,
        seeds = [VELOCK_SEED, user.key().as_ref()],
        bump  = lock_position.bump,
    )]
    pub lock_position: Box<Account<'info, VeLockPosition>>,

    /// Read-only market vault snapshot for accumulator advance.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// Fee-share position — updated at unlock time so the user starts earning
    /// fees only from the moment of unlock (not backdated to before the lock).
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    pub system_program: Program<'info, System>,
}
