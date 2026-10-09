// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, Token, TokenAccount, Transfer},
};

use anchor_spl::token::spl_token::native_mint;

use crate::amm_math::{self, MINIMUM_LIQUIDITY};
use crate::constants::*;
use crate::errors::SoladromeError;
use crate::instructions::amm::{
    advance_pool_rewards, apply_swap_reserves, continuous_active, quote_swap,
    require_floor_respected,
};
use crate::instructions::strategy::pool_address;
use crate::math;
use crate::state::{AmmPool, PolState, ProtocolState};

/// The reserve on `mint`'s side of `pool`. The caller has established the pool holds it.
fn reserve_of(pool: &AmmPool, mint: Pubkey) -> u64 {
    if pool.token_a_mint == mint {
        pool.reserve_a
    } else {
        pool.reserve_b
    }
}

fn pol_pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &crate::ID).0
}

// ── Instructions ──────────────────────────────────────────────────────────────

/// One-time setup: create the PolState PDA and its two token holding accounts.
/// Authority-only. pol_lp_vault is created lazily on the first deploy_pol call.
///
/// There is no target pool any more (2026-10-08): `deploy_pol` takes any SOLA pool whose other side
/// is USDC, SOL or an approved LST, and keeps one LP vault per pool.
pub fn initialize_pol(ctx: Context<InitializePol>, pol_split_bps: u16) -> Result<()> {
    require!(pol_split_bps <= 5_000, SoladromeError::InvalidAmount); // max 50 %

    let pol = &mut ctx.accounts.pol_state;
    pol.pol_split_bps = pol_split_bps;
    pol.usdc_accumulated = 0;
    pol.bump = ctx.bumps.pol_state;
    Ok(())
}

/// Redirect a portion of market_vault USDC into pol_usdc_vault.
///
/// The POL skim comes OUT of the stakers' share: the accumulator is advanced on
/// `market_balance - amount`, so stakers are only ever credited fees that remain in the
/// vault after the skim. Until 2026-07-18 the accumulator was advanced on the FULL
/// balance and `amount` removed afterwards — crediting stakers 100% of new fees while
/// the vault held less, an insolvent promise: once cumulative collections exceeded the
/// unclaimed remainder, `claim_fees` (and `stake_sola`, which auto-claims) reverted with
/// a raw SPL "insufficient funds". Same defect class as the floor drain: an accounting
/// promise the vault cannot honour.
pub fn collect_to_pol(ctx: Context<CollectToPol>, amount: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(amount > 0, SoladromeError::InvalidAmount);

    let market_balance = ctx.accounts.market_vault.amount;
    require!(market_balance >= amount, SoladromeError::InvalidAmount);

    // ── The split the field advertises, finally enforced ──────────────────────
    // `pol_split_bps` was written and validated by `initialize_pol` ("max 50 %") and then
    // read by nothing: `amount` was a free parameter of the authority, bounded only by the
    // solvency guard below. So the published policy — POL takes a *portion* of fees — was
    // documentation, not code, and an authority key could route 100 % of every uncredited
    // USDC into POL while the docs promised half.
    //
    // The base is the uncredited growth, not the whole vault: everything at or below
    // `last_market_vault_balance` is already promised to stakers and is not POL's to split.
    let growth =
        market_balance.saturating_sub(ctx.accounts.protocol_state.last_market_vault_balance);
    let max_skim = (growth as u128)
        .checked_mul(ctx.accounts.pol_state.pol_split_bps as u128)
        .ok_or(SoladromeError::Overflow)?
        / 10_000;
    require!(amount as u128 <= max_skim, SoladromeError::PolSplitExceeded);

    // Credit stakers only on what the skim leaves behind. saturating_sub also covers the
    // case where `amount` digs into fees already credited in a previous advance: the
    // accumulator simply doesn't move (it can never move backwards), and the guard below
    // keeps the vault able to honour every credit already issued.
    let acc = math::advance_accumulator(
        ctx.accounts.protocol_state.fees_per_hi_sola,
        market_balance.saturating_sub(amount),
        ctx.accounts.protocol_state.last_market_vault_balance,
        ctx.accounts.protocol_state.total_hi_sola,
    );
    // Solvency guard: never skim fees that stakers were already credited. Everything at
    // or below last_market_vault_balance is spoken for; only growth above it is available.
    //
    // Redundant today — the split cap above allows at most `growth × 50 %`, which implies
    // `amount <= growth`, which is exactly this. Kept anyway, and it must stay: the split cap
    // is only tighter while `pol_split_bps <= 5_000`, and that bound is validated in a
    // DIFFERENT instruction (`initialize_pol`). This guard is the one that does not depend on
    // another instruction having done its job — it is the safety property, the split is the
    // policy. Delete it and a future `set_pol_split` taking 20 000 bps silently drains the
    // stakers' credited fees.
    require!(
        market_balance.saturating_sub(amount)
            >= ctx.accounts.protocol_state.last_market_vault_balance,
        SoladromeError::InvalidAmount
    );

    let state_bump = ctx.accounts.protocol_state.bump;
    let state_seeds: &[&[u8]] = &[STATE_SEED, &[state_bump]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.market_vault.to_account_info(),
                to: ctx.accounts.pol_usdc_vault.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[state_seeds],
        ),
        amount,
    )?;

    let s = &mut ctx.accounts.protocol_state;
    s.fees_per_hi_sola = acc;
    s.last_market_vault_balance = market_balance - amount;

    ctx.accounts.pol_state.usdc_accumulated = ctx
        .accounts
        .pol_state
        .usdc_accumulated
        .checked_add(amount)
        .ok_or(SoladromeError::Overflow)?;

    Ok(())
}

/// Buy a counter-asset for protocol-owned liquidity: USDC → SOL on THE SOL/USDC pool, or
/// SOL → a token whose X/SOL pool is approved (an LST, by the multisig's rule — the program only
/// checks the approval). Authority-only. The output stays with the POL, in
/// `[POL_TOKEN_SEED, mint]`, for `deploy_pol` to pair with SOLA.
///
/// ☢️ Only these two legs, only on the canonical pools. The pool is recomputed from the two mints
/// (`pool_address`), so no lookalike pool can be passed; an LST leg also requires its LST/SOL pool
/// to be approved (`rewards_enabled`, authority-only), so the POL never buys a token no one vetted
/// through a pool anyone could have opened and priced. The whole swap fee stays in the pool as LP
/// revenue — the POL is a buyer here, not a fee route.
pub fn pol_swap(ctx: Context<PolSwap>, amount_in: u64, min_out: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(amount_in > 0, SoladromeError::InvalidAmount);

    let usdc = ctx.accounts.protocol_state.usdc_mint;
    let wsol = native_mint::ID;
    let in_mint = ctx.accounts.pol_in.mint;
    let out_mint = ctx.accounts.out_mint.key();
    let pool_key = ctx.accounts.pool.key();

    let usdc_to_sol = in_mint == usdc
        && out_mint == wsol
        && pool_key == pool_address(wsol, usdc)
        && ctx.accounts.pol_in.key() == pol_pda(&[POL_USDC_VAULT_SEED]);
    let sol_to_lst = in_mint == wsol
        && out_mint != usdc
        && out_mint != ctx.accounts.protocol_state.sola_mint
        && out_mint != ctx.accounts.protocol_state.o_sola_mint
        && pool_key == pool_address(out_mint, wsol)
        && ctx.accounts.pool.rewards_enabled
        && ctx.accounts.pol_in.key() == pol_pda(&[POL_TOKEN_SEED, wsol.as_ref()]);
    require!(usdc_to_sol || sol_to_lst, SoladromeError::PolInvalidRoute);

    let pool = &ctx.accounts.pool;
    let in_is_a = pool.token_a_mint == in_mint;
    let (vault_in, vault_out) = if in_is_a {
        (pool.token_a_vault, pool.token_b_vault)
    } else {
        (pool.token_b_vault, pool.token_a_vault)
    };
    require!(
        ctx.accounts.pool_vault_in.key() == vault_in
            && ctx.accounts.pool_vault_out.key() == vault_out,
        SoladromeError::PolInvalidRoute
    );

    let quote = quote_swap(pool, amount_in, in_is_a)?;
    require!(
        quote.amount_out >= min_out,
        SoladromeError::SlippageExceeded
    );

    let pol_bump = ctx.accounts.pol_state.bump;
    let pol_seeds: &[&[u8]] = &[POL_SEED, &[pol_bump]];
    let (mint_a, mint_b, pool_bump) = (pool.token_a_mint, pool.token_b_mint, pool.bump);
    let pool_seeds: &[&[u8]] = &[
        AMM_POOL_SEED,
        mint_a.as_ref(),
        mint_b.as_ref(),
        &[pool_bump],
    ];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.pol_in.to_account_info(),
                to: ctx.accounts.pool_vault_in.to_account_info(),
                authority: ctx.accounts.pol_state.to_account_info(),
            },
            &[pol_seeds],
        ),
        amount_in,
    )?;
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.pool_vault_out.to_account_info(),
                to: ctx.accounts.pol_out.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[pool_seeds],
        ),
        quote.amount_out,
    )?;

    apply_swap_reserves(&mut ctx.accounts.pool, in_is_a, amount_in, quote.amount_out)?;
    Ok(())
}

/// Buy SOLA on the curve and/or add it, with its counter-asset, to a SOLA pool. Authority-only.
///
/// The pool is any SOLA pool whose other side is **USDC, SOL or an approved LST** — SOLA/USDC,
/// SOLA/SOL, SOLA/mSOL, SOLA/jitoSOL (decided 2026-10-08: SOLA/SOL at launch, an LST pair with an
/// LST partner). Until then this was hardcoded to one target pool, paired with USDC only.
///
/// Phase 1 (`usdc_for_sola > 0`): buy SOLA on the curve from `pol_usdc_vault` into `pol_sola_ata`.
/// Phase 2 (`sola_for_lp > 0`): deposit `sola_for_lp` SOLA and `counter_for_lp` of the
/// counter-asset — from `pol_usdc_vault` for USDC, from `[POL_TOKEN_SEED, mint]` (filled by
/// `pol_swap`) otherwise. LP tokens are held permanently, one vault per pool.
///
/// ☢️ The deposit is refused if it prices SOLA more than `max_price_dev_bps` (≤
/// `POL_MAX_PRICE_DEV_BPS`) away from the curve, the counter-asset valued through THE SOL/USDC
/// pool and, for an LST, THE LST/SOL pool. A first deposit SETS the pool's price: without this
/// check a mistyped ratio, or a pool skewed just before the call, would hand the POL's value to
/// the first arbitrageur.
///
/// ☢️ Those references are this AMM's own pools, read at their spot price — thin at launch, and a
/// Squads proposal is public, arguments included, before it executes. Someone could move the SOLA
/// pool and the SOL/USDC pool in compensating directions just before it and pass the check at a bad
/// ratio. So the multisig also states, in the proposal, what one whole counter token is worth
/// (`counter_usdc_ref`, USDC base units, from a market outside this AMM): the on-chain reference
/// must sit within `max_price_dev_bps` of it. Ignored when the counter-asset is USDC.
///
/// Every SOL / LST counter-asset is "any token whose X/SOL pool is approved" (`rewards_enabled`) —
/// the program does not know what an LST is. Pairing SOLA only with LSTs is the multisig's rule.
#[allow(clippy::too_many_arguments)]
pub fn deploy_pol(
    ctx: Context<DeployPol>,
    usdc_for_sola: u64,
    min_sola_out: u64,
    sola_for_lp: u64,
    counter_for_lp: u64,
    min_lp: u64,
    max_price_dev_bps: u16,
    counter_usdc_ref: u64,
) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(
        max_price_dev_bps <= POL_MAX_PRICE_DEV_BPS,
        SoladromeError::InvalidAmount
    );
    require!(
        usdc_for_sola > 0 || sola_for_lp > 0,
        SoladromeError::InvalidAmount
    );

    // ── The route: what the other side is, and what one unit of it is worth in USDC ──────────
    let sola = ctx.accounts.protocol_state.sola_mint;
    let usdc = ctx.accounts.protocol_state.usdc_mint;
    let wsol = native_mint::ID;
    let counter = if ctx.accounts.pool.token_a_mint == sola {
        ctx.accounts.pool.token_b_mint
    } else {
        ctx.accounts.pool.token_a_mint
    };
    require!(
        ctx.accounts.counter_mint.key() == counter,
        SoladromeError::PolInvalidRoute
    );
    let counter_is_usdc = counter == usdc;
    let expected_counter_account = if counter_is_usdc {
        ctx.accounts.pol_usdc_vault.key()
    } else {
        pol_pda(&[POL_TOKEN_SEED, counter.as_ref()])
    };
    require!(
        ctx.accounts.pol_counter.key() == expected_counter_account,
        SoladromeError::PolInvalidRoute
    );
    // Raw USDC per raw unit of the counter-asset, in `POL_PRICE_SCALE` units.
    let counter_usdc_fp = if counter_is_usdc {
        math::POL_PRICE_SCALE
    } else {
        let sol_usdc = ctx
            .accounts
            .sol_usdc_pool
            .as_ref()
            .ok_or(SoladromeError::PolInvalidRoute)?;
        require!(
            sol_usdc.key() == pool_address(wsol, usdc),
            SoladromeError::PolInvalidRoute
        );
        let sol_px = math::ratio_fp(reserve_of(sol_usdc, usdc), reserve_of(sol_usdc, wsol))?;
        let onchain = if counter == wsol {
            sol_px
        } else {
            let lst_sol = ctx
                .accounts
                .lst_sol_pool
                .as_ref()
                .ok_or(SoladromeError::PolInvalidRoute)?;
            require!(
                lst_sol.key() == pool_address(counter, wsol) && lst_sol.rewards_enabled,
                SoladromeError::PolInvalidRoute
            );
            let lst_in_sol =
                math::ratio_fp(reserve_of(lst_sol, wsol), reserve_of(lst_sol, counter))?;
            math::mul_fp(lst_in_sol, sol_px)?
        };
        // The multisig's own figure, per whole token, brought to raw USDC per raw counter unit.
        require!(counter_usdc_ref > 0, SoladromeError::InvalidAmount);
        let ref_fp = (counter_usdc_ref as u128)
            .checked_mul(math::POL_PRICE_SCALE)
            .ok_or(SoladromeError::Overflow)?
            / 10u128.pow(ctx.accounts.counter_mint.decimals as u32);
        require!(
            math::within_bps(onchain, ref_fp, max_price_dev_bps),
            SoladromeError::PolPriceDeviation
        );
        onchain
    };

    // ── Budget ────────────────────────────────────────────────────────────────
    let usdc_needed = if counter_is_usdc {
        usdc_for_sola
            .checked_add(counter_for_lp)
            .ok_or(SoladromeError::Overflow)?
    } else {
        require!(
            ctx.accounts.pol_counter.amount >= counter_for_lp,
            SoladromeError::InvalidAmount
        );
        usdc_for_sola
    };
    require!(
        ctx.accounts.pol_usdc_vault.amount >= usdc_needed,
        SoladromeError::InvalidAmount
    );

    // ── Snapshot reads before mutable borrows ─────────────────────────────────
    let state_bump = ctx.accounts.protocol_state.bump;
    let pol_bump = ctx.accounts.pol_state.bump;
    let vu = ctx.accounts.protocol_state.virtual_usdc;
    let vs = ctx.accounts.protocol_state.virtual_sola;
    let k_val = ctx.accounts.protocol_state.k;

    let pool_reserve_a = ctx.accounts.pool.reserve_a;
    let pool_reserve_b = ctx.accounts.pool.reserve_b;
    let pool_total_lp = ctx.accounts.pool.total_lp;
    let pool_token_a_mint = ctx.accounts.pool.token_a_mint;
    let pool_token_b_mint = ctx.accounts.pool.token_b_mint;
    let pool_bump = ctx.accounts.pool.bump;
    let pre_sola_balance = ctx.accounts.pol_sola_ata.amount;

    let pol_seeds: &[&[u8]] = &[POL_SEED, &[pol_bump]];
    let state_seeds: &[&[u8]] = &[STATE_SEED, &[state_bump]];
    let pool_seeds: &[&[u8]] = &[
        AMM_POOL_SEED,
        pool_token_a_mint.as_ref(),
        pool_token_b_mint.as_ref(),
        &[pool_bump],
    ];

    // ── Phase 1: Buy SOLA via bonding curve ───────────────────────────────────
    if usdc_for_sola > 0 {
        let slot = Clock::get()?.slot;
        ctx.accounts.protocol_state.note_curve_trade(slot);
    }
    let sola_minted: u64 = if usdc_for_sola > 0 {
        // No curve fee here: this USDC is already the stakers' (skimmed from `market_vault` by
        // `collect_to_pol`), and charging it would only send part of it back where it came from.
        let q = math::curve_buy(vu, vs, k_val, usdc_for_sola, 0)?;
        let sola_amount = q.sola_out;
        require!(
            sola_amount >= min_sola_out,
            SoladromeError::SlippageExceeded
        );
        require!(sola_amount > 0, SoladromeError::InvalidAmount);

        // ☢️ The premium stays in the market reserve, owed to sellers — see `buy_sola`.
        for (to, amount) in [
            (ctx.accounts.floor_vault.to_account_info(), sola_amount),
            (ctx.accounts.market_reserve.to_account_info(), q.premium),
        ] {
            if amount > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.pol_usdc_vault.to_account_info(),
                            to,
                            authority: ctx.accounts.pol_state.to_account_info(),
                        },
                        &[pol_seeds],
                    ),
                    amount,
                )?;
            }
        }

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.sola_mint.to_account_info(),
                    to: ctx.accounts.pol_sola_ata.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[state_seeds],
            ),
            sola_amount,
        )?;

        let s = &mut ctx.accounts.protocol_state;
        s.virtual_usdc = q.new_vu;
        s.virtual_sola = q.new_vs;
        s.total_sola = s
            .total_sola
            .checked_add(sola_amount)
            .ok_or(SoladromeError::Overflow)?;
        // POL-purchased SOLA is fully floor-backed (USDC went to floor_vault),
        // so it must count in total_purchased_sola to keep sell_sola accurate.
        s.total_purchased_sola = s
            .total_purchased_sola
            .checked_add(sola_amount)
            .ok_or(SoladromeError::Overflow)?;
        sola_amount
    } else {
        0
    };

    // ── Phase 2: Add LP to the pool ───────────────────────────────────────────
    if sola_for_lp > 0 {
        require!(counter_for_lp > 0, SoladromeError::ZeroLiquidity);
        let available_sola = pre_sola_balance
            .checked_add(sola_minted)
            .ok_or(SoladromeError::Overflow)?;
        require!(sola_for_lp <= available_sola, SoladromeError::InvalidAmount);

        let sola_is_a = pool_token_a_mint == sola;
        let (amount_a_desired, amount_b_desired) = if sola_is_a {
            (sola_for_lp, counter_for_lp)
        } else {
            (counter_for_lp, sola_for_lp)
        };
        let (lp_out, actual_a, actual_b) = amm_math::lp_for_deposit(
            pool_reserve_a,
            pool_reserve_b,
            pool_total_lp,
            amount_a_desired,
            amount_b_desired,
        )?;
        require!(lp_out >= min_lp, SoladromeError::SlippageExceeded);
        let (actual_sola, actual_counter) = if sola_is_a {
            (actual_a, actual_b)
        } else {
            (actual_b, actual_a)
        };

        // ☢️ The price check, on the pool as this deposit leaves it, against the curve as phase 1
        // left it. Raw units throughout: counter-per-SOLA × USDC-per-counter = USDC-per-SOLA.
        let (post_sola, post_counter) = if sola_is_a {
            (
                pool_reserve_a.checked_add(actual_a),
                pool_reserve_b.checked_add(actual_b),
            )
        } else {
            (
                pool_reserve_b.checked_add(actual_b),
                pool_reserve_a.checked_add(actual_a),
            )
        };
        let post_sola = post_sola.ok_or(SoladromeError::Overflow)?;
        let post_counter = post_counter.ok_or(SoladromeError::Overflow)?;
        let implied = math::mul_fp(math::ratio_fp(post_counter, post_sola)?, counter_usdc_fp)?;
        let curve = math::ratio_fp(
            ctx.accounts.protocol_state.virtual_usdc,
            ctx.accounts.protocol_state.virtual_sola,
        )?;
        require!(
            math::within_bps(implied, curve, max_price_dev_bps),
            SoladromeError::PolPriceDeviation
        );

        // Rewards first, on the supply BEFORE this deposit. The POL's LP is minted into the
        // pool's supply; advancing the accumulator after it would spread time already elapsed
        // over LP that did not exist yet, short-changing the LPs who were there.
        let now = Clock::get()?.unix_timestamp;
        let rate = ctx.accounts.protocol_state.continuous_rate_per_sec;
        let active = continuous_active(&ctx.accounts.protocol_state, now);
        advance_pool_rewards(&mut ctx.accounts.pool, now, rate, active);

        let (sola_vault, counter_vault) = if sola_is_a {
            (
                ctx.accounts.pool_token_a_vault.to_account_info(),
                ctx.accounts.pool_token_b_vault.to_account_info(),
            )
        } else {
            (
                ctx.accounts.pool_token_b_vault.to_account_info(),
                ctx.accounts.pool_token_a_vault.to_account_info(),
            )
        };
        let counter_source = if counter_is_usdc {
            ctx.accounts.pol_usdc_vault.to_account_info()
        } else {
            ctx.accounts.pol_counter.to_account_info()
        };
        for (from, to, amount) in [
            (
                ctx.accounts.pol_sola_ata.to_account_info(),
                sola_vault,
                actual_sola,
            ),
            (counter_source, counter_vault, actual_counter),
        ] {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from,
                        to,
                        authority: ctx.accounts.pol_state.to_account_info(),
                    },
                    &[pol_seeds],
                ),
                amount,
            )?;
        }

        if pool_total_lp == 0 {
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.lp_mint.to_account_info(),
                        to: ctx.accounts.lp_dead_ata.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    &[pool_seeds],
                ),
                MINIMUM_LIQUIDITY,
            )?;
        }
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.pol_lp_vault.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            lp_out,
        )?;

        let pool = &mut ctx.accounts.pool;
        pool.reserve_a = pool
            .reserve_a
            .checked_add(actual_a)
            .ok_or(SoladromeError::Overflow)?;
        pool.reserve_b = pool
            .reserve_b
            .checked_add(actual_b)
            .ok_or(SoladromeError::Overflow)?;
        pool.total_lp = pool
            .total_lp
            .checked_add(lp_out)
            .ok_or(SoladromeError::Overflow)?;
        require_floor_respected(pool, &ctx.accounts.protocol_state)?;
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

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
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
pub struct PolSwap<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [STATE_SEED],
        bump  = protocol_state.bump,
        has_one = authority @ SoladromeError::Unauthorized,
    )]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(seeds = [POL_SEED], bump = pol_state.bump)]
    pub pol_state: Box<Account<'info, PolState>>,

    /// THE SOL/USDC pool or an approved LST/SOL pool — checked against `pool_address`.
    #[account(
        mut,
        seeds = [AMM_POOL_SEED, pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump  = pool.bump,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    #[account(mut)]
    pub pool_vault_in: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub pool_vault_out: Box<Account<'info, TokenAccount>>,

    /// `pol_usdc_vault` for USDC → SOL, `[POL_TOKEN_SEED, wSOL]` for SOL → LST.
    #[account(mut, token::authority = pol_state)]
    pub pol_in: Box<Account<'info, TokenAccount>>,

    pub out_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = authority,
        seeds = [POL_TOKEN_SEED, out_mint.key().as_ref()],
        bump,
        token::mint      = out_mint,
        token::authority = pol_state,
    )]
    pub pol_out: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
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
    #[account(seeds = [POL_SEED], bump = pol_state.bump)]
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

    /// The pool's other side.
    pub counter_mint: Box<Account<'info, Mint>>,

    /// Where the counter-asset comes from: `pol_usdc_vault` itself for USDC, `[POL_TOKEN_SEED,
    /// mint]` otherwise — checked in the handler.
    #[account(mut, token::mint = counter_mint, token::authority = pol_state)]
    pub pol_counter: Box<Account<'info, TokenAccount>>,

    /// One LP vault per pool, created on the first deposit there. Held permanently.
    #[account(
        init_if_needed,
        payer = authority,
        seeds = [POL_LP_VAULT_SEED, pool.key().as_ref()],
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

    /// Receives the premium of the POL's curve purchase, like `buy_sola`.
    #[account(mut, seeds = [MARKET_RESERVE_SEED], bump)]
    pub market_reserve: Box<Account<'info, TokenAccount>>,

    // ── AMM pool ──────────────────────────────────────────────────────────────
    #[account(
        mut,
        seeds = [AMM_POOL_SEED, pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump  = pool.bump,
        // M-03: at least one side is SOLA. The other side is checked in the handler — USDC, SOL
        // or an approved LST, nothing else.
        constraint = (
            pool.token_a_mint == protocol_state.sola_mint ||
            pool.token_b_mint == protocol_state.sola_mint
        ) @ SoladromeError::InvalidPoolTokens,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = pool.token_a_vault)]
    pub pool_token_a_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = pool.token_b_vault)]
    pub pool_token_b_vault: Box<Account<'info, TokenAccount>>,

    // ── Price references (read-only) ──────────────────────────────────────────
    /// THE SOL/USDC pool. Required unless the counter-asset is USDC.
    pub sol_usdc_pool: Option<Box<Account<'info, AmmPool>>>,

    /// THE LST/SOL pool, approved. Required when the counter-asset is an LST.
    pub lst_sol_pool: Option<Box<Account<'info, AmmPool>>>,

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

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
