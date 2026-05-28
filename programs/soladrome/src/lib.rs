// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Christophe Hertecant

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer},
};

mod errors;
mod math;
mod state;
mod amm_math;
mod amm_state;
mod amm;
mod pol;
mod ve;

use errors::SoladromeError;
use amm_state::AmmPool;
use state::{
    BribeVault, ContributorVesting, FounderHiSolaVesting, FounderVesting, GaugeState,
    GlobalEpochVotes, LpEpochClaim, LpPoolEpochAccum, LpUserCheckpoint, LpUserInfo,
    ProtocolState, UserBribeClaim, UserEpochVotes, UserPosition, UserVoteReceipt,
    PRECISION, EPOCH_DURATION, current_epoch,
    VESTING_CLIFF_SECS, VESTING_DURATION_SECS,
    CONTRIBUTOR_CLIFF_SECS, CONTRIBUTOR_DURATION_SECS,
    FLOOR_RESERVE_MIN_BPS,
};
pub use amm::*;
pub use pol::*;
pub use ve::*;

/// Canonical dead address for MINIMUM_LIQUIDITY lock (System Program address).
pub const LP_DEAD_PUBKEY: Pubkey = anchor_lang::system_program::ID;

declare_id!("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");

pub const STATE_SEED: &[u8] = b"state";
pub const POSITION_SEED: &[u8] = b"position";
pub const FLOOR_VAULT_SEED: &[u8] = b"floor_vault";
pub const MARKET_VAULT_SEED: &[u8] = b"market_vault";
pub const SOLA_VAULT_SEED: &[u8] = b"sola_vault";

pub const INIT_VIRTUAL_USDC: u64 = 100_000_000; // 100 USDC (6 dec)
pub const INIT_VIRTUAL_SOLA: u64 = 100_000_000; // 100 SOLA (6 dec)  – floor = 1:1

/// Total oSOLA minted per epoch, split proportionally across voted pools (legacy gauge system).
pub const LP_EMISSION_PER_EPOCH: u64 = 10_000 * 1_000_000; // 10 000 oSOLA (6 dec)

/// Continuous Masterchef-style oSOLA emission per pool per second (6 decimals).
/// devnet : 0.1 oSOLA/s  — high rate for fast visibility during testing.
/// mainnet: 0.001 oSOLA/s ≈ 86 oSOLA/pool/day — conservative, adjust before launch.
#[cfg(feature = "devnet")]
pub const OSOLA_EMISSION_PER_SEC: u64 = 100_000;
#[cfg(not(feature = "devnet"))]
pub const OSOLA_EMISSION_PER_SEC: u64 = 1_000;

/// Precision factor for the oSOLA-per-LP accumulator.
pub const LP_REWARD_PRECISION: u128 = 1_000_000_000_000; // 1e12

// Founder allocation — 12% of reference 100 M-token supply, 7% auto-staked.
pub const FOUNDER_TOTAL: u64    = 12_000_000_000_000; // 12 000 000 SOLA (6 dec)
pub const FOUNDER_STAKE: u64    =  7_000_000_000_000; //  7 000 000 SOLA → hiSOLA (governance)
/// 5 000 000 SOLA liquid — held in vesting vault, released linearly after cliff.
pub const FOUNDER_LIQUID: u64   =  5_000_000_000_000; // FOUNDER_TOTAL − FOUNDER_STAKE
pub const ECOSYSTEM_TOTAL: u64  =  2_000_000_000_000; //  2 000 000 SOLA — marketing + airdrop
/// One-time origination fee on each borrow (like Beradrome). Sent to market_vault → hiSOLA stakers.
pub const BORROW_FEE_BPS: u64   =    200;             //  2 % of borrowed amount
/// Founder borrow cap: max 10 % of total *claimed* hiSOLA ever borrowed.
/// Ensures the founder cannot drain the floor vault before organic users arrive.
pub const FOUNDER_BORROW_CAP_BPS: u64 = 1_000;       // 10 %

pub const FOUNDER_HI_VESTING_SEED: &[u8] = b"founder_hi_vesting";

// ⚠️ Mainnet founder wallet — hardcoded for security (cannot be redirected).
// This is the PERSONAL founder wallet, NOT the Soladrome treasury.
// Treasury: 46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4 (separate, no on-chain role)
pub const FOUNDER_WALLET: &str = "CL4yt4Ep6N3AKbbHhQaidjVLNzQrdgT5NobQSE6FGHr3";

// ── Contributor / marketing allocation ────────────────────────────────────────
pub const CONTRIBUTOR_SEED: &[u8] = b"contributor";
/// Contributor borrow cap: max 10 % of total *claimed* hiSOLA at borrow time.
/// Mirrors the founder logic — scales dynamically with actual claims.
pub const CONTRIBUTOR_BORROW_CAP_BPS: u64 = 1_000; // 10 %

#[program]
pub mod soladrome {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let s = &mut ctx.accounts.protocol_state;
        s.authority = ctx.accounts.authority.key();
        s.usdc_mint = ctx.accounts.usdc_mint.key();
        s.sola_mint = ctx.accounts.sola_mint.key();
        s.hi_sola_mint = ctx.accounts.hi_sola_mint.key();
        s.o_sola_mint = ctx.accounts.o_sola_mint.key();
        s.floor_vault = ctx.accounts.floor_vault.key();
        s.market_vault = ctx.accounts.market_vault.key();
        s.sola_vault = ctx.accounts.sola_vault.key();
        s.virtual_usdc = INIT_VIRTUAL_USDC;
        s.virtual_sola = INIT_VIRTUAL_SOLA;
        s.k = INIT_VIRTUAL_USDC as u128 * INIT_VIRTUAL_SOLA as u128;
        s.bump = ctx.bumps.protocol_state;
        Ok(())
    }

    // Deposit USDC → receive SOLA via constant-product curve.
    // USDC splits: floor vault (1:1 backing) + market vault (excess fees).
    pub fn buy_sola(ctx: Context<BuySola>, usdc_in: u64, min_sola_out: u64) -> Result<()> {
        let vu = ctx.accounts.protocol_state.virtual_usdc;
        let vs = ctx.accounts.protocol_state.virtual_sola;
        let k = ctx.accounts.protocol_state.k;
        let bump = ctx.accounts.protocol_state.bump;

        let sola_amount = math::sola_out(vu, vs, k, usdc_in)?;
        require!(sola_amount >= min_sola_out, SoladromeError::SlippageExceeded);
        require!(sola_amount > 0, SoladromeError::InvalidAmount);

        let floor_amount = sola_amount; // 1 USDC per SOLA (1:1, both 6 dec)
        let market_amount = usdc_in
            .checked_sub(floor_amount)
            .ok_or(SoladromeError::Overflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.floor_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            floor_amount,
        )?;

        if market_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_usdc.to_account_info(),
                        to: ctx.accounts.market_vault.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                market_amount,
            )?;
        }

        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.sola_mint.to_account_info(),
                    to: ctx.accounts.user_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            sola_amount,
        )?;

        let s = &mut ctx.accounts.protocol_state;
        s.virtual_usdc = s.virtual_usdc.checked_add(usdc_in).ok_or(SoladromeError::Overflow)?;
        s.virtual_sola = s.virtual_sola.checked_sub(sola_amount).ok_or(SoladromeError::Overflow)?;
        s.total_sola = s.total_sola.checked_add(sola_amount).ok_or(SoladromeError::Overflow)?;
        s.total_purchased_sola = s.total_purchased_sola.checked_add(sola_amount).ok_or(SoladromeError::Overflow)?;
        s.accumulated_fees = s.accumulated_fees.checked_add(market_amount).ok_or(SoladromeError::Overflow)?;
        Ok(())
    }

    // Burn SOLA → receive 1 USDC per SOLA from floor reserve.
    // Does not touch the virtual curve; market price stays the same.
    pub fn sell_sola(ctx: Context<SellSola>, sola_amount: u64) -> Result<()> {
        require!(sola_amount > 0, SoladromeError::InvalidAmount);
        let usdc_out = sola_amount;
        let bump = ctx.accounts.protocol_state.bump;

        require!(
            ctx.accounts.floor_vault.amount >= usdc_out,
            SoladromeError::InsufficientFloorReserve
        );

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.sola_mint.to_account_info(),
                    from: ctx.accounts.user_sola.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            sola_amount,
        )?;

        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
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
            usdc_out,
        )?;

        ctx.accounts.protocol_state.total_sola = ctx
            .accounts
            .protocol_state
            .total_sola
            .checked_sub(sola_amount)
            .ok_or(SoladromeError::Overflow)?;

        // ── Under-collateralisation guard ─────────────────────────────────────
        // Invariant: floor_vault + total_usdc_borrowed ≥ total_purchased_sola
        //
        // Only SOLA minted via buy_sola or exercise_o_sola carries 1 USDC of
        // floor backing. Founder/ecosystem allocations are excluded, preventing
        // unfinanced supply from blocking legitimate user redemptions.
        ctx.accounts.protocol_state.total_purchased_sola = ctx
            .accounts.protocol_state.total_purchased_sola
            .saturating_sub(sola_amount);

        let floor_post = ctx.accounts.floor_vault.amount
            .checked_sub(usdc_out)
            .ok_or(SoladromeError::Overflow)?;
        let backed = floor_post
            .checked_add(ctx.accounts.protocol_state.total_usdc_borrowed)
            .ok_or(SoladromeError::Overflow)?;
        require!(
            backed >= ctx.accounts.protocol_state.total_purchased_sola,
            SoladromeError::InsufficientFloorReserve
        );

        Ok(())
    }

    // Lock SOLA → mint hiSOLA 1:1 (governance + fee share + borrow rights).
    // Sets user's fees_debt to current accumulator so they don't claim past fees.
    pub fn stake_sola(ctx: Context<StakeSola>, sola_amount: u64) -> Result<()> {
        require!(sola_amount > 0, SoladromeError::InvalidAmount);

        // Snapshot accumulator before staking so new hiSOLA only earns future fees.
        let market_balance = ctx.accounts.market_vault.amount;
        let acc = math::advance_accumulator(
            ctx.accounts.protocol_state.fees_per_hi_sola,
            market_balance,
            ctx.accounts.protocol_state.last_market_vault_balance,
            ctx.accounts.protocol_state.total_hi_sola,
        );

        let bump = ctx.accounts.protocol_state.bump;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_sola.to_account_info(),
                    to: ctx.accounts.sola_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            sola_amount,
        )?;

        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.hi_sola_mint.to_account_info(),
                    to: ctx.accounts.user_hi_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            sola_amount,
        )?;

        // Init position if first interaction
        let position = &mut ctx.accounts.user_position;
        if position.owner == Pubkey::default() {
            position.owner = ctx.accounts.user.key();
            position.bump = ctx.bumps.user_position;
        }
        // Anchor entry point: debt = current accumulator (no retroactive claim)
        position.fees_debt = acc;

        let s = &mut ctx.accounts.protocol_state;
        s.fees_per_hi_sola = acc;
        s.last_market_vault_balance = market_balance;
        s.total_hi_sola = s.total_hi_sola.checked_add(sola_amount).ok_or(SoladromeError::Overflow)?;
        Ok(())
    }

    // Burn hiSOLA → unlock SOLA. Blocked if remaining collateral < debt.
    pub fn unstake_hi_sola(ctx: Context<UnstakeHiSola>, hi_sola_amount: u64) -> Result<()> {
        require!(hi_sola_amount > 0, SoladromeError::InvalidAmount);
        let bump = ctx.accounts.protocol_state.bump;

        if ctx.accounts.user_position.owner == Pubkey::default() {
            ctx.accounts.user_position.owner = ctx.accounts.user.key();
            ctx.accounts.user_position.bump = ctx.bumps.user_position;
        }

        let balance = ctx.accounts.user_hi_sola.amount;
        require!(balance >= hi_sola_amount, SoladromeError::InvalidAmount);
        let remaining = balance - hi_sola_amount;
        require!(
            ctx.accounts.user_position.usdc_borrowed <= remaining,
            SoladromeError::OutstandingDebt
        );

        // ── Advance accumulator before reducing total_hi_sola ────────────────
        // Without this, fees earned while more stakers were active would be
        // diluted when calculated against the post-unstake supply.
        let market_balance = ctx.accounts.market_vault.amount;
        let acc = math::advance_accumulator(
            ctx.accounts.protocol_state.fees_per_hi_sola,
            market_balance,
            ctx.accounts.protocol_state.last_market_vault_balance,
            ctx.accounts.protocol_state.total_hi_sola,
        );

        // ── Auto-pay pending fees (Masterchef pattern) ───────────────────────
        // Compute on the FULL pre-unstake balance so the staker captures every
        // fee earned up to this moment — then set fees_debt = acc so future
        // claim_fees only credits post-unstake earnings on the residual balance.
        let pending = math::pending_fees(acc, ctx.accounts.user_position.fees_debt, balance);
        if pending > 0 {
            let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from:      ctx.accounts.market_vault.to_account_info(),
                        to:        ctx.accounts.user_usdc.to_account_info(),
                        authority: ctx.accounts.protocol_state.to_account_info(),
                    },
                    &[seeds],
                ),
                pending,
            )?;
            ctx.accounts.protocol_state.last_market_vault_balance =
                market_balance.saturating_sub(pending);
        }
        ctx.accounts.user_position.fees_debt = acc;

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.hi_sola_mint.to_account_info(),
                    from: ctx.accounts.user_hi_sola.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            hi_sola_amount,
        )?;

        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.sola_vault.to_account_info(),
                    to: ctx.accounts.user_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            hi_sola_amount,
        )?;

        let s = &mut ctx.accounts.protocol_state;
        s.fees_per_hi_sola = acc;
        // Use post-payout balance as snapshot so the auto-paid USDC is not
        // double-credited to remaining stakers on the next accumulator advance.
        s.last_market_vault_balance = market_balance.saturating_sub(pending);
        s.total_hi_sola = s.total_hi_sola
            .checked_sub(hi_sola_amount)
            .ok_or(SoladromeError::Overflow)?;
        Ok(())
    }

    // Borrow USDC from floor reserve. Max = hiSOLA balance × 1 USDC (1:1 floor). No liquidation.
    pub fn borrow_usdc(ctx: Context<BorrowUsdc>, usdc_amount: u64) -> Result<()> {
        require!(usdc_amount > 0, SoladromeError::InvalidAmount);
        let bump = ctx.accounts.protocol_state.bump;

        if ctx.accounts.user_position.owner == Pubkey::default() {
            ctx.accounts.user_position.owner = ctx.accounts.user.key();
            ctx.accounts.user_position.bump = ctx.bumps.user_position;
        }

        let hi_sola_balance = ctx.accounts.user_hi_sola.amount;
        let new_borrowed = ctx
            .accounts
            .user_position
            .usdc_borrowed
            .checked_add(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;
        require!(new_borrowed <= hi_sola_balance, SoladromeError::BorrowLimitExceeded);
        require!(
            ctx.accounts.floor_vault.amount >= usdc_amount,
            SoladromeError::InsufficientFloorReserve
        );
        // ── 75% floor buffer guardrail ───────────────────────────────────────
        // Ensures sell_sola remains liquid for at least 75% of floor-backed supply.
        {
            let floor_after = ctx.accounts.floor_vault.amount
                .checked_sub(usdc_amount).ok_or(SoladromeError::Overflow)?;
            let min_floor = (ctx.accounts.protocol_state.total_purchased_sola as u128)
                .checked_mul(FLOOR_RESERVE_MIN_BPS as u128).ok_or(SoladromeError::Overflow)?
                .checked_div(10_000).ok_or(SoladromeError::Overflow)? as u64;
            require!(floor_after >= min_floor, SoladromeError::BorrowExceedsFloorBuffer);
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
                    to:   ctx.accounts.user_usdc.to_account_info(),
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
                        to:   ctx.accounts.market_vault.to_account_info(),
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

    // Burn oSOLA + pay floor USDC → receive SOLA. Strengthens floor reserve.
    pub fn exercise_o_sola(ctx: Context<ExerciseOSola>, o_sola_amount: u64) -> Result<()> {
        require!(o_sola_amount > 0, SoladromeError::InvalidAmount);
        let bump = ctx.accounts.protocol_state.bump;
        let usdc_cost = o_sola_amount;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.floor_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            usdc_cost,
        )?;

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.o_sola_mint.to_account_info(),
                    from: ctx.accounts.user_o_sola.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            o_sola_amount,
        )?;

        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.sola_mint.to_account_info(),
                    to: ctx.accounts.user_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            o_sola_amount,
        )?;

        let s = &mut ctx.accounts.protocol_state;
        s.total_sola = s.total_sola.checked_add(o_sola_amount).ok_or(SoladromeError::Overflow)?;
        // Exercising oSOLA pays 1 USDC to floor_vault per SOLA — counts as floor-backed supply.
        s.total_purchased_sola = s.total_purchased_sola.checked_add(o_sola_amount).ok_or(SoladromeError::Overflow)?;
        Ok(())
    }

    // Claim pro-rata share of market_vault fees. Permissionless — no admin needed.
    // Uses reward-per-token accumulator: O(1), no loops, no snapshots.
    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        let market_balance = ctx.accounts.market_vault.amount;

        // Advance accumulator with any new fees since last interaction
        let acc = math::advance_accumulator(
            ctx.accounts.protocol_state.fees_per_hi_sola,
            market_balance,
            ctx.accounts.protocol_state.last_market_vault_balance,
            ctx.accounts.protocol_state.total_hi_sola,
        );

        let hi_sola_balance = ctx.accounts.user_hi_sola.amount;
        let claimable = math::pending_fees(acc, ctx.accounts.user_position.fees_debt, hi_sola_balance);
        require!(claimable > 0, SoladromeError::NothingToClaim);

        let bump = ctx.accounts.protocol_state.bump;
        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            claimable,
        )?;

        // Persist accumulator state
        let s = &mut ctx.accounts.protocol_state;
        s.fees_per_hi_sola = acc;
        s.last_market_vault_balance = market_balance.checked_sub(claimable).ok_or(SoladromeError::Overflow)?;

        // Move user's debt forward so they can't double-claim
        ctx.accounts.user_position.fees_debt = acc;
        Ok(())
    }

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
        hiv.claimed      = 0;
        hiv.start_ts     = clock.unix_timestamp;
        hiv.bump         = ctx.bumps.founder_hi_vesting;

        // ── oSOLA progressive vesting (5M, cliff + linear) ──────────────────
        // Founder claims oSOLA linearly. To convert to USDC:
        //   exercise_o_sola (pay 1 USDC → floor_vault, mint 1 SOLA) → sell on AMM.
        // Each exercise is ADDITIVE to floor_vault (net positive for protocol).
        let ov = &mut ctx.accounts.founder_vesting;
        ov.total_amount = FOUNDER_LIQUID;
        ov.claimed      = 0;
        ov.start_ts     = clock.unix_timestamp;
        ov.bump         = ctx.bumps.founder_vesting;

        ctx.accounts.protocol_state.founder_allocated = true;
        Ok(())
    }

    // One-time ecosystem allocation: 2 M SOLA liquid → authority wallet for marketing & airdrop.
    // Entirely separate from the founder allocation; protected by `ecosystem_allocated` flag.
    pub fn mint_ecosystem_allocation(ctx: Context<MintEcosystemAllocation>) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.ecosystem_allocated,
            SoladromeError::AlreadyAllocated
        );

        let bump = ctx.accounts.protocol_state.bump;
        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

        // Mint ECOSYSTEM_TOTAL SOLA directly to authority's ATA — liquid, no auto-stake.
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.sola_mint.to_account_info(),
                    to:        ctx.accounts.authority_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            ECOSYSTEM_TOTAL,
        )?;

        let s = &mut ctx.accounts.protocol_state;
        s.total_sola = s.total_sola.checked_add(ECOSYSTEM_TOTAL).ok_or(SoladromeError::Overflow)?;
        s.ecosystem_allocated = true;

        Ok(())
    }

    // Claim linearly-vested hiSOLA (7M tranche).
    // Each call mints `claimable` SOLA to sola_vault + `claimable` hiSOLA to founder.
    // total_sola grows gradually, giving floor_vault time to accumulate from user buys.
    // Founder uses borrow_usdc against hiSOLA for immediate liquidity (no token selling needed).
    pub fn claim_founder_hi_sola(ctx: Context<ClaimFounderHiSola>) -> Result<()> {
        let clock   = Clock::get()?;
        let vesting = &ctx.accounts.founder_hi_vesting;
        let elapsed = ((clock.unix_timestamp - vesting.start_ts).max(0)) as u64;

        require!(elapsed >= VESTING_CLIFF_SECS, SoladromeError::VestingCliffNotReached);
        require!(vesting.claimed < vesting.total_amount, SoladromeError::VestingFullyClaimed);

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
                    mint:      ctx.accounts.sola_mint.to_account_info(),
                    to:        ctx.accounts.sola_vault.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            claimable,
        )?;

        // Mint hiSOLA to founder
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.hi_sola_mint.to_account_info(),
                    to:        ctx.accounts.founder_hi_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            claimable,
        )?;

        // Init/update founder position debt snapshot
        let pos = &mut ctx.accounts.founder_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.founder.key();
            pos.bump  = ctx.bumps.founder_position;
        }
        pos.fees_debt = acc;

        let s = &mut ctx.accounts.protocol_state;
        s.fees_per_hi_sola          = acc;
        s.last_market_vault_balance = market_balance;
        s.total_sola    = s.total_sola.checked_add(claimable).ok_or(SoladromeError::Overflow)?;
        s.total_hi_sola = s.total_hi_sola.checked_add(claimable).ok_or(SoladromeError::Overflow)?;

        ctx.accounts.founder_hi_vesting.claimed = ctx.accounts.founder_hi_vesting.claimed
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;

        Ok(())
    }

    // Claim linearly-vested oSOLA (5M tranche).
    // Mints oSOLA directly to founder — no floor impact.
    // To realise USDC: exercise_o_sola (pay 1 USDC → floor_vault) → sell SOLA on AMM.
    // Each exercise is net positive for the floor vault.
    pub fn claim_founder_vesting(ctx: Context<ClaimFounderVesting>) -> Result<()> {
        let clock   = Clock::get()?;
        let vesting = &ctx.accounts.founder_vesting;
        let elapsed = ((clock.unix_timestamp - vesting.start_ts).max(0)) as u64;

        require!(elapsed >= VESTING_CLIFF_SECS, SoladromeError::VestingCliffNotReached);
        require!(vesting.claimed < vesting.total_amount, SoladromeError::VestingFullyClaimed);

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
                    mint:      ctx.accounts.o_sola_mint.to_account_info(),
                    to:        ctx.accounts.founder_o_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            claimable,
        )?;

        ctx.accounts.founder_vesting.claimed = ctx.accounts.founder_vesting.claimed
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;

        Ok(())
    }

    // ── Founder borrow (capped) ───────────────────────────────────────────────

    /// Founder-only variant of borrow_usdc with a 10 % cap.
    /// Max cumulative borrow = FOUNDER_BORROW_CAP_BPS (10 %) × total hiSOLA claimed.
    /// With 7 M hiSOLA vesting linearly over 24 months (~291 k/mo), the founder
    /// can borrow at most ~29 k USDC per month — enough for running costs while
    /// the floor vault grows from organic user activity.
    pub fn founder_borrow_usdc(ctx: Context<FounderBorrowUsdc>, usdc_amount: u64) -> Result<()> {
        require!(usdc_amount > 0, SoladromeError::InvalidAmount);
        let bump = ctx.accounts.protocol_state.bump;

        if ctx.accounts.founder_position.owner == Pubkey::default() {
            ctx.accounts.founder_position.owner = ctx.accounts.founder.key();
            ctx.accounts.founder_position.bump  = ctx.bumps.founder_position;
        }

        // ── Founder-specific cap ─────────────────────────────────────────────
        let claimed    = ctx.accounts.founder_hi_vesting.claimed;
        let max_borrow = (claimed as u128)
            .checked_mul(FOUNDER_BORROW_CAP_BPS as u128)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(10_000)
            .ok_or(SoladromeError::Overflow)? as u64;

        let new_borrowed = ctx
            .accounts
            .founder_position
            .usdc_borrowed
            .checked_add(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;

        require!(new_borrowed <= max_borrow, SoladromeError::FounderBorrowCapExceeded);

        // ── Standard borrow checks ───────────────────────────────────────────
        let hi_sola_balance = ctx.accounts.founder_hi_sola.amount;
        require!(new_borrowed <= hi_sola_balance, SoladromeError::BorrowLimitExceeded);
        require!(
            ctx.accounts.floor_vault.amount >= usdc_amount,
            SoladromeError::InsufficientFloorReserve
        );
        // ── 75% floor buffer guardrail ───────────────────────────────────────
        {
            let floor_after = ctx.accounts.floor_vault.amount
                .checked_sub(usdc_amount).ok_or(SoladromeError::Overflow)?;
            let min_floor = (ctx.accounts.protocol_state.total_purchased_sola as u128)
                .checked_mul(FLOOR_RESERVE_MIN_BPS as u128).ok_or(SoladromeError::Overflow)?
                .checked_div(10_000).ok_or(SoladromeError::Overflow)? as u64;
            require!(floor_after >= min_floor, SoladromeError::BorrowExceedsFloorBuffer);
        }

        // ── 2 % origination fee → market_vault ──────────────────────────────
        let fee = usdc_amount
            .checked_mul(BORROW_FEE_BPS)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(10_000)
            .ok_or(SoladromeError::Overflow)?;
        let founder_receives = usdc_amount
            .checked_sub(fee)
            .ok_or(SoladromeError::Overflow)?;

        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.floor_vault.to_account_info(),
                    to:        ctx.accounts.founder_usdc.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            founder_receives,
        )?;

        if fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from:      ctx.accounts.floor_vault.to_account_info(),
                        to:        ctx.accounts.market_vault.to_account_info(),
                        authority: ctx.accounts.protocol_state.to_account_info(),
                    },
                    &[seeds],
                ),
                fee,
            )?;
        }

        ctx.accounts.founder_position.usdc_borrowed = new_borrowed;
        ctx.accounts.protocol_state.total_usdc_borrowed = ctx
            .accounts
            .protocol_state
            .total_usdc_borrowed
            .checked_add(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;
        // Flash-borrow guard: record the slot so repay_usdc cannot fire in the same tx.
        ctx.accounts.founder_position.last_borrow_slot = Clock::get()?.slot;

        Ok(())
    }

    // ── Contributor / marketing vesting ──────────────────────────────────────

    /// Authority-only: register a contributor wallet with a dual hiSOLA + oSOLA allocation.
    /// Mirrors the founder structure — hiSOLA (governance + borrow) + oSOLA (liquid options).
    /// Vesting starts immediately (start_ts = now) — call at launch time.
    pub fn register_contributor(
        ctx: Context<RegisterContributor>,
        hi_sola_amount: u64,
        o_sola_amount:  u64,
    ) -> Result<()> {
        require!(hi_sola_amount > 0 || o_sola_amount > 0, SoladromeError::InvalidAmount);
        let v = &mut ctx.accounts.contributor_vesting;
        v.contributor     = ctx.accounts.contributor_wallet.key();
        v.hi_sola_amount  = hi_sola_amount;
        v.o_sola_amount   = o_sola_amount;
        v.hi_sola_claimed = 0;
        v.o_sola_claimed  = 0;
        v.start_ts        = Clock::get()?.unix_timestamp;
        v.bump            = ctx.bumps.contributor_vesting;
        msg!(
            "Contributor registered: {} | {} hiSOLA + {} oSOLA | start_ts={}",
            v.contributor, v.hi_sola_amount, v.o_sola_amount, v.start_ts
        );
        Ok(())
    }

    /// Contributor-only: claim linearly-vested hiSOLA after the cliff.
    /// Mints SOLA to sola_vault (locked backing) + hiSOLA to contributor wallet 1:1.
    /// Also snapshots the fee accumulator so the contributor earns fees from day one.
    pub fn claim_contributor_hi_sola(ctx: Context<ClaimContributorHiSola>) -> Result<()> {
        let clock   = Clock::get()?;
        let vesting = &ctx.accounts.contributor_vesting;
        let elapsed = ((clock.unix_timestamp - vesting.start_ts).max(0)) as u64;

        require!(elapsed >= CONTRIBUTOR_CLIFF_SECS,    SoladromeError::VestingCliffNotReached);
        require!(vesting.hi_sola_claimed < vesting.hi_sola_amount, SoladromeError::VestingFullyClaimed);

        let vested_amount = if elapsed >= CONTRIBUTOR_DURATION_SECS {
            vesting.hi_sola_amount
        } else {
            (vesting.hi_sola_amount as u128)
                .checked_mul(elapsed as u128)
                .ok_or(SoladromeError::Overflow)?
                .checked_div(CONTRIBUTOR_DURATION_SECS as u128)
                .ok_or(SoladromeError::Overflow)? as u64
        };

        let claimable = vested_amount
            .checked_sub(vesting.hi_sola_claimed)
            .ok_or(SoladromeError::Overflow)?;
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

        // Mint SOLA to sola_vault (backing the hiSOLA 1:1)
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.sola_mint.to_account_info(),
                    to:        ctx.accounts.sola_vault.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            claimable,
        )?;

        // Mint hiSOLA to contributor
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.hi_sola_mint.to_account_info(),
                    to:        ctx.accounts.contributor_hi_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            claimable,
        )?;

        // Init/update contributor position debt snapshot
        let pos = &mut ctx.accounts.contributor_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.contributor.key();
            pos.bump  = ctx.bumps.contributor_position;
        }
        pos.fees_debt = acc;

        let s = &mut ctx.accounts.protocol_state;
        s.fees_per_hi_sola          = acc;
        s.last_market_vault_balance = market_balance;
        s.total_sola    = s.total_sola.checked_add(claimable).ok_or(SoladromeError::Overflow)?;
        s.total_hi_sola = s.total_hi_sola.checked_add(claimable).ok_or(SoladromeError::Overflow)?;

        ctx.accounts.contributor_vesting.hi_sola_claimed = vesting.hi_sola_claimed
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;

        Ok(())
    }

    /// Contributor-only: claim linearly-vested oSOLA after the cliff.
    /// Mints oSOLA to contributor wallet — floor-neutral until exercised.
    pub fn claim_contributor_vesting(ctx: Context<ClaimContributorVesting>) -> Result<()> {
        let clock   = Clock::get()?;
        let vesting = &ctx.accounts.contributor_vesting;
        let elapsed = ((clock.unix_timestamp - vesting.start_ts).max(0)) as u64;

        require!(elapsed >= CONTRIBUTOR_CLIFF_SECS,   SoladromeError::VestingCliffNotReached);
        require!(vesting.o_sola_claimed < vesting.o_sola_amount, SoladromeError::VestingFullyClaimed);

        let vested_amount = if elapsed >= CONTRIBUTOR_DURATION_SECS {
            vesting.o_sola_amount
        } else {
            (vesting.o_sola_amount as u128)
                .checked_mul(elapsed as u128)
                .ok_or(SoladromeError::Overflow)?
                .checked_div(CONTRIBUTOR_DURATION_SECS as u128)
                .ok_or(SoladromeError::Overflow)? as u64
        };

        let claimable = vested_amount
            .checked_sub(vesting.o_sola_claimed)
            .ok_or(SoladromeError::Overflow)?;
        require!(claimable > 0, SoladromeError::NothingToClaim);

        let bump = ctx.accounts.protocol_state.bump;
        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.o_sola_mint.to_account_info(),
                    to:        ctx.accounts.contributor_o_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            claimable,
        )?;

        ctx.accounts.contributor_vesting.o_sola_claimed = vesting.o_sola_claimed
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;

        Ok(())
    }

    /// Contributor borrow: draw USDC from floor_vault against hiSOLA collateral.
    /// Max cumulative borrow = 10 % of total *claimed* hiSOLA (dynamic, mirrors founder logic).
    /// 2% origination fee → market_vault. Flash-borrow guard included.
    pub fn contributor_borrow_usdc(
        ctx: Context<ContributorBorrowUsdc>,
        usdc_amount: u64,
    ) -> Result<()> {
        require!(usdc_amount > 0, SoladromeError::InvalidAmount);

        let bump = ctx.accounts.protocol_state.bump;

        // Initialise position on first borrow
        if ctx.accounts.contributor_position.owner == Pubkey::default() {
            ctx.accounts.contributor_position.owner = ctx.accounts.contributor.key();
            ctx.accounts.contributor_position.bump  = ctx.bumps.contributor_position;
        }

        // Cap = 10% of total hiSOLA *claimed so far* (dynamic, scales with actual vesting progress).
        // Using hi_sola_claimed (not total allocation) mirrors founder_borrow_usdc exactly and
        // prevents borrowing against unvested tokens.
        let max_borrow = (ctx.accounts.contributor_vesting.hi_sola_claimed as u128)
            .checked_mul(CONTRIBUTOR_BORROW_CAP_BPS as u128)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(10_000)
            .ok_or(SoladromeError::Overflow)? as u64;
        let new_borrowed = ctx.accounts.contributor_position.usdc_borrowed
            .checked_add(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;
        require!(new_borrowed <= max_borrow, SoladromeError::ContributorBorrowCapExceeded);
        require!(
            ctx.accounts.floor_vault.amount >= usdc_amount,
            SoladromeError::InsufficientFloorReserve
        );
        // ── 75% floor buffer guardrail ───────────────────────────────────────
        {
            let floor_after = ctx.accounts.floor_vault.amount
                .checked_sub(usdc_amount).ok_or(SoladromeError::Overflow)?;
            let min_floor = (ctx.accounts.protocol_state.total_purchased_sola as u128)
                .checked_mul(FLOOR_RESERVE_MIN_BPS as u128).ok_or(SoladromeError::Overflow)?
                .checked_div(10_000).ok_or(SoladromeError::Overflow)? as u64;
            require!(floor_after >= min_floor, SoladromeError::BorrowExceedsFloorBuffer);
        }

        // 2% origination fee to market_vault
        let fee = usdc_amount
            .checked_mul(BORROW_FEE_BPS).ok_or(SoladromeError::Overflow)?
            .checked_div(10_000).ok_or(SoladromeError::Overflow)?;
        let net_amount = usdc_amount.checked_sub(fee).ok_or(SoladromeError::Overflow)?;
        require!(net_amount > 0, SoladromeError::InvalidAmount);

        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

        // floor_vault → contributor (net amount)
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.floor_vault.to_account_info(),
                    to:        ctx.accounts.contributor_usdc.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            net_amount,
        )?;

        // floor_vault → market_vault (2% fee)
        if fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from:      ctx.accounts.floor_vault.to_account_info(),
                        to:        ctx.accounts.market_vault.to_account_info(),
                        authority: ctx.accounts.protocol_state.to_account_info(),
                    },
                    &[seeds],
                ),
                fee,
            )?;
        }

        ctx.accounts.contributor_position.usdc_borrowed = new_borrowed;
        ctx.accounts.protocol_state.total_usdc_borrowed = ctx.accounts.protocol_state
            .total_usdc_borrowed
            .checked_add(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;

        // Flash-borrow guard
        ctx.accounts.contributor_position.last_borrow_slot = Clock::get()?.slot;

        Ok(())
    }

    // ── Bribe system ─────────────────────────────────────────────────────────

    /// Permissionless: any protocol deposits bribe tokens to attract hiSOLA votes.
    /// epoch must equal the current epoch — bribes target the live voting window.
    pub fn deposit_bribe(ctx: Context<DepositBribe>, epoch: u64, amount: u64) -> Result<()> {
        require!(amount > 0, SoladromeError::InvalidAmount);
        let clock = Clock::get()?;
        require!(epoch == current_epoch(clock.unix_timestamp), SoladromeError::WrongEpoch);

        // First-time vault init (pool_id starts as default when account is blank)
        if ctx.accounts.bribe_vault.pool_id == Pubkey::default() {
            ctx.accounts.bribe_vault.pool_id     = ctx.accounts.pool_id.key();
            ctx.accounts.bribe_vault.reward_mint = ctx.accounts.reward_mint.key();
            ctx.accounts.bribe_vault.epoch       = epoch;
            ctx.accounts.bribe_vault.bump        = ctx.bumps.bribe_vault;
        }

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.depositor_token.to_account_info(),
                    to:        ctx.accounts.bribe_token_vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
        )?;

        ctx.accounts.bribe_vault.total_bribed = ctx.accounts.bribe_vault.total_bribed
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;
        Ok(())
    }

    /// hiSOLA holder directs vote-weight at a pool gauge for the current epoch.
    /// Total allocated across all pools ≤ raw hiSOLA + ve-weighted locked hiSOLA.
    /// One UserVoteReceipt per (user, pool, epoch) — double-vote for same pool is blocked.
    pub fn vote_gauge(ctx: Context<VoteGauge>, epoch: u64, votes: u64) -> Result<()> {
        require!(votes > 0, SoladromeError::InvalidAmount);
        let clock = Clock::get()?;
        require!(epoch == current_epoch(clock.unix_timestamp), SoladromeError::WrongEpoch);

        // Total power = unlocked hiSOLA (1×) + ve-weighted locked hiSOLA (up to 4×).
        let hi_sola_balance = ctx.accounts.user_hi_sola.amount;
        let ve_power = ve::try_load_ve_power(
            &ctx.accounts.lock_position,
            &ctx.accounts.user.key(),
            clock.unix_timestamp,
        );
        let total_power = hi_sola_balance.saturating_add(ve_power);

        let already_allocated = ctx.accounts.user_epoch_votes.allocated;
        let new_total = already_allocated
            .checked_add(votes)
            .ok_or(SoladromeError::Overflow)?;
        require!(new_total <= total_power, SoladromeError::VoteOverflow);

        // Init UserEpochVotes if first vote this epoch
        if ctx.accounts.user_epoch_votes.epoch == 0 {
            ctx.accounts.user_epoch_votes.epoch = epoch;
            ctx.accounts.user_epoch_votes.bump  = ctx.bumps.user_epoch_votes;
        }

        // Init GaugeState if first vote for this pool this epoch
        if ctx.accounts.gauge_state.pool_id == Pubkey::default() {
            ctx.accounts.gauge_state.pool_id = ctx.accounts.pool_id.key();
            ctx.accounts.gauge_state.epoch   = epoch;
            ctx.accounts.gauge_state.bump    = ctx.bumps.gauge_state;
        }
        ctx.accounts.gauge_state.total_votes = ctx.accounts.gauge_state.total_votes
            .checked_add(votes)
            .ok_or(SoladromeError::Overflow)?;

        // Record vote receipt (init enforces one-shot per pool per epoch)
        ctx.accounts.user_vote_receipt.user    = ctx.accounts.user.key();
        ctx.accounts.user_vote_receipt.pool_id = ctx.accounts.pool_id.key();
        ctx.accounts.user_vote_receipt.epoch   = epoch;
        ctx.accounts.user_vote_receipt.votes   = votes;
        ctx.accounts.user_vote_receipt.bump    = ctx.bumps.user_vote_receipt;

        // Persist allocation counter
        ctx.accounts.user_epoch_votes.allocated = new_total;

        // Update global vote total (denominator for LP emissions)
        let gev = &mut ctx.accounts.global_epoch_votes;
        if gev.epoch == 0 {
            gev.epoch = epoch;
            gev.bump  = ctx.bumps.global_epoch_votes;
        }
        gev.total_votes = gev.total_votes
            .checked_add(votes)
            .ok_or(SoladromeError::Overflow)?;

        Ok(())
    }

    /// Record a time-weighted LP balance snapshot for the caller in a given pool+epoch.
    /// Must be called before the epoch ends; updates both the user and pool accumulators.
    pub fn checkpoint_lp(ctx: Context<CheckpointLp>, epoch: u64) -> Result<()> {
        let clock      = Clock::get()?;
        let now        = clock.unix_timestamp;
        let epoch_start = (epoch * EPOCH_DURATION) as i64;
        let epoch_end   = ((epoch + 1) * EPOCH_DURATION) as i64;

        require!(now >= epoch_start, SoladromeError::WrongEpoch);
        require!(now <  epoch_end,   SoladromeError::EpochNotEnded);

        let pool_key  = ctx.accounts.pool.key();
        let lp_supply = ctx.accounts.lp_mint.supply;
        let user_lp   = ctx.accounts.user_lp.amount;

        // ── Pool accumulator ────────────────────────────────────────────
        let pa = &mut ctx.accounts.pool_epoch_accum;
        if pa.epoch == 0 {
            pa.epoch          = epoch;
            pa.pool           = pool_key;
            pa.last_update_ts = epoch_start;
            pa.last_lp_supply = lp_supply;
            pa.bump           = ctx.bumps.pool_epoch_accum;
        }
        require!(!pa.finalized, SoladromeError::EpochNotFinalized);

        let pa_elapsed = (now - pa.last_update_ts).max(0) as u128;
        pa.total_weighted_supply = pa.total_weighted_supply
            .checked_add((pa.last_lp_supply as u128).checked_mul(pa_elapsed).ok_or(SoladromeError::Overflow)?)
            .ok_or(SoladromeError::Overflow)?;
        pa.last_update_ts = now;
        pa.last_lp_supply = lp_supply;

        // ── User checkpoint ─────────────────────────────────────────────
        let ckpt = &mut ctx.accounts.lp_user_checkpoint;
        if ckpt.pool == Pubkey::default() {
            ckpt.user           = ctx.accounts.user.key();
            ckpt.pool           = pool_key;
            ckpt.last_epoch     = epoch;
            ckpt.last_update_ts = epoch_start;
            ckpt.bump           = ctx.bumps.lp_user_checkpoint;
        }
        // Reset for a new epoch
        if ckpt.last_epoch < epoch {
            ckpt.weighted_balance = 0;
            ckpt.last_update_ts   = epoch_start;
            ckpt.last_epoch       = epoch;
        }

        let ckpt_elapsed = (now - ckpt.last_update_ts).max(0) as u128;
        ckpt.weighted_balance = ckpt.weighted_balance
            .checked_add((user_lp as u128).checked_mul(ckpt_elapsed).ok_or(SoladromeError::Overflow)?)
            .ok_or(SoladromeError::Overflow)?;
        ckpt.last_update_ts = now;

        Ok(())
    }

    /// Finalize the LP emission allocation for one pool after its epoch has ended.
    /// Permissionless — anyone can call. Records how much oSOLA this pool's LPs may claim.
    pub fn emit_pool_rewards(ctx: Context<EmitPoolRewards>, epoch: u64) -> Result<()> {
        let clock     = Clock::get()?;
        let epoch_end = ((epoch + 1) * EPOCH_DURATION) as i64;
        require!(clock.unix_timestamp >= epoch_end, SoladromeError::EpochNotEnded);

        let pool_accum = &mut ctx.accounts.pool_epoch_accum;
        require!(!pool_accum.finalized, SoladromeError::AlreadyAllocated);

        let lp_supply = ctx.accounts.lp_mint.supply;

        // Initialise if nobody checkpointed this epoch
        if pool_accum.epoch == 0 {
            pool_accum.epoch          = epoch;
            pool_accum.pool           = ctx.accounts.pool.key();
            pool_accum.last_update_ts = (epoch * EPOCH_DURATION) as i64;
            pool_accum.last_lp_supply = lp_supply;
            pool_accum.bump           = ctx.bumps.pool_epoch_accum;
        }

        // Add remaining time from last checkpoint to epoch end
        let remaining = (epoch_end - pool_accum.last_update_ts).max(0) as u128;
        pool_accum.total_weighted_supply = pool_accum.total_weighted_supply
            .checked_add((pool_accum.last_lp_supply as u128).checked_mul(remaining).ok_or(SoladromeError::Overflow)?)
            .ok_or(SoladromeError::Overflow)?;
        pool_accum.last_update_ts = epoch_end;
        pool_accum.last_lp_supply = lp_supply;

        let total_votes = ctx.accounts.global_epoch_votes.total_votes as u128;
        let pool_votes  = ctx.accounts.gauge_state.total_votes as u128;
        require!(total_votes > 0, SoladromeError::NoVotes);
        require!(pool_votes  > 0, SoladromeError::NoVotes);

        pool_accum.osola_allocated = (LP_EMISSION_PER_EPOCH as u128)
            .checked_mul(pool_votes).ok_or(SoladromeError::Overflow)?
            .checked_div(total_votes).ok_or(SoladromeError::Overflow)? as u64;
        pool_accum.finalized = true;

        Ok(())
    }

    /// Mint a user's pro-rata oSOLA share from LP emissions for a given pool+epoch.
    /// Requires: epoch finalized, user checkpointed during epoch, not yet claimed.
    pub fn claim_lp_emissions(ctx: Context<ClaimLpEmissions>, _epoch: u64) -> Result<()> {
        let pa   = &ctx.accounts.pool_epoch_accum;
        let ckpt = &ctx.accounts.lp_user_checkpoint;

        require!(pa.total_weighted_supply > 0, SoladromeError::NothingToClaim);
        require!(ckpt.weighted_balance    > 0, SoladromeError::NothingToClaim);

        let user_osola = (pa.osola_allocated as u128)
            .checked_mul(ckpt.weighted_balance).ok_or(SoladromeError::Overflow)?
            .checked_div(pa.total_weighted_supply).ok_or(SoladromeError::Overflow)? as u64;
        require!(user_osola > 0, SoladromeError::NothingToClaim);

        let bump  = ctx.accounts.protocol_state.bump;
        let seeds = &[STATE_SEED, &[bump][..]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.o_sola_mint.to_account_info(),
                    to:        ctx.accounts.user_o_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            user_osola,
        )?;

        ctx.accounts.lp_epoch_claim.bump = ctx.bumps.lp_epoch_claim;
        Ok(())
    }

    /// Claim pro-rata bribe after the voting epoch has ended.
    /// claimable = total_bribed × user_votes / total_votes  (safe u128 muldiv)
    /// Creating UserBribeClaim PDA is the idempotency guard (init = fails if exists).
    pub fn claim_bribe(ctx: Context<ClaimBribe>, epoch: u64) -> Result<()> {
        let clock = Clock::get()?;
        require!(epoch < current_epoch(clock.unix_timestamp), SoladromeError::EpochNotEnded);

        let total_votes  = ctx.accounts.gauge_state.total_votes;
        let user_votes   = ctx.accounts.user_vote_receipt.votes;
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
        let pool_key   = ctx.accounts.pool_id.key();
        let mint_key   = ctx.accounts.reward_mint.key();
        let epoch_le   = epoch.to_le_bytes();
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
                    from:      ctx.accounts.bribe_token_vault.to_account_info(),
                    to:        ctx.accounts.user_reward_ata.to_account_info(),
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

    // ── AMM multi-pool instructions ───────────────────────────────────────────

    pub fn create_pool(ctx: Context<CreatePool>, fee_rate: u16, protocol_fee_bps: u16) -> Result<()> {
        amm::create_pool(ctx, fee_rate, protocol_fee_bps)
    }

    pub fn add_liquidity(ctx: Context<AddLiquidity>, amount_a_desired: u64, amount_b_desired: u64, min_lp: u64) -> Result<()> {
        amm::add_liquidity(ctx, amount_a_desired, amount_b_desired, min_lp)
    }

    pub fn remove_liquidity(ctx: Context<RemoveLiquidity>, lp_amount: u64, min_a: u64, min_b: u64) -> Result<()> {
        amm::remove_liquidity(ctx, lp_amount, min_a, min_b)
    }

    /// Claim accumulated oSOLA LP rewards without changing liquidity.
    pub fn claim_lp_rewards(ctx: Context<ClaimLpRewards>) -> Result<()> {
        amm::claim_lp_rewards(ctx)
    }

    pub fn amm_swap(ctx: Context<Swap>, amount_in: u64, min_out: u64, a_to_b: bool) -> Result<()> {
        amm::swap(ctx, amount_in, min_out, a_to_b)
    }

    // Mint oSOLA to a recipient as LP reward. Authority-only.
    pub fn distribute_o_sola(ctx: Context<DistributeOSola>, amount: u64) -> Result<()> {
        require!(amount > 0, SoladromeError::InvalidAmount);
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
        Ok(())
    }

    // ── Protocol-Owned Liquidity ──────────────────────────────────────────────

    /// One-time setup: create PolState and its token vaults. Authority-only.
    pub fn initialize_pol(
        ctx: Context<InitializePol>,
        pol_split_bps: u16,
        target_pool: Pubkey,
    ) -> Result<()> {
        pol::initialize_pol(ctx, pol_split_bps, target_pool)
    }

    /// Redirect a portion of market_vault fees to pol_usdc_vault. Authority-only.
    pub fn collect_to_pol(ctx: Context<CollectToPol>, amount: u64) -> Result<()> {
        pol::collect_to_pol(ctx, amount)
    }

    /// Buy SOLA via bonding curve and/or add LP to the target pool. Authority-only.
    pub fn deploy_pol(
        ctx: Context<DeployPol>,
        usdc_for_sola: u64,
        min_sola_out:  u64,
        sola_for_lp:   u64,
        usdc_for_lp:   u64,
        min_lp:        u64,
    ) -> Result<()> {
        pol::deploy_pol(ctx, usdc_for_sola, min_sola_out, sola_for_lp, usdc_for_lp, min_lp)
    }

    // ── Ve-layer ──────────────────────────────────────────────────────────────

    /// Lock hiSOLA for ve-weighted governance power.
    /// Subsequent calls extend the lock or add tokens (never shorten).
    pub fn lock_hi_sola(
        ctx: Context<LockHiSola>,
        amount: u64,
        lock_duration_secs: u64,
    ) -> Result<()> {
        ve::lock_hi_sola(ctx, amount, lock_duration_secs)
    }

    /// Return locked hiSOLA after expiry. Restores tokens to the fee pool.
    pub fn unlock_hi_sola(ctx: Context<UnlockHiSola>) -> Result<()> {
        ve::unlock_hi_sola(ctx)
    }

    /// Flash-arbitrage: burn oSOLA → mint SOLA → sell on AMM → split profit.
    /// Caller pays zero USDC upfront. Profitable only when SOLA_AMM > 1 USDC (floor).
    /// Profit split: CALLER_ARB_SHARE_BPS (10 %) to caller, rest to market_vault → hiSOLA stakers.
    pub fn flash_arbitrage(
        ctx: Context<FlashArbitrage>,
        amount_osola: u64,
        min_profit_usdc: u64,
    ) -> Result<()> {
        require!(amount_osola > 0, SoladromeError::InvalidAmount);

        let state_bump = ctx.accounts.protocol_state.bump;
        let state_seeds: &[&[u8]] = &[STATE_SEED, &[state_bump]];

        // ── 1. Burn caller's oSOLA ────────────────────────────────────────────
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint:      ctx.accounts.o_sola_mint.to_account_info(),
                    from:      ctx.accounts.caller_o_sola.to_account_info(),
                    authority: ctx.accounts.caller.to_account_info(),
                },
            ),
            amount_osola,
        )?;

        // ── 2. Mint SOLA to caller (floor will be replenished from AMM proceeds) ──
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.sola_mint.to_account_info(),
                    to:        ctx.accounts.caller_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[state_seeds],
            ),
            amount_osola,
        )?;
        ctx.accounts.protocol_state.total_sola = ctx.accounts.protocol_state.total_sola
            .checked_add(amount_osola).ok_or(SoladromeError::Overflow)?;
        // Floor receives amount_osola USDC (step 5), so this SOLA is fully floor-backed.
        ctx.accounts.protocol_state.total_purchased_sola = ctx.accounts.protocol_state.total_purchased_sola
            .checked_add(amount_osola).ok_or(SoladromeError::Overflow)?;

        // ── 3. AMM swap: sell SOLA → USDC ────────────────────────────────────
        let pool      = &ctx.accounts.pool;
        let pool_bump = pool.bump;
        let mint_a    = pool.token_a_mint;
        let mint_b    = pool.token_b_mint;
        let sola_is_a = mint_a == ctx.accounts.protocol_state.sola_mint;

        let fee_rate   = pool.fee_rate as u128;
        let fee_total  = amount_osola as u128 * fee_rate / 10_000;
        let amount_net = (amount_osola as u128 - fee_total) as u64;

        let (reserve_in, reserve_out) = if sola_is_a {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };

        let usdc_out = amm_math::swap_out(reserve_in, reserve_out, amount_net)?;

        let pool_seeds: &[&[u8]] = &[AMM_POOL_SEED, mint_a.as_ref(), mint_b.as_ref(), &[pool_bump]];

        let (vault_sola, vault_usdc) = if sola_is_a {
            (ctx.accounts.token_a_vault.to_account_info(), ctx.accounts.token_b_vault.to_account_info())
        } else {
            (ctx.accounts.token_b_vault.to_account_info(), ctx.accounts.token_a_vault.to_account_info())
        };

        // SOLA: caller → pool vault (only amount_net — the portion after AMM fee deduction).
        // The swap was calculated on amount_net, so the vault and reserve must both increase
        // by exactly amount_net. Sending the full amount_osola would create a vault/reserve
        // divergence equal to fee_total that grows unboundedly and corrupts LP withdrawals.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.caller_sola.to_account_info(),
                    to:        vault_sola,
                    authority: ctx.accounts.caller.to_account_info(),
                },
            ),
            amount_net,
        )?;

        // USDC: pool vault → caller_usdc (temp holding for split below)
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      vault_usdc,
                    to:        ctx.accounts.caller_usdc.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            usdc_out,
        )?;

        // ── Burn the AMM fee remainder ────────────────────────────────────────
        // Only amount_net was deposited into the pool; the remaining fee_total
        // SOLA is still in caller_sola. Burn it now so that total_sola (already
        // incremented by amount_osola above) stays accurate and no unbacked SOLA
        // leaks into circulation.
        let fee_total_u64 = fee_total as u64;
        if fee_total_u64 > 0 {
            token::burn(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint:      ctx.accounts.sola_mint.to_account_info(),
                        from:      ctx.accounts.caller_sola.to_account_info(),
                        authority: ctx.accounts.caller.to_account_info(),
                    },
                ),
                fee_total_u64,
            )?;
            ctx.accounts.protocol_state.total_sola = ctx.accounts.protocol_state.total_sola
                .checked_sub(fee_total_u64).ok_or(SoladromeError::Overflow)?;
            ctx.accounts.protocol_state.total_purchased_sola = ctx.accounts.protocol_state.total_purchased_sola
                .checked_sub(fee_total_u64).ok_or(SoladromeError::Overflow)?;
        }

        // Update pool reserves
        let pool = &mut ctx.accounts.pool;
        if sola_is_a {
            pool.reserve_a = pool.reserve_a.checked_add(amount_net).ok_or(SoladromeError::Overflow)?;
            pool.reserve_b = pool.reserve_b.checked_sub(usdc_out).ok_or(SoladromeError::Overflow)?;
        } else {
            pool.reserve_b = pool.reserve_b.checked_add(amount_net).ok_or(SoladromeError::Overflow)?;
            pool.reserve_a = pool.reserve_a.checked_sub(usdc_out).ok_or(SoladromeError::Overflow)?;
        }

        // ── 4. Profitability check ────────────────────────────────────────────
        // Floor needs `amount_osola` USDC to back the freshly minted SOLA.
        require!(usdc_out > amount_osola, SoladromeError::NotProfitable);
        let gross_profit = usdc_out.checked_sub(amount_osola).ok_or(SoladromeError::Overflow)?;
        require!(gross_profit >= min_profit_usdc, SoladromeError::SlippageExceeded);

        // ── 5. Split proceeds ─────────────────────────────────────────────────
        let caller_reward = (gross_profit as u128)
            .checked_mul(state::CALLER_ARB_SHARE_BPS as u128).ok_or(SoladromeError::Overflow)?
            .checked_div(10_000).ok_or(SoladromeError::Overflow)? as u64;
        let protocol_profit = gross_profit.checked_sub(caller_reward).ok_or(SoladromeError::Overflow)?;

        // Floor replenishment: amount_osola USDC from caller_usdc → floor_vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.caller_usdc.to_account_info(),
                    to:        ctx.accounts.floor_vault.to_account_info(),
                    authority: ctx.accounts.caller.to_account_info(),
                },
            ),
            amount_osola,
        )?;

        // Protocol profit → market_vault → hiSOLA stakers
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.caller_usdc.to_account_info(),
                    to:        ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.caller.to_account_info(),
                },
            ),
            protocol_profit,
        )?;
        ctx.accounts.protocol_state.accumulated_fees = ctx.accounts.protocol_state.accumulated_fees
            .saturating_add(protocol_profit);

        // caller_reward stays in caller_usdc — no extra transfer needed
        let _ = caller_reward;
        Ok(())
    }
}

// ── Account Contexts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = ProtocolState::LEN,
        seeds = [STATE_SEED],
        bump,
    )]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        mint::decimals = 6,
        mint::authority = protocol_state,
        seeds = [b"sola_mint"],
        bump,
    )]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        mint::decimals = 6,
        mint::authority = protocol_state,
        seeds = [b"hi_sola_mint"],
        bump,
    )]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        mint::decimals = 6,
        mint::authority = protocol_state,
        seeds = [b"o_sola_mint"],
        bump,
    )]
    pub o_sola_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        token::mint = usdc_mint,
        token::authority = protocol_state,
        seeds = [FLOOR_VAULT_SEED],
        bump,
    )]
    pub floor_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        token::mint = usdc_mint,
        token::authority = protocol_state,
        seeds = [MARKET_VAULT_SEED],
        bump,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        token::mint = sola_mint,
        token::authority = protocol_state,
        seeds = [SOLA_VAULT_SEED],
        bump,
    )]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct BuySola<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = user_usdc.mint == protocol_state.usdc_mint @ SoladromeError::InvalidAmount,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = sola_mint,
        associated_token::authority = user,
    )]
    pub user_sola: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SellSola<'info> {
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Account<'info, Mint>,

    #[account(mut, token::mint = sola_mint, token::authority = user)]
    pub user_sola: Account<'info, TokenAccount>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_usdc.mint == protocol_state.usdc_mint @ SoladromeError::InvalidAmount,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct StakeSola<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = sola_mint, token::authority = user)]
    pub user_sola: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = hi_sola_mint,
        associated_token::authority = user,
    )]
    pub user_hi_sola: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Market vault needed to snapshot the accumulator on stake entry.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump,
    )]
    pub user_position: Account<'info, UserPosition>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnstakeHiSola<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Account<'info, Mint>,

    #[account(mut, address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Account<'info, Mint>,

    #[account(mut, token::mint = hi_sola_mint, token::authority = user)]
    pub user_hi_sola: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = sola_mint,
        associated_token::authority = user,
    )]
    pub user_sola: Account<'info, TokenAccount>,

    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Account<'info, TokenAccount>,

    /// Source of pending fee payouts. Mutable so fees can be transferred out.
    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Account<'info, TokenAccount>,

    /// USDC mint — needed to init user_usdc ATA on first unstake if absent.
    #[account(address = protocol_state.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    /// User's USDC ATA — receives any pending fees auto-paid on unstake.
    /// Created if it doesn't exist yet.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint      = usdc_mint,
        associated_token::authority = user,
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
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BorrowUsdc<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Account<'info, Mint>,

    #[account(token::mint = hi_sola_mint, token::authority = user)]
    pub user_hi_sola: Account<'info, TokenAccount>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Account<'info, TokenAccount>,

    /// Receives the 2 % origination fee → distributed to hiSOLA stakers.
    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_usdc.mint == protocol_state.usdc_mint @ SoladromeError::InvalidAmount,
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

#[derive(Accounts)]
pub struct ExerciseOSola<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = o_sola_mint, token::authority = user)]
    pub user_o_sola: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = sola_mint,
        associated_token::authority = user,
    )]
    pub user_sola: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = user_usdc.mint == protocol_state.usdc_mint @ SoladromeError::InvalidAmount,
        token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

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

    #[account(
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

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Account<'info, Mint>,

    /// User's hiSOLA balance determines their fee share.
    #[account(token::mint = hi_sola_mint, token::authority = user)]
    pub user_hi_sola: Account<'info, TokenAccount>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_usdc.mint == protocol_state.usdc_mint @ SoladromeError::InvalidAmount,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump = user_position.bump,
    )]
    pub user_position: Account<'info, UserPosition>,

    pub token_program: Program<'info, Token>,
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

    /// Founder wallet — hardcoded, cannot be substituted.
    #[account(
        address = FOUNDER_WALLET.parse::<Pubkey>().unwrap() @ SoladromeError::Unauthorized,
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

// ── Ecosystem allocation context ─────────────────────────────────────────────

#[derive(Accounts)]
pub struct MintEcosystemAllocation<'info> {
    #[account(mut, address = protocol_state.authority @ SoladromeError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    /// Authority's SOLA ATA — receives the ecosystem allocation.
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = sola_mint,
        associated_token::authority = authority,
    )]
    pub authority_sola: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ── ClaimFounderHiSola ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ClaimFounderHiSola<'info> {
    /// Only the hardcoded founder wallet may call this.
    #[account(
        mut,
        address = FOUNDER_WALLET.parse::<Pubkey>().unwrap() @ SoladromeError::Unauthorized,
    )]
    pub founder: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

    /// Receives freshly locked SOLA backing the claimed hiSOLA.
    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only — needed for accumulator snapshot before hiSOLA supply changes.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// Founder's hiSOLA ATA — created on first claim if needed.
    #[account(
        init_if_needed,
        payer = founder,
        associated_token::mint = hi_sola_mint,
        associated_token::authority = founder,
    )]
    pub founder_hi_sola: Box<Account<'info, TokenAccount>>,

    /// Founder's fee-share position — tracks fees_debt for claim_fees.
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

// ── ClaimFounderVesting (oSOLA) ───────────────────────────────────────────────

#[derive(Accounts)]
pub struct ClaimFounderVesting<'info> {
    /// Only the hardcoded founder wallet may call this.
    #[account(
        mut,
        address = FOUNDER_WALLET.parse::<Pubkey>().unwrap() @ SoladromeError::Unauthorized,
    )]
    pub founder: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

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

// ── Founder borrow (capped) context ──────────────────────────────────────────

#[derive(Accounts)]
pub struct FounderBorrowUsdc<'info> {
    /// Only the hardcoded founder wallet may call this.
    #[account(
        mut,
        address = FOUNDER_WALLET.parse::<Pubkey>().unwrap() @ SoladromeError::Unauthorized,
    )]
    pub founder: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Account<'info, Mint>,

    /// Founder's hiSOLA balance — used as collateral ceiling.
    #[account(token::mint = hi_sola_mint, token::authority = founder)]
    pub founder_hi_sola: Account<'info, TokenAccount>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Account<'info, TokenAccount>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Account<'info, TokenAccount>,

    /// USDC mint — needed to init founder_usdc ATA on first borrow.
    #[account(address = protocol_state.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    /// Founder's USDC ATA — created on first borrow if needed.
    #[account(
        init_if_needed,
        payer = founder,
        associated_token::mint      = usdc_mint,
        associated_token::authority = founder,
    )]
    pub founder_usdc: Account<'info, TokenAccount>,

    /// Tracks founder's cumulative borrow (same seed as regular UserPosition).
    #[account(
        init_if_needed,
        payer = founder,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, founder.key().as_ref()],
        bump,
    )]
    pub founder_position: Account<'info, UserPosition>,

    /// Vesting schedule — supplies the `claimed` amount used for the 10 % cap.
    #[account(
        seeds = [FOUNDER_HI_VESTING_SEED],
        bump = founder_hi_vesting.bump,
    )]
    pub founder_hi_vesting: Account<'info, FounderHiSolaVesting>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ── Bribe system contexts ─────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct DepositBribe<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

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
pub struct VoteGauge<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: Pool being voted for — label only.
    pub pool_id: UncheckedAccount<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

    /// Caller's hiSOLA balance determines base vote power.
    #[account(constraint = user_hi_sola.mint == hi_sola_mint.key() && user_hi_sola.owner == user.key())]
    pub user_hi_sola: Box<Account<'info, TokenAccount>>,

    /// CHECK: Optional VeLockPosition [b"velock", user].
    /// Pass any account (e.g. SystemProgram) when not using a ve lock.
    /// If valid and unexpired, adds ve-weighted power to the vote cap.
    pub lock_position: UncheckedAccount<'info>,

    /// Aggregate votes for this pool this epoch.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + GaugeState::LEN,
        seeds = [b"gauge", pool_id.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub gauge_state: Box<Account<'info, GaugeState>>,

    /// One receipt per (user, pool, epoch). init = fails on second vote for same pool.
    #[account(
        init,
        payer = user,
        space = 8 + UserVoteReceipt::LEN,
        seeds = [b"vote", user.key().as_ref(), pool_id.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub user_vote_receipt: Box<Account<'info, UserVoteReceipt>>,

    /// Cumulative allocation tracker — prevents over-voting across pools.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserEpochVotes::LEN,
        seeds = [b"uev", user.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub user_epoch_votes: Box<Account<'info, UserEpochVotes>>,

    /// Global vote total for the epoch — denominator for LP emission splits.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + GlobalEpochVotes::LEN,
        seeds = [b"epoch_votes", epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub global_epoch_votes: Box<Account<'info, GlobalEpochVotes>>,

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

// ── LP Emission contexts ──────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct CheckpointLp<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"amm_pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    #[account(constraint = lp_mint.key() == pool.lp_mint)]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(token::mint = lp_mint, token::authority = user)]
    pub user_lp: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + LpUserCheckpoint::LEN,
        seeds = [b"lp_ckpt", pool.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub lp_user_checkpoint: Box<Account<'info, LpUserCheckpoint>>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + LpPoolEpochAccum::LEN,
        seeds = [b"lp_pool_epoch", pool.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub pool_epoch_accum: Box<Account<'info, LpPoolEpochAccum>>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct EmitPoolRewards<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        seeds = [b"amm_pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    #[account(constraint = lp_mint.key() == pool.lp_mint)]
    pub lp_mint: Box<Account<'info, Mint>>,

    /// Gauge for this pool — requires voters used the AMM pool address as pool_id.
    #[account(
        seeds = [b"gauge", pool.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump = gauge_state.bump,
    )]
    pub gauge_state: Box<Account<'info, GaugeState>>,

    #[account(
        seeds = [b"epoch_votes", epoch.to_le_bytes().as_ref()],
        bump = global_epoch_votes.bump,
    )]
    pub global_epoch_votes: Box<Account<'info, GlobalEpochVotes>>,

    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + LpPoolEpochAccum::LEN,
        seeds = [b"lp_pool_epoch", pool.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub pool_epoch_accum: Box<Account<'info, LpPoolEpochAccum>>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct ClaimLpEmissions<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"amm_pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = o_sola_mint,
        associated_token::authority = user,
    )]
    pub user_o_sola: Box<Account<'info, TokenAccount>>,

    #[account(
        seeds = [b"lp_pool_epoch", pool.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump = pool_epoch_accum.bump,
        constraint = pool_epoch_accum.finalized @ SoladromeError::EpochNotFinalized,
    )]
    pub pool_epoch_accum: Box<Account<'info, LpPoolEpochAccum>>,

    #[account(
        seeds = [b"lp_ckpt", pool.key().as_ref(), user.key().as_ref()],
        bump = lp_user_checkpoint.bump,
        constraint = lp_user_checkpoint.last_epoch == epoch @ SoladromeError::NothingToClaim,
    )]
    pub lp_user_checkpoint: Box<Account<'info, LpUserCheckpoint>>,

    #[account(
        init,
        payer = user,
        space = 8 + LpEpochClaim::LEN,
        seeds = [b"lp_claim", user.key().as_ref(), pool.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub lp_epoch_claim: Box<Account<'info, LpEpochClaim>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ── FlashArbitrage ────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct FlashArbitrage<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    /// Caller's oSOLA — burned atomically.
    #[account(mut, token::mint = o_sola_mint, token::authority = caller)]
    pub caller_o_sola: Box<Account<'info, TokenAccount>>,

    /// Caller's SOLA — receives freshly minted SOLA then immediately sells it.
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = sola_mint,
        associated_token::authority = caller,
    )]
    pub caller_sola: Box<Account<'info, TokenAccount>>,

    /// Caller's USDC — receives AMM proceeds; floor + protocol shares are deducted from here.
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = usdc_mint,
        associated_token::authority = caller,
    )]
    pub caller_usdc: Box<Account<'info, TokenAccount>>,

    pub usdc_mint: Box<Account<'info, Mint>>,

    /// AMM pool — must pair SOLA with USDC.
    #[account(
        mut,
        seeds = [AMM_POOL_SEED, pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
        constraint = (
            (pool.token_a_mint == protocol_state.sola_mint && pool.token_b_mint == protocol_state.usdc_mint) ||
            (pool.token_b_mint == protocol_state.sola_mint && pool.token_a_mint == protocol_state.usdc_mint)
        ) @ SoladromeError::InvalidArbPool,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    #[account(mut, address = pool.token_a_vault)]
    pub token_a_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = pool.token_b_vault)]
    pub token_b_vault: Box<Account<'info, TokenAccount>>,

    /// Floor vault — receives `amount_osola` USDC to back the freshly minted SOLA.
    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Box<Account<'info, TokenAccount>>,

    /// Market vault — receives 90 % of gross profit → hiSOLA stakers via claim_fees.
    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
    pub rent:                     Sysvar<'info, Rent>,
}

// ── Contributor / marketing vesting contexts ──────────────────────────────────

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

    pub system_program: Program<'info, System>,
    pub rent:           Sysvar<'info, Rent>,
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

    #[account(mut, address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only — needed for accumulator snapshot before hiSOLA supply changes.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// Contributor's hiSOLA ATA — created on first claim if needed.
    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint      = hi_sola_mint,
        associated_token::authority = contributor,
    )]
    pub contributor_hi_sola: Box<Account<'info, TokenAccount>>,

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

    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
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

    pub token_program:            Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
}

/// Contributor borrows USDC against hiSOLA collateral.
/// Cap = 10% of monthly hiSOLA installment = hi_sola_amount / 120.
/// Flash-borrow guard: repay_usdc requires a strictly later slot.
#[derive(Accounts)]
pub struct ContributorBorrowUsdc<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Account<'info, TokenAccount>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Account<'info, TokenAccount>,

    /// USDC mint — needed to init contributor_usdc ATA on first borrow.
    #[account(address = protocol_state.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    /// Contributor's USDC ATA — created on first borrow if needed.
    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint      = usdc_mint,
        associated_token::authority = contributor,
    )]
    pub contributor_usdc: Account<'info, TokenAccount>,

    /// Shared UserPosition PDA — same seed as regular users, enables repay_usdc.
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
