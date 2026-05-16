// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Christophe Hertecant

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, Token, TokenAccount, Transfer},
};

use crate::amm::AMM_POOL_SEED;
use crate::amm_math::{self, MINIMUM_LIQUIDITY};
use crate::amm_state::AmmPool;
use crate::errors::SoladromeError;
use crate::math;
use crate::state::{PolState, ProtocolState};
use crate::{LP_DEAD_PUBKEY, STATE_SEED};

pub const POL_SEED:           &[u8] = b"pol";
pub const POL_USDC_VAULT_SEED: &[u8] = b"pol_usdc_vault";
pub const POL_SOLA_ATA_SEED:  &[u8] = b"pol_sola_ata";
pub const POL_LP_VAULT_SEED:  &[u8] = b"pol_lp_vault";

// ── Instructions ──────────────────────────────────────────────────────────────

/// One-time setup: create the PolState PDA and its two token holding accounts.
/// Authority-only. pol_lp_vault is created lazily on the first deploy_pol call.
pub fn initialize_pol(
    ctx:          Context<InitializePol>,
    pol_split_bps: u16,
    target_pool:  Pubkey,
) -> Result<()> {
    require!(pol_split_bps <= 5_000, SoladromeError::InvalidAmount); // max 50 %

    let pol          = &mut ctx.accounts.pol_state;
    pol.pol_split_bps    = pol_split_bps;
    pol.target_pool      = target_pool;
    pol.usdc_accumulated = 0;
    pol.bump             = ctx.bumps.pol_state;
    Ok(())
}

/// Redirect a portion of market_vault USDC into pol_usdc_vault.
/// Advances the fee accumulator first so stakers' pending fees are preserved.
pub fn collect_to_pol(ctx: Context<CollectToPol>, amount: u64) -> Result<()> {
    require!(amount > 0, SoladromeError::InvalidAmount);

    let market_balance = ctx.accounts.market_vault.amount;
    require!(market_balance >= amount, SoladromeError::InvalidAmount);

    // Lock in stakers' share before removing from market_vault.
    let acc = math::advance_accumulator(
        ctx.accounts.protocol_state.fees_per_hi_sola,
        market_balance,
        ctx.accounts.protocol_state.last_market_vault_balance,
        ctx.accounts.protocol_state.total_hi_sola,
    );

    let state_bump   = ctx.accounts.protocol_state.bump;
    let state_seeds: &[&[u8]] = &[STATE_SEED, &[state_bump]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.market_vault.to_account_info(),
                to:        ctx.accounts.pol_usdc_vault.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[state_seeds],
        ),
        amount,
    )?;

    let s = &mut ctx.accounts.protocol_state;
    s.fees_per_hi_sola         = acc;
    s.last_market_vault_balance = market_balance - amount;

    ctx.accounts.pol_state.usdc_accumulated = ctx
        .accounts.pol_state.usdc_accumulated
        .checked_add(amount)
        .ok_or(SoladromeError::Overflow)?;

    Ok(())
}

/// Compound operation: buy SOLA via bonding curve and/or add LP to the target pool.
///
/// Phase 1 (usdc_for_sola > 0): executes a buy on the bonding curve using
///   pol_usdc_vault as the payer. Minted SOLA lands in pol_sola_ata.
///
/// Phase 2 (sola_for_lp > 0): deposits sola_for_lp SOLA from pol_sola_ata and
///   usdc_for_lp USDC from pol_usdc_vault into the target AMM pool. LP tokens
///   are held permanently in pol_lp_vault.
pub fn deploy_pol(
    ctx:          Context<DeployPol>,
    usdc_for_sola: u64,
    min_sola_out:  u64,
    sola_for_lp:   u64,
    usdc_for_lp:   u64,
    min_lp:        u64,
) -> Result<()> {
    // ── Budget validation ─────────────────────────────────────────────────────
    let total_usdc = usdc_for_sola
        .checked_add(usdc_for_lp)
        .ok_or(SoladromeError::Overflow)?;
    require!(total_usdc > 0, SoladromeError::InvalidAmount);
    require!(
        ctx.accounts.pol_usdc_vault.amount >= total_usdc,
        SoladromeError::InvalidAmount
    );

    // ── Snapshot reads before mutable borrows ─────────────────────────────────
    let state_bump = ctx.accounts.protocol_state.bump;
    let pol_bump   = ctx.accounts.pol_state.bump;
    let vu         = ctx.accounts.protocol_state.virtual_usdc;
    let vs         = ctx.accounts.protocol_state.virtual_sola;
    let k_val      = ctx.accounts.protocol_state.k;

    let pool_reserve_a    = ctx.accounts.pool.reserve_a;
    let pool_reserve_b    = ctx.accounts.pool.reserve_b;
    let pool_total_lp     = ctx.accounts.pool.total_lp;
    let pool_token_a_mint = ctx.accounts.pool.token_a_mint;
    let pool_token_b_mint = ctx.accounts.pool.token_b_mint;
    let pool_bump         = ctx.accounts.pool.bump;
    let pre_sola_balance  = ctx.accounts.pol_sola_ata.amount;

    let pol_seeds:   &[&[u8]] = &[POL_SEED, &[pol_bump]];
    let state_seeds: &[&[u8]] = &[STATE_SEED, &[state_bump]];
    let pool_seeds:  &[&[u8]] = &[
        AMM_POOL_SEED,
        pool_token_a_mint.as_ref(),
        pool_token_b_mint.as_ref(),
        &[pool_bump],
    ];

    // ── Phase 1: Buy SOLA via bonding curve ───────────────────────────────────
    let sola_minted: u64 = if usdc_for_sola > 0 {
        let sola_amount = math::sola_out(vu, vs, k_val, usdc_for_sola)?;
        require!(sola_amount >= min_sola_out, SoladromeError::SlippageExceeded);
        require!(sola_amount > 0, SoladromeError::InvalidAmount);

        let floor_amount  = sola_amount;
        let market_amount = usdc_for_sola
            .checked_sub(floor_amount)
            .ok_or(SoladromeError::Overflow)?;

        // pol_usdc_vault → floor_vault (1:1 backing)
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.pol_usdc_vault.to_account_info(),
                    to:        ctx.accounts.floor_vault.to_account_info(),
                    authority: ctx.accounts.pol_state.to_account_info(),
                },
                &[pol_seeds],
            ),
            floor_amount,
        )?;

        // pol_usdc_vault → market_vault (excess above floor)
        if market_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from:      ctx.accounts.pol_usdc_vault.to_account_info(),
                        to:        ctx.accounts.market_vault.to_account_info(),
                        authority: ctx.accounts.pol_state.to_account_info(),
                    },
                    &[pol_seeds],
                ),
                market_amount,
            )?;
        }

        // Mint SOLA to pol_sola_ata
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.sola_mint.to_account_info(),
                    to:        ctx.accounts.pol_sola_ata.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[state_seeds],
            ),
            sola_amount,
        )?;

        // Update bonding curve state (scoped borrow)
        {
            let s = &mut ctx.accounts.protocol_state;
            s.virtual_usdc = s.virtual_usdc
                .checked_add(usdc_for_sola).ok_or(SoladromeError::Overflow)?;
            s.virtual_sola = s.virtual_sola
                .checked_sub(sola_amount).ok_or(SoladromeError::Overflow)?;
            s.total_sola = s.total_sola
                .checked_add(sola_amount).ok_or(SoladromeError::Overflow)?;
            s.accumulated_fees = s.accumulated_fees
                .checked_add(market_amount).ok_or(SoladromeError::Overflow)?;
        }

        sola_amount
    } else {
        0
    };

    // ── Phase 2: Add LP to target pool ────────────────────────────────────────
    if sola_for_lp > 0 {
        require!(usdc_for_lp > 0, SoladromeError::ZeroLiquidity);

        let available_sola = pre_sola_balance
            .checked_add(sola_minted)
            .ok_or(SoladromeError::Overflow)?;
        require!(sola_for_lp <= available_sola, SoladromeError::InvalidAmount);

        // Which pool vault holds SOLA?
        let sola_is_a = pool_token_a_mint == ctx.accounts.protocol_state.sola_mint;

        let (amount_a_desired, amount_b_desired) = if sola_is_a {
            (sola_for_lp, usdc_for_lp)
        } else {
            (usdc_for_lp, sola_for_lp)
        };

        let (lp_out, actual_a, actual_b) = amm_math::lp_for_deposit(
            pool_reserve_a,
            pool_reserve_b,
            pool_total_lp,
            amount_a_desired,
            amount_b_desired,
        )?;
        require!(lp_out >= min_lp, SoladromeError::SlippageExceeded);

        let (actual_sola, actual_usdc) = if sola_is_a {
            (actual_a, actual_b)
        } else {
            (actual_b, actual_a)
        };

        // pol_sola_ata → pool SOLA vault
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pol_sola_ata.to_account_info(),
                    to:   if sola_is_a {
                              ctx.accounts.pool_token_a_vault.to_account_info()
                          } else {
                              ctx.accounts.pool_token_b_vault.to_account_info()
                          },
                    authority: ctx.accounts.pol_state.to_account_info(),
                },
                &[pol_seeds],
            ),
            actual_sola,
        )?;

        // pol_usdc_vault → pool USDC vault
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pol_usdc_vault.to_account_info(),
                    to:   if sola_is_a {
                              ctx.accounts.pool_token_b_vault.to_account_info()
                          } else {
                              ctx.accounts.pool_token_a_vault.to_account_info()
                          },
                    authority: ctx.accounts.pol_state.to_account_info(),
                },
                &[pol_seeds],
            ),
            actual_usdc,
        )?;

        // First deposit: lock MINIMUM_LIQUIDITY to dead address
        if pool_total_lp == 0 {
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint:      ctx.accounts.lp_mint.to_account_info(),
                        to:        ctx.accounts.lp_dead_ata.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    &[pool_seeds],
                ),
                MINIMUM_LIQUIDITY,
            )?;
        }

        // Mint LP tokens to pol_lp_vault (permanently held)
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.lp_mint.to_account_info(),
                    to:        ctx.accounts.pol_lp_vault.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            lp_out,
        )?;

        // Update pool reserves
        {
            let pool = &mut ctx.accounts.pool;
            pool.reserve_a = pool.reserve_a.checked_add(actual_a).ok_or(SoladromeError::Overflow)?;
            pool.reserve_b = pool.reserve_b.checked_add(actual_b).ok_or(SoladromeError::Overflow)?;
            pool.total_lp  = pool.total_lp.checked_add(lp_out).ok_or(SoladromeError::Overflow)?;
        }
    }

    Ok(())
}

// ── Account Contexts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializePol<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [STATE_SEED],
        bump  = protocol_state.bump,
        has_one = authority @ SoladromeError::Unauthorized,
    )]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(
        init,
        payer = authority,
        space = 8 + PolState::LEN,
        seeds = [POL_SEED],
        bump,
    )]
    pub pol_state: Box<Account<'info, PolState>>,

    /// USDC accumulator vault — receives collect_to_pol transfers.
    #[account(
        init,
        payer = authority,
        token::mint      = usdc_mint,
        token::authority = pol_state,
        seeds = [POL_USDC_VAULT_SEED],
        bump,
    )]
    pub pol_usdc_vault: Box<Account<'info, TokenAccount>>,

    /// Staging account for SOLA bought before LP deployment.
    #[account(
        init,
        payer = authority,
        token::mint      = sola_mint,
        token::authority = pol_state,
        seeds = [POL_SOLA_ATA_SEED],
        bump,
    )]
    pub pol_sola_ata: Box<Account<'info, TokenAccount>>,

    #[account(address = protocol_state.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent:           Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CollectToPol<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [STATE_SEED],
        bump  = protocol_state.bump,
        has_one = authority @ SoladromeError::Unauthorized,
    )]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(
        mut,
        seeds = [POL_SEED],
        bump  = pol_state.bump,
    )]
    pub pol_state: Box<Account<'info, PolState>>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [POL_USDC_VAULT_SEED],
        bump,
        token::mint      = protocol_state.usdc_mint,
        token::authority = pol_state,
    )]
    pub pol_usdc_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DeployPol<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [STATE_SEED],
        bump  = protocol_state.bump,
        has_one = authority @ SoladromeError::Unauthorized,
    )]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// PolState — not mutated here; used only as a PDA signer.
    #[account(
        seeds = [POL_SEED],
        bump  = pol_state.bump,
        constraint = pol_state.target_pool == pool.key() @ SoladromeError::Unauthorized,
    )]
    pub pol_state: Box<Account<'info, PolState>>,

    // ── POL token vaults ──────────────────────────────────────────────────────

    #[account(
        mut,
        seeds = [POL_USDC_VAULT_SEED],
        bump,
        token::mint      = protocol_state.usdc_mint,
        token::authority = pol_state,
    )]
    pub pol_usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [POL_SOLA_ATA_SEED],
        bump,
        token::mint      = protocol_state.sola_mint,
        token::authority = pol_state,
    )]
    pub pol_sola_ata: Box<Account<'info, TokenAccount>>,

    /// Created on first deploy_pol call; LP tokens are held here permanently.
    #[account(
        init_if_needed,
        payer = authority,
        seeds = [POL_LP_VAULT_SEED],
        bump,
        token::mint      = lp_mint,
        token::authority = pol_state,
    )]
    pub pol_lp_vault: Box<Account<'info, TokenAccount>>,

    // ── Bonding curve accounts ─────────────────────────────────────────────────

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    // ── AMM pool ──────────────────────────────────────────────────────────────

    #[account(
        mut,
        seeds = [AMM_POOL_SEED, pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump  = pool.bump,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = pool.token_a_vault)]
    pub pool_token_a_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = pool.token_b_vault)]
    pub pool_token_b_vault: Box<Account<'info, TokenAccount>>,

    // ── MINIMUM_LIQUIDITY dead address (first deposit only) ───────────────────

    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint      = lp_mint,
        associated_token::authority = lp_dead,
    )]
    pub lp_dead_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: Canonical dead address — LP tokens sent here are permanently locked.
    #[account(address = LP_DEAD_PUBKEY)]
    pub lp_dead: UncheckedAccount<'info>,

    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
}
