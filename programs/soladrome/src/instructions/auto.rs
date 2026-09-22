// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs

//! Standing compound orders: configure once, crank permissionlessly.
//!
//! ☢️ THE WHOLE POINT IS THAT NOBODY HOLDS A KEY. `crank_auto_compound` takes any signer as its
//! caller — a keeper we run, a competitor, a cron on someone's laptop — and that signer pays the
//! transaction fee and gains nothing else. The authority that moves the user's tokens is the
//! `AutoCompound` PDA, acting as an SPL **delegate** the user approved from their own wallet for
//! an amount they chose. The tokens never leave the user's accounts until the moment they are
//! burnt or paid into the floor, and `revoke` ends the arrangement without asking us.
//!
//! Compare with the alternative that was measured and rejected (pre-signed durable-nonce
//! transactions): those are bearer instruments whose COST is not fixed by the signature, because
//! the exercise fee is priced off the curve at landing. Whoever held the bytes chose the moment
//! and therefore the price. Here the user writes the ceiling into `max_cost_per_unit` and the
//! chain enforces it, so choosing the moment buys an attacker nothing.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::instructions::curve::exercise_fee;
use crate::instructions::stake::credit_financed_stake;
use crate::math;
use crate::state::*;

/// Create or update a standing order. The user signs; nothing is escrowed.
///
/// The token allowances live outside this instruction on purpose: they are ordinary SPL
/// `approve` calls the frontend puts in the same transaction. That keeps the cap in the token
/// program, where the wallet can show it and `revoke` can end it, instead of in a field here
/// that only this program would honour.
pub fn configure_auto_compound(
    ctx: Context<ConfigureAutoCompound>,
    threshold: u64,
    chunk: u64,
    max_cost_per_unit: u64,
    min_interval: i64,
    max_fee_bps: u16,
) -> Result<()> {
    require!(chunk > 0, SoladromeError::InvalidAmount);
    require!(threshold >= chunk, SoladromeError::InvalidAmount);
    // A ceiling below the strike itself can never be met, so the order would be born inert.
    // Refuse it rather than let someone configure a strategy that silently never fires.
    require!(
        max_cost_per_unit >= UNIT_ONE,
        SoladromeError::AutoCostTooHigh
    );
    // ☢️ NOT `>= 0`. Zero makes `ready()`'s clock comparison vacuous — `now - now >= 0` — so the
    // order fires as many times as the balance and the allowance allow inside ONE transaction,
    // and the pacing the user chose becomes a property of our frontend rather than of the chain.
    // See `MIN_CRANK_INTERVAL`.
    require!(
        min_interval >= MIN_CRANK_INTERVAL,
        SoladromeError::InvalidAmount
    );
    // A tolerance above what the protocol itself may ever charge is not a bound, it is a number
    // that reads like one. `MAX_EXERCISE_FEE_BPS` is the ceiling `set_exercise_fee` enforces, so
    // anything above it can never be reached and would only mislead whoever reads the order back.
    // Zero stays legal and means UNSET — see `AutoCompound::max_fee_bps`.
    require!(
        max_fee_bps <= MAX_EXERCISE_FEE_BPS,
        SoladromeError::InvalidAmount
    );

    let auto = &mut ctx.accounts.auto;
    auto.owner = ctx.accounts.user.key();
    auto.threshold = threshold;
    auto.chunk = chunk;
    auto.max_cost_per_unit = max_cost_per_unit;
    auto.min_interval = min_interval;
    auto.max_fee_bps = max_fee_bps;
    auto.enabled = true;
    if auto.bump == 0 {
        auto.bump = ctx.bumps.auto;
    }
    Ok(())
}

/// Pause an order without closing it. The allowance is untouched — `revoke` is the user's to
/// make from their wallet, and doing it for them here would be this program deciding how much
/// of their own token account they may delegate.
pub fn set_auto_compound_enabled(
    ctx: Context<SetAutoCompoundEnabled>,
    enabled: bool,
) -> Result<()> {
    ctx.accounts.auto.enabled = enabled;
    Ok(())
}

/// Fire one round of a standing order. Callable by anyone.
///
/// The order of operations mirrors `exercise_o_sola` followed by `stake_sola`, because that is
/// exactly what it is, and every counter it touches is touched the same way. The one deliberate
/// difference: the SOLA is minted straight into `sola_vault` instead of into the user's own
/// account and transferred back out. That removes a third delegation the user would otherwise
/// have to grant on their SOLA account, and leaves the end state identical — same vault balance,
/// same position, same three `ProtocolState` counters.
pub fn crank_auto_compound(ctx: Context<CrankAutoCompound>) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    // A standing order is an exercise pathway, so it honours the same gate `exercise_o_sola`
    // and `flash_arbitrage` do. Without this, a closed-launch promise would be bypassable by
    // configuring an order before the flag is flipped.
    require!(
        ctx.accounts.protocol_state.exercise_enabled,
        SoladromeError::FeatureDisabled
    );
    require!(
        ctx.accounts.auto.owner == ctx.accounts.owner.key(),
        SoladromeError::AutoOwnerMismatch
    );

    let now = Clock::get()?.unix_timestamp;
    let amount = ctx.accounts.auto.chunk;
    require!(
        ctx.accounts
            .auto
            .ready(ctx.accounts.user_o_sola.amount, now),
        SoladromeError::AutoNotReady
    );

    // ── The ceiling the user set, enforced before a single token moves ────────
    let fee = exercise_fee(&ctx.accounts.protocol_state, amount)?;
    let cost = amount.checked_add(fee).ok_or(SoladromeError::Overflow)?;
    let ceiling = (amount as u128)
        .checked_mul(ctx.accounts.auto.max_cost_per_unit as u128)
        .ok_or(SoladromeError::Overflow)?
        / UNIT_ONE as u128;
    require!(cost as u128 <= ceiling, SoladromeError::AutoCostTooHigh);

    // ☢️ The bound that does not expire against a rising market.
    //
    // The ceiling above is absolute, so the only way to reach it is for the price to rise — and
    // a rising price makes this round MORE profitable, not less, because the strike stays at
    // 1 USDC while the SOLA minted is worth more. Enforced alone it stops the order exactly when
    // its owner would most want it to run, on a forecast they were never able to make.
    //
    // What they can answer is the share of the gain they are willing to leave behind, and that
    // is a rate: price-independent, so the order adapts instead of expiring. The rate lives in
    // `ProtocolState`, where the authority may move it up to `MAX_EXERCISE_FEE_BPS` — which is
    // the one change to this arrangement that was never the owner's to accept.
    //
    // ⚠️ `0` is UNSET and skips the check. Every order armed before this field existed reads
    // zero from the account's spare bytes, and treating that as a bound would refuse them all
    // on their next crank.
    let max_fee_bps = ctx.accounts.auto.max_fee_bps;
    if max_fee_bps > 0 {
        require!(
            ctx.accounts.protocol_state.exercise_fee_bps <= max_fee_bps,
            SoladromeError::AutoCostTooHigh
        );
    }

    let state_bump = ctx.accounts.protocol_state.bump;
    let state_seeds: &[&[u8]] = &[STATE_SEED, &[state_bump]];
    let owner_key = ctx.accounts.owner.key();
    let auto_bump = ctx.accounts.auto.bump;
    let auto_seeds: &[&[u8]] = &[AUTO_SEED, owner_key.as_ref(), &[auto_bump]];

    // ── 1. Pay the strike IN FULL into the floor, and the fee ON TOP ──────────
    //
    // ☢️ Same rule as `exercise_o_sola`, and it is load-bearing: carving the fee out of the
    // strike would credit `total_purchased_sola` by more than the floor actually received. That
    // is the unfinanced-supply defect closed on 2026-07-17, and a second instruction minting
    // floor-backed SOLA is exactly where it would come back.
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_usdc.to_account_info(),
                to: ctx.accounts.floor_vault.to_account_info(),
                authority: ctx.accounts.auto.to_account_info(),
            },
            &[auto_seeds],
        ),
        amount,
    )?;

    if fee > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.auto.to_account_info(),
                },
                &[auto_seeds],
            ),
            fee,
        )?;
    }

    // ── 2. Burn the oSOLA, as the delegate the user approved ─────────────────
    token::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.o_sola_mint.to_account_info(),
                from: ctx.accounts.user_o_sola.to_account_info(),
                authority: ctx.accounts.auto.to_account_info(),
            },
            &[auto_seeds],
        ),
        amount,
    )?;

    // ── 3. Mint the SOLA straight into the stake vault ───────────────────────
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.sola_mint.to_account_info(),
                to: ctx.accounts.sola_vault.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[state_seeds],
        ),
        amount,
    )?;

    {
        let s = &mut ctx.accounts.protocol_state;
        s.total_sola = s
            .total_sola
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;
        // The strike reached the floor above, so this SOLA is fully floor-backed.
        s.total_purchased_sola = s
            .total_purchased_sola
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;
        s.accumulated_fees = s
            .accumulated_fees
            .checked_add(fee)
            .ok_or(SoladromeError::Overflow)?;
    }

    // ── 4. Stake it, exactly as `stake_sola` would ───────────────────────────
    //
    // ☢️ `reload()` is not optional. `market_vault.amount` was deserialized when the instruction
    // opened, and step 1 just paid the fee into it through a CPI — so the cached figure is stale
    // by exactly the fee. Advancing the accumulator on a stale balance would leave that fee
    // uncredited until some later interaction happened to notice it, which is the class of bug
    // that hides for months because the totals stay self-consistent while they drift.
    ctx.accounts.market_vault.reload()?;
    let market_balance = ctx.accounts.market_vault.amount;
    let acc = math::advance_accumulator(
        ctx.accounts.protocol_state.fees_per_hi_sola,
        market_balance,
        ctx.accounts.protocol_state.last_market_vault_balance,
        ctx.accounts.protocol_state.total_hi_sola,
    );

    let pending = credit_financed_stake(
        &mut ctx.accounts.user_position,
        owner_key,
        ctx.bumps.user_position,
        acc,
        amount,
    )?;

    // The harvested fees are the OWNER's, and they go to the owner's own account. A cranker who
    // hoped to be paid here is reading the wrong instruction: this one pays nobody but the user
    // it serves.
    if pending > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[state_seeds],
            ),
            pending,
        )?;
    }

    {
        let s = &mut ctx.accounts.protocol_state;
        s.fees_per_hi_sola = acc;
        // Subtract the auto-paid fees so they are not double-credited to the remaining stakers
        // on the next advance — same as `stake_sola` and `unstake_hi_sola`.
        s.last_market_vault_balance = market_balance.saturating_sub(pending);
        s.total_hi_sola = s
            .total_hi_sola
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;
    }

    let auto = &mut ctx.accounts.auto;
    auto.usdc_spent = auto.usdc_spent.saturating_add(cost);
    auto.rounds = auto.rounds.saturating_add(1);
    auto.last_crank_ts = now;
    Ok(())
}

/// Close an order and return its rent. The user signs.
pub fn close_auto_compound(_ctx: Context<CloseAutoCompound>) -> Result<()> {
    Ok(())
}

// ── Contexts ─────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ConfigureAutoCompound<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + AutoCompound::LEN,
        seeds = [AUTO_SEED, user.key().as_ref()],
        bump,
    )]
    pub auto: Box<Account<'info, AutoCompound>>,

    /// Created here, paid for by its own owner, so the crank never has to initialise an account
    /// on someone else's behalf — and never has to take a payer it could be made to drain.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAutoCompoundEnabled<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [AUTO_SEED, user.key().as_ref()],
        bump = auto.bump,
        has_one = owner @ SoladromeError::AutoOwnerMismatch,
    )]
    pub auto: Box<Account<'info, AutoCompound>>,

    /// CHECK: bound to `auto.owner` by `has_one`, and to the signer by the seeds.
    #[account(address = user.key())]
    pub owner: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CloseAutoCompound<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        close = user,
        seeds = [AUTO_SEED, user.key().as_ref()],
        bump = auto.bump,
    )]
    pub auto: Box<Account<'info, AutoCompound>>,
}

#[derive(Accounts)]
pub struct CrankAutoCompound<'info> {
    /// Anyone. Pays the transaction fee and receives nothing.
    pub cranker: Signer<'info>,

    /// CHECK: identity only — every account below is bound to it by seeds or by `token::authority`,
    /// and `auto.owner` is checked against it in the handler. It signs nothing.
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [AUTO_SEED, owner.key().as_ref()],
        bump = auto.bump,
    )]
    pub auto: Box<Account<'info, AutoCompound>>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Box<Account<'info, Mint>>,

    /// ☢️ THE OWNER'S ASSOCIATED ACCOUNTS, not merely accounts they happen to own.
    ///
    /// Binding to the authority alone is what made the permissionless `claim_lp_rewards`
    /// grievable: anyone may create a token account and name someone else as its owner, so
    /// "an account the owner owns" is a set an attacker can add to. Nothing exploitable was
    /// found on this instruction — a decoy holds no delegation, so the burn fails — but the
    /// reasoning that establishes that is long, and the constraint that removes the need for
    /// it is one line. There is exactly one address here, and the frontend and the keeper
    /// both already use it.
    #[account(
        mut,
        associated_token::mint = o_sola_mint,
        associated_token::authority = owner,
    )]
    pub user_o_sola: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = user_usdc.mint == protocol_state.usdc_mint @ SoladromeError::InvalidAmount,
        associated_token::mint = usdc_mint,
        associated_token::authority = owner,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(address = protocol_state.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
