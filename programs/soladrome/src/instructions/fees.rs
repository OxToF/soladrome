// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs

//! Pool protocol fees: pay what a pool's ledger owes to its voters (and to the operating company).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::math::current_epoch;
use crate::state::{AmmPool, BribeVault, CompanyConfig, ProtocolState};

/// Pay one side of a pool's owed protocol fees out of its vault. Permissionless crank.
///
/// The voters' part lands in the pool's bribe pot for the CURRENT epoch — the same
/// `[bribe_vault, pool, mint, epoch]` pot a partner's `deposit_bribe` fills — so it is claimed
/// with `claim_bribe` by whoever voted for this pool this epoch, pro rata, and rolled over by
/// `rollover_bribe` if nobody did. No new claim path, no new accounting.
///
/// Fees booked during epoch E and collected in E+1 go to E+1's voters. That is the price of a
/// crank instead of a CPI on every swap, and it is symmetric: nothing is lost, and a voter who
/// keeps voting for a pool keeps being paid by it.
///
/// The company's part (`CompanyConfig::fee_bps`, 0 until the company exists) goes to the
/// company wallet's token account for this mint.
pub fn collect_pool_fees(ctx: Context<CollectPoolFees>, epoch: u64, side_a: bool) -> Result<()> {
    let state = &ctx.accounts.protocol_state;
    require!(!state.paused, SoladromeError::ProtocolPaused);
    require!(state.bribes_enabled, SoladromeError::FeatureDisabled);
    require!(
        epoch == current_epoch(Clock::get()?.unix_timestamp),
        SoladromeError::WrongEpoch
    );

    let pool = &ctx.accounts.pool;
    let (mint, vault, owed) = if side_a {
        (pool.token_a_mint, pool.token_a_vault, pool.protocol_fees_a)
    } else {
        (pool.token_b_mint, pool.token_b_vault, pool.protocol_fees_b)
    };
    require_keys_eq!(
        ctx.accounts.mint.key(),
        mint,
        SoladromeError::InvalidPoolTokens
    );
    require_keys_eq!(
        ctx.accounts.pool_vault.key(),
        vault,
        SoladromeError::InvalidPoolTokens
    );
    require!(owed > 0, SoladromeError::NothingToClaim);

    // ☢️ Read at its canonical address, never optional: see `CompanyConfig`. An account that
    // this program does not own, or that is empty, is "no company yet" — 0 %.
    let company = {
        let info = ctx.accounts.company_config.to_account_info();
        if info.owner == ctx.program_id && info.data_len() > 0 {
            let data = info.try_borrow_data()?;
            Some(CompanyConfig::try_deserialize(&mut &data[..])?)
        } else {
            None
        }
    };
    let company_bps = company.as_ref().map_or(0, |c| c.fee_bps);
    // `MAX_COMPANY_FEE_BPS` re-applied here, not only in the setter: the bound in the binary is
    // what the voters rely on.
    let company_cut =
        ((owed as u128) * (company_bps.min(MAX_COMPANY_FEE_BPS) as u128) / 10_000) as u64;
    let voters_cut = owed - company_cut;

    let (mint_a, mint_b, bump) = (pool.token_a_mint, pool.token_b_mint, pool.bump);
    let pool_seeds: &[&[u8]] = &[AMM_POOL_SEED, mint_a.as_ref(), mint_b.as_ref(), &[bump]];
    let decimals = ctx.accounts.mint.decimals;

    if company_cut > 0 {
        let wallet = company.as_ref().map(|c| c.wallet).unwrap_or_default();
        let dest = ctx
            .accounts
            .company_token
            .as_ref()
            .ok_or(SoladromeError::CompanyAccountRequired)?;
        require!(
            dest.owner == wallet && dest.mint == mint,
            SoladromeError::CompanyAccountRequired
        );
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.pool_vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: dest.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            company_cut,
            decimals,
        )?;
    }

    if voters_cut > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.pool_vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.bribe_token_vault.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            voters_cut,
            decimals,
        )?;
    }

    let pool_key = ctx.accounts.pool.key();
    let bv = &mut ctx.accounts.bribe_vault;
    if bv.pool_id == Pubkey::default() {
        bv.pool_id = pool_key;
        bv.reward_mint = mint;
        bv.epoch = epoch;
        bv.bump = ctx.bumps.bribe_vault;
    }
    bv.total_bribed = bv
        .total_bribed
        .checked_add(voters_cut)
        .ok_or(SoladromeError::Overflow)?;

    let pool = &mut ctx.accounts.pool;
    if side_a {
        pool.protocol_fees_a = 0;
    } else {
        pool.protocol_fees_b = 0;
    }
    msg!(
        "Pool fees collected: {} to voters (epoch {}), {} to the company",
        voters_cut,
        epoch,
        company_cut
    );
    Ok(())
}

/// Set the operating company's wallet and its share of collected pool fees. Authority-only.
///
/// `fee_bps` ≤ `MAX_COMPANY_FEE_BPS`, and a non-zero share needs a real wallet. Setting 0 turns
/// the share off without forgetting the wallet.
pub fn set_company_fee(ctx: Context<SetCompanyFee>, fee_bps: u16, wallet: Pubkey) -> Result<()> {
    require!(
        fee_bps <= MAX_COMPANY_FEE_BPS && (fee_bps == 0 || wallet != Pubkey::default()),
        SoladromeError::CompanyFeeInvalid
    );
    let c = &mut ctx.accounts.company_config;
    c.wallet = wallet;
    c.fee_bps = fee_bps;
    c.bump = ctx.bumps.company_config;
    msg!("Company fee: {} bps to {}", fee_bps, wallet);
    Ok(())
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct CollectPoolFees<'info> {
    /// Pays rent for the epoch's bribe pot if this is its first deposit.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(
        mut,
        seeds = [AMM_POOL_SEED, pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    /// The side being collected; checked against the pool in the handler.
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// That side's pool vault; checked against the pool in the handler.
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + BribeVault::LEN,
        seeds = [b"bribe_vault", pool.key().as_ref(), mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub bribe_vault: Box<Account<'info, BribeVault>>,

    #[account(
        init_if_needed,
        payer = payer,
        token::mint = mint,
        token::authority = bribe_vault,
        token::token_program = token_program,
        seeds = [b"bribe_tokens", pool.key().as_ref(), mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub bribe_token_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: the `CompanyConfig` PDA, read in the handler whether or not it exists.
    #[account(seeds = [COMPANY_CONFIG_SEED], bump)]
    pub company_config: UncheckedAccount<'info>,

    /// The company wallet's token account for `mint`. Required only while a share is due.
    #[account(mut)]
    pub company_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetCompanyFee<'info> {
    #[account(
        mut,
        address = protocol_state.authority @ SoladromeError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + CompanyConfig::LEN,
        seeds = [COMPANY_CONFIG_SEED],
        bump,
    )]
    pub company_config: Box<Account<'info, CompanyConfig>>,

    pub system_program: Program<'info, System>,
}
