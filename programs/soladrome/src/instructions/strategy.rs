// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs

//! Per-position reward strategies: each LP position's oSOLA goes where its owner said, harvested
//! at the source so that two positions' strategies never touch each other's rewards.
//!
//! Same shape as the standing order, for the same reason: NOBODY HOLDS A KEY. The cranks are
//! permissionless; the owner fixes the mode, the destination and the bounds; the cranker pays a
//! fee and chooses only the moment.
//!
//! ☢️ Every harvest here is a harvest by a stranger, so every one goes through
//! `harvest_lp_rewards` with `owner_present = false`: a position whose owner parked part of their
//! LP elsewhere is refused, never forfeited.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::spl_token::native_mint;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::instructions::amm::{
    advance_pool_rewards, continuous_active, harvest_lp_rewards, harvest_lp_rewards_up_to,
};
use crate::instructions::auto::{exercise_into_stake, StakeLeg};
use crate::instructions::auto_lp::{lp_deposit_side, route_into_lp, LpRoute, SaleInput};
use crate::instructions::curve::{exercise_fee, max_exercisable};
use crate::state::*;

/// The address of the pool pairing `x` and `y`, as `create_pool` derives it.
fn pool_address(x: Pubkey, y: Pubkey) -> Pubkey {
    let (a, b) = sort_mints(x, y);
    Pubkey::find_program_address(&[AMM_POOL_SEED, a.as_ref(), b.as_ref()], &crate::ID).0
}

/// Create or change the strategy of the owner's position in `source_pool`. The owner signs.
///
/// Also creates, at the owner's expense, every account a crank will write — the destination's LP
/// account and reward record, the oSOLA account a harvest overflow lands in, the stake position —
/// so a crank never initialises anything on someone else's behalf.
pub fn set_pool_strategy(
    ctx: Context<SetPoolStrategy>,
    mode: u8,
    min_harvest: u64,
    min_interval: i64,
    min_intrinsic_bps: u16,
    max_fee_bps: u16,
) -> Result<()> {
    require!(min_harvest > 0, SoladromeError::InvalidAmount);
    require!(
        min_interval >= MIN_CRANK_INTERVAL,
        SoladromeError::InvalidAmount
    );
    let state = &ctx.accounts.protocol_state;
    let source = ctx.accounts.source_pool.key();
    let target = ctx.accounts.target_pool.key();

    let strategy = &mut ctx.accounts.strategy;
    match mode {
        STRATEGY_LIQUIDITY => {
            require!(
                min_intrinsic_bps > 0 && min_intrinsic_bps <= 10_000,
                SoladromeError::InvalidAmount
            );
            let (_, needs_hop) = lp_deposit_side(&ctx.accounts.target_pool, state)?;
            // ☢️ A round harvests the source pool and trades through the route pools. If the
            // source WERE a route pool, the same account would appear twice in one instruction,
            // and two deserialized copies of one pool would overwrite each other at exit. Refused
            // here, where the owner can see why, and re-checked at every crank.
            require!(
                source != pool_address(state.o_sola_mint, state.usdc_mint),
                SoladromeError::StrategyRouteConflict
            );
            require!(
                !needs_hop || source != pool_address(native_mint::ID, state.usdc_mint),
                SoladromeError::StrategyRouteConflict
            );
            strategy.target_pool = target;
            strategy.min_intrinsic_bps = min_intrinsic_bps;
            strategy.max_fee_bps = 0;
        }
        STRATEGY_VOTE => {
            // An explicit bound, not an "unset" zero: a strategy is new, so there is no older
            // account whose zeros need honouring.
            require!(
                max_fee_bps > 0 && max_fee_bps <= MAX_EXERCISE_FEE_BPS,
                SoladromeError::InvalidAmount
            );
            strategy.target_pool = Pubkey::default();
            strategy.min_intrinsic_bps = 0;
            strategy.max_fee_bps = max_fee_bps;
        }
        _ => return err!(SoladromeError::StrategyWrongMode),
    }

    strategy.owner = ctx.accounts.user.key();
    strategy.source_pool = source;
    strategy.mode = mode;
    strategy.min_harvest = min_harvest;
    strategy.min_interval = min_interval;
    if strategy.bump == 0 {
        strategy.bump = ctx.bumps.strategy;
    }

    let info = &mut ctx.accounts.target_lp_user_info;
    if info.bump == 0 {
        info.bump = ctx.bumps.target_lp_user_info;
    }
    Ok(())
}

/// Remove a strategy: the position's rewards go back to accruing for a manual claim. The owner
/// signs and recovers the rent.
pub fn close_pool_strategy(_ctx: Context<ClosePoolStrategy>) -> Result<()> {
    Ok(())
}

/// Harvest a position's rewards and compound them into liquidity. Callable by anyone.
pub fn crank_pool_strategy_lp(ctx: Context<CrankPoolStrategyLp>) -> Result<()> {
    let a = ctx.accounts;
    require!(!a.protocol_state.paused, SoladromeError::ProtocolPaused);
    require!(
        a.strategy.owner == a.owner.key(),
        SoladromeError::AutoOwnerMismatch
    );
    require!(
        a.strategy.mode == STRATEGY_LIQUIDITY,
        SoladromeError::StrategyWrongMode
    );
    // The destination is the owner's: the pool passed must be the one the strategy names.
    require!(
        a.target_pool.key() == a.strategy.target_pool,
        SoladromeError::AutoWrongDestination
    );
    let now = Clock::get()?.unix_timestamp;
    require!(a.strategy.due(now), SoladromeError::AutoNotReady);

    let owner = a.owner.key();
    let cont_rate = a.protocol_state.continuous_rate_per_sec;
    let cont_active = continuous_active(&a.protocol_state, now);
    let source_is_target = a.strategy.source_pool == a.strategy.target_pool;

    // ── 1. Harvest the source position ────────────────────────────────────────
    //
    // When the source IS the destination, it is passed once and harvested through the target's
    // accounts; the separate source accounts must then be absent, so the same pool can never be
    // two accounts in this instruction.
    let pending = if source_is_target {
        require!(
            a.source_pool.is_none()
                && a.source_lp_user_info.is_none()
                && a.source_user_lp.is_none(),
            SoladromeError::StrategyRouteConflict
        );
        advance_pool_rewards(&mut a.target_pool, now, cont_rate, cont_active);
        let acc = a.target_pool.osola_reward_per_lp;
        // The same position is guarded twice here: this harvest, then the deposit's own
        // `credit_lp_deposit`, both with `owner_present = false`. Deliberate — a mutation that
        // weakens only this one survives the suite, because the second still refuses; the
        // cross-pool branch below has no second guard and is tested on its own.
        harvest_lp_rewards(&mut a.target_lp_user_info, acc, a.user_lp.amount, false)?
    } else {
        let (Some(pool), Some(info), Some(user_lp)) = (
            a.source_pool.as_deref_mut(),
            a.source_lp_user_info.as_deref_mut(),
            a.source_user_lp.as_deref(),
        ) else {
            return err!(SoladromeError::AutoInvalidRoute);
        };
        require!(
            pool.key() == a.strategy.source_pool,
            SoladromeError::AutoWrongDestination
        );
        // ☢️ The source is not a route pool — see `set_pool_strategy` — re-checked against the
        // accounts actually passed, since that is what an overwrite would come from.
        require!(
            pool.key() != a.sell_pool.key()
                && a.hop_pool.as_ref().is_none_or(|h| h.key() != pool.key()),
            SoladromeError::StrategyRouteConflict
        );
        // The reward record and the LP balance must be THIS owner's in THIS pool: the record by
        // its seeds, the balance by being the associated account — a decoy LP account is a set
        // anyone can add to (the 2026-09-21 grief).
        let expected_info = Pubkey::create_program_address(
            &[
                b"lp_user",
                pool.key().as_ref(),
                owner.as_ref(),
                &[info.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(SoladromeError::AutoInvalidRoute))?;
        require!(
            info.key() == expected_info
                && user_lp.key() == get_associated_token_address(&owner, &pool.lp_mint),
            SoladromeError::AutoInvalidRoute
        );
        advance_pool_rewards(pool, now, cont_rate, cont_active);
        let acc = pool.osola_reward_per_lp;
        harvest_lp_rewards(info, acc, user_lp.amount, false)?
    };
    require!(
        pending > 0 && pending >= a.strategy.min_harvest,
        SoladromeError::AutoNotReady
    );

    // ── 2. Sell what one round may, hand the rest to the owner ───────────────
    //
    // A harvest cannot be partial — the accrual is one scalar per position — so a backlog larger
    // than one leg may trade would otherwise block the strategy for good. What exceeds the leg is
    // minted to the owner's own oSOLA account: theirs, not lost, just not compounded this round.
    let o_sola = a.protocol_state.o_sola_mint;
    let sell_reserve = if a.sell_pool.token_a_mint == o_sola {
        a.sell_pool.reserve_a
    } else {
        a.sell_pool.reserve_b
    };
    let leg = (sell_reserve as u128 * MAX_LP_LEG_IMPACT_BPS / 10_000) as u64;
    let sell = pending.min(leg);
    let overflow = pending - sell;

    let min_intrinsic_bps = a.strategy.min_intrinsic_bps;
    let lp_user_info_bump = ctx.bumps.target_lp_user_info;
    route_into_lp(
        LpRoute {
            protocol_state: &mut a.protocol_state,
            o_sola_mint: &a.o_sola_mint,
            user_o_sola: &a.user_o_sola,
            sell_pool: &mut a.sell_pool,
            sell_o_sola_vault: &a.sell_o_sola_vault,
            sell_usdc_vault: &a.sell_usdc_vault,
            hop_pool: a.hop_pool.as_deref_mut(),
            hop_usdc_vault: a.hop_usdc_vault.as_deref(),
            hop_sol_vault: a.hop_sol_vault.as_deref(),
            target_pool: &mut a.target_pool,
            target_deposit_vault: &a.target_deposit_vault,
            lp_mint: &a.lp_mint,
            user_lp: &a.user_lp,
            lp_user_info: &mut a.target_lp_user_info,
            lp_user_info_bump,
            market_vault: &a.market_vault,
            token_program: &a.token_program,
        },
        sell,
        min_intrinsic_bps,
        now,
        SaleInput::Minted,
    )?;

    if overflow > 0 {
        let state_seeds: &[&[u8]] = &[STATE_SEED, &[a.protocol_state.bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                MintTo {
                    mint: a.o_sola_mint.to_account_info(),
                    to: a.user_o_sola.to_account_info(),
                    authority: a.protocol_state.to_account_info(),
                },
                &[state_seeds],
            ),
            overflow,
        )?;
    }

    let s = &mut a.strategy;
    s.rounds = s.rounds.saturating_add(1);
    s.harvested = s.harvested.saturating_add(pending);
    s.last_ts = now;
    Ok(())
}

/// Harvest a position's rewards and exercise them into staked hiSOLA. Callable by anyone.
///
/// The oSOLA is never minted: the harvested amount is exercised directly — strike in full to the
/// floor, fee on top, both from the owner's USDC through the delegate they approved — and staked
/// as financed hiSOLA. The same end state as claim, exercise and stake, one instruction.
pub fn crank_pool_strategy_vote(ctx: Context<CrankPoolStrategyVote>) -> Result<()> {
    let a = ctx.accounts;
    require!(!a.protocol_state.paused, SoladromeError::ProtocolPaused);
    // An exercise pathway honours the exercise gate, like `exercise_o_sola` and the standing order.
    require!(
        a.protocol_state.exercise_enabled,
        SoladromeError::FeatureDisabled
    );
    require!(
        a.strategy.owner == a.owner.key(),
        SoladromeError::AutoOwnerMismatch
    );
    require!(
        a.strategy.mode == STRATEGY_VOTE,
        SoladromeError::StrategyWrongMode
    );
    let now = Clock::get()?.unix_timestamp;
    require!(a.strategy.due(now), SoladromeError::AutoNotReady);
    // ☢️ The rate bound, price-independent — see `AutoCompound::max_fee_bps`.
    require!(
        a.protocol_state.exercise_fee_bps <= a.strategy.max_fee_bps,
        SoladromeError::AutoCostTooHigh
    );

    let cont_rate = a.protocol_state.continuous_rate_per_sec;
    let cont_active = continuous_active(&a.protocol_state, now);
    advance_pool_rewards(&mut a.source_pool, now, cont_rate, cont_active);
    let acc = a.source_pool.osola_reward_per_lp;

    // ☢️ The round takes what the owner's USDC pays for, never more. It used to exercise the
    // whole accrual, and the day that exceeded the allowance or the balance the strike transfer
    // failed — on that round and every round after, because accrual only grows while the budget
    // stands still (5 of 8 devnet strategies, 2026-09-26). The rest stays accrued on the position.
    let budget = match a.user_usdc.delegate {
        COption::Some(d) if d == a.auto_delegate.key() => {
            a.user_usdc.amount.min(a.user_usdc.delegated_amount)
        }
        _ => 0,
    };
    require!(budget > 0, SoladromeError::StrategyNoBudget);
    let affordable = max_exercisable(&a.protocol_state, budget)?;
    let pending = harvest_lp_rewards_up_to(
        &mut a.source_lp_user_info,
        acc,
        a.source_user_lp.amount,
        false,
        affordable,
    )?;
    // `min_harvest` bounds the round, not the accrual: a round is what the cranker pays a fee for.
    require!(
        pending > 0 && pending >= a.strategy.min_harvest,
        SoladromeError::AutoNotReady
    );

    let fee = exercise_fee(&a.protocol_state, pending)?;
    let owner = a.owner.key();
    let delegate_bump = ctx.bumps.auto_delegate;
    let delegate_seeds: &[&[u8]] = &[AUTO_SEED, owner.as_ref(), &[delegate_bump]];
    let position_bump = ctx.bumps.user_position;
    let delegate = a.auto_delegate.to_account_info();
    exercise_into_stake(
        StakeLeg {
            protocol_state: &mut a.protocol_state,
            user_position: &mut a.user_position,
            position_bump,
            user_usdc: &a.user_usdc,
            floor_vault: &a.floor_vault,
            market_vault: &mut a.market_vault,
            sola_mint: &a.sola_mint,
            sola_vault: &a.sola_vault,
            token_program: &a.token_program,
        },
        owner,
        pending,
        fee,
        delegate,
        delegate_seeds,
    )?;

    let s = &mut a.strategy;
    s.rounds = s.rounds.saturating_add(1);
    s.harvested = s.harvested.saturating_add(pending);
    s.last_ts = now;
    Ok(())
}

// ── Contexts ─────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct SetPoolStrategy<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + PoolStrategy::LEN,
        seeds = [STRATEGY_SEED, user.key().as_ref(), source_pool.key().as_ref()],
        bump,
    )]
    pub strategy: Box<Account<'info, PoolStrategy>>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(
        seeds = [AMM_POOL_SEED, source_pool.token_a_mint.as_ref(), source_pool.token_b_mint.as_ref()],
        bump = source_pool.bump,
    )]
    pub source_pool: Box<Account<'info, AmmPool>>,

    /// The destination for a liquidity strategy. For a voting one, pass the source again — it is
    /// read, never written, and nothing is stored from it.
    #[account(
        seeds = [AMM_POOL_SEED, target_pool.token_a_mint.as_ref(), target_pool.token_b_mint.as_ref()],
        bump = target_pool.bump,
    )]
    pub target_pool: Box<Account<'info, AmmPool>>,

    #[account(address = target_pool.lp_mint)]
    pub target_lp_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = target_lp_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub target_user_lp: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + LpUserInfo::LEN,
        seeds = [b"lp_user", target_pool.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub target_lp_user_info: Box<Account<'info, LpUserInfo>>,

    #[account(address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Box<Account<'info, Mint>>,

    /// Where a harvest larger than one round lands, and where a deposit's own harvest goes.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = o_sola_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_o_sola: Box<Account<'info, TokenAccount>>,

    /// Created here so a voting crank never has to.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClosePoolStrategy<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        close = user,
        seeds = [STRATEGY_SEED, user.key().as_ref(), strategy.source_pool.as_ref()],
        bump = strategy.bump,
        constraint = strategy.owner == user.key() @ SoladromeError::AutoOwnerMismatch,
    )]
    pub strategy: Box<Account<'info, PoolStrategy>>,
}

#[derive(Accounts)]
pub struct CrankPoolStrategyLp<'info> {
    /// Anyone. Pays the transaction fee and receives nothing.
    pub cranker: Signer<'info>,

    /// CHECK: identity only — every account below is bound to it by seeds or by associated-token
    /// derivation, and `strategy.owner` is checked against it in the handler.
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [STRATEGY_SEED, owner.key().as_ref(), strategy.source_pool.as_ref()],
        bump = strategy.bump,
    )]
    pub strategy: Box<Account<'info, PoolStrategy>>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// Mut: harvested rewards are minted from here.
    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = o_sola_mint,
        associated_token::authority = owner,
    )]
    pub user_o_sola: Box<Account<'info, TokenAccount>>,

    /// The source position — absent when the source IS the destination, which is then harvested
    /// through the target accounts below. Checked in the handler against the strategy and owner.
    #[account(
        mut,
        seeds = [AMM_POOL_SEED, source_pool.token_a_mint.as_ref(), source_pool.token_b_mint.as_ref()],
        bump = source_pool.bump,
    )]
    pub source_pool: Option<Box<Account<'info, AmmPool>>>,

    #[account(mut)]
    pub source_lp_user_info: Option<Box<Account<'info, LpUserInfo>>>,

    pub source_user_lp: Option<Box<Account<'info, TokenAccount>>>,

    #[account(
        mut,
        seeds = [AMM_POOL_SEED, sell_pool.token_a_mint.as_ref(), sell_pool.token_b_mint.as_ref()],
        bump = sell_pool.bump,
    )]
    pub sell_pool: Box<Account<'info, AmmPool>>,

    #[account(mut)]
    pub sell_o_sola_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub sell_usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [AMM_POOL_SEED, hop_pool.token_a_mint.as_ref(), hop_pool.token_b_mint.as_ref()],
        bump = hop_pool.bump,
    )]
    pub hop_pool: Option<Box<Account<'info, AmmPool>>>,

    #[account(mut)]
    pub hop_usdc_vault: Option<Box<Account<'info, TokenAccount>>>,

    #[account(mut)]
    pub hop_sol_vault: Option<Box<Account<'info, TokenAccount>>>,

    #[account(
        mut,
        seeds = [AMM_POOL_SEED, target_pool.token_a_mint.as_ref(), target_pool.token_b_mint.as_ref()],
        bump = target_pool.bump,
    )]
    pub target_pool: Box<Account<'info, AmmPool>>,

    #[account(mut)]
    pub target_deposit_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = target_pool.lp_mint)]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = lp_mint,
        associated_token::authority = owner,
    )]
    pub user_lp: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"lp_user", target_pool.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub target_lp_user_info: Box<Account<'info, LpUserInfo>>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CrankPoolStrategyVote<'info> {
    /// Anyone. Pays the transaction fee and receives nothing.
    pub cranker: Signer<'info>,

    /// CHECK: identity only — bound to every account below by seeds or associated-token
    /// derivation, and to `strategy.owner` in the handler.
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [STRATEGY_SEED, owner.key().as_ref(), source_pool.key().as_ref()],
        bump = strategy.bump,
    )]
    pub strategy: Box<Account<'info, PoolStrategy>>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(
        mut,
        seeds = [AMM_POOL_SEED, source_pool.token_a_mint.as_ref(), source_pool.token_b_mint.as_ref()],
        bump = source_pool.bump,
    )]
    pub source_pool: Box<Account<'info, AmmPool>>,

    #[account(address = source_pool.lp_mint)]
    pub source_lp_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"lp_user", source_pool.key().as_ref(), owner.key().as_ref()],
        bump = source_lp_user_info.bump,
    )]
    pub source_lp_user_info: Box<Account<'info, LpUserInfo>>,

    /// The ASSOCIATED account and no other: a decoy LP account is a set anyone can add to.
    #[account(
        associated_token::mint = source_lp_mint,
        associated_token::authority = owner,
    )]
    pub source_user_lp: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = owner,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(address = protocol_state.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// CHECK: the standing-order PDA [b"auto", owner], used only as the SPL delegate that pays the
    /// strike. It need not hold an account — a PDA signs whether or not one exists — and the seeds
    /// bind it to this owner, so no other delegate can be substituted.
    #[account(seeds = [AUTO_SEED, owner.key().as_ref()], bump)]
    pub auto_delegate: UncheckedAccount<'info>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
