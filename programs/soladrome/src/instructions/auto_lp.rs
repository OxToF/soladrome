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

    let usdc = ctx.accounts.protocol_state.usdc_mint;
    let o_sola = ctx.accounts.protocol_state.o_sola_mint;
    let (deposit_mint, needs_hop) =
        lp_deposit_side(&ctx.accounts.target_pool, &ctx.accounts.protocol_state)?;
    let cont_rate = ctx.accounts.protocol_state.continuous_rate_per_sec;
    let cont_active = continuous_active(&ctx.accounts.protocol_state, now);

    let owner_key = ctx.accounts.owner.key();
    let auto_bump = ctx.accounts.auto.bump;
    let auto_seeds: &[&[u8]] = &[AUTO_SEED, owner_key.as_ref(), &[auto_bump]];

    // ── 1. Sell the oSOLA on THE oSOLA/USDC pool ─────────────────────────────
    let sell = &ctx.accounts.sell_pool;
    require!(
        is_pair(sell, o_sola, usdc),
        SoladromeError::AutoInvalidRoute
    );
    require!(
        ctx.accounts.sell_o_sola_vault.key() == vault_of(sell, o_sola)
            && ctx.accounts.sell_usdc_vault.key() == vault_of(sell, usdc),
        SoladromeError::AutoInvalidRoute
    );
    let o_sola_is_a = sell.token_a_mint == o_sola;
    let q1 = quote_swap(sell, amount, o_sola_is_a)?;
    require_small_leg(amount, reserve_of(sell, o_sola))?;

    // ☢️ The bound a sandwich cannot move. Exercising `amount` would net its gain on the curve
    // less the fee on that gain; the pool must pay at least the owner's share of that.
    let state = &ctx.accounts.protocol_state;
    let intrinsic = exercise_gain(state, amount)?.saturating_sub(exercise_fee(state, amount)?);
    let floor_out = intrinsic as u128 * ctx.accounts.auto.min_intrinsic_bps as u128 / 10_000;
    require!(
        q1.amount_out as u128 >= floor_out,
        SoladromeError::AutoBelowIntrinsic
    );

    let (sell_a, sell_b, sell_bump) = (sell.token_a_mint, sell.token_b_mint, sell.bump);
    let sell_seeds: &[&[u8]] = &[
        AMM_POOL_SEED,
        sell_a.as_ref(),
        sell_b.as_ref(),
        &[sell_bump],
    ];

    // oSOLA: owner → pool, moved by the delegate the owner approved. The whole input enters the
    // reserve: the fee is on oSOLA, not USDC, so like `swap` it stays with the LPs.
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_o_sola.to_account_info(),
                to: ctx.accounts.sell_o_sola_vault.to_account_info(),
                authority: ctx.accounts.auto.to_account_info(),
            },
            &[auto_seeds],
        ),
        amount,
    )?;
    advance_pool_rewards(&mut ctx.accounts.sell_pool, now, cont_rate, cont_active);
    apply_swap_reserves(
        &mut ctx.accounts.sell_pool,
        o_sola_is_a,
        amount,
        q1.amount_out,
    )?;

    // USDC: straight to the next vault on the route. It never passes through a wallet.
    let usdc_dest = if needs_hop {
        ctx.accounts
            .hop_usdc_vault
            .as_ref()
            .ok_or(SoladromeError::AutoInvalidRoute)?
            .to_account_info()
    } else {
        ctx.accounts.target_deposit_vault.to_account_info()
    };
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.sell_usdc_vault.to_account_info(),
                to: usdc_dest,
                authority: ctx.accounts.sell_pool.to_account_info(),
            },
            &[sell_seeds],
        ),
        q1.amount_out,
    )?;

    // ── 2. The SOL hop, when the destination pairs SOL ───────────────────────
    let deposit = if needs_hop {
        let (Some(hop), Some(hop_usdc), Some(hop_sol)) = (
            ctx.accounts.hop_pool.as_mut(),
            ctx.accounts.hop_usdc_vault.as_ref(),
            ctx.accounts.hop_sol_vault.as_ref(),
        ) else {
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
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: hop_usdc.to_account_info(),
                        to: ctx.accounts.market_vault.to_account_info(),
                        authority: hop.to_account_info(),
                    },
                    &[hop_seeds],
                ),
                q2.fee_protocol,
            )?;
        }
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: hop_sol.to_account_info(),
                    to: ctx.accounts.target_deposit_vault.to_account_info(),
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
        ctx.accounts.protocol_state.accumulated_fees = ctx
            .accounts
            .protocol_state
            .accumulated_fees
            .saturating_add(q2.fee_protocol);
        q2.amount_out
    } else {
        q1.amount_out
    };

    // ── 3. Deposit that one side into the destination ────────────────────────
    let target = &ctx.accounts.target_pool;
    require!(
        ctx.accounts.target_deposit_vault.key() == vault_of(target, deposit_mint),
        SoladromeError::AutoInvalidRoute
    );
    let deposit_is_a = target.token_a_mint == deposit_mint;
    let (r_in, r_out) = if deposit_is_a {
        (target.reserve_a, target.reserve_b)
    } else {
        (target.reserve_b, target.reserve_a)
    };
    require_small_leg(deposit, r_in)?;
    let zap = amm_math::zap_in(
        r_in,
        r_out,
        target.total_lp,
        deposit,
        target.fee_rate,
        target.protocol_fee_bps,
        deposit_mint == usdc,
    )?;

    let (t_a, t_b, t_bump) = (target.token_a_mint, target.token_b_mint, target.bump);
    let target_seeds: &[&[u8]] = &[AMM_POOL_SEED, t_a.as_ref(), t_b.as_ref(), &[t_bump]];

    if zap.fee_routed > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.target_deposit_vault.to_account_info(),
                    to: ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.target_pool.to_account_info(),
                },
                &[target_seeds],
            ),
            zap.fee_routed,
        )?;
        ctx.accounts.protocol_state.accumulated_fees = ctx
            .accounts
            .protocol_state
            .accumulated_fees
            .saturating_add(zap.fee_routed);
    }

    // Rewards first, on the supply BEFORE this deposit — see `credit_lp_deposit`.
    advance_pool_rewards(&mut ctx.accounts.target_pool, now, cont_rate, cont_active);
    let acc = ctx.accounts.target_pool.osola_reward_per_lp;
    // ☢️ `owner_present = false`: this deposit harvests, and the one making it is a stranger.
    let pending = credit_lp_deposit(
        &mut ctx.accounts.lp_user_info,
        acc,
        ctx.accounts.user_lp.amount,
        zap.lp_out,
        now,
        ctx.bumps.lp_user_info,
        false,
    )?;

    {
        let pool = &mut ctx.accounts.target_pool;
        if deposit_is_a {
            pool.reserve_a = pool
                .reserve_a
                .checked_add(zap.reserve_in_delta)
                .ok_or(SoladromeError::Overflow)?;
        } else {
            pool.reserve_b = pool
                .reserve_b
                .checked_add(zap.reserve_in_delta)
                .ok_or(SoladromeError::Overflow)?;
        }
        pool.total_lp = pool
            .total_lp
            .checked_add(zap.lp_out)
            .ok_or(SoladromeError::Overflow)?;
    }

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.lp_mint.to_account_info(),
                to: ctx.accounts.user_lp.to_account_info(),
                authority: ctx.accounts.target_pool.to_account_info(),
            },
            &[target_seeds],
        ),
        zap.lp_out,
    )?;

    if pending > 0 {
        let state_bump = ctx.accounts.protocol_state.bump;
        let state_seeds: &[&[u8]] = &[STATE_SEED, &[state_bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.o_sola_mint.to_account_info(),
                    to: ctx.accounts.user_o_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[state_seeds],
            ),
            pending,
        )?;
    }

    // A deposit only ever raises a SOLA/USDC price, so this cannot fire today; it is here so that
    // no path which moves a pool's reserves is the one that forgot.
    require_floor_respected(&ctx.accounts.target_pool, &ctx.accounts.protocol_state)?;

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

    let auto = &mut ctx.accounts.auto;
    auto.rounds = auto.rounds.saturating_add(1);
    auto.last_crank_ts = now;
    Ok(())
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
