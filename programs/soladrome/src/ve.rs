// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Christophe Hertecant

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

use crate::errors::SoladromeError;
use crate::math;
use crate::state::{
    ProtocolState, VeLockPosition, MAX_LOCK_DURATION, MIN_LOCK_DURATION,
};
use crate::STATE_SEED;

pub const VELOCK_SEED:   &[u8] = b"velock";
pub const VE_VAULT_SEED: &[u8] = b"ve_vault";

// ── Instructions ──────────────────────────────────────────────────────────────

/// Lock hiSOLA for governance voting power.
///
/// Transferring hiSOLA into the ve_lock_vault removes it from the fee
/// accumulator denominator — locked holders trade fee yield for ve power.
/// Subsequent calls on an existing lock may add tokens or extend the end date
/// (never shorten). Locking into an expired position resets it.
pub fn lock_hi_sola(
    ctx:                Context<LockHiSola>,
    amount:             u64,
    lock_duration_secs: u64,
) -> Result<()> {
    require!(amount > 0, SoladromeError::InvalidAmount);
    require!(lock_duration_secs >= MIN_LOCK_DURATION, SoladromeError::InvalidAmount);
    require!(lock_duration_secs <= MAX_LOCK_DURATION, SoladromeError::InvalidAmount);

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
            require!(new_lock_end_ts >= lock.lock_end_ts, SoladromeError::InvalidAmount);
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

    // Transfer hiSOLA: user ATA → ve_lock_vault.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.user_hi_sola.to_account_info(),
                to:        ctx.accounts.ve_lock_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // Update lock position.
    {
        let lock = &mut ctx.accounts.lock_position;
        if lock.owner == Pubkey::default() {
            lock.owner = ctx.accounts.user.key();
            lock.bump  = ctx.bumps.lock_position;
        }
        lock.amount_locked = lock.amount_locked
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;
        lock.lock_end_ts = new_lock_end_ts;
    }

    // Remove locked hiSOLA from the fee distribution pool.
    let s = &mut ctx.accounts.protocol_state;
    s.fees_per_hi_sola         = acc;
    s.last_market_vault_balance = market_balance;
    s.total_hi_sola = s.total_hi_sola
        .checked_sub(amount)
        .ok_or(SoladromeError::Overflow)?;

    Ok(())
}

/// Unlock hiSOLA after the lock has expired.
///
/// Restores hiSOLA to the fee accumulator denominator so the returned tokens
/// resume earning staking fees on the next claim.
pub fn unlock_hi_sola(ctx: Context<UnlockHiSola>) -> Result<()> {
    let clock = Clock::get()?;

    let amount    = ctx.accounts.lock_position.amount_locked;
    let lock_bump  = ctx.accounts.lock_position.bump;
    let user_key  = ctx.accounts.user.key();

    require!(amount > 0, SoladromeError::InvalidAmount);
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

    // Transfer hiSOLA: ve_lock_vault → user ATA (lock_position PDA signs).
    let lock_seeds: &[&[u8]] = &[VELOCK_SEED, user_key.as_ref(), &[lock_bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.ve_lock_vault.to_account_info(),
                to:        ctx.accounts.user_hi_sola.to_account_info(),
                authority: ctx.accounts.lock_position.to_account_info(),
            },
            &[lock_seeds],
        ),
        amount,
    )?;

    ctx.accounts.lock_position.amount_locked = 0;

    // Return locked hiSOLA to the fee distribution pool.
    let s = &mut ctx.accounts.protocol_state;
    s.fees_per_hi_sola         = acc;
    s.last_market_vault_balance = market_balance;
    s.total_hi_sola = s.total_hi_sola
        .checked_add(amount)
        .ok_or(SoladromeError::Overflow)?;

    Ok(())
}

// ── Ve-power helper ───────────────────────────────────────────────────────────

/// Attempt to read ve_power from an UncheckedAccount.
/// Returns 0 if the account is missing, owned by another program, or expired.
/// Callers pass SystemProgram as a placeholder when not using a ve lock.
pub fn try_load_ve_power(
    account_info: &AccountInfo,
    user:         &Pubkey,
    current_ts:   i64,
) -> u64 {
    if account_info.owner != &crate::ID {
        return 0;
    }
    let data = match account_info.try_borrow_data() {
        Ok(d)  => d,
        Err(_) => return 0,
    };
    let lock = match VeLockPosition::try_deserialize(&mut &data[..]) {
        Ok(l)  => l,
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

    #[account(address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

    /// Caller's hiSOLA ATA — source of tokens to lock.
    #[account(mut, token::mint = hi_sola_mint, token::authority = user)]
    pub user_hi_sola: Box<Account<'info, TokenAccount>>,

    /// Lock metadata PDA. Created on first lock, updated on subsequent ones.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + VeLockPosition::LEN,
        seeds = [VELOCK_SEED, user.key().as_ref()],
        bump,
    )]
    pub lock_position: Box<Account<'info, VeLockPosition>>,

    /// Token account holding locked hiSOLA. Owned by the lock_position PDA.
    #[account(
        init_if_needed,
        payer = user,
        token::mint      = hi_sola_mint,
        token::authority = lock_position,
        seeds = [VE_VAULT_SEED, user.key().as_ref()],
        bump,
    )]
    pub ve_lock_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only market vault snapshot for accumulator advance.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent:           Sysvar<'info, Rent>,
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

    #[account(address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

    /// Destination for unlocked hiSOLA. Created if user burned their ATA previously.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint      = hi_sola_mint,
        associated_token::authority = user,
    )]
    pub user_hi_sola: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [VELOCK_SEED, user.key().as_ref()],
        bump  = lock_position.bump,
    )]
    pub lock_position: Box<Account<'info, VeLockPosition>>,

    /// Source vault — tokens transferred back to user on unlock.
    #[account(
        mut,
        seeds = [VE_VAULT_SEED, user.key().as_ref()],
        bump,
        token::mint      = hi_sola_mint,
        token::authority = lock_position,
    )]
    pub ve_lock_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only market vault snapshot for accumulator advance.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
}
