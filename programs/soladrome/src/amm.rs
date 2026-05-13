// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Christophe Hertecant

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer},
};

use crate::amm_math::{self, MINIMUM_LIQUIDITY};
use crate::amm_state::{AmmPool, sort_mints};
use crate::errors::SoladromeError;
use crate::state::ProtocolState;
use crate::STATE_SEED;

// ── Constants ─────────────────────────────────────────────────────────────────
pub const AMM_POOL_SEED:  &[u8] = b"amm_pool";
pub const LP_MINT_SEED:   &[u8] = b"lp_mint";
pub const VAULT_A_SEED:   &[u8] = b"vault_a";
pub const VAULT_B_SEED:   &[u8] = b"vault_b";

pub const MAX_FEE_RATE:        u16 = 1_000; // 10% max swap fee
pub const MAX_PROTOCOL_FEE:    u16 = 5_000; // 50% of fee max to protocol

// ── Instructions ──────────────────────────────────────────────────────────────

/// Create a new volatile (xy=k) AMM pool for any two distinct token mints.
/// Permissionless — anyone can create a pool.
/// Mints are sorted internally so (A, B) and (B, A) map to the same pool.
pub fn create_pool(
    ctx: Context<CreatePool>,
    fee_rate: u16,
    protocol_fee_bps: u16,
) -> Result<()> {
    require!(fee_rate <= MAX_FEE_RATE, SoladromeError::InvalidAmount);
    require!(protocol_fee_bps <= MAX_PROTOCOL_FEE, SoladromeError::InvalidAmount);

    let mint_a_key = ctx.accounts.token_a_mint.key();
    let mint_b_key = ctx.accounts.token_b_mint.key();
    require!(mint_a_key != mint_b_key, SoladromeError::InvalidPoolTokens);

    let (sorted_a, sorted_b) = sort_mints(mint_a_key, mint_b_key);
    require!(
        sorted_a == mint_a_key && sorted_b == mint_b_key,
        SoladromeError::InvalidPoolTokens
    );

    let pool = &mut ctx.accounts.pool;
    pool.token_a_mint     = mint_a_key;
    pool.token_b_mint     = mint_b_key;
    pool.token_a_vault    = ctx.accounts.token_a_vault.key();
    pool.token_b_vault    = ctx.accounts.token_b_vault.key();
    pool.lp_mint          = ctx.accounts.lp_mint.key();
    pool.fee_rate         = fee_rate;
    pool.protocol_fee_bps = protocol_fee_bps;
    pool.total_lp         = 0;
    pool.reserve_a        = 0;
    pool.reserve_b        = 0;
    pool.bump             = ctx.bumps.pool;
    Ok(())
}

/// Deposit token_a and token_b, receive LP tokens.
/// First deposit sets the price; subsequent deposits must match the current ratio.
pub fn add_liquidity(
    ctx: Context<AddLiquidity>,
    amount_a_desired: u64,
    amount_b_desired: u64,
    min_lp: u64,
) -> Result<()> {
    let pool = &ctx.accounts.pool;
    let (lp_out, actual_a, actual_b) = amm_math::lp_for_deposit(
        pool.reserve_a,
        pool.reserve_b,
        pool.total_lp,
        amount_a_desired,
        amount_b_desired,
    )?;
    require!(lp_out >= min_lp, SoladromeError::SlippageExceeded);

    // Transfer token A from user → vault_a
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.user_token_a.to_account_info(),
                to:        ctx.accounts.token_a_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        actual_a,
    )?;

    // Transfer token B from user → vault_b
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.user_token_b.to_account_info(),
                to:        ctx.accounts.token_b_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        actual_b,
    )?;

    let pool_key = ctx.accounts.pool.key();
    let pool_bump = ctx.accounts.pool.bump;
    let seeds: &[&[u8]] = &[AMM_POOL_SEED,
        ctx.accounts.pool.token_a_mint.as_ref(),
        ctx.accounts.pool.token_b_mint.as_ref(),
        &[pool_bump],
    ];
    let _ = pool_key; // suppress unused warning

    // Mint MINIMUM_LIQUIDITY to a dead address on first deposit (locked forever)
    if ctx.accounts.pool.total_lp == 0 {
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.lp_mint.to_account_info(),
                    to:        ctx.accounts.lp_dead.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            MINIMUM_LIQUIDITY,
        )?;
    }

    // Mint lp_out to user
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint:      ctx.accounts.lp_mint.to_account_info(),
                to:        ctx.accounts.user_lp.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[seeds],
        ),
        lp_out,
    )?;

    let pool = &mut ctx.accounts.pool;
    pool.reserve_a = pool.reserve_a.checked_add(actual_a).ok_or(SoladromeError::Overflow)?;
    pool.reserve_b = pool.reserve_b.checked_add(actual_b).ok_or(SoladromeError::Overflow)?;
    pool.total_lp  = pool.total_lp.checked_add(lp_out).ok_or(SoladromeError::Overflow)?;
    Ok(())
}

/// Burn LP tokens, receive proportional token_a and token_b back.
pub fn remove_liquidity(
    ctx: Context<RemoveLiquidity>,
    lp_amount: u64,
    min_a: u64,
    min_b: u64,
) -> Result<()> {
    let pool = &ctx.accounts.pool;
    let (amount_a, amount_b) = amm_math::tokens_for_lp(
        pool.reserve_a,
        pool.reserve_b,
        pool.total_lp,
        lp_amount,
    )?;
    require!(amount_a >= min_a && amount_b >= min_b, SoladromeError::SlippageExceeded);

    // Burn LP tokens from user
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint:      ctx.accounts.lp_mint.to_account_info(),
                from:      ctx.accounts.user_lp.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        lp_amount,
    )?;

    let pool_bump = ctx.accounts.pool.bump;
    let seeds: &[&[u8]] = &[AMM_POOL_SEED,
        ctx.accounts.pool.token_a_mint.as_ref(),
        ctx.accounts.pool.token_b_mint.as_ref(),
        &[pool_bump],
    ];

    // Transfer token A from vault_a → user
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.token_a_vault.to_account_info(),
                to:        ctx.accounts.user_token_a.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[seeds],
        ),
        amount_a,
    )?;

    // Transfer token B from vault_b → user
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.token_b_vault.to_account_info(),
                to:        ctx.accounts.user_token_b.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[seeds],
        ),
        amount_b,
    )?;

    let pool = &mut ctx.accounts.pool;
    pool.reserve_a = pool.reserve_a.checked_sub(amount_a).ok_or(SoladromeError::Overflow)?;
    pool.reserve_b = pool.reserve_b.checked_sub(amount_b).ok_or(SoladromeError::Overflow)?;
    pool.total_lp  = pool.total_lp.checked_sub(lp_amount).ok_or(SoladromeError::Overflow)?;
    Ok(())
}

/// Swap token_in for token_out via the pool's xy=k curve.
/// a_to_b: true  → sell token_a, receive token_b
///         false → sell token_b, receive token_a
/// Fee split: LP portion stays in reserves, protocol portion → market_vault.
pub fn swap(
    ctx: Context<Swap>,
    amount_in: u64,
    min_out: u64,
    a_to_b: bool,
) -> Result<()> {
    require!(amount_in > 0, SoladromeError::InvalidAmount);

    let pool        = &ctx.accounts.pool;
    let fee_rate    = pool.fee_rate as u128;
    let proto_bps   = pool.protocol_fee_bps as u128;

    // Fee computation (all in u128 to avoid overflow)
    let amount_in_u128  = amount_in as u128;
    let fee_total       = amount_in_u128 * fee_rate / 10_000;
    let fee_protocol    = fee_total * proto_bps / 10_000;
    let amount_in_net   = amount_in_u128 - fee_total;

    let (reserve_in, reserve_out) = if a_to_b {
        (pool.reserve_a, pool.reserve_b)
    } else {
        (pool.reserve_b, pool.reserve_a)
    };

    let amount_out = amm_math::swap_out(reserve_in, reserve_out, amount_in_net as u64)?;
    require!(amount_out >= min_out, SoladromeError::SlippageExceeded);

    let pool_bump = pool.bump;
    let state_bump = ctx.accounts.protocol_state.bump;
    let pool_seeds: &[&[u8]] = &[AMM_POOL_SEED,
        ctx.accounts.pool.token_a_mint.as_ref(),
        ctx.accounts.pool.token_b_mint.as_ref(),
        &[pool_bump],
    ];
    let state_seeds: &[&[u8]] = &[STATE_SEED, &[state_bump]];

    // Transfer amount_in from user → vault_in
    let (vault_in, vault_out, user_in, user_out) = if a_to_b {
        (
            ctx.accounts.token_a_vault.to_account_info(),
            ctx.accounts.token_b_vault.to_account_info(),
            ctx.accounts.user_token_in.to_account_info(),
            ctx.accounts.user_token_out.to_account_info(),
        )
    } else {
        (
            ctx.accounts.token_b_vault.to_account_info(),
            ctx.accounts.token_a_vault.to_account_info(),
            ctx.accounts.user_token_in.to_account_info(),
            ctx.accounts.user_token_out.to_account_info(),
        )
    };

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer { from: user_in, to: vault_in, authority: ctx.accounts.user.to_account_info() },
        ),
        amount_in,
    )?;

    // Transfer amount_out from vault_out → user
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer { from: vault_out, to: user_out, authority: ctx.accounts.pool.to_account_info() },
            &[pool_seeds],
        ),
        amount_out,
    )?;

    // Transfer protocol fee (in the input token) from vault_in → market_vault
    if fee_protocol > 0 {
        let fee_proto_u64 = fee_protocol as u64;
        // Route protocol fee: transfer from the input vault to market_vault via pool PDA
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      if a_to_b { ctx.accounts.token_a_vault.to_account_info() }
                               else      { ctx.accounts.token_b_vault.to_account_info() },
                    to:        ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            fee_proto_u64,
        )?;

        // Update protocol state fee accumulator snapshot
        let _ = state_seeds;
        ctx.accounts.protocol_state.accumulated_fees = ctx
            .accounts.protocol_state.accumulated_fees
            .saturating_add(fee_proto_u64);
    }

    // Update pool reserves
    let pool = &mut ctx.accounts.pool;
    if a_to_b {
        // reserve_a increases by (amount_in - fee_protocol), reserve_b decreases by amount_out
        let net_a = (amount_in as u128 - fee_protocol) as u64;
        pool.reserve_a = pool.reserve_a.checked_add(net_a).ok_or(SoladromeError::Overflow)?;
        pool.reserve_b = pool.reserve_b.checked_sub(amount_out).ok_or(SoladromeError::Overflow)?;
    } else {
        let net_b = (amount_in as u128 - fee_protocol) as u64;
        pool.reserve_b = pool.reserve_b.checked_add(net_b).ok_or(SoladromeError::Overflow)?;
        pool.reserve_a = pool.reserve_a.checked_sub(amount_out).ok_or(SoladromeError::Overflow)?;
    }
    Ok(())
}

// ── Account Contexts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_a_mint: Box<Account<'info, Mint>>,
    pub token_b_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        space = AmmPool::LEN,
        seeds = [AMM_POOL_SEED, token_a_mint.key().as_ref(), token_b_mint.key().as_ref()],
        bump,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    #[account(
        init,
        payer = creator,
        mint::decimals = 6,
        mint::authority = pool,
        seeds = [LP_MINT_SEED, pool.key().as_ref()],
        bump,
    )]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        token::mint = token_a_mint,
        token::authority = pool,
        seeds = [VAULT_A_SEED, pool.key().as_ref()],
        bump,
    )]
    pub token_a_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = creator,
        token::mint = token_b_mint,
        token::authority = pool,
        seeds = [VAULT_B_SEED, pool.key().as_ref()],
        bump,
    )]
    pub token_b_vault: Box<Account<'info, TokenAccount>>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent:           Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [AMM_POOL_SEED, pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = pool.token_a_vault)]
    pub token_a_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = pool.token_b_vault)]
    pub token_b_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = pool.token_a_mint, token::authority = user)]
    pub user_token_a: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = pool.token_b_mint, token::authority = user)]
    pub user_token_b: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = lp_mint,
        associated_token::authority = user,
    )]
    pub user_lp: Box<Account<'info, TokenAccount>>,

    /// Dead address ATA to receive MINIMUM_LIQUIDITY on first deposit.
    /// CHECK: Any address is fine — tokens sent here are permanently locked.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = lp_mint,
        associated_token::authority = lp_dead,
    )]
    pub lp_dead_ata: Box<Account<'info, TokenAccount>>,

    /// CHECK: The dead address itself — must equal the canonical dead pubkey.
    #[account(address = crate::LP_DEAD_PUBKEY)]
    pub lp_dead: UncheckedAccount<'info>,

    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [AMM_POOL_SEED, pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = pool.token_a_vault)]
    pub token_a_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = pool.token_b_vault)]
    pub token_b_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, token::mint = lp_mint, token::authority = user)]
    pub user_lp: Box<Account<'info, TokenAccount>>,

    /// User's token-A ATA (must already exist; created during add_liquidity).
    #[account(mut)]
    pub user_token_a: Box<Account<'info, TokenAccount>>,

    /// User's token-B ATA (must already exist; created during add_liquidity).
    #[account(mut)]
    pub user_token_b: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [AMM_POOL_SEED, pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    #[account(mut, address = pool.token_a_vault)]
    pub token_a_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = pool.token_b_vault)]
    pub token_b_vault: Box<Account<'info, TokenAccount>>,

    /// User's input token ATA (token_a if a_to_b, token_b otherwise).
    #[account(mut)]
    pub user_token_in: Box<Account<'info, TokenAccount>>,

    /// User's output token ATA.
    #[account(mut)]
    pub user_token_out: Box<Account<'info, TokenAccount>>,

    /// Protocol market vault — receives the protocol fee portion (in input token).
    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    pub token_program: Program<'info, Token>,
}
