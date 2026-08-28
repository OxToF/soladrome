// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Gauge voting: casting, replaying, configuring, and buying votes with oSOLA.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::instructions::ve;
use crate::math;
use crate::math::*;
use crate::state::*;

/// hiSOLA holder directs vote-weight at a pool gauge for the current epoch.
/// Total allocated across all pools ≤ raw hiSOLA + ve-weighted locked hiSOLA.
/// One UserVoteReceipt per (user, pool, epoch) — double-vote for same pool is blocked.
pub fn vote_gauge(ctx: Context<VoteGauge>, epoch: u64, votes: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(
        ctx.accounts.protocol_state.voting_enabled,
        SoladromeError::FeatureDisabled
    );
    require!(votes > 0, SoladromeError::InvalidAmount);
    let clock = Clock::get()?;
    require!(
        epoch == current_epoch(clock.unix_timestamp),
        SoladromeError::WrongEpoch
    );

    // Founder break-glass: the founder stake is a dormant anti-capture reserve
    // and cannot vote unless authority has explicitly enabled it.
    require!(
        ctx.accounts.user.key() != ctx.accounts.protocol_state.founder_wallet
            || ctx.accounts.protocol_state.founder_voting_enabled,
        SoladromeError::FounderVotingDisabled
    );

    // Total power = unlocked hiSOLA (1×) + ve-weighted locked hiSOLA (up to 4×).
    //
    // ☢️ This read is the one the ledger model exists for. Under the token model the power
    // came from a token balance and `staked_amount` was never consulted, so hiSOLA bought
    // on a secondary market voted at full weight while owing nothing to the floor: buy at
    // a discount, vote, collect the bribes, sell. Dormant on devnet only for want of a
    // hiSOLA pool — never closed. `hi_sola` cannot be acquired from anyone; the only ways
    // in are `stake_sola` (financed) and `unlock_hi_sola` (an allocation the protocol
    // itself granted), so voting power now belongs to whoever the protocol says it does.
    let hi_sola_balance = ctx.accounts.user_position.hi_sola;
    let ve_power = ve::try_load_ve_power(
        &ctx.accounts.lock_position,
        &ctx.accounts.user.key(),
        clock.unix_timestamp,
    );
    let total_power = hi_sola_balance.saturating_add(ve_power);

    // Init UserEpochVotes on first vote — snapshot total_power as the epoch-wide cap.
    // Snapshotting here stops a user voting with a lock, letting it expire, then voting
    // again on a fresh balance that exceeds the original cap. The snapshot is immutable
    // once set; subsequent votes check against it, not live power.
    //
    // The duplication it could never stop — move the balance to a fresh wallet, which
    // gets its own snapshot and votes the same stake again while the first wallet's
    // `init`-created receipt still counts — is gone with transferability itself.
    if ctx.accounts.user_epoch_votes.epoch == 0 {
        ctx.accounts.user_epoch_votes.epoch = epoch;
        ctx.accounts.user_epoch_votes.total_power_snapshot = total_power;
        ctx.accounts.user_epoch_votes.ve_power_snapshot = ve_power;
        ctx.accounts.user_epoch_votes.bump = ctx.bumps.user_epoch_votes;
    }

    // ── 30% per-address cap applies only to hiSOLA governance power ─────
    // The oSOLA burn bonus is added on top of the capped hiSOLA portion, for the current
    // epoch only. It is NOT unbounded, and the bound is not here:
    // `lock_vote_backing` below requires `new_total - ve_power_snapshot <= hi_sola` and
    // has no bonus term, so the real ceiling on a wallet's cumulative votes is
    // `hi_sola + ve_power_snapshot` — the power it held before burning anything.
    //
    // So the bonus buys exactly one thing: the ground the 30% global cap took away,
    // never more. Once `total_hi_sola` is large enough that the global cap stops binding,
    // it buys nothing at all. `burn_o_sola_for_votes` refuses a burn beyond that usable
    // margin rather than destroying oSOLA for votes that could never be cast; the
    // arithmetic is spelled out there, and pinned in tests/bankrun_osola_bonus.ts.
    let hi_sola_cap = ctx.accounts.user_epoch_votes.total_power_snapshot;
    let o_sola_bonus = ctx.accounts.user_epoch_votes.o_sola_bonus;

    let global_cap = ctx
        .accounts
        .protocol_state
        .total_hi_sola
        .saturating_mul(VOTE_WEIGHT_CAP_BPS)
        / 10_000;
    let effective_hi_sola = hi_sola_cap.min(global_cap);

    // Total power = capped hiSOLA portion + uncapped oSOLA burn bonus
    let power_cap = effective_hi_sola.saturating_add(o_sola_bonus);

    let already_allocated = ctx.accounts.user_epoch_votes.allocated;
    let new_total = already_allocated
        .checked_add(votes)
        .ok_or(SoladromeError::Overflow)?;
    require!(new_total <= power_cap, SoladromeError::VoteOverflow);

    // Immobilise the backing stake before any tally is written.
    if ctx.accounts.user_position.owner == Pubkey::default() {
        ctx.accounts.user_position.owner = ctx.accounts.user.key();
        ctx.accounts.user_position.bump = ctx.bumps.user_position;
        // SECURITY: stamp the accumulator, exactly as stake_sola / unstake_hi_sola /
        // borrow_usdc do when they lazily open a position. Without it the position is
        // born with `fees_debt = 0` and `claim_fees` reads this wallet as having been
        // staked since genesis. The accumulator is deliberately NOT persisted here (nor
        // is last_market_vault_balance touched): we only need the highest value it could
        // legitimately hold right now, so that nothing accrued before this moment is
        // claimable. Same treatment as borrow_usdc.
        ctx.accounts.user_position.fees_debt = math::advance_accumulator(
            ctx.accounts.protocol_state.fees_per_hi_sola,
            ctx.accounts.market_vault.amount,
            ctx.accounts.protocol_state.last_market_vault_balance,
            ctx.accounts.protocol_state.total_hi_sola,
        );
    }
    lock_vote_backing(
        &mut ctx.accounts.user_position,
        new_total,
        ctx.accounts.user_epoch_votes.ve_power_snapshot,
        epoch,
    )?;

    // Init GaugeState if first vote for this pool this epoch
    if ctx.accounts.gauge_state.pool_id == Pubkey::default() {
        ctx.accounts.gauge_state.pool_id = ctx.accounts.pool_id.key();
        ctx.accounts.gauge_state.epoch = epoch;
        ctx.accounts.gauge_state.bump = ctx.bumps.gauge_state;
    }
    ctx.accounts.gauge_state.total_votes = ctx
        .accounts
        .gauge_state
        .total_votes
        .checked_add(votes)
        .ok_or(SoladromeError::Overflow)?;

    // Record vote receipt (init enforces one-shot per pool per epoch)
    ctx.accounts.user_vote_receipt.user = ctx.accounts.user.key();
    ctx.accounts.user_vote_receipt.pool_id = ctx.accounts.pool_id.key();
    ctx.accounts.user_vote_receipt.epoch = epoch;
    ctx.accounts.user_vote_receipt.votes = votes;
    ctx.accounts.user_vote_receipt.bump = ctx.bumps.user_vote_receipt;

    // Persist allocation counter
    ctx.accounts.user_epoch_votes.allocated = new_total;

    // Update global vote total (denominator for LP emissions)
    let gev = &mut ctx.accounts.global_epoch_votes;
    if gev.epoch == 0 {
        gev.epoch = epoch;
        gev.bump = ctx.bumps.global_epoch_votes;
    }
    gev.total_votes = gev
        .total_votes
        .checked_add(votes)
        .ok_or(SoladromeError::Overflow)?;

    Ok(())
}

/// Permissionless epoch vote carry-over for one pool entry.
///
/// Reproduces a single `vote_gauge` call using the owner's saved config.
/// The CALLER signs and pays rent; the OWNER's hiSOLA balance and ve-power
/// determine the actual vote weight — the owner need not be online.
///
/// Call once per pool entry per epoch (up to `config.n_pools` times).
/// Fails if `auto_replay = false` (`VoteConfigDisabled`).
/// Fails if `pool_id` not found in config (`PoolNotInConfig`).
/// Fails if `UserVoteReceipt` already exists — same double-vote guard as
/// `vote_gauge`; replay and manual vote for the same pool are mutually exclusive.
///
/// The 30% anti-whale cap applies identically to `vote_gauge`.
pub fn replay_vote(ctx: Context<ReplayVote>, epoch: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    // Phase gate: replay_vote casts REAL gauge votes (gauge_state.total_votes,
    // global_epoch_votes, UserVoteReceipt), so it must honor the same
    // voting_enabled gate as vote_gauge — otherwise the closed-launch "voting
    // disabled" window is bypassable through a saved auto-replay config.
    require!(
        ctx.accounts.protocol_state.voting_enabled,
        SoladromeError::FeatureDisabled
    );
    let clock = Clock::get()?;
    require!(
        epoch == current_epoch(clock.unix_timestamp),
        SoladromeError::WrongEpoch
    );
    require!(
        ctx.accounts.vote_config.auto_replay,
        SoladromeError::VoteConfigDisabled
    );
    // Founder break-glass guard (mirror of vote_gauge) — prevents replaying
    // founder votes through a saved config while founder voting is disabled.
    require!(
        ctx.accounts.user.key() != ctx.accounts.protocol_state.founder_wallet
            || ctx.accounts.protocol_state.founder_voting_enabled,
        SoladromeError::FounderVotingDisabled
    );

    // Locate pool_id in config
    let pool_key = ctx.accounts.pool_id.key();
    let n = ctx.accounts.vote_config.n_pools as usize;
    let pool_idx = ctx.accounts.vote_config.pools[..n]
        .iter()
        .position(|p| p == &pool_key)
        .ok_or(SoladromeError::PoolNotInConfig)?;
    let pool_bps = ctx.accounts.vote_config.bps[pool_idx] as u128;

    // Compute voting power — same formula and same source as vote_gauge. A recurring
    // voter's balance simply stays on their position from one epoch to the next.
    let hi_sola_balance = ctx.accounts.user_position.hi_sola;
    let ve_power = ve::try_load_ve_power(
        &ctx.accounts.lock_position,
        &ctx.accounts.user.key(),
        clock.unix_timestamp,
    );
    let total_power = hi_sola_balance.saturating_add(ve_power);

    // Init UserEpochVotes on first vote this epoch (snapshot total_power)
    if ctx.accounts.user_epoch_votes.epoch == 0 {
        ctx.accounts.user_epoch_votes.epoch = epoch;
        ctx.accounts.user_epoch_votes.total_power_snapshot = total_power;
        ctx.accounts.user_epoch_votes.ve_power_snapshot = ve_power;
        ctx.accounts.user_epoch_votes.bump = ctx.bumps.user_epoch_votes;
    }

    // Apply 30% per-address cap on hiSOLA portion (oSOLA bonus stays uncapped)
    let snapshot = ctx.accounts.user_epoch_votes.total_power_snapshot;
    let o_sola_bonus = ctx.accounts.user_epoch_votes.o_sola_bonus;
    let global_cap = ctx
        .accounts
        .protocol_state
        .total_hi_sola
        .saturating_mul(VOTE_WEIGHT_CAP_BPS)
        / 10_000;
    let effective_snapshot = snapshot.min(global_cap);
    let power_cap = effective_snapshot.saturating_add(o_sola_bonus);

    // Votes for this pool = effective_snapshot × bps / 10 000
    let votes = (effective_snapshot as u128)
        .checked_mul(pool_bps)
        .ok_or(SoladromeError::Overflow)?
        .checked_div(10_000)
        .ok_or(SoladromeError::Overflow)? as u64;
    require!(votes > 0, SoladromeError::InvalidAmount);

    // Overflow / cap check
    let already_allocated = ctx.accounts.user_epoch_votes.allocated;
    let new_total = already_allocated
        .checked_add(votes)
        .ok_or(SoladromeError::Overflow)?;
    require!(new_total <= power_cap, SoladromeError::VoteOverflow);

    // Same vote lock as vote_gauge. The replay cannot move anything — there is nothing to
    // move — and fails with InsufficientVoteBacking if the owner's balance no longer
    // covers the weight their config asks for (e.g. they unstaked since).
    if ctx.accounts.user_position.owner == Pubkey::default() {
        ctx.accounts.user_position.owner = ctx.accounts.user.key();
        ctx.accounts.user_position.bump = ctx.bumps.user_position;
        // SECURITY: same accumulator stamp as vote_gauge — a position opened by a replay
        // must not be born claiming the whole fee history either. Unreachable in practice
        // (a position with no balance backs no votes), but the stamp costs nothing.
        ctx.accounts.user_position.fees_debt = math::advance_accumulator(
            ctx.accounts.protocol_state.fees_per_hi_sola,
            ctx.accounts.market_vault.amount,
            ctx.accounts.protocol_state.last_market_vault_balance,
            ctx.accounts.protocol_state.total_hi_sola,
        );
    }
    lock_vote_backing(
        &mut ctx.accounts.user_position,
        new_total,
        ctx.accounts.user_epoch_votes.ve_power_snapshot,
        epoch,
    )?;

    // Init GaugeState if first vote for this pool this epoch
    if ctx.accounts.gauge_state.pool_id == Pubkey::default() {
        ctx.accounts.gauge_state.pool_id = pool_key;
        ctx.accounts.gauge_state.epoch = epoch;
        ctx.accounts.gauge_state.bump = ctx.bumps.gauge_state;
    }
    ctx.accounts.gauge_state.total_votes = ctx
        .accounts
        .gauge_state
        .total_votes
        .checked_add(votes)
        .ok_or(SoladromeError::Overflow)?;

    // Write UserVoteReceipt (init = replay-proof, one per pool per epoch)
    ctx.accounts.user_vote_receipt.user = ctx.accounts.user.key();
    ctx.accounts.user_vote_receipt.pool_id = pool_key;
    ctx.accounts.user_vote_receipt.epoch = epoch;
    ctx.accounts.user_vote_receipt.votes = votes;
    ctx.accounts.user_vote_receipt.bump = ctx.bumps.user_vote_receipt;

    ctx.accounts.user_epoch_votes.allocated = new_total;

    // Init / update GlobalEpochVotes
    if ctx.accounts.global_epoch_votes.epoch == 0 {
        ctx.accounts.global_epoch_votes.epoch = epoch;
        ctx.accounts.global_epoch_votes.bump = ctx.bumps.global_epoch_votes;
    }
    ctx.accounts.global_epoch_votes.total_votes = ctx
        .accounts
        .global_epoch_votes
        .total_votes
        .checked_add(votes)
        .ok_or(SoladromeError::Overflow)?;

    Ok(())
}

/// Save or update the caller's persistent gauge vote allocation.
///
/// Once `auto_replay = true`, any external caller (keeper, cron bot, partner)
/// can invoke `replay_vote` each epoch without the owner signing — enabling
/// fully passive bribe collection, identical to Beradrome/Velodrome behaviour.
///
/// Constraints:
/// - `n_pools` in [1, 5]
/// - `bps[0..n_pools]` must sum to exactly 10 000 (100 %)
/// - Unused slots: `pools[i] = Pubkey::default()`, `bps[i] = 0`
pub fn set_vote_config(
    ctx: Context<SetVoteConfig>,
    pools: [Pubkey; 5],
    bps: [u16; 5],
    n_pools: u8,
    auto_replay: bool,
) -> Result<()> {
    require!(
        n_pools >= 1 && n_pools as usize <= UserVoteConfig::MAX_POOLS,
        SoladromeError::InvalidVoteConfig
    );
    let total_bps: u32 = bps[..n_pools as usize].iter().map(|&b| b as u32).sum();
    require!(total_bps == 10_000, SoladromeError::InvalidVoteConfig);

    let cfg = &mut ctx.accounts.vote_config;
    if cfg.bump == 0 {
        cfg.bump = ctx.bumps.vote_config;
    }
    cfg.pools = pools;
    cfg.bps = bps;
    cfg.n_pools = n_pools;
    cfg.auto_replay = auto_replay;
    Ok(())
}

/// Burn oSOLA to gain additional voting power for the current epoch.
///
/// Unlike hiSOLA (which gives permanent voting rights + fees + borrow),
/// burning oSOLA grants **epoch-scoped** vote weight only — it resets
/// with every new epoch (new UserEpochVotes PDA).
///
/// The oSOLA bonus is NOT subject to the 30% per-address cap:
/// burning tokens is a permanent, deflationary act that justifies
/// uncapped influence for that epoch.
///
/// Conversion: 1 oSOLA (6 dec) = 1 vote unit (same as 1 hiSOLA).
pub fn burn_o_sola_for_votes(
    ctx: Context<BurnOSolaForVotes>,
    amount: u64,
    epoch: u64,
) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    // Founder break-glass: mirrors vote_gauge / replay_vote. Without this, the
    // founder's 5M oSOLA would be an UNCAPPED vote path (the oSOLA bonus bypasses
    // the per-address cap by design), defeating the muzzle on the 7M reserve.
    require!(
        ctx.accounts.user.key() != ctx.accounts.protocol_state.founder_wallet
            || ctx.accounts.protocol_state.founder_voting_enabled,
        SoladromeError::FounderVotingDisabled
    );
    // Phase gate: banking oSOLA-bonus voting power only has meaning once votes
    // can be cast, and burning is irreversible — block it while voting is
    // closed so a user can't destroy oSOLA for power they can't yet use.
    require!(
        ctx.accounts.protocol_state.voting_enabled,
        SoladromeError::FeatureDisabled
    );
    require!(amount > 0, SoladromeError::InvalidAmount);
    let clock = Clock::get()?;
    require!(
        epoch == current_epoch(clock.unix_timestamp),
        SoladromeError::WrongEpoch
    );

    // Snapshot governance power BEFORE mutably borrowing the tracker, mirroring
    // vote_gauge. Without this, burning oSOLA before the first vote_gauge call
    // would leave total_power_snapshot at 0 — zeroing the user's hiSOLA vote cap
    // for the epoch (the vote_gauge init block is skipped once uev.epoch != 0).
    // Reads the ledger balance, like vote_gauge. The old token read here omitted the
    // escrowed portion entirely, so burning oSOLA after having voted snapshotted a
    // hiSOLA power of nearly zero for the rest of the epoch; there is no second place
    // for the balance to be any more, so the discrepancy goes away with the token.
    let hi_sola_balance = ctx.accounts.user_position.hi_sola;
    let ve_power = ve::try_load_ve_power(
        &ctx.accounts.lock_position,
        &ctx.accounts.user.key(),
        clock.unix_timestamp,
    );
    let total_power = hi_sola_balance.saturating_add(ve_power);

    // ── Refuse a burn that could not buy a single vote ───────────────────
    //
    // The burn is irreversible and this instruction used to accept any amount, but the
    // limit that decides whether the bonus is usable lives in ANOTHER instruction:
    // `lock_vote_backing`, called from `vote_gauge`, requires
    // `new_total - ve_power_snapshot <= hi_sola` and has no bonus term. So a wallet's
    // cumulative votes can never exceed `hi_sola + ve_power`, whatever it burns, and
    // every oSOLA burned past that ceiling was destroyed for nothing.
    //
    // The usable margin is the gap the 30% global cap opens below that ceiling:
    //
    //     usable = (hi_sola + ve_power) - min(power_snapshot, global_cap)
    //
    // and it is 0 whenever the global cap is slack — which is the steady state of a
    // protocol with enough stakers. This instruction therefore refuses most calls once
    // the protocol has grown, by design: the bonus is a launch-phase mechanic, and
    // failing loudly is the point. Do NOT "fix" this by silently burning only the usable
    // part — burning an amount the caller did not ask for is its own surprise on an
    // irreversible operation.
    //
    // Snapshots are read as they will stand AFTER this call, so the first burn of an
    // epoch is measured against the values it is about to write, not against zeros.
    let (power_snapshot, ve_snapshot) = if ctx.accounts.user_epoch_votes.epoch == 0 {
        (total_power, ve_power)
    } else {
        (
            ctx.accounts.user_epoch_votes.total_power_snapshot,
            ctx.accounts.user_epoch_votes.ve_power_snapshot,
        )
    };
    let global_cap = ctx
        .accounts
        .protocol_state
        .total_hi_sola
        .saturating_mul(VOTE_WEIGHT_CAP_BPS)
        / 10_000;
    let ceiling = hi_sola_balance.saturating_add(ve_snapshot);
    let usable = ceiling.saturating_sub(power_snapshot.min(global_cap));
    let new_bonus = ctx
        .accounts
        .user_epoch_votes
        .o_sola_bonus
        .checked_add(amount)
        .ok_or(SoladromeError::Overflow)?;
    require!(new_bonus <= usable, SoladromeError::BurnBuysNoVotes);

    // Burn the oSOLA — permanent, irreversible. Everything that could refuse has
    // refused by now, so nothing below this line may fail on a recoverable condition.
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Burn {
                mint: ctx.accounts.o_sola_mint.to_account_info(),
                from: ctx.accounts.user_o_sola.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // Credit voting power for this epoch only.
    let uev = &mut ctx.accounts.user_epoch_votes;
    if uev.epoch == 0 {
        uev.epoch = epoch;
        uev.bump = ctx.bumps.user_epoch_votes;
        uev.total_power_snapshot = total_power;
        // Stamping `epoch` here disarms the `if epoch == 0` init block in `vote_gauge`
        // and `replay_vote` for the rest of the epoch, so this is the ONLY chance to
        // record the ve half. Omitting it left `ve_power_snapshot` at 0, and
        // `lock_vote_backing` then demanded liquid hiSOLA for the ve-funded part of the
        // vote too: a locker who burned before voting lost their entire ve credit, and
        // one holding nothing but a lock could not vote at all. Pinned in
        // tests/bankrun_osola_bonus.ts.
        uev.ve_power_snapshot = ve_power;
    }
    uev.o_sola_bonus = new_bonus;

    Ok(())
}

/// Immobilise the hiSOLA backing a user's cumulative vote allocation for this epoch.
///
/// Shared by `vote_gauge` and `replay_vote` so the two can never drift apart — they cast
/// identical weight through different entry points and must lock identical backing.
///
/// Only the portion of `new_total` exceeding the frozen ve snapshot is recorded: ve power is
/// already immobilised in its own lock position, and counting it twice would make voting cost
/// more balance than the voter has.
///
/// This used to be a custody transfer into an escrow vault, because a `require!` could not
/// stop a holder simply moving the tokens to another wallet. A ledger balance has nowhere to
/// go, so the same guarantee is now a number that `unstake_hi_sola` and `lock_hi_sola` check
/// — one write instead of a vault, a top-up transfer and a release instruction.
///
/// Note the consequence on the permissionless `replay_vote` path: a replay can raise the
/// caller's own lock on the OWNER's balance, which the old custody version could not do (only
/// the owner's signature could move their tokens). That is a lock, never a transfer, it lasts
/// one epoch, and it is exactly what the owner asked for by setting `auto_replay` — but it is
/// a real widening, so it is stated rather than left to be discovered.
fn lock_vote_backing(
    user_position: &mut UserPosition,
    new_total: u64,
    ve_power_snapshot: u64,
    epoch: u64,
) -> Result<()> {
    let required = new_total.saturating_sub(ve_power_snapshot);
    require!(
        user_position.hi_sola >= required,
        SoladromeError::InsufficientVoteBacking
    );

    // Never lower an existing lock within the same epoch: `vote_gauge` is cumulative, so
    // `required` only grows, but `replay_vote` computes its weight from a config that the
    // owner can change mid-epoch. Taking the maximum keeps a shrinking allocation from
    // freeing stake that votes already cast this epoch still stand on.
    let standing = if user_position.vote_lock_epoch == epoch {
        user_position.vote_locked
    } else {
        0
    };
    user_position.vote_locked = required.max(standing);
    // Stamp every vote, including those that add no backing: re-voting the same weight in a
    // later epoch must still extend the lock, otherwise the stake becomes withdrawable while
    // the freshly cast votes are live.
    user_position.vote_lock_epoch = epoch;
    Ok(())
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

    /// Read-only. Needed to stamp `fees_debt` at the live accumulator when this instruction
    /// is what first opens the caller's UserPosition — see the security note in the body.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// Carries the caller's hiSOLA balance (base vote power) and takes the vote lock on it.
    /// There is no hiSOLA mint, ATA or escrow vault in this context any more: the balance
    /// being voted lives here, and voting marks it rather than moving it.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

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

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Permissionless carry-over: any caller replays one pool vote for the owner.
/// Caller pays rent; vote weight is derived from the owner's live hiSOLA position.
#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct ReplayVote<'info> {
    /// Keeper, partner bot, or the owner themselves — pays rent for new PDAs.
    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: The hiSOLA holder whose config is being replayed.
    pub user: UncheckedAccount<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// Read-only. Needed to stamp `fees_debt` at the live accumulator when a replay is what
    /// first opens the owner's UserPosition — see the security note in the body.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: Optional VeLockPosition [b"velock", user].
    /// Pass SystemProgram when owner has no lock.
    pub lock_position: UncheckedAccount<'info>,

    /// Owner's position — the source of their hiSOLA balance, and where the replay writes
    /// the vote lock. Pinned to `user` by seeds, so a caller cannot replay one wallet's
    /// config against another wallet's balance.
    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    /// Owner's persistent vote config — must have auto_replay = true.
    #[account(
        seeds = [VOTE_CONFIG_SEED, user.key().as_ref()],
        bump = vote_config.bump,
    )]
    pub vote_config: Box<Account<'info, UserVoteConfig>>,

    /// CHECK: Pool being voted for — validated against config in instruction body.
    pub pool_id: UncheckedAccount<'info>,

    /// Aggregate votes for this pool this epoch.
    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + GaugeState::LEN,
        seeds = [b"gauge", pool_id.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub gauge_state: Box<Account<'info, GaugeState>>,

    /// One receipt per (user, pool, epoch) — init fails on double-vote.
    /// Mutually exclusive with a manual vote_gauge for the same pool/epoch.
    #[account(
        init,
        payer = caller,
        space = 8 + UserVoteReceipt::LEN,
        seeds = [b"vote", user.key().as_ref(), pool_id.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub user_vote_receipt: Box<Account<'info, UserVoteReceipt>>,

    /// Cumulative allocation tracker for the owner this epoch.
    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + UserEpochVotes::LEN,
        seeds = [b"uev", user.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub user_epoch_votes: Box<Account<'info, UserEpochVotes>>,

    /// Global vote total — denominator for LP emission splits.
    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + GlobalEpochVotes::LEN,
        seeds = [b"epoch_votes", epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub global_epoch_votes: Box<Account<'info, GlobalEpochVotes>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Owner creates or updates their persistent vote allocation.
/// Called once to set up carry-over; update any time preferences change.
#[derive(Accounts)]
pub struct SetVoteConfig<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserVoteConfig::LEN,
        seeds = [VOTE_CONFIG_SEED, user.key().as_ref()],
        bump,
    )]
    pub vote_config: Account<'info, UserVoteConfig>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Burn oSOLA to gain epoch-scoped voting power.
/// Seeds for user_epoch_votes: [b"uev", user, epoch_le8] — same as vote_gauge.
/// The o_sola_bonus field on UserEpochVotes is credited here.
#[derive(Accounts)]
#[instruction(amount: u64, epoch: u64)]
pub struct BurnOSolaForVotes<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// Read-only — used for pause check and o_sola_mint address.
    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// The oSOLA mint — needed for the burn CPI.
    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Box<Account<'info, Mint>>,

    /// User's oSOLA token account — tokens are burned from here.
    #[account(
        mut,
        token::mint      = o_sola_mint,
        token::authority = user,
    )]
    pub user_o_sola: Box<Account<'info, TokenAccount>>,

    /// Caller's hiSOLA balance — snapshotted as the epoch vote cap if this is
    /// the first instruction to init UserEpochVotes (mirrors vote_gauge).
    ///
    /// Read-only: burning oSOLA buys a bonus that is additive and uncapped, and it never
    /// touches the hiSOLA balance, so this instruction takes no vote lock.
    ///
    /// Required to exist rather than `init_if_needed`, deliberately. Every route to a hiSOLA
    /// balance now goes through an instruction that creates this account, so anyone with
    /// power to snapshot already has one; opening a position here would only add the
    /// unstamped-`fees_debt` variant that `vote_gauge` guards against, on a path that gains
    /// nothing from it. A caller with no position burns nothing and keeps their oSOLA.
    #[account(
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump = user_position.bump,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    /// CHECK: Optional VeLockPosition [b"velock", user].
    /// Pass any account (e.g. SystemProgram) when not using a ve lock.
    /// If valid and unexpired, adds ve-weighted power to the snapshot.
    pub lock_position: UncheckedAccount<'info>,

    /// Epoch vote tracker — created on first burn if it doesn't exist yet.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserEpochVotes::LEN,
        seeds = [b"uev", user.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub user_epoch_votes: Box<Account<'info, UserEpochVotes>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
