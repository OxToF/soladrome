// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Borrowing USDC out of the floor vault against hiSOLA, financed and unfinanced.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::math;
use crate::state::*;

// Borrow USDC from floor reserve. Max = financed stake still in hand. No liquidation.
pub fn borrow_usdc(ctx: Context<BorrowUsdc>, usdc_amount: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(usdc_amount > 0, SoladromeError::InvalidAmount);
    let bump = ctx.accounts.protocol_state.bump;

    if ctx.accounts.user_position.owner == Pubkey::default() {
        ctx.accounts.user_position.owner = ctx.accounts.user.key();
        ctx.accounts.user_position.bump = ctx.bumps.user_position;
        // SECURITY: snapshot accumulator so a position opened here cannot retroactively
        // claim fees through claim_fees after being initialised with fees_debt = 0.
        ctx.accounts.user_position.fees_debt = math::advance_accumulator(
            ctx.accounts.protocol_state.fees_per_hi_sola,
            ctx.accounts.market_vault.amount,
            ctx.accounts.protocol_state.last_market_vault_balance,
            ctx.accounts.protocol_state.total_hi_sola,
        );
    }

    // Voting does not reduce this: a vote immobilises the balance in place
    // (`vote_locked`), it no longer moves it into custody. Borrowing and voting are
    // therefore independent, which is what we want — a vote-directed emission system must
    // never give borrowers a reason to abstain.
    //
    // ☢️ The cap keeps BOTH halves. `staked_amount` counts hiSOLA financed through the
    // curve; `hi_sola` is the whole balance, which also carries the unfinanced hiSOLA an
    // expired ve lock releases. The minimum is what confines the 100% channel to
    // collateral whose USDC is actually sitting in the floor vault — everything else goes
    // through `borrow_against_locked` at 20%.
    let borrow_cap = ctx
        .accounts
        .user_position
        .staked_amount
        .min(ctx.accounts.user_position.hi_sola);
    let new_borrowed = ctx
        .accounts
        .user_position
        .usdc_borrowed
        .checked_add(usdc_amount)
        .ok_or(SoladromeError::Overflow)?;
    require!(
        new_borrowed <= borrow_cap,
        SoladromeError::BorrowLimitExceeded
    );
    require!(
        ctx.accounts.floor_vault.amount >= usdc_amount,
        SoladromeError::InsufficientFloorReserve
    );
    // ── 75% floor buffer guardrail ───────────────────────────────────────
    // Ensures sell_sola remains liquid for at least 75% of floor-backed supply.
    {
        let floor_after = ctx
            .accounts
            .floor_vault
            .amount
            .checked_sub(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;
        let min_floor = (ctx.accounts.protocol_state.total_purchased_sola as u128)
            .checked_mul(FLOOR_RESERVE_MIN_BPS as u128)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(10_000)
            .ok_or(SoladromeError::Overflow)? as u64;
        require!(
            floor_after >= min_floor,
            SoladromeError::BorrowExceedsFloorBuffer
        );
    }

    // ── 2 % origination fee (one-time, like Beradrome) ──────────────────
    // fee   → market_vault  → distributed to hiSOLA stakers via accumulator
    // net   → user_usdc
    // usdc_borrowed tracks the GROSS amount so repay fully restores floor_vault.
    let fee = usdc_amount
        .checked_mul(BORROW_FEE_BPS)
        .ok_or(SoladromeError::Overflow)?
        .checked_div(10_000)
        .ok_or(SoladromeError::Overflow)?;
    let user_receives = usdc_amount
        .checked_sub(fee)
        .ok_or(SoladromeError::Overflow)?;

    let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

    // Transfer net amount to user
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.floor_vault.to_account_info(),
                to: ctx.accounts.user_usdc.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[seeds],
        ),
        user_receives,
    )?;

    // Transfer fee to market_vault (→ hiSOLA stakers)
    if fee > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.floor_vault.to_account_info(),
                    to: ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            fee,
        )?;
    }

    // usdc_borrowed = gross (user repays full amount → floor_vault fully restored)
    ctx.accounts.user_position.usdc_borrowed = new_borrowed;
    // Track global borrow total for floor-vault invariant.
    ctx.accounts.protocol_state.total_usdc_borrowed = ctx
        .accounts
        .protocol_state
        .total_usdc_borrowed
        .checked_add(usdc_amount)
        .ok_or(SoladromeError::Overflow)?;
    // Flash-borrow guard: record the slot so repay_usdc cannot fire in the same tx.
    ctx.accounts.user_position.last_borrow_slot = Clock::get()?.slot;
    Ok(())
}

pub fn repay_usdc(ctx: Context<RepayUsdc>, usdc_amount: u64) -> Result<()> {
    require!(usdc_amount > 0, SoladromeError::InvalidAmount);
    let repay = usdc_amount.min(ctx.accounts.user_position.usdc_borrowed);
    require!(repay > 0, SoladromeError::InvalidAmount);
    // Flash-borrow guard: repay must be in a strictly later slot than borrow.
    require!(
        Clock::get()?.slot > ctx.accounts.user_position.last_borrow_slot,
        SoladromeError::FlashBorrowDetected
    );

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc.to_account_info(),
                to: ctx.accounts.floor_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        repay,
    )?;

    ctx.accounts.user_position.usdc_borrowed = ctx
        .accounts
        .user_position
        .usdc_borrowed
        .checked_sub(repay)
        .ok_or(SoladromeError::Overflow)?;
    ctx.accounts.protocol_state.total_usdc_borrowed = ctx
        .accounts
        .protocol_state
        .total_usdc_borrowed
        .checked_sub(repay)
        .ok_or(SoladromeError::Overflow)?;
    Ok(())
}

/// Borrow USDC against a vote-locked hiSOLA position (the partner liquidity valve).
///
/// A partner's hiSOLA sits in their `VeLockPosition`, so `UserPosition.hi_sola` reads 0 for
/// them and the normal `borrow_usdc` path finds nothing to lend against. (No vault is
/// involved: both are ledger figures.) This draws USDC from the floor reserve using
/// the LOCKED position (`VeLockPosition.amount_locked`) as collateral, capped at
/// `PARTNER_BORROW_CAP_BPS` (20%). Repay via the standard `repay_usdc` (same
/// UserPosition PDA). 2% origination fee → market_vault, 75% floor buffer, no
/// interest, no liquidation. Available to any ve-locker, not just partners.
pub fn borrow_against_locked(ctx: Context<BorrowAgainstLocked>, usdc_amount: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(usdc_amount > 0, SoladromeError::InvalidAmount);
    let bump = ctx.accounts.protocol_state.bump;

    if ctx.accounts.partner_position.owner == Pubkey::default() {
        ctx.accounts.partner_position.owner = ctx.accounts.partner.key();
        ctx.accounts.partner_position.bump = ctx.bumps.partner_position;
    }

    // ── Cap: 20% of the locked hiSOLA position ──────────────────────────
    let locked = ctx.accounts.lock_position.amount_locked;
    let max_borrow = (locked as u128)
        .checked_mul(PARTNER_BORROW_CAP_BPS as u128)
        .ok_or(SoladromeError::Overflow)?
        .checked_div(10_000)
        .ok_or(SoladromeError::Overflow)? as u64;

    let new_borrowed = ctx
        .accounts
        .partner_position
        .usdc_borrowed
        .checked_add(usdc_amount)
        .ok_or(SoladromeError::Overflow)?;
    require!(
        new_borrowed <= max_borrow,
        SoladromeError::BorrowLimitExceeded
    );
    require!(
        ctx.accounts.floor_vault.amount >= usdc_amount,
        SoladromeError::InsufficientFloorReserve
    );

    // ── 75% floor buffer guardrail ──────────────────────────────────────
    {
        let floor_after = ctx
            .accounts
            .floor_vault
            .amount
            .checked_sub(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;
        let min_floor = (ctx.accounts.protocol_state.total_purchased_sola as u128)
            .checked_mul(FLOOR_RESERVE_MIN_BPS as u128)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(10_000)
            .ok_or(SoladromeError::Overflow)? as u64;
        require!(
            floor_after >= min_floor,
            SoladromeError::BorrowExceedsFloorBuffer
        );
    }

    // ── 2% origination fee → market_vault ───────────────────────────────
    let fee = usdc_amount
        .checked_mul(BORROW_FEE_BPS)
        .ok_or(SoladromeError::Overflow)?
        .checked_div(10_000)
        .ok_or(SoladromeError::Overflow)?;
    let user_receives = usdc_amount
        .checked_sub(fee)
        .ok_or(SoladromeError::Overflow)?;

    let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.floor_vault.to_account_info(),
                to: ctx.accounts.partner_usdc.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[seeds],
        ),
        user_receives,
    )?;

    if fee > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.floor_vault.to_account_info(),
                    to: ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            fee,
        )?;
    }

    ctx.accounts.partner_position.usdc_borrowed = new_borrowed;
    ctx.accounts.protocol_state.total_usdc_borrowed = ctx
        .accounts
        .protocol_state
        .total_usdc_borrowed
        .checked_add(usdc_amount)
        .ok_or(SoladromeError::Overflow)?;
    ctx.accounts.partner_position.last_borrow_slot = Clock::get()?.slot;
    Ok(())
}

#[derive(Accounts)]
pub struct BorrowUsdc<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Account<'info, TokenAccount>,

    /// Receives the 2 % origination fee → distributed to hiSOLA stakers.
    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Account<'info, TokenAccount>,

    // M-04 FIX: enforce token::authority so borrowed USDC cannot be silently
    // routed to market_vault or any other protocol account, which would allow
    // converting a borrow into artificial fee income claimable via claim_fees.
    #[account(
        mut,
        constraint = user_usdc.mint  == protocol_state.usdc_mint @ SoladromeError::InvalidAmount,
        constraint = user_usdc.owner == user.key()               @ SoladromeError::Unauthorized,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump,
    )]
    pub user_position: Account<'info, UserPosition>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RepayUsdc<'info> {
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(
        mut,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump = user_position.bump,
    )]
    pub user_position: Account<'info, UserPosition>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_usdc.mint == protocol_state.usdc_mint @ SoladromeError::InvalidAmount,
        token::authority = user,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Authority-only: register a protocol partner allocation.
/// Creates a PartnerAllocation PDA keyed on the partner's wallet.
#[derive(Accounts)]
pub struct BorrowAgainstLocked<'info> {
    #[account(mut)]
    pub partner: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    /// The vote-locked position used as collateral (collateral ceiling = amount_locked).
    #[account(
        seeds = [VELOCK_SEED, partner.key().as_ref()],
        bump = lock_position.bump,
    )]
    pub lock_position: Box<Account<'info, VeLockPosition>>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(address = protocol_state.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = partner,
        associated_token::mint      = usdc_mint,
        associated_token::authority = partner,
    )]
    pub partner_usdc: Box<Account<'info, TokenAccount>>,

    /// Tracks cumulative borrow (same PDA as UserPosition → repay via repay_usdc).
    #[account(
        init_if_needed,
        payer = partner,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, partner.key().as_ref()],
        bump,
    )]
    pub partner_position: Box<Account<'info, UserPosition>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
