// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! The bonding curve and the floor reserve: buy, sell, exercise, and the arbitrage crank.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer},
};

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::instructions::amm;
use crate::math;
use crate::state::*;

// Deposit USDC → receive SOLA via constant-product curve.
// USDC splits: floor vault (1:1 backing) + market vault (excess fees).
pub fn buy_sola(ctx: Context<BuySola>, usdc_in: u64, min_sola_out: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    // Phase gate: the curve is closed during the partner-only launch window.
    // The curve price is monotonically increasing, so an open curve before
    // the public event would let snipers buy the cheapest SOLA ahead of the
    // community airdrop. sell_sola stays open (exit path).
    require!(
        ctx.accounts.protocol_state.curve_enabled,
        SoladromeError::FeatureDisabled
    );
    let vu = ctx.accounts.protocol_state.virtual_usdc;
    let vs = ctx.accounts.protocol_state.virtual_sola;
    let k = ctx.accounts.protocol_state.k;
    let bump = ctx.accounts.protocol_state.bump;

    let sola_amount = math::sola_out(vu, vs, k, usdc_in)?;
    require!(
        sola_amount >= min_sola_out,
        SoladromeError::SlippageExceeded
    );
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
    s.virtual_usdc = s
        .virtual_usdc
        .checked_add(usdc_in)
        .ok_or(SoladromeError::Overflow)?;
    s.virtual_sola = s
        .virtual_sola
        .checked_sub(sola_amount)
        .ok_or(SoladromeError::Overflow)?;
    s.total_sola = s
        .total_sola
        .checked_add(sola_amount)
        .ok_or(SoladromeError::Overflow)?;
    s.total_purchased_sola = s
        .total_purchased_sola
        .checked_add(sola_amount)
        .ok_or(SoladromeError::Overflow)?;
    s.accumulated_fees = s
        .accumulated_fees
        .checked_add(market_amount)
        .ok_or(SoladromeError::Overflow)?;
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
    // floor backing. Founder/ecosystem allocations are excluded: they are
    // never added to total_purchased_sola, so they cannot be redeemed at
    // floor price via sell_sola (this check enforces that).
    require!(
        ctx.accounts.protocol_state.total_purchased_sola >= sola_amount,
        SoladromeError::InsufficientFloorReserve
    );
    ctx.accounts.protocol_state.total_purchased_sola = ctx
        .accounts
        .protocol_state
        .total_purchased_sola
        .checked_sub(sola_amount)
        .ok_or(SoladromeError::Overflow)?;

    let floor_post = ctx
        .accounts
        .floor_vault
        .amount
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

// Burn oSOLA + pay floor USDC → receive SOLA. Strengthens floor reserve.
pub fn exercise_o_sola(ctx: Context<ExerciseOSola>, o_sola_amount: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(
        ctx.accounts.protocol_state.exercise_enabled,
        SoladromeError::FeatureDisabled
    );
    require!(o_sola_amount > 0, SoladromeError::InvalidAmount);
    let bump = ctx.accounts.protocol_state.bump;
    let usdc_cost = o_sola_amount;

    // ── Exercise fee: a share of the GAIN, priced off the curve ───────────────
    // Reference price = virtual_usdc / virtual_sola. This needs no oracle and is
    // structurally manipulation-resistant in the direction that matters: to inflate
    // it an attacker must buy through the curve with real USDC (expensive, and it
    // moves the price against their own position), and to DEFLATE it — the direction
    // that would cut their own fee — there is no lever at all, because `sell_sola`
    // never touches the virtual reserves. Only `buy_sola` and `deploy_pol` do.
    //
    // fee = fee_bps × (vu/vs − 1) × amount, evaluated as
    //       (amount × (vu − vs) / vs) × fee_bps / 10_000.
    // Dividing by `vs` before applying the bps keeps every intermediate small (the
    // first product is bounded by amount × vu) and rounds the gain DOWN, so the
    // truncation error is sub-base-unit and always in the user's favour — the
    // protocol can never overcharge through rounding.
    let fee = {
        let vu = ctx.accounts.protocol_state.virtual_usdc as u128;
        let vs = ctx.accounts.protocol_state.virtual_sola as u128;
        let fee_bps = ctx.accounts.protocol_state.exercise_fee_bps as u128;
        // Out of the money (or exactly at the floor) => no gain => no fee. vs is
        // never 0 while k > 0, but guard anyway rather than divide blindly.
        if vu <= vs || vs == 0 || fee_bps == 0 {
            0u64
        } else {
            let gain = (o_sola_amount as u128)
                .checked_mul(vu - vs)
                .ok_or(SoladromeError::Overflow)?
                / vs;
            let f = gain.checked_mul(fee_bps).ok_or(SoladromeError::Overflow)? / 10_000;
            u64::try_from(f).map_err(|_| error!(SoladromeError::Overflow))?
        }
    };

    // ☢️ RULE: the strike goes to floor_vault IN FULL, and the fee is an ADDITIONAL
    // ☢️ payment on top of it. Never carve the fee out of `usdc_cost`.
    //
    // Carving it out would credit `total_purchased_sola` by the full amount while the
    // floor received only `usdc_cost − fee` — a counter incremented beyond what the
    // vault actually holds. That is precisely the unfinanced-supply defect closed on
    // 2026-07-17: cumulative, permanent, and invisible in tests because the accounting
    // stays self-consistent while the backing evaporates. Here the user pays 1 + fee,
    // backing per exercised SOLA stays exactly 1:1, and the invariant
    // `floor_vault + total_usdc_borrowed >= total_purchased_sola` is untouched.
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

    if fee > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            fee,
        )?;
    }

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
    s.total_sola = s
        .total_sola
        .checked_add(o_sola_amount)
        .ok_or(SoladromeError::Overflow)?;
    // Exercising oSOLA pays 1 USDC to floor_vault per SOLA — counts as floor-backed supply.
    s.total_purchased_sola = s
        .total_purchased_sola
        .checked_add(o_sola_amount)
        .ok_or(SoladromeError::Overflow)?;
    // Lifetime market_vault inflow counter, same as buy_sola's market_amount.
    //
    // The staker accumulator is deliberately NOT advanced here. It is lazy: the next
    // staker interaction (`claim_fees`, `stake_sola`, `unstake_hi_sola`, …) reads the
    // real `market_vault` balance and credits the growth above
    // `last_market_vault_balance`. Advancing it here — or, worse, touching
    // `last_market_vault_balance` — would either double-count the fee or hide it from
    // stakers entirely. Crediting is therefore driven by USDC that has actually landed
    // in the vault, never by a computed figure. Same pattern as `buy_sola`.
    s.accumulated_fees = s
        .accumulated_fees
        .checked_add(fee)
        .ok_or(SoladromeError::Overflow)?;
    Ok(())
}

/// Flash-arbitrage: burn oSOLA → mint SOLA → sell on AMM → split profit.
/// Caller pays zero USDC upfront. Profitable only when SOLA_AMM > 1 USDC (floor).
/// Profit split: CALLER_ARB_SHARE_BPS (10 %) to caller, rest to market_vault → hiSOLA stakers.
pub fn flash_arbitrage(
    ctx: Context<FlashArbitrage>,
    amount_osola: u64,
    min_profit_usdc: u64,
) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    // Phase gate: flash arb burns oSOLA and mints floor-backed SOLA — it is
    // an exercise pathway and must honor the same gate as exercise_o_sola,
    // otherwise the closed-launch "exercise disabled" promise is bypassable.
    require!(
        ctx.accounts.protocol_state.exercise_enabled,
        SoladromeError::FeatureDisabled
    );
    require!(amount_osola > 0, SoladromeError::InvalidAmount);

    let state_bump = ctx.accounts.protocol_state.bump;
    let state_seeds: &[&[u8]] = &[STATE_SEED, &[state_bump]];

    // ── 1. Burn caller's oSOLA ────────────────────────────────────────────
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.o_sola_mint.to_account_info(),
                from: ctx.accounts.caller_o_sola.to_account_info(),
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
                mint: ctx.accounts.sola_mint.to_account_info(),
                to: ctx.accounts.caller_sola.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[state_seeds],
        ),
        amount_osola,
    )?;
    ctx.accounts.protocol_state.total_sola = ctx
        .accounts
        .protocol_state
        .total_sola
        .checked_add(amount_osola)
        .ok_or(SoladromeError::Overflow)?;
    // Floor receives amount_osola USDC (step 5), so this SOLA is fully floor-backed.
    ctx.accounts.protocol_state.total_purchased_sola = ctx
        .accounts
        .protocol_state
        .total_purchased_sola
        .checked_add(amount_osola)
        .ok_or(SoladromeError::Overflow)?;

    // ── 3. AMM swap: sell SOLA → USDC ────────────────────────────────────
    let pool = &ctx.accounts.pool;
    let pool_bump = pool.bump;
    let mint_a = pool.token_a_mint;
    let mint_b = pool.token_b_mint;
    let sola_is_a = mint_a == ctx.accounts.protocol_state.sola_mint;

    // Same quote the public `swap` gets, from the same function — see `amm::quote_swap` for why
    // this arbitrage path must never price its own trade. `fee_protocol` is ignored here: this
    // path burns the whole fee rather than splitting it, see below.
    let quote = amm::quote_swap(pool, amount_osola, sola_is_a)?;
    let fee_total = quote.fee_total;
    let amount_net = quote.amount_net;
    let usdc_out = quote.amount_out;

    let pool_seeds: &[&[u8]] = &[
        AMM_POOL_SEED,
        mint_a.as_ref(),
        mint_b.as_ref(),
        &[pool_bump],
    ];

    let (vault_sola, vault_usdc) = if sola_is_a {
        (
            ctx.accounts.token_a_vault.to_account_info(),
            ctx.accounts.token_b_vault.to_account_info(),
        )
    } else {
        (
            ctx.accounts.token_b_vault.to_account_info(),
            ctx.accounts.token_a_vault.to_account_info(),
        )
    };

    // SOLA: caller → pool vault (only amount_net — the portion after AMM fee deduction).
    // The swap was calculated on amount_net, so the vault and reserve must both increase
    // by exactly amount_net. Sending the full amount_osola would create a vault/reserve
    // divergence equal to fee_total that grows unboundedly and corrupts LP withdrawals.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.caller_sola.to_account_info(),
                to: vault_sola,
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
                from: vault_usdc,
                to: ctx.accounts.caller_usdc.to_account_info(),
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
    let fee_total_u64 = fee_total;
    if fee_total_u64 > 0 {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.sola_mint.to_account_info(),
                    from: ctx.accounts.caller_sola.to_account_info(),
                    authority: ctx.accounts.caller.to_account_info(),
                },
            ),
            fee_total_u64,
        )?;
        ctx.accounts.protocol_state.total_sola = ctx
            .accounts
            .protocol_state
            .total_sola
            .checked_sub(fee_total_u64)
            .ok_or(SoladromeError::Overflow)?;
        ctx.accounts.protocol_state.total_purchased_sola = ctx
            .accounts
            .protocol_state
            .total_purchased_sola
            .checked_sub(fee_total_u64)
            .ok_or(SoladromeError::Overflow)?;
    }

    // Update pool reserves + advance reward accumulator.
    // Advancing here prevents the next add/remove/swap from retroactively
    // crediting oSOLA rewards that accrued during this arbitrage call.
    let clock_now = Clock::get()?.unix_timestamp;
    let cont_rate = ctx.accounts.protocol_state.continuous_rate_per_sec;
    let cont_active = amm::continuous_active(&ctx.accounts.protocol_state, clock_now);
    let pool = &mut ctx.accounts.pool;
    amm::advance_pool_rewards(pool, clock_now, cont_rate, cont_active);
    // Only `amount_net` was transferred into the vault (the fee was burned, not deposited), so
    // that is what the reserve grows by — vault and reserve stay equal.
    amm::apply_swap_reserves(pool, sola_is_a, amount_net, usdc_out)?;

    // ☢️ Floor guard — the pool may not be LEFT below 1.00, however profitable the
    // trade was on average. The check below constrains the average price only; see
    // `amm::require_floor_respected` for why that is not the same thing. This call site
    // is the reason the guard is a shared function: `flash_arbitrage` never touches
    // `amm::swap`, so a guard written inside `swap` would not have covered it.
    amm::require_floor_respected(&ctx.accounts.pool, &ctx.accounts.protocol_state)?;

    // ── 4. Profitability check ────────────────────────────────────────────
    // Floor needs `amount_osola` USDC to back the freshly minted SOLA.
    require!(usdc_out > amount_osola, SoladromeError::NotProfitable);
    let gross_profit = usdc_out
        .checked_sub(amount_osola)
        .ok_or(SoladromeError::Overflow)?;
    require!(
        gross_profit >= min_profit_usdc,
        SoladromeError::SlippageExceeded
    );

    // ── 5. Split proceeds ─────────────────────────────────────────────────
    let caller_reward = (gross_profit as u128)
        .checked_mul(CALLER_ARB_SHARE_BPS as u128)
        .ok_or(SoladromeError::Overflow)?
        .checked_div(10_000)
        .ok_or(SoladromeError::Overflow)? as u64;
    let protocol_profit = gross_profit
        .checked_sub(caller_reward)
        .ok_or(SoladromeError::Overflow)?;

    // Floor replenishment: amount_osola USDC from caller_usdc → floor_vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.caller_usdc.to_account_info(),
                to: ctx.accounts.floor_vault.to_account_info(),
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
                from: ctx.accounts.caller_usdc.to_account_info(),
                to: ctx.accounts.market_vault.to_account_info(),
                authority: ctx.accounts.caller.to_account_info(),
            },
        ),
        protocol_profit,
    )?;
    ctx.accounts.protocol_state.accumulated_fees = ctx
        .accounts
        .protocol_state
        .accumulated_fees
        .saturating_add(protocol_profit);

    // caller_reward stays in caller_usdc — no extra transfer needed
    let _ = caller_reward;
    Ok(())
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

    // M-11 FIX: enforce owner so sell proceeds cannot be routed to a third-party
    // account (e.g., forced deposit into victim wallets or protocol vaults).
    #[account(
        mut,
        constraint = user_usdc.mint  == protocol_state.usdc_mint @ SoladromeError::InvalidAmount,
        constraint = user_usdc.owner == user.key()               @ SoladromeError::Unauthorized,
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

    /// Destination of the exercise fee (a share of the gain, paid on top of the strike).
    /// Feeds `fees_per_hi_sola` → hiSOLA stakers via the existing lazy accumulator.
    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

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

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
