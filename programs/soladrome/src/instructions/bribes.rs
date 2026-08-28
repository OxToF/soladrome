// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Bribe pots: deposit, claim, and roll unclaimed tokens forward.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::math::*;
use crate::state::*;

/// Permissionless: any protocol deposits bribe tokens to attract hiSOLA votes.
/// epoch must equal the current epoch — bribes target the live voting window.
pub fn deposit_bribe(ctx: Context<DepositBribe>, epoch: u64, amount: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(
        ctx.accounts.protocol_state.bribes_enabled,
        SoladromeError::FeatureDisabled
    );
    require!(amount > 0, SoladromeError::InvalidAmount);
    let clock = Clock::get()?;
    require!(
        epoch == current_epoch(clock.unix_timestamp),
        SoladromeError::WrongEpoch
    );

    // First-time vault init (pool_id starts as default when account is blank)
    if ctx.accounts.bribe_vault.pool_id == Pubkey::default() {
        ctx.accounts.bribe_vault.pool_id = ctx.accounts.pool_id.key();
        ctx.accounts.bribe_vault.reward_mint = ctx.accounts.reward_mint.key();
        ctx.accounts.bribe_vault.epoch = epoch;
        ctx.accounts.bribe_vault.bump = ctx.bumps.bribe_vault;
    }

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor_token.to_account_info(),
                to: ctx.accounts.bribe_token_vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
    )?;

    ctx.accounts.bribe_vault.total_bribed = ctx
        .accounts
        .bribe_vault
        .total_bribed
        .checked_add(amount)
        .ok_or(SoladromeError::Overflow)?;
    Ok(())
}

/// Claim pro-rata bribe after the voting epoch has ended.
/// claimable = total_bribed × user_votes / total_votes  (safe u128 muldiv)
/// Creating UserBribeClaim PDA is the idempotency guard (init = fails if exists).
pub fn claim_bribe(ctx: Context<ClaimBribe>, epoch: u64) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        epoch < current_epoch(clock.unix_timestamp),
        SoladromeError::EpochNotEnded
    );

    let total_votes = ctx.accounts.gauge_state.total_votes;
    let user_votes = ctx.accounts.user_vote_receipt.votes;
    let total_bribed = ctx.accounts.bribe_vault.total_bribed;
    require!(
        total_votes > 0 && user_votes > 0 && total_bribed > 0,
        SoladromeError::NothingToClaim
    );

    // Pro-rata muldiv in u128 to avoid overflow
    let claimable = (total_bribed as u128)
        .checked_mul(user_votes as u128)
        .ok_or(SoladromeError::Overflow)?
        .checked_div(total_votes as u128)
        .ok_or(SoladromeError::Overflow)? as u64;
    require!(claimable > 0, SoladromeError::NothingToClaim);

    // Sign with bribe_vault PDA
    let pool_key = ctx.accounts.pool_id.key();
    let mint_key = ctx.accounts.reward_mint.key();
    let epoch_le = epoch.to_le_bytes();
    let vault_bump = [ctx.accounts.bribe_vault.bump];
    let seeds: &[&[u8]] = &[
        b"bribe_vault",
        pool_key.as_ref(),
        mint_key.as_ref(),
        epoch_le.as_ref(),
        vault_bump.as_ref(),
    ];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bribe_token_vault.to_account_info(),
                to: ctx.accounts.user_reward_ata.to_account_info(),
                authority: ctx.accounts.bribe_vault.to_account_info(),
            },
            &[seeds],
        ),
        claimable,
    )?;

    // Stamp the claim PDA (existence = guard against replay)
    ctx.accounts.user_bribe_claim.bump = ctx.bumps.user_bribe_claim;
    Ok(())
}

/// Move remaining (unclaimed) bribe tokens from a past epoch into the current epoch vault.
///
/// Two cases:
///   • Zero-vote pool (gauge absent or total_votes == 0): rollover allowed immediately
///     after the epoch ends — nobody can ever claim, so recycling is safe.
///   • Pool with votes: a ROLLOVER_DELAY_EPOCHS grace period is enforced so that
///     slow voters are not robbed before they get a chance to claim.
///
/// Permissionless — anyone can call this for any (pool, token, old_epoch) triple.
pub fn rollover_bribe(ctx: Context<RolloverBribe>, old_epoch: u64, new_epoch: u64) -> Result<()> {
    let clock = Clock::get()?;
    let curr_epoch = current_epoch(clock.unix_timestamp);

    require!(new_epoch == curr_epoch, SoladromeError::WrongEpoch);
    require!(old_epoch < curr_epoch, SoladromeError::EpochNotEnded);

    // Verify old_gauge_state is the canonical PDA for (pool, old_epoch)
    let old_epoch_le = old_epoch.to_le_bytes();
    let (expected_gauge, _) = Pubkey::find_program_address(
        &[
            b"gauge",
            ctx.accounts.pool_id.key().as_ref(),
            old_epoch_le.as_ref(),
        ],
        ctx.program_id,
    );
    require_keys_eq!(
        ctx.accounts.old_gauge_state.key(),
        expected_gauge,
        SoladromeError::Unauthorized
    );

    // Check whether the old gauge recorded any votes.
    // Ownership must be verified first: the canonical PDA address can be
    // pre-occupied by a third-party program, and only an account actually
    // owned by THIS program holds real GaugeState vote data. A foreign or
    // uninitialized account ⇒ no real votes ⇒ rollover is allowed immediately
    // (prevents a forged account from faking votes to force the grace period).
    let owned_by_program = ctx.accounts.old_gauge_state.owner == ctx.program_id;
    let gauge_data = ctx.accounts.old_gauge_state.try_borrow_data()?;
    let has_votes = owned_by_program
        && gauge_data.len() >= 56
        && u64::from_le_bytes(gauge_data[48..56].try_into().unwrap()) > 0;
    drop(gauge_data);

    if has_votes {
        require!(
            curr_epoch >= old_epoch.saturating_add(ROLLOVER_DELAY_EPOCHS),
            SoladromeError::RolloverTooEarly
        );
    }

    let amount = ctx.accounts.old_bribe_token_vault.amount;
    require!(amount > 0, SoladromeError::NothingToClaim);

    // Transfer: sign as old_bribe_vault PDA
    let pool_key = ctx.accounts.pool_id.key();
    let mint_key = ctx.accounts.reward_mint.key();
    let vault_bump = [ctx.accounts.old_bribe_vault.bump];
    let seeds: &[&[u8]] = &[
        b"bribe_vault",
        pool_key.as_ref(),
        mint_key.as_ref(),
        old_epoch_le.as_ref(),
        vault_bump.as_ref(),
    ];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.old_bribe_token_vault.to_account_info(),
                to: ctx.accounts.new_bribe_token_vault.to_account_info(),
                authority: ctx.accounts.old_bribe_vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    // Initialise new vault on first rollover/deposit
    if ctx.accounts.new_bribe_vault.pool_id == Pubkey::default() {
        ctx.accounts.new_bribe_vault.pool_id = ctx.accounts.pool_id.key();
        ctx.accounts.new_bribe_vault.reward_mint = ctx.accounts.reward_mint.key();
        ctx.accounts.new_bribe_vault.epoch = new_epoch;
        ctx.accounts.new_bribe_vault.bump = ctx.bumps.new_bribe_vault;
    }

    ctx.accounts.new_bribe_vault.total_bribed = ctx
        .accounts
        .new_bribe_vault
        .total_bribed
        .checked_add(amount)
        .ok_or(SoladromeError::Overflow)?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct DepositBribe<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// Read-only — used only for the pause check.
    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// CHECK: External pool address used as bribe label — validation by seeds only.
    pub pool_id: UncheckedAccount<'info>,

    pub reward_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = reward_mint, token::authority = depositor)]
    pub depositor_token: Box<Account<'info, TokenAccount>>,

    /// Bribe metadata account. init_if_needed = multiple depositors additive.
    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + BribeVault::LEN,
        seeds = [b"bribe_vault", pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub bribe_vault: Box<Account<'info, BribeVault>>,

    /// Token account holding the deposited bribe tokens. Owned by bribe_vault PDA.
    #[account(
        init_if_needed,
        payer = depositor,
        token::mint = reward_mint,
        token::authority = bribe_vault,
        seeds = [b"bribe_tokens", pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub bribe_token_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct ClaimBribe<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: Pool label — validated by seeds derivation.
    pub pool_id: UncheckedAccount<'info>,

    pub reward_mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [b"bribe_vault", pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump = bribe_vault.bump,
    )]
    pub bribe_vault: Box<Account<'info, BribeVault>>,

    #[account(
        mut,
        seeds = [b"bribe_tokens", pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = bribe_vault,
    )]
    pub bribe_token_vault: Box<Account<'info, TokenAccount>>,

    /// Destination — created if the user doesn't already hold this token.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = reward_mint,
        associated_token::authority = user,
    )]
    pub user_reward_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        seeds = [b"gauge", pool_id.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump = gauge_state.bump,
    )]
    pub gauge_state: Box<Account<'info, GaugeState>>,

    #[account(
        seeds = [b"vote", user.key().as_ref(), pool_id.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump = user_vote_receipt.bump,
    )]
    pub user_vote_receipt: Box<Account<'info, UserVoteReceipt>>,

    /// Created by this instruction — its existence is the double-claim guard.
    #[account(
        init,
        payer = user,
        space = 8 + UserBribeClaim::LEN,
        seeds = [b"bribe_claim", user.key().as_ref(), pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub user_bribe_claim: Account<'info, UserBribeClaim>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Transfer remaining bribe tokens from a past epoch's vault into the current epoch's vault.
/// Permissionless — callable by anyone once the grace period has passed.
#[derive(Accounts)]
#[instruction(old_epoch: u64, new_epoch: u64)]
pub struct RolloverBribe<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Pool label — seeds validated in instruction body.
    pub pool_id: UncheckedAccount<'info>,

    pub reward_mint: Box<Account<'info, Mint>>,

    /// Source: old epoch bribe metadata.
    #[account(
        seeds = [b"bribe_vault", pool_id.key().as_ref(), reward_mint.key().as_ref(), old_epoch.to_le_bytes().as_ref()],
        bump = old_bribe_vault.bump,
    )]
    pub old_bribe_vault: Box<Account<'info, BribeVault>>,

    /// Source: old epoch token vault.
    #[account(
        mut,
        seeds = [b"bribe_tokens", pool_id.key().as_ref(), reward_mint.key().as_ref(), old_epoch.to_le_bytes().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = old_bribe_vault,
    )]
    pub old_bribe_token_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: GaugeState for (pool, old_epoch) — may be absent if no votes were cast.
    /// PDA seeds [b"gauge", pool_id, old_epoch_le8] verified in instruction body.
    pub old_gauge_state: UncheckedAccount<'info>,

    /// Destination: current epoch bribe metadata (created if not yet seeded).
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + BribeVault::LEN,
        seeds = [b"bribe_vault", pool_id.key().as_ref(), reward_mint.key().as_ref(), new_epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub new_bribe_vault: Box<Account<'info, BribeVault>>,

    /// Destination: current epoch token vault (created if not yet seeded).
    #[account(
        init_if_needed,
        payer = payer,
        token::mint = reward_mint,
        token::authority = new_bribe_vault,
        seeds = [b"bribe_tokens", pool_id.key().as_ref(), reward_mint.key().as_ref(), new_epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub new_bribe_token_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
