// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer},
};

use crate::amm_math::{self, MINIMUM_LIQUIDITY};
use crate::amm_state::{sort_mints, AmmPool};
use crate::errors::SoladromeError;
use crate::state::{LpPoolEpochAccum, LpUserCheckpoint, LpUserInfo, ProtocolState, EPOCH_DURATION};
use crate::{LP_REWARD_PRECISION, STATE_SEED};

// ── Constants ─────────────────────────────────────────────────────────────────
pub const AMM_POOL_SEED: &[u8] = b"amm_pool";
pub const LP_MINT_SEED: &[u8] = b"lp_mint";
pub const VAULT_A_SEED: &[u8] = b"vault_a";
pub const VAULT_B_SEED: &[u8] = b"vault_b";

pub const MAX_FEE_RATE: u16 = 1_000; // 10% max swap fee
pub const MAX_PROTOCOL_FEE: u16 = 5_000; // 50% of fee max to protocol

// ── Reward accumulator helpers ────────────────────────────────────────────────

/// Advance pool's oSOLA-per-LP accumulator using elapsed seconds.
/// Inlined to avoid borrow checker conflicts with Anchor account references.
macro_rules! update_pool_rewards {
    ($pool:expr, $now:expr, $rate:expr, $active:expr) => {{
        if $pool.last_reward_ts == 0 {
            $pool.last_reward_ts = $now;
        } else {
            let elapsed = ($now - $pool.last_reward_ts).max(0) as u128;
            // Accrue only when: this pool is authority-approved (`rewards_enabled`),
            // the continuous window is still open (`$active` = current_epoch <
            // continuous_end_epoch), and a rate is configured. The timestamp still
            // advances otherwise so re-enabling later never back-pays.
            if elapsed > 0 && $pool.total_lp > 0 && $pool.rewards_enabled && $active {
                let new_rewards = ($rate as u128).saturating_mul(elapsed);
                let delta =
                    new_rewards.saturating_mul(LP_REWARD_PRECISION) / ($pool.total_lp as u128);
                $pool.osola_reward_per_lp = $pool.osola_reward_per_lp.saturating_add(delta);
            }
            $pool.last_reward_ts = $now;
        }
    }};
}

/// Advance the per-pool oSOLA reward accumulator.
/// Identical to the `update_pool_rewards!` macro but callable from other modules
/// (e.g. `flash_arbitrage` in lib.rs which manipulates pool reserves directly).
/// `rate` = oSOLA base units/sec; `active` = continuous window still open.
pub fn advance_pool_rewards(pool: &mut AmmPool, now: i64, rate: u32, active: bool) {
    if pool.last_reward_ts == 0 {
        pool.last_reward_ts = now;
    } else {
        let elapsed = (now - pool.last_reward_ts).max(0) as u128;
        // Only approved pools, within the open window, with a rate set, accrue;
        // timestamp advances regardless to avoid back-paying after a gap.
        if elapsed > 0 && pool.total_lp > 0 && pool.rewards_enabled && active {
            let new_rewards = (rate as u128).saturating_mul(elapsed);
            let delta = new_rewards.saturating_mul(LP_REWARD_PRECISION) / (pool.total_lp as u128);
            pool.osola_reward_per_lp = pool.osola_reward_per_lp.saturating_add(delta);
        }
        pool.last_reward_ts = now;
    }
}

/// Whether the continuous emission window is open at `now` for the given state.
pub fn continuous_active(state: &ProtocolState, now: i64) -> bool {
    crate::state::current_epoch(now) < u64::from(state.continuous_end_epoch)
}

/// Authority-only: approve or revoke a pool's eligibility for continuous oSOLA
/// emissions ("house" LP pools). Settles accrual up to now under the OLD flag
/// before flipping, so toggling never back-pays nor forfeits earned rewards.
pub fn set_pool_rewards(ctx: Context<SetPoolRewards>, enabled: bool) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rate = ctx.accounts.protocol_state.continuous_rate_per_sec;
    let active = continuous_active(&ctx.accounts.protocol_state, now);
    let pool = &mut ctx.accounts.pool;
    advance_pool_rewards(pool, now, rate, active);
    pool.rewards_enabled = enabled;
    msg!("Pool {} rewards_enabled = {}", pool.key(), enabled,);
    Ok(())
}

/// Reward basis for a user: the LP they deposited through the program, floored by what
/// their wallet still holds.
///
/// `lp_amount` alone would keep paying someone who has since transferred their LP away;
/// the wallet balance alone pays anyone who was transferred LP without ever depositing
/// (fresh wallet ⇒ `reward_debt` = 0 ⇒ the whole accumulator since pool creation). Only the
/// minimum requires both, and the same tokens cannot satisfy it in two wallets at once.
pub fn reward_basis(info: &LpUserInfo, wallet_lp: u64) -> u64 {
    info.lp_amount.min(wallet_lp)
}

/// Compute pending oSOLA for a user given current accumulator and their debt.
fn pending_osola(acc: u128, debt: u128, user_lp: u64) -> u64 {
    if user_lp == 0 || acc <= debt {
        return 0;
    }
    let delta = acc - debt;
    (delta.saturating_mul(user_lp as u128) / LP_REWARD_PRECISION) as u64
}

// ── Instructions ──────────────────────────────────────────────────────────────

/// Create a new volatile (xy=k) AMM pool for any two distinct token mints.
/// Permissionless — anyone can create a pool.
/// Mints are sorted internally so (A, B) and (B, A) map to the same pool.
pub fn create_pool(ctx: Context<CreatePool>, fee_rate: u16, protocol_fee_bps: u16) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        crate::errors::SoladromeError::ProtocolPaused
    );
    require!(
        ctx.accounts.protocol_state.lp_enabled,
        SoladromeError::FeatureDisabled
    );
    require!(fee_rate <= MAX_FEE_RATE, SoladromeError::InvalidAmount);
    require!(
        protocol_fee_bps <= MAX_PROTOCOL_FEE,
        SoladromeError::InvalidAmount
    );

    let mint_a_key = ctx.accounts.token_a_mint.key();
    let mint_b_key = ctx.accounts.token_b_mint.key();
    require!(mint_a_key != mint_b_key, SoladromeError::InvalidPoolTokens);

    let (sorted_a, sorted_b) = sort_mints(mint_a_key, mint_b_key);
    require!(
        sorted_a == mint_a_key && sorted_b == mint_b_key,
        SoladromeError::InvalidPoolTokens
    );

    let pool = &mut ctx.accounts.pool;
    pool.token_a_mint = mint_a_key;
    pool.token_b_mint = mint_b_key;
    pool.token_a_vault = ctx.accounts.token_a_vault.key();
    pool.token_b_vault = ctx.accounts.token_b_vault.key();
    pool.lp_mint = ctx.accounts.lp_mint.key();
    pool.fee_rate = fee_rate;
    pool.protocol_fee_bps = protocol_fee_bps;
    pool.total_lp = 0;
    pool.reserve_a = 0;
    pool.reserve_b = 0;
    pool.bump = ctx.bumps.pool;
    // Permissionless pools earn NO continuous oSOLA emissions by default; the
    // authority must explicitly approve a pool via `set_pool_rewards`.
    pool.rewards_enabled = false;
    Ok(())
}

/// Deposit token_a and token_b, receive LP tokens.
/// First deposit sets the price; subsequent deposits must match the current ratio.
/// Auto-harvests any pending oSOLA rewards before updating the user's debt checkpoint.
pub fn add_liquidity(
    ctx: Context<AddLiquidity>,
    amount_a_desired: u64,
    amount_b_desired: u64,
    min_lp: u64,
) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        crate::errors::SoladromeError::ProtocolPaused
    );
    let (lp_out, actual_a, actual_b) = amm_math::lp_for_deposit(
        ctx.accounts.pool.reserve_a,
        ctx.accounts.pool.reserve_b,
        ctx.accounts.pool.total_lp,
        amount_a_desired,
        amount_b_desired,
    )?;
    require!(lp_out >= min_lp, SoladromeError::SlippageExceeded);

    // Transfer token A from user → vault_a
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_a.to_account_info(),
                to: ctx.accounts.token_a_vault.to_account_info(),
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
                from: ctx.accounts.user_token_b.to_account_info(),
                to: ctx.accounts.token_b_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        actual_b,
    )?;

    // Extract values we'll need for seeds before any mutable borrows
    let pool_bump = ctx.accounts.pool.bump;
    let mint_a = ctx.accounts.pool.token_a_mint;
    let mint_b = ctx.accounts.pool.token_b_mint;
    let user_lp_pre = ctx.accounts.user_lp.amount; // balance before this mint

    let pool_seeds: &[&[u8]] = &[
        AMM_POOL_SEED,
        mint_a.as_ref(),
        mint_b.as_ref(),
        &[pool_bump],
    ];

    // Mint MINIMUM_LIQUIDITY to a dead address on first deposit (locked forever)
    if ctx.accounts.pool.total_lp == 0 {
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

    // ── Update reward accumulator (pre-mint total_lp) ─────────────────────────
    let now = Clock::get()?.unix_timestamp;
    let cont_rate = ctx.accounts.protocol_state.continuous_rate_per_sec;
    let cont_active = continuous_active(&ctx.accounts.protocol_state, now);
    {
        let pool = &mut ctx.accounts.pool;
        update_pool_rewards!(pool, now, cont_rate, cont_active);
    }

    // ── Auto-harvest pending oSOLA for user's existing LP position ────────────
    let acc = ctx.accounts.pool.osola_reward_per_lp;
    let basis = reward_basis(&ctx.accounts.lp_user_info, user_lp_pre);
    let pending = pending_osola(acc, ctx.accounts.lp_user_info.reward_debt, basis);
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

    // Snapshot user's debt at current accumulator (new LP earns from here)
    let lp_user_info = &mut ctx.accounts.lp_user_info;
    lp_user_info.reward_debt = acc;
    if lp_user_info.bump == 0 {
        lp_user_info.bump = ctx.bumps.lp_user_info;
    }
    // Record the deposit: this is the only way lp_amount ever grows, so reward-earning
    // LP can only be created by actually paying tokens into the vaults.
    lp_user_info.lp_amount = lp_user_info
        .lp_amount
        .checked_add(lp_out)
        .ok_or(SoladromeError::Overflow)?;
    // Restart the epoch-weight accrual window (see LpUserInfo::last_change_ts).
    lp_user_info.last_change_ts = now.max(0) as u32;

    // Mint lp_out to user
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.lp_mint.to_account_info(),
                to: ctx.accounts.user_lp.to_account_info(),
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
    Ok(())
}

/// Burn LP tokens, receive proportional token_a and token_b back.
/// Auto-harvests pending oSOLA rewards before burning.
pub fn remove_liquidity(
    ctx: Context<RemoveLiquidity>,
    lp_amount: u64,
    min_a: u64,
    min_b: u64,
) -> Result<()> {
    let user_lp_pre = ctx.accounts.user_lp.amount; // balance before burn

    // ── Update reward accumulator (pre-burn total_lp) ─────────────────────────
    let now = Clock::get()?.unix_timestamp;
    let cont_rate = ctx.accounts.protocol_state.continuous_rate_per_sec;
    let cont_active = continuous_active(&ctx.accounts.protocol_state, now);
    {
        let pool = &mut ctx.accounts.pool;
        update_pool_rewards!(pool, now, cont_rate, cont_active);
    }

    // ── Auto-harvest pending oSOLA ────────────────────────────────────────────
    let acc = ctx.accounts.pool.osola_reward_per_lp;
    let basis = reward_basis(&ctx.accounts.lp_user_info, user_lp_pre);
    let pending = pending_osola(acc, ctx.accounts.lp_user_info.reward_debt, basis);
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

    // Reset user's debt checkpoint (remaining LP earns from current acc)
    let lp_user_info = &mut ctx.accounts.lp_user_info;
    lp_user_info.reward_debt = acc;
    if lp_user_info.bump == 0 {
        lp_user_info.bump = ctx.bumps.lp_user_info;
    }
    // Withdrawal shrinks the recorded deposit. saturating_sub, not checked_sub: a legacy
    // position created before this field existed reads lp_amount = 0 and must still be
    // able to withdraw — it simply earns nothing until its next add_liquidity.
    lp_user_info.lp_amount = lp_user_info.lp_amount.saturating_sub(lp_amount);
    // Restart the epoch-weight accrual window (see LpUserInfo::last_change_ts).
    lp_user_info.last_change_ts = now.max(0) as u32;

    // ── Burn LP and return tokens ─────────────────────────────────────────────
    let pool = &ctx.accounts.pool;
    let (amount_a, amount_b) =
        amm_math::tokens_for_lp(pool.reserve_a, pool.reserve_b, pool.total_lp, lp_amount)?;
    require!(
        amount_a >= min_a && amount_b >= min_b,
        SoladromeError::SlippageExceeded
    );

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.lp_mint.to_account_info(),
                from: ctx.accounts.user_lp.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        lp_amount,
    )?;

    let pool_bump = ctx.accounts.pool.bump;
    let mint_a = ctx.accounts.pool.token_a_mint;
    let mint_b = ctx.accounts.pool.token_b_mint;
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
                from: ctx.accounts.token_a_vault.to_account_info(),
                to: ctx.accounts.user_token_a.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[pool_seeds],
        ),
        amount_a,
    )?;

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.token_b_vault.to_account_info(),
                to: ctx.accounts.user_token_b.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[pool_seeds],
        ),
        amount_b,
    )?;

    let pool = &mut ctx.accounts.pool;
    pool.reserve_a = pool
        .reserve_a
        .checked_sub(amount_a)
        .ok_or(SoladromeError::Overflow)?;
    pool.reserve_b = pool
        .reserve_b
        .checked_sub(amount_b)
        .ok_or(SoladromeError::Overflow)?;
    pool.total_lp = pool
        .total_lp
        .checked_sub(lp_amount)
        .ok_or(SoladromeError::Overflow)?;
    Ok(())
}

/// Claim accumulated oSOLA rewards for the caller's LP position without changing liquidity.
pub fn claim_lp_rewards(ctx: Context<ClaimLpRewards>) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        crate::errors::SoladromeError::ProtocolPaused
    );
    let user_lp = ctx.accounts.user_lp.amount;

    // Update pool accumulator
    let now = Clock::get()?.unix_timestamp;
    let cont_rate = ctx.accounts.protocol_state.continuous_rate_per_sec;
    let cont_active = continuous_active(&ctx.accounts.protocol_state, now);
    {
        let pool = &mut ctx.accounts.pool;
        update_pool_rewards!(pool, now, cont_rate, cont_active);
    }

    let acc = ctx.accounts.pool.osola_reward_per_lp;
    let basis = reward_basis(&ctx.accounts.lp_user_info, user_lp);
    let pending = pending_osola(acc, ctx.accounts.lp_user_info.reward_debt, basis);
    require!(pending > 0, SoladromeError::NothingToClaim);

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

    let lp_user_info = &mut ctx.accounts.lp_user_info;
    lp_user_info.reward_debt = acc;
    if lp_user_info.bump == 0 {
        lp_user_info.bump = ctx.bumps.lp_user_info;
    }

    Ok(())
}

/// Swap token_in for token_out via the pool's xy=k curve.
/// a_to_b: true  → sell token_a, receive token_b
///         false → sell token_b, receive token_a
/// Fee split: LP portion stays in reserves, protocol portion → market_vault.
pub fn swap(ctx: Context<Swap>, amount_in: u64, min_out: u64, a_to_b: bool) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        crate::errors::SoladromeError::ProtocolPaused
    );
    require!(amount_in > 0, SoladromeError::InvalidAmount);

    let pool = &ctx.accounts.pool;
    let fee_rate = pool.fee_rate as u128;
    let proto_bps = pool.protocol_fee_bps as u128;

    let amount_in_u128 = amount_in as u128;
    let fee_total = amount_in_u128 * fee_rate / 10_000;
    let fee_protocol = fee_total * proto_bps / 10_000;
    let amount_in_net = amount_in_u128 - fee_total;

    let (reserve_in, reserve_out) = if a_to_b {
        (pool.reserve_a, pool.reserve_b)
    } else {
        (pool.reserve_b, pool.reserve_a)
    };

    let amount_out = amm_math::swap_out(reserve_in, reserve_out, amount_in_net as u64)?;
    require!(amount_out >= min_out, SoladromeError::SlippageExceeded);

    let pool_bump = pool.bump;
    let pool_seeds: &[&[u8]] = &[
        AMM_POOL_SEED,
        ctx.accounts.pool.token_a_mint.as_ref(),
        ctx.accounts.pool.token_b_mint.as_ref(),
        &[pool_bump],
    ];
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
            Transfer {
                from: user_in,
                to: vault_in,
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount_in,
    )?;

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: vault_out,
                to: user_out,
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[pool_seeds],
        ),
        amount_out,
    )?;

    // Only route protocol fee to market_vault if the input token matches the market_vault mint (USDC).
    // For non-USDC pools (e.g. oSOLA/SOLA), the protocol fee stays in reserves as LP revenue.
    let mut fee_routed: u128 = 0;
    if fee_protocol > 0 {
        let input_vault_mint = if a_to_b {
            ctx.accounts.token_a_vault.mint
        } else {
            ctx.accounts.token_b_vault.mint
        };
        if input_vault_mint == ctx.accounts.market_vault.mint {
            let fee_proto_u64 = fee_protocol as u64;
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: if a_to_b {
                            ctx.accounts.token_a_vault.to_account_info()
                        } else {
                            ctx.accounts.token_b_vault.to_account_info()
                        },
                        to: ctx.accounts.market_vault.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    &[pool_seeds],
                ),
                fee_proto_u64,
            )?;
            ctx.accounts.protocol_state.accumulated_fees = ctx
                .accounts
                .protocol_state
                .accumulated_fees
                .saturating_add(fee_proto_u64);
            fee_routed = fee_protocol;
        }
        // else: fee stays in vault — LP earns 100% of the swap fee for non-USDC pools
    }

    let pool = &mut ctx.accounts.pool;
    if a_to_b {
        let net_a = (amount_in as u128 - fee_routed) as u64;
        pool.reserve_a = pool
            .reserve_a
            .checked_add(net_a)
            .ok_or(SoladromeError::Overflow)?;
        pool.reserve_b = pool
            .reserve_b
            .checked_sub(amount_out)
            .ok_or(SoladromeError::Overflow)?;
    } else {
        let net_b = (amount_in as u128 - fee_routed) as u64;
        pool.reserve_b = pool
            .reserve_b
            .checked_add(net_b)
            .ok_or(SoladromeError::Overflow)?;
        pool.reserve_a = pool
            .reserve_a
            .checked_sub(amount_out)
            .ok_or(SoladromeError::Overflow)?;
    }
    Ok(())
}

// ── LP emission auto-checkpoint helper (kept for standalone checkpoint_lp) ────
/// Called automatically on every add/remove liquidity (legacy, kept for compatibility).
#[allow(clippy::too_many_arguments)]
pub fn lp_auto_checkpoint(
    ckpt: &mut LpUserCheckpoint,
    pa: &mut LpPoolEpochAccum,
    pool_key: Pubkey,
    user_key: Pubkey,
    user_lp_pre: u64,
    lp_supply_pre: u64,
    now: i64,
    epoch: u64,
    ckpt_bump: u8,
    pa_bump: u8,
) -> Result<()> {
    let epoch_start = (epoch * EPOCH_DURATION) as i64;

    if pa.epoch == 0 {
        pa.pool = pool_key;
        pa.epoch = epoch;
        pa.last_update_ts = epoch_start;
        pa.last_lp_supply = lp_supply_pre;
        pa.bump = pa_bump;
    }

    if !pa.finalized {
        let pa_elapsed = (now - pa.last_update_ts).max(0) as u128;
        pa.total_weighted_supply = pa
            .total_weighted_supply
            .checked_add(
                (pa.last_lp_supply as u128)
                    .checked_mul(pa_elapsed)
                    .ok_or(SoladromeError::Overflow)?,
            )
            .ok_or(SoladromeError::Overflow)?;
        pa.last_update_ts = now;
        pa.last_lp_supply = lp_supply_pre;
    }

    if ckpt.pool == Pubkey::default() {
        ckpt.user = user_key;
        ckpt.pool = pool_key;
        ckpt.last_epoch = epoch;
        ckpt.last_update_ts = epoch_start;
        ckpt.bump = ckpt_bump;
    }

    if ckpt.last_epoch < epoch {
        ckpt.weighted_balance = 0;
        ckpt.last_update_ts = epoch_start;
        ckpt.last_epoch = epoch;
    }

    let ckpt_elapsed = (now - ckpt.last_update_ts).max(0) as u128;
    ckpt.weighted_balance = ckpt
        .weighted_balance
        .checked_add(
            (user_lp_pre as u128)
                .checked_mul(ckpt_elapsed)
                .ok_or(SoladromeError::Overflow)?,
        )
        .ok_or(SoladromeError::Overflow)?;
    ckpt.last_update_ts = now;

    Ok(())
}

// ── Account Contexts ──────────────────────────────────────────────────────────

/// Authority-only toggle of a pool's continuous-emission eligibility.
#[derive(Accounts)]
pub struct SetPoolRewards<'info> {
    #[account(
        address = protocol_state.authority @ SoladromeError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(seeds = [crate::STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, crate::state::ProtocolState>>,

    #[account(
        mut,
        seeds = [AMM_POOL_SEED, pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, AmmPool>>,
}

#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// Read-only — used only for the pause check.
    #[account(seeds = [crate::STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, crate::state::ProtocolState>>,

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

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
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

    /// Dead address ATA — permanently locked MINIMUM_LIQUIDITY on first deposit.
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

    /// Per-user continuous oSOLA reward state for this pool.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + LpUserInfo::LEN,
        seeds = [b"lp_user", pool.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub lp_user_info: Box<Account<'info, LpUserInfo>>,

    /// Protocol state — needed to sign the oSOLA mint CPI.
    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// oSOLA mint — auto-harvested rewards are minted here.
    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Box<Account<'info, Mint>>,

    /// User's oSOLA ATA — receives auto-harvested rewards.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = o_sola_mint,
        associated_token::authority = user,
    )]
    pub user_o_sola: Box<Account<'info, TokenAccount>>,

    pub rent: Sysvar<'info, Rent>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
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

    /// User's token-A ATA (must already exist).
    // M-10 FIX: enforce mint to prevent wrong-mint routing.
    // Review fix: also enforce owner so a front-runner cannot substitute an arbitrary
    // same-mint account and redirect LP withdrawal proceeds to a wallet they control.
    #[account(
        mut,
        constraint = user_token_a.mint  == token_a_vault.mint @ SoladromeError::InvalidPoolTokens,
        constraint = user_token_a.owner == user.key()         @ SoladromeError::Unauthorized,
    )]
    pub user_token_a: Box<Account<'info, TokenAccount>>,

    /// User's token-B ATA (must already exist).
    #[account(
        mut,
        constraint = user_token_b.mint  == token_b_vault.mint @ SoladromeError::InvalidPoolTokens,
        constraint = user_token_b.owner == user.key()         @ SoladromeError::Unauthorized,
    )]
    pub user_token_b: Box<Account<'info, TokenAccount>>,

    /// Per-user continuous oSOLA reward state for this pool.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + LpUserInfo::LEN,
        seeds = [b"lp_user", pool.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub lp_user_info: Box<Account<'info, LpUserInfo>>,

    /// Protocol state — needed to sign the oSOLA mint CPI.
    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// oSOLA mint — auto-harvested rewards are minted here.
    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Box<Account<'info, Mint>>,

    /// User's oSOLA ATA — receives auto-harvested rewards.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = o_sola_mint,
        associated_token::authority = user,
    )]
    pub user_o_sola: Box<Account<'info, TokenAccount>>,

    pub rent: Sysvar<'info, Rent>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Claim accumulated oSOLA without changing LP position.
#[derive(Accounts)]
pub struct ClaimLpRewards<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [AMM_POOL_SEED, pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    #[account(address = pool.lp_mint)]
    pub lp_mint: Box<Account<'info, Mint>>,

    /// User's LP balance — determines the reward share.
    #[account(token::mint = lp_mint, token::authority = user)]
    pub user_lp: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + LpUserInfo::LEN,
        seeds = [b"lp_user", pool.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub lp_user_info: Box<Account<'info, LpUserInfo>>,

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

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
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
    // M-02 FIX: explicit authority check so a caller cannot pass someone else's
    // token account as the input source (SPL enforces this too, but belt-and-suspenders).
    #[account(mut, constraint = user_token_in.owner == user.key() @ SoladromeError::Unauthorized)]
    pub user_token_in: Box<Account<'info, TokenAccount>>,

    /// User's output token ATA — intentionally unconstrained on owner so integrators
    /// can direct swap output to a different recipient account if desired.
    #[account(mut)]
    pub user_token_out: Box<Account<'info, TokenAccount>>,

    /// Protocol market vault — receives the protocol fee portion (in input token).
    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    pub token_program: Program<'info, Token>,
}
