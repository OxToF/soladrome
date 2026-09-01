// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! The per-epoch, gauge-weighted oSOLA pot, and the configuration of both emission channels.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, Token, TokenAccount},
};

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::instructions::amm;
use crate::math;
use crate::math::*;
use crate::state::*;

/// Record a time-weighted LP balance snapshot for the caller in a given pool+epoch.
/// Must be called before the epoch ends; updates both the user and pool accumulators.
pub fn checkpoint_lp(ctx: Context<CheckpointLp>, epoch: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let epoch_start = (epoch * EPOCH_DURATION) as i64;
    let epoch_end = ((epoch + 1) * EPOCH_DURATION) as i64;

    require!(now >= epoch_start, SoladromeError::WrongEpoch);
    require!(now < epoch_end, SoladromeError::EpochNotEnded);

    let pool_key = ctx.accounts.pool.key();
    let lp_supply = ctx.accounts.lp_mint.supply;
    // Program-recorded deposit, floored by the wallet balance — never the raw wallet
    // balance. LP tokens are transferable, and this checkpoint is what the epoch pot is
    // split on: paying on the balance let one position be walked through N fresh wallets,
    // each banking the same weight against a denominator (`total_weighted_supply`) that
    // only ever counts the mint supply once. See LpUserInfo::lp_amount.
    let user_lp = amm::reward_basis(&ctx.accounts.lp_user_info, ctx.accounts.user_lp.amount);
    let last_change_ts = ctx.accounts.lp_user_info.last_change_ts as i64;

    // ── Pool accumulator ────────────────────────────────────────────
    let pa = &mut ctx.accounts.pool_epoch_accum;
    if pa.epoch == 0 {
        pa.epoch = epoch;
        pa.pool = pool_key;
        pa.last_update_ts = epoch_start;
        pa.last_lp_supply = lp_supply;
        pa.bump = ctx.bumps.pool_epoch_accum;
    }
    // Weight must never be added to a pot that has already been sized. ⚠️ This check is
    // UNREACHABLE as the code stands, and the error it used to raise said the opposite of
    // the condition (`EpochNotFinalized` when the epoch IS finalized), which is how it
    // read as load-bearing. What actually refuses the call is the window guard above:
    // `checkpoint_lp` only runs while `now < epoch_end`, `emit_pool_rewards` only once
    // `now >= epoch_end`, so no call can see a finalized accumulator inside its own
    // window — the caller gets `EpochNotEnded` first.
    //
    // Kept deliberately, not deleted: it costs one comparison and it is the DIRECT
    // statement of the invariant, whereas the window guard enforces it only as a
    // consequence of the clock. Widen `checkpoint_lp`'s window — allow a grace period
    // after the epoch, say — and this line is what stops weight being billed against a
    // pot that is already closed. Do not remove it on the grounds that it never fires.
    require!(!pa.finalized, SoladromeError::EpochAlreadyFinalized);

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
    pa.last_lp_supply = lp_supply;

    // ── User checkpoint ─────────────────────────────────────────────
    // Weight accrues from the FIRST checkpoint of the epoch, never from `epoch_start`.
    // Back-dating to epoch_start paid a full epoch of weight for zero holding time: add
    // liquidity at T−ε, checkpoint, withdraw — the credit is already banked. The
    // denominator still counts the whole epoch, so late checkpointers simply earn less
    // and the unclaimed remainder is never minted (the pot under-distributes, which is
    // the safe direction). Practical consequence for honest LPs: checkpoint EARLY in the
    // epoch, and again before it ends.
    let ckpt = &mut ctx.accounts.lp_user_checkpoint;
    if ckpt.pool == Pubkey::default() {
        ckpt.user = ctx.accounts.user.key();
        ckpt.pool = pool_key;
        ckpt.last_epoch = epoch;
        ckpt.last_update_ts = now;
        ckpt.bump = ctx.bumps.lp_user_checkpoint;
    }
    // Reset for a new epoch
    if ckpt.last_epoch < epoch {
        ckpt.weighted_balance = 0;
        ckpt.last_update_ts = now;
        ckpt.last_epoch = epoch;
    }

    // Bill only an interval the position was held across in full: any change of size
    // (deposit or withdrawal) restarts the window — see LpUserInfo::last_change_ts. A
    // late deposit, or a withdraw-redeposit cycle, can no longer bill a whole epoch of
    // weight for an instant of capital.
    let window_start = ckpt.last_update_ts.max(last_change_ts);
    let ckpt_elapsed = (now - window_start).max(0) as u128;
    ckpt.weighted_balance = ckpt
        .weighted_balance
        .checked_add(
            (user_lp as u128)
                .checked_mul(ckpt_elapsed)
                .ok_or(SoladromeError::Overflow)?,
        )
        .ok_or(SoladromeError::Overflow)?;
    ckpt.last_update_ts = now;

    Ok(())
}

/// Finalize the LP emission allocation for one pool after its epoch has ended.
/// Permissionless — anyone can call. Records how much oSOLA this pool's LPs may claim.
pub fn emit_pool_rewards(ctx: Context<EmitPoolRewards>, epoch: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    // Master emission switch (ProtocolState::emissions_enabled). While off,
    // the epoch/gauge path can allocate no oSOLA, so the "emissions dormant"
    // launch guarantee holds explicitly — not via the transitive no-votes
    // coupling below (which the pre-Genesis audit still validates).
    require!(
        ctx.accounts.protocol_state.emissions_enabled,
        SoladromeError::FeatureDisabled
    );
    let clock = Clock::get()?;
    let epoch_end = ((epoch + 1) * EPOCH_DURATION) as i64;
    require!(
        clock.unix_timestamp >= epoch_end,
        SoladromeError::EpochNotEnded
    );

    let pool_accum = &mut ctx.accounts.pool_epoch_accum;
    require!(!pool_accum.finalized, SoladromeError::AlreadyAllocated);

    let lp_supply = ctx.accounts.lp_mint.supply;

    // Initialise if nobody checkpointed this epoch
    if pool_accum.epoch == 0 {
        pool_accum.epoch = epoch;
        pool_accum.pool = ctx.accounts.pool.key();
        pool_accum.last_update_ts = (epoch * EPOCH_DURATION) as i64;
        pool_accum.last_lp_supply = lp_supply;
        pool_accum.bump = ctx.bumps.pool_epoch_accum;
    }

    // Add remaining time from last checkpoint to epoch end
    let remaining = (epoch_end - pool_accum.last_update_ts).max(0) as u128;
    pool_accum.total_weighted_supply = pool_accum
        .total_weighted_supply
        .checked_add(
            (pool_accum.last_lp_supply as u128)
                .checked_mul(remaining)
                .ok_or(SoladromeError::Overflow)?,
        )
        .ok_or(SoladromeError::Overflow)?;
    pool_accum.last_update_ts = epoch_end;
    pool_accum.last_lp_supply = lp_supply;

    let total_votes = ctx.accounts.global_epoch_votes.total_votes as u128;
    let pool_votes = ctx.accounts.gauge_state.total_votes as u128;
    require!(total_votes > 0, SoladromeError::NoVotes);
    require!(pool_votes > 0, SoladromeError::NoVotes);

    // Compute decayed epoch emission for this specific epoch.
    let elapsed = epoch.saturating_sub(ctx.accounts.protocol_state.osola_emission_start_epoch);
    let epoch_total = math::decayed_emission(
        ctx.accounts.protocol_state.osola_emission_initial,
        ctx.accounts.protocol_state.osola_emission_decay_bps,
        elapsed,
        ctx.accounts.protocol_state.osola_emission_floor_bps,
    );

    let vote_share = (epoch_total as u128)
        .checked_mul(pool_votes)
        .ok_or(SoladromeError::Overflow)?
        .checked_div(total_votes)
        .ok_or(SoladromeError::Overflow)? as u64;

    // Fold in anything `recycle_lp_emissions` rolled forward from this pool's earlier epochs.
    // The carry is consumed here and nowhere else: once `finalized` is set, the accum is a
    // claim target and `carry_in` is inert, which is what keeps the two figures from being
    // counted twice.
    pool_accum.osola_allocated = vote_share
        .checked_add(pool_accum.carry_in)
        .ok_or(SoladromeError::Overflow)?;
    pool_accum.finalized = true;

    Ok(())
}

/// Roll one settled epoch's unclaimed LP emission residue forward into the pool's current epoch.
///
/// Permissionless, and deliberately shaped like `rollover_bribe`, which solves the same problem
/// one layer up: a pot sized for a week, partly unclaimed, that would otherwise sit dead.
///
/// **What the residue is, stated precisely.** `emit_pool_rewards` sizes a (pool, epoch) pot from
/// the gauge vote; `claim_lp_emissions` mints against it. oSOLA is minted **on claim**, so an
/// unclaimed residue is not tokens sitting somewhere — it is emission the schedule intended for
/// this pool's LPs that simply never came into existence. Nothing is at risk and no cap is
/// breached (`osola_claimed` still ceilings the pot). What is lost is budget: an epoch where
/// half the LPs never claimed quietly emits half of what the curve says it emits, and the
/// published schedule stops describing reality.
///
/// **Why the destination is the current epoch of the same pool.** The residue was voted to this
/// pool, so it stays with this pool's LPs rather than being socialised; and the current epoch is
/// the only one that cannot already be a claim target, since `emit_pool_rewards` refuses to
/// finalize an epoch before it has ended. Crediting a finalized epoch would hand the whole carry
/// to whoever claimed last, purely for claiming late.
///
/// **The grace period is the same `ROLLOVER_DELAY_EPOCHS` a bribe rollover waits**, and for the
/// same reason: a slow LP must not be robbed of a claim that is still legitimately open.
///
/// **Draining is marked by settling, not by a flag.** Setting `osola_claimed = osola_allocated`
/// on the source leaves `remaining` at zero, so the residue can be recycled exactly once and a
/// later claim against that epoch finds an empty pot — which is precisely what the grace period
/// exists to make unlikely, and what it means for the epoch to be closed.
///
/// ⚠️ **Known limitation, not a defect.** The carry only becomes claimable when the destination
/// epoch is finalized, which needs votes. A pool that never receives another vote strands its
/// carry — but such a pool receives no emissions at all, so nothing that would otherwise have
/// been distributed is withheld. The oSOLA was never minted; it is not owed to anyone.
pub fn recycle_lp_emissions(
    ctx: Context<RecycleLpEmissions>,
    old_epoch: u64,
    new_epoch: u64,
) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );

    let clock = Clock::get()?;
    let curr_epoch = math::current_epoch(clock.unix_timestamp);
    require!(new_epoch == curr_epoch, SoladromeError::WrongEpoch);
    require!(old_epoch < curr_epoch, SoladromeError::EpochNotEnded);
    require!(
        curr_epoch >= old_epoch.saturating_add(ROLLOVER_DELAY_EPOCHS),
        SoladromeError::RolloverTooEarly
    );

    let src = &ctx.accounts.old_pool_epoch_accum;
    require!(src.finalized, SoladromeError::EpochNotFinalized);

    let residue = src.osola_allocated.saturating_sub(src.osola_claimed);
    require!(residue > 0, SoladromeError::NothingToClaim);

    // The destination must still be open. `emit_pool_rewards` cannot finalize an epoch that has
    // not ended, so for `new_epoch == curr_epoch` this holds by construction — asserted anyway,
    // because it is the property that makes crediting the carry fair rather than a race.
    require!(
        !ctx.accounts.new_pool_epoch_accum.finalized,
        SoladromeError::EpochAlreadyFinalized
    );

    ctx.accounts.new_pool_epoch_accum.carry_in = ctx
        .accounts
        .new_pool_epoch_accum
        .carry_in
        .checked_add(residue)
        .ok_or(SoladromeError::Overflow)?;

    // Settle the source: allocated == claimed leaves nothing to recycle or claim a second time.
    ctx.accounts.old_pool_epoch_accum.osola_claimed = src.osola_allocated;

    msg!(
        "Recycled {} oSOLA residue: pool {} epoch {} → epoch {}",
        residue,
        ctx.accounts.pool.key(),
        old_epoch,
        new_epoch,
    );
    Ok(())
}

/// Mint a user's pro-rata oSOLA share from LP emissions for a given pool+epoch.
/// Requires: epoch finalized, user checkpointed during epoch, not yet claimed.
pub fn claim_lp_emissions(ctx: Context<ClaimLpEmissions>, _epoch: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    let pa = &ctx.accounts.pool_epoch_accum;
    let ckpt = &ctx.accounts.lp_user_checkpoint;

    require!(pa.total_weighted_supply > 0, SoladromeError::NothingToClaim);
    require!(ckpt.weighted_balance > 0, SoladromeError::NothingToClaim);

    let share = (pa.osola_allocated as u128)
        .checked_mul(ckpt.weighted_balance)
        .ok_or(SoladromeError::Overflow)?
        .checked_div(pa.total_weighted_supply)
        .ok_or(SoladromeError::Overflow)? as u64;

    // Hard cap on the pot: whatever the weighted balances say, this (pool, epoch) can
    // never mint more than it was allocated. The pro-rata formula is only sound while
    // Σ user weights ≤ total_weighted_supply, and no single claim can check that — so
    // the ceiling is enforced on the running total instead.
    let remaining = pa.osola_allocated.saturating_sub(pa.osola_claimed);
    let user_osola = share.min(remaining);
    require!(user_osola > 0, SoladromeError::NothingToClaim);

    let bump = ctx.accounts.protocol_state.bump;
    let seeds = &[STATE_SEED, &[bump][..]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.o_sola_mint.to_account_info(),
                to: ctx.accounts.user_o_sola.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[seeds],
        ),
        user_osola,
    )?;

    ctx.accounts.pool_epoch_accum.osola_claimed = ctx
        .accounts
        .pool_epoch_accum
        .osola_claimed
        .checked_add(user_osola)
        .ok_or(SoladromeError::Overflow)?;

    // M-01 FIX: reset weighted_balance after a successful claim so that
    // checkpoint_lp for the next epoch does not overwrite unclaimed data.
    // Double-claim is still blocked by the LpEpochClaim PDA (init = fails if exists).
    ctx.accounts.lp_user_checkpoint.weighted_balance = 0;

    ctx.accounts.lp_epoch_claim.bump = ctx.bumps.lp_epoch_claim;
    Ok(())
}

/// Authority-only: reconfigure the epoch oSOLA emission decay curve.
///
/// Resets the decay clock to the current epoch — the new `initial` becomes
/// the emission for epoch 0 of the new schedule.  Use this to:
/// - Boost emissions at launch (high `initial`, soft `decay_bps`)
/// - Reduce emissions once pools are deep (lower `initial`)
/// - Adjust the floor to keep a minimum incentive long-term
///
/// `decay_bps` in [1, 10_000]:
///   10 000 = no decay (flat forever)
///    9 900 = −1 %/epoch  (−40 %/year)
///    9 800 = −2 %/epoch  (−65 %/year)
///
/// `floor_bps` in [0, 10_000]: minimum emission as % of `initial`.
///   1 000 = 10 % floor (recommended — never reaches zero).
pub fn configure_emissions(
    ctx: Context<ConfigureEmissions>,
    initial: u64,
    decay_bps: u16,
    floor_bps: u16,
) -> Result<()> {
    require!(initial > 0, SoladromeError::InvalidAmount);
    require!(
        (1..=10_000).contains(&decay_bps),
        SoladromeError::InvalidAmount
    );
    require!(floor_bps <= 10_000, SoladromeError::InvalidAmount);

    let clock = Clock::get()?;
    let s = &mut ctx.accounts.protocol_state;
    s.osola_emission_initial = initial;
    s.osola_emission_decay_bps = decay_bps;
    s.osola_emission_floor_bps = floor_bps;
    s.osola_emission_start_epoch = current_epoch(clock.unix_timestamp);

    msg!(
        "Emissions reconfigured: initial={} decay_bps={} floor_bps={} start_epoch={}",
        initial,
        decay_bps,
        floor_bps,
        s.osola_emission_start_epoch,
    );
    Ok(())
}

/// Authority-only: configure the continuous (Masterchef) oSOLA stream used to
/// bootstrap liquidity at launch. Sets the per-pool rate and an on-chain expiry
/// window of `duration_epochs` from the current epoch, after which emissions
/// auto-stop with no manual action. Only pools with `rewards_enabled = true`
/// (set via `set_pool_rewards`) actually accrue. Pass `rate_per_sec = 0` or
/// `duration_epochs = 0` to disable immediately.
pub fn configure_continuous_emissions(
    ctx: Context<ConfigureContinuousEmissions>,
    rate_per_sec: u64,
    duration_epochs: u64,
) -> Result<()> {
    // Storage is u32/u16 (carved from ProtocolState spare); validate ranges.
    require!(
        rate_per_sec <= u32::MAX as u64,
        SoladromeError::InvalidAmount
    );
    let clock = Clock::get()?;
    let cur = current_epoch(clock.unix_timestamp);
    let end_epoch = cur
        .checked_add(duration_epochs)
        .ok_or(SoladromeError::Overflow)?;
    require!(end_epoch <= u16::MAX as u64, SoladromeError::InvalidAmount);

    let s = &mut ctx.accounts.protocol_state;
    s.continuous_rate_per_sec = rate_per_sec as u32;
    s.continuous_end_epoch = end_epoch as u16;

    msg!(
        "Continuous emissions: rate_per_sec={} current_epoch={} end_epoch={} ({} epochs)",
        rate_per_sec,
        cur,
        end_epoch,
        duration_epochs,
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct CheckpointLp<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// Read-only — used only for the pause check.
    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(
        seeds = [b"amm_pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    #[account(constraint = lp_mint.key() == pool.lp_mint)]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(token::mint = lp_mint, token::authority = user)]
    pub user_lp: Box<Account<'info, TokenAccount>>,

    /// Program-recorded LP deposit for this (user, pool) — the reward basis, floored by
    /// `user_lp`. `init_if_needed` so a wallet that never provided liquidity can still call
    /// this: it lands on `lp_amount = 0` and banks no weight.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + LpUserInfo::LEN,
        seeds = [b"lp_user", pool.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub lp_user_info: Box<Account<'info, LpUserInfo>>,

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

    /// Read-only — used only for the pause check.
    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

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

/// Move a settled epoch's unclaimed LP emission residue into the pool's current epoch.
/// Permissionless — anyone may call it for any (pool, old_epoch) once the grace period is up.
#[derive(Accounts)]
#[instruction(old_epoch: u64, new_epoch: u64)]
pub struct RecycleLpEmissions<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    /// Read-only — used only for the pause check.
    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(
        seeds = [b"amm_pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, AmmPool>>,

    /// Source: the settled epoch whose pot was never fully claimed. The seeds pin it to this
    /// pool, so the caller cannot present another pool's richer accum.
    #[account(
        mut,
        seeds = [b"lp_pool_epoch", pool.key().as_ref(), old_epoch.to_le_bytes().as_ref()],
        bump = old_pool_epoch_accum.bump,
    )]
    pub old_pool_epoch_accum: Box<Account<'info, LpPoolEpochAccum>>,

    /// Destination: the current epoch's accum for the same pool. `init_if_needed` because the
    /// pool may not have been checkpointed yet this epoch — in which case only `carry_in` is
    /// written and the account stays blank for `emit_pool_rewards` to initialise properly.
    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + LpPoolEpochAccum::LEN,
        seeds = [b"lp_pool_epoch", pool.key().as_ref(), new_epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub new_pool_epoch_accum: Box<Account<'info, LpPoolEpochAccum>>,

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

    /// `mut`: the running `osola_claimed` total is what caps the pot.
    #[account(
        mut,
        seeds = [b"lp_pool_epoch", pool.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump = pool_epoch_accum.bump,
        constraint = pool_epoch_accum.finalized @ SoladromeError::EpochNotFinalized,
    )]
    pub pool_epoch_accum: Box<Account<'info, LpPoolEpochAccum>>,

    // M-01 FIX: mut so we can reset weighted_balance = 0 after claiming,
    // preventing a future checkpoint_lp call from silently discarding unclaimed data.
    #[account(
        mut,
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

/// Authority-only: update the epoch oSOLA emission decay curve parameters.
/// Resets the decay clock to the current epoch.
#[derive(Accounts)]
pub struct ConfigureEmissions<'info> {
    #[account(
        mut,
        address = protocol_state.authority @ SoladromeError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,
}

/// Authority-only: configure the continuous oSOLA bootstrap stream (rate + expiry).
#[derive(Accounts)]
pub struct ConfigureContinuousEmissions<'info> {
    #[account(
        mut,
        address = protocol_state.authority @ SoladromeError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,
}
