// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs

//! Standing LP orders: the second destination of a standing compound order.
//!
//! Where `crank_auto_compound` turns oSOLA into voting power (exercise, stake), this turns it into
//! liquidity: sell the oSOLA on the oSOLA/USDC pool, reach the destination pool's quote side —
//! directly if it pairs USDC, through the SOL/USDC pool if it pairs SOL — and deposit that single
//! side with `amm_math::zap_in`. Nothing is exercised, so no strike, no floor movement and no USDC
//! is asked of the owner: whoever buys the oSOLA pays the strike when they exercise it.
//!
//! ☢️ Same shape as the staking order, and for the same reason: NOBODY HOLDS A KEY. The oSOLA
//! moves under the SPL delegation the owner granted to the `AutoCompound` PDA, capped by SPL Token
//! itself; every other token moves vault to vault under the pool PDAs; the LP is minted to the
//! owner's own associated account. The cranker signs, pays the fee, and receives nothing.
//!
//! What a permissionless crank can still do is choose the MOMENT, and therefore sandwich. The
//! defences, leg by leg:
//!   · the sale: at least `min_intrinsic_bps` of the oSOLA's exercise value, a reference priced
//!     off the curve, which no trade can push down;
//!   · every leg: at most `MAX_LP_LEG_IMPACT_BPS` of the input reserve;
//!   · the route: derived, never passed — the cranker cannot pick a shallower hop.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::spl_token::native_mint;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::amm_math;
use crate::constants::*;
use crate::errors::SoladromeError;
use crate::instructions::amm::{
    advance_pool_rewards, apply_swap_reserves, continuous_active, credit_lp_deposit, quote_swap,
    require_floor_respected,
};
use crate::instructions::curve::{exercise_fee, exercise_gain};
use crate::state::*;

/// Which side of `pool` a standing LP order deposits, and whether reaching it needs the SOL hop.
///
/// A destination must pair USDC (deposit the sale's proceeds as they are) or SOL (buy SOL on the
/// SOL/USDC pool first). USDC wins when a pool holds both, because it needs no hop. A pool that
/// holds oSOLA is refused: the order would be selling into the pool it then deposits into, and
/// the sale's own price impact would be what it bought.
pub fn lp_deposit_side(pool: &AmmPool, state: &ProtocolState) -> Result<(Pubkey, bool)> {
    let holds = |m: Pubkey| pool.token_a_mint == m || pool.token_b_mint == m;
    require!(!holds(state.o_sola_mint), SoladromeError::AutoInvalidRoute);
    if holds(state.usdc_mint) {
        Ok((state.usdc_mint, false))
    } else if holds(native_mint::ID) {
        Ok((native_mint::ID, true))
    } else {
        err!(SoladromeError::AutoInvalidRoute)
    }
}

/// Whether `pool` is exactly the pair `{x, y}`, in either order.
fn is_pair(pool: &AmmPool, x: Pubkey, y: Pubkey) -> bool {
    (pool.token_a_mint == x && pool.token_b_mint == y)
        || (pool.token_a_mint == y && pool.token_b_mint == x)
}

/// The vault holding `mint` in `pool`. The caller has already established that the pool holds it.
fn vault_of(pool: &AmmPool, mint: Pubkey) -> Pubkey {
    if pool.token_a_mint == mint {
        pool.token_a_vault
    } else {
        pool.token_b_vault
    }
}

/// The reserve on `mint`'s side of `pool`.
fn reserve_of(pool: &AmmPool, mint: Pubkey) -> u64 {
    if pool.token_a_mint == mint {
        pool.reserve_a
    } else {
        pool.reserve_b
    }
}

/// Refuse a leg that trades more than `MAX_LP_LEG_IMPACT_BPS` of the reserve it trades into.
fn require_small_leg(amount_in: u64, reserve_in: u64) -> Result<()> {
    require!(
        amount_in as u128 * 10_000 <= reserve_in as u128 * MAX_LP_LEG_IMPACT_BPS,
        SoladromeError::AutoImpactTooHigh
    );
    Ok(())
}

/// Point an existing standing order at a pool: from now on it compounds into liquidity there.
/// The owner signs.
///
/// The threshold, chunk, pacing and oSOLA allowance are the order's own and stay as
/// `configure_auto_compound` set them. This instruction also creates, at the owner's expense, the
/// two accounts the crank will write — the LP associated account and the reward record — so the
/// crank never has to initialise anything on someone else's behalf, nor take a payer it could be
/// made to drain.
pub fn set_auto_compound_lp(ctx: Context<SetAutoCompoundLp>, min_intrinsic_bps: u16) -> Result<()> {
    // Zero would accept any price, which is no bound at all; above 100 % the order could never
    // fire, because a buyer who can exercise will not pay more than exercising nets.
    require!(
        min_intrinsic_bps > 0 && min_intrinsic_bps <= 10_000,
        SoladromeError::InvalidAmount
    );
    lp_deposit_side(&ctx.accounts.target_pool, &ctx.accounts.protocol_state)?;

    let auto = &mut ctx.accounts.auto;
    auto.lp_target = ctx.accounts.target_pool.key();
    auto.min_intrinsic_bps = min_intrinsic_bps;

    let info = &mut ctx.accounts.lp_user_info;
    if info.bump == 0 {
        info.bump = ctx.bumps.lp_user_info;
    }
    Ok(())
}

/// Point a standing order back at staking. The owner signs.
pub fn clear_auto_compound_lp(ctx: Context<ClearAutoCompoundLp>) -> Result<()> {
    let auto = &mut ctx.accounts.auto;
    auto.lp_target = Pubkey::default();
    auto.min_intrinsic_bps = 0;
    Ok(())
}

/// Fire one round of a standing LP order. Callable by anyone.
pub fn crank_auto_compound_lp(ctx: Context<CrankAutoCompoundLp>) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(
        ctx.accounts.auto.owner == ctx.accounts.owner.key(),
        SoladromeError::AutoOwnerMismatch
    );
    // The destination is the owner's, not the cranker's: the pool passed must be the one named.
    let target_key = ctx.accounts.target_pool.key();
    require!(
        ctx.accounts.auto.lp_target != Pubkey::default()
            && ctx.accounts.auto.lp_target == target_key,
        SoladromeError::AutoWrongDestination
    );

    let now = Clock::get()?.unix_timestamp;
    let amount = ctx.accounts.auto.chunk;
    require!(
        ctx.accounts
            .auto
            .ready(ctx.accounts.user_o_sola.amount, now),
        SoladromeError::AutoNotReady
    );

    let owner_key = ctx.accounts.owner.key();
    let auto_bump = ctx.accounts.auto.bump;
    let auto_seeds: &[&[u8]] = &[AUTO_SEED, owner_key.as_ref(), &[auto_bump]];
    let min_intrinsic_bps = ctx.accounts.auto.min_intrinsic_bps;

    let lp_user_info_bump = ctx.bumps.lp_user_info;
    let a = ctx.accounts;
    let delegate = a.auto.to_account_info();
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
            lp_user_info: &mut a.lp_user_info,
            lp_user_info_bump,
            market_vault: &a.market_vault,
            token_program: &a.token_program,
        },
        amount,
        min_intrinsic_bps,
        now,
        SaleInput::FromOwner {
            from: a.user_o_sola.to_account_info(),
            delegate,
            seeds: auto_seeds,
        },
    )?;

    let auto = &mut a.auto;
    auto.rounds = auto.rounds.saturating_add(1);
    auto.last_crank_ts = now;
    Ok(())
}

// ── The route, shared by every crank that turns oSOLA into liquidity ─────────

/// Where the oSOLA a route sells comes from.
pub enum SaleInput<'a, 'info> {
    /// Out of the owner's own account, moved by the delegate they approved (a standing order).
    FromOwner {
        from: AccountInfo<'info>,
        delegate: AccountInfo<'info>,
        seeds: &'a [&'a [u8]],
    },
    /// Minted straight into the sale vault: rewards harvested at their source by a per-position
    /// strategy, which never reach the owner's wallet at all.
    Minted,
}

/// The accounts a route touches. Borrowed out of whichever context the crank has, so the two
/// cranks share one body instead of two copies that could drift.
pub struct LpRoute<'a, 'info> {
    pub protocol_state: &'a mut Account<'info, ProtocolState>,
    pub o_sola_mint: &'a Account<'info, Mint>,
    pub user_o_sola: &'a Account<'info, TokenAccount>,
    pub sell_pool: &'a mut Account<'info, AmmPool>,
    pub sell_o_sola_vault: &'a Account<'info, TokenAccount>,
    pub sell_usdc_vault: &'a Account<'info, TokenAccount>,
    pub hop_pool: Option<&'a mut Account<'info, AmmPool>>,
    pub hop_usdc_vault: Option<&'a Account<'info, TokenAccount>>,
    pub hop_sol_vault: Option<&'a Account<'info, TokenAccount>>,
    pub target_pool: &'a mut Account<'info, AmmPool>,
    pub target_deposit_vault: &'a Account<'info, TokenAccount>,
    pub lp_mint: &'a Account<'info, Mint>,
    pub user_lp: &'a Account<'info, TokenAccount>,
    pub lp_user_info: &'a mut Account<'info, LpUserInfo>,
    pub lp_user_info_bump: u8,
    pub market_vault: &'a Account<'info, TokenAccount>,
    pub token_program: &'a Program<'info, Token>,
}

/// Sell `amount` oSOLA on THE oSOLA/USDC pool, reach the destination's USDC or SOL side — through
/// THE SOL/USDC pool when it pairs SOL — and deposit that single side for the owner.
///
/// Every check a permissionless caller could otherwise exploit lives here, once:
///   · the route is derived — the pair and vault of every leg are checked against the pools' own
///     records, so no hop or vault can be substituted;
///   · ☢️ the sale must pay `min_intrinsic_bps` of the oSOLA's exercise value, priced off the
///     curve, which no trade can push down;
///   · every leg is capped at `MAX_LP_LEG_IMPACT_BPS` of the reserve it trades into;
///   · ☢️ the deposit books through `credit_lp_deposit` with `owner_present = false`, so a
///     position whose owner parked part of their LP elsewhere is refused, not forfeited.
pub fn route_into_lp<'a, 'info>(
    r: LpRoute<'a, 'info>,
    amount: u64,
    min_intrinsic_bps: u16,
    now: i64,
    input: SaleInput<'a, 'info>,
) -> Result<RouteOutcome> {
    let usdc = r.protocol_state.usdc_mint;
    let o_sola = r.protocol_state.o_sola_mint;
    let (deposit_mint, needs_hop) = lp_deposit_side(r.target_pool, r.protocol_state)?;
    let cont_rate = r.protocol_state.continuous_rate_per_sec;
    let cont_active = continuous_active(r.protocol_state, now);
    let state_bump = r.protocol_state.bump;
    let state_seeds: &[&[u8]] = &[STATE_SEED, &[state_bump]];

    // ☢️ NO POOL MAY BE PASSED TWICE. `AmmPool` is owned by this program, so Anchor writes every
    // mutable copy back at exit, in field order — and it does NOT refuse a duplicate. Found in the
    // 2026-09-24 review: with a USDC destination the hop was never read, so a cranker could pass
    // THE SALE POOL as `hop_pool`; its stale copy, written after the real one, reverted the sale's
    // reserve update and left the pool pricing USDC its vault no longer held — repeatable by anyone,
    // with their own cheap orders, until the vault was drained. So: the hop is absent unless the
    // route needs it, and every pool on the route is a distinct account.
    if !needs_hop {
        require!(
            r.hop_pool.is_none() && r.hop_usdc_vault.is_none() && r.hop_sol_vault.is_none(),
            SoladromeError::AutoInvalidRoute
        );
    }
    let (sell_key, target_key) = (r.sell_pool.key(), r.target_pool.key());
    require!(sell_key != target_key, SoladromeError::AutoInvalidRoute);
    if let Some(hop) = r.hop_pool.as_ref() {
        require!(
            hop.key() != sell_key && hop.key() != target_key,
            SoladromeError::AutoInvalidRoute
        );
    }

    // ── 1. Sell the oSOLA on THE oSOLA/USDC pool ─────────────────────────────
    require!(
        is_pair(r.sell_pool, o_sola, usdc),
        SoladromeError::AutoInvalidRoute
    );
    require!(
        r.sell_o_sola_vault.key() == vault_of(r.sell_pool, o_sola)
            && r.sell_usdc_vault.key() == vault_of(r.sell_pool, usdc),
        SoladromeError::AutoInvalidRoute
    );
    let o_sola_is_a = r.sell_pool.token_a_mint == o_sola;
    let q1 = quote_swap(r.sell_pool, amount, o_sola_is_a)?;
    require_small_leg(amount, reserve_of(r.sell_pool, o_sola))?;

    // ☢️ The bound a sandwich cannot move. Exercising `amount` would net its gain on the curve
    // less the fee on that gain; the pool must pay at least the owner's share of that.
    let intrinsic = exercise_gain(r.protocol_state, amount)?
        .saturating_sub(exercise_fee(r.protocol_state, amount)?);
    let floor_out = intrinsic as u128 * min_intrinsic_bps as u128 / 10_000;
    require!(
        q1.amount_out as u128 >= floor_out,
        SoladromeError::AutoBelowIntrinsic
    );

    let (sell_a, sell_b, sell_bump) = (
        r.sell_pool.token_a_mint,
        r.sell_pool.token_b_mint,
        r.sell_pool.bump,
    );
    let sell_seeds: &[&[u8]] = &[
        AMM_POOL_SEED,
        sell_a.as_ref(),
        sell_b.as_ref(),
        &[sell_bump],
    ];

    // The oSOLA enters the pool. The whole input enters the reserve: the fee is on oSOLA, not
    // USDC, so like `swap` it stays with the LPs.
    match input {
        SaleInput::FromOwner {
            from,
            delegate,
            seeds,
        } => token::transfer(
            CpiContext::new_with_signer(
                r.token_program.to_account_info(),
                Transfer {
                    from,
                    to: r.sell_o_sola_vault.to_account_info(),
                    authority: delegate,
                },
                &[seeds],
            ),
            amount,
        )?,
        SaleInput::Minted => token::mint_to(
            CpiContext::new_with_signer(
                r.token_program.to_account_info(),
                MintTo {
                    mint: r.o_sola_mint.to_account_info(),
                    to: r.sell_o_sola_vault.to_account_info(),
                    authority: r.protocol_state.to_account_info(),
                },
                &[state_seeds],
            ),
            amount,
        )?,
    }
    advance_pool_rewards(r.sell_pool, now, cont_rate, cont_active);
    apply_swap_reserves(r.sell_pool, o_sola_is_a, amount, q1.amount_out)?;

    // USDC: straight to the next vault on the route. It never passes through a wallet.
    let usdc_dest = if needs_hop {
        r.hop_usdc_vault
            .ok_or(SoladromeError::AutoInvalidRoute)?
            .to_account_info()
    } else {
        r.target_deposit_vault.to_account_info()
    };
    token::transfer(
        CpiContext::new_with_signer(
            r.token_program.to_account_info(),
            Transfer {
                from: r.sell_usdc_vault.to_account_info(),
                to: usdc_dest,
                authority: r.sell_pool.to_account_info(),
            },
            &[sell_seeds],
        ),
        q1.amount_out,
    )?;

    // ── 2. The SOL hop, when the destination pairs SOL ───────────────────────
    let deposit = if needs_hop {
        let (Some(hop), Some(hop_usdc), Some(hop_sol)) =
            (r.hop_pool, r.hop_usdc_vault, r.hop_sol_vault)
        else {
            return err!(SoladromeError::AutoInvalidRoute);
        };
        require!(
            is_pair(hop, usdc, native_mint::ID)
                && hop_usdc.key() == vault_of(hop, usdc)
                && hop_sol.key() == vault_of(hop, native_mint::ID),
            SoladromeError::AutoInvalidRoute
        );
        let usdc_is_a = hop.token_a_mint == usdc;
        let q2 = quote_swap(hop, q1.amount_out, usdc_is_a)?;
        require_small_leg(q1.amount_out, reserve_of(hop, usdc))?;

        let (hop_a, hop_b, hop_bump) = (hop.token_a_mint, hop.token_b_mint, hop.bump);
        let hop_seeds: &[&[u8]] = &[AMM_POOL_SEED, hop_a.as_ref(), hop_b.as_ref(), &[hop_bump]];

        // The input is USDC, so the protocol's share of the fee leaves for `market_vault`,
        // exactly as `swap` routes it.
        if q2.fee_protocol > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    r.token_program.to_account_info(),
                    Transfer {
                        from: hop_usdc.to_account_info(),
                        to: r.market_vault.to_account_info(),
                        authority: hop.to_account_info(),
                    },
                    &[hop_seeds],
                ),
                q2.fee_protocol,
            )?;
        }
        token::transfer(
            CpiContext::new_with_signer(
                r.token_program.to_account_info(),
                Transfer {
                    from: hop_sol.to_account_info(),
                    to: r.target_deposit_vault.to_account_info(),
                    authority: hop.to_account_info(),
                },
                &[hop_seeds],
            ),
            q2.amount_out,
        )?;
        advance_pool_rewards(hop, now, cont_rate, cont_active);
        apply_swap_reserves(
            hop,
            usdc_is_a,
            q1.amount_out - q2.fee_protocol,
            q2.amount_out,
        )?;
        r.protocol_state.accumulated_fees = r
            .protocol_state
            .accumulated_fees
            .saturating_add(q2.fee_protocol);
        q2.amount_out
    } else {
        q1.amount_out
    };

    // ── 3. Deposit that one side into the destination ────────────────────────
    require!(
        r.target_deposit_vault.key() == vault_of(r.target_pool, deposit_mint),
        SoladromeError::AutoInvalidRoute
    );
    let deposit_is_a = r.target_pool.token_a_mint == deposit_mint;
    let (r_in, r_out) = if deposit_is_a {
        (r.target_pool.reserve_a, r.target_pool.reserve_b)
    } else {
        (r.target_pool.reserve_b, r.target_pool.reserve_a)
    };
    require_small_leg(deposit, r_in)?;
    let zap = amm_math::zap_in(
        r_in,
        r_out,
        r.target_pool.total_lp,
        deposit,
        r.target_pool.fee_rate,
        r.target_pool.protocol_fee_bps,
        deposit_mint == usdc,
    )?;

    let (t_a, t_b, t_bump) = (
        r.target_pool.token_a_mint,
        r.target_pool.token_b_mint,
        r.target_pool.bump,
    );
    let target_seeds: &[&[u8]] = &[AMM_POOL_SEED, t_a.as_ref(), t_b.as_ref(), &[t_bump]];

    if zap.fee_routed > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                r.token_program.to_account_info(),
                Transfer {
                    from: r.target_deposit_vault.to_account_info(),
                    to: r.market_vault.to_account_info(),
                    authority: r.target_pool.to_account_info(),
                },
                &[target_seeds],
            ),
            zap.fee_routed,
        )?;
        r.protocol_state.accumulated_fees = r
            .protocol_state
            .accumulated_fees
            .saturating_add(zap.fee_routed);
    }

    // Rewards first, on the supply BEFORE this deposit — see `credit_lp_deposit`.
    advance_pool_rewards(r.target_pool, now, cont_rate, cont_active);
    let acc = r.target_pool.osola_reward_per_lp;
    // ☢️ `owner_present = false`: this deposit harvests, and the one making it is a stranger.
    let pending = credit_lp_deposit(
        r.lp_user_info,
        acc,
        r.user_lp.amount,
        zap.lp_out,
        now,
        r.lp_user_info_bump,
        false,
    )?;

    if deposit_is_a {
        r.target_pool.reserve_a = r
            .target_pool
            .reserve_a
            .checked_add(zap.reserve_in_delta)
            .ok_or(SoladromeError::Overflow)?;
    } else {
        r.target_pool.reserve_b = r
            .target_pool
            .reserve_b
            .checked_add(zap.reserve_in_delta)
            .ok_or(SoladromeError::Overflow)?;
    }
    r.target_pool.total_lp = r
        .target_pool
        .total_lp
        .checked_add(zap.lp_out)
        .ok_or(SoladromeError::Overflow)?;

    token::mint_to(
        CpiContext::new_with_signer(
            r.token_program.to_account_info(),
            MintTo {
                mint: r.lp_mint.to_account_info(),
                to: r.user_lp.to_account_info(),
                authority: r.target_pool.to_account_info(),
            },
            &[target_seeds],
        ),
        zap.lp_out,
    )?;

    if pending > 0 {
        token::mint_to(
            CpiContext::new_with_signer(
                r.token_program.to_account_info(),
                MintTo {
                    mint: r.o_sola_mint.to_account_info(),
                    to: r.user_o_sola.to_account_info(),
                    authority: r.protocol_state.to_account_info(),
                },
                &[state_seeds],
            ),
            pending,
        )?;
    }

    // A deposit only ever raises a SOLA/USDC price, so this cannot fire today; it is here so that
    // no path which moves a pool's reserves is the one that forgot.
    require_floor_respected(r.target_pool, r.protocol_state)?;

    // One line per round, for the keeper and for anyone reading the transaction: what was sold,
    // what reached the destination, and how much of it the virtual swap priced.
    msg!(
        "auto-lp: {} oSOLA -> {} USDC -> {} deposited ({} swapped virtually for {}) -> {} LP",
        amount,
        q1.amount_out,
        deposit,
        zap.swap_in,
        zap.swap_out,
        zap.lp_out
    );

    Ok(RouteOutcome { lp_out: zap.lp_out })
}

/// What a route produced, for the caller's own bookkeeping.
pub struct RouteOutcome {
    pub lp_out: u64,
}

// ── Contexts ─────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct SetAutoCompoundLp<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [AUTO_SEED, user.key().as_ref()],
        bump = auto.bump,
        constraint = auto.owner == user.key() @ SoladromeError::AutoOwnerMismatch,
    )]
    pub auto: Box<Account<'info, AutoCompound>>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(
        seeds = [AMM_POOL_SEED, target_pool.token_a_mint.as_ref(), target_pool.token_b_mint.as_ref()],
        bump = target_pool.bump,
    )]
    pub target_pool: Box<Account<'info, AmmPool>>,

    #[account(address = target_pool.lp_mint)]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = lp_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_lp: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + LpUserInfo::LEN,
        seeds = [b"lp_user", target_pool.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub lp_user_info: Box<Account<'info, LpUserInfo>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClearAutoCompoundLp<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [AUTO_SEED, user.key().as_ref()],
        bump = auto.bump,
        constraint = auto.owner == user.key() @ SoladromeError::AutoOwnerMismatch,
    )]
    pub auto: Box<Account<'info, AutoCompound>>,
}

#[derive(Accounts)]
pub struct CrankAutoCompoundLp<'info> {
    /// Anyone. Pays the transaction fee and receives nothing.
    pub cranker: Signer<'info>,

    /// CHECK: identity only — every account below is bound to it by seeds or by associated-token
    /// derivation, and `auto.owner` is checked against it in the handler. It signs nothing.
    pub owner: UncheckedAccount<'info>,

    #[account(mut, seeds = [AUTO_SEED, owner.key().as_ref()], bump = auto.bump)]
    pub auto: Box<Account<'info, AutoCompound>>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// Mut: harvested rewards on the destination are minted here.
    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Box<Account<'info, Mint>>,

    /// The owner's oSOLA — the ASSOCIATED account and no other, for the same reason
    /// `claim_lp_rewards` binds its LP account: an account "the owner owns" is a set anyone can
    /// add to, and only the associated one carries the delegation this order runs on.
    #[account(
        mut,
        associated_token::mint = o_sola_mint,
        associated_token::authority = owner,
    )]
    pub user_o_sola: Box<Account<'info, TokenAccount>>,

    /// Checked in the handler to be the oSOLA/USDC pair; its seeds make it a genuine pool.
    #[account(
        mut,
        seeds = [AMM_POOL_SEED, sell_pool.token_a_mint.as_ref(), sell_pool.token_b_mint.as_ref()],
        bump = sell_pool.bump,
    )]
    pub sell_pool: Box<Account<'info, AmmPool>>,

    /// Checked in the handler against the pool's own record.
    #[account(mut)]
    pub sell_o_sola_vault: Box<Account<'info, TokenAccount>>,

    /// Checked in the handler against the pool's own record.
    #[account(mut)]
    pub sell_usdc_vault: Box<Account<'info, TokenAccount>>,

    /// The SOL/USDC pool, required when the destination pairs SOL and ignored otherwise.
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

    /// Checked in the handler to be the pool the order names.
    #[account(
        mut,
        seeds = [AMM_POOL_SEED, target_pool.token_a_mint.as_ref(), target_pool.token_b_mint.as_ref()],
        bump = target_pool.bump,
    )]
    pub target_pool: Box<Account<'info, AmmPool>>,

    /// The destination's USDC or SOL vault — the only side of it that ever moves. The other side,
    /// which may be a Token-2022 mint, is read through the reserves and never touched.
    #[account(mut)]
    pub target_deposit_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = target_pool.lp_mint)]
    pub lp_mint: Box<Account<'info, Mint>>,

    /// Created by `set_auto_compound_lp`, at the owner's expense.
    #[account(
        mut,
        associated_token::mint = lp_mint,
        associated_token::authority = owner,
    )]
    pub user_lp: Box<Account<'info, TokenAccount>>,

    /// Created by `set_auto_compound_lp`, at the owner's expense.
    #[account(
        mut,
        seeds = [b"lp_user", target_pool.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub lp_user_info: Box<Account<'info, LpUserInfo>>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
