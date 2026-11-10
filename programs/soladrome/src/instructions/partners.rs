// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs

//! Protocol-partner deals: the signature bag, the escrowed bribe schedule, the LP escrow,
//! and the crank that credits each epoch the escrow covered.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, MintTo, Token, TokenAccount, Transfer};
use anchor_spl::token_interface::{
    self, Mint as MintInterface, TokenAccount as TokenAccountInterface, TokenInterface,
    TransferChecked,
};

// ☢️ The partner path is the one place where a third-party mint and a protocol mint move in the
// SAME instruction: `crank_partner_epoch` releases a bribe tranche (`bribe_mint`, possibly
// Token-2022) and mints SOLA backing for the retainer (always classic SPL Token). One
// `token_program` account cannot be both, so the context carries two — `bribe_token_program`
// for the escrow leg and `token_program` for the SOLA leg. Collapsing them would make every
// crank fail the moment a partner bribes in USDG.

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::math;
use crate::math::*;
use crate::state::*;
use crate::token_ext::require_supported_mint;

/// Authority-only: register a protocol partner — a closed deal (2026-11-09).
///
/// Two money terms, and a total known at signature: `base_hi_sola` (optional signature bag,
/// delivered whole once the bribe schedule is escrowed; 0 by default since every hiSOLA should
/// be earned) plus `retainer_per_epoch × schedule_epochs`, credited one full epoch at a time
/// while at least `lp_threshold` of `lp_mint` sits in the partner's LP escrow. After
/// `schedule_epochs` covered epochs the deal pays nothing more and the LP can leave.
///
/// Published tiers (in dollars of LP, degressive so one partner cannot take a disproportionate
/// share of fees and votes), the bag also bounded by the dollars of bribes escrowed:
/// $100K → 10 000 hiSOLA · $250K → 22 000 · $500K → 40 000 · $1M → 70 000, over 26 epochs.
///
/// `lp_threshold` is in LP base units. The tier is negotiated in dollars, the chain sees
/// only LP units and there is no oracle, so this is the unit count that matched the agreed
/// size on the day it was signed — imprecise on value, exact on "did they withdraw".
///
/// `lock_duration_secs` must be in [MIN_LOCK_DURATION, MAX_LOCK_DURATION].
/// Suggested mainnet value for strategic partners: 208 × 604 800 = 125 798 400 s
/// (≈ 4 years — the maximum lock, granting full 4× ve-power).
///
/// Nine arguments, over clippy's seven. They are the money terms of the deal and each one is
/// written verbatim into `PartnerAllocation`; folding them into a struct would move the same
/// nine fields behind one name, change the instruction's ABI, and buy nothing an auditor
/// reading the account layout does not already see.
#[allow(clippy::too_many_arguments)]
pub fn register_partner(
    ctx: Context<RegisterPartner>,
    bribe_mint: Pubkey,
    lp_mint: Pubkey,
    lp_threshold: u64,
    retainer_per_epoch: u64,
    base_hi_sola: u64,
    lock_duration_secs: u64,
    schedule_epochs: u64,
    min_bribe_per_epoch: u64,
) -> Result<()> {
    // A deal that pays nothing per epoch is not a retainer, and one with no liquidity
    // threshold is a retainer conditioned on nothing — which is the vesting this replaced.
    require!(retainer_per_epoch > 0, SoladromeError::InvalidAmount);
    require!(lp_threshold > 0, SoladromeError::InvalidAmount);
    // The bribe the partner commits to is the consideration for the bag. A zero floor would
    // let them escrow 52 epochs of one lamport and collect it.
    require!(min_bribe_per_epoch > 0, SoladromeError::InvalidAmount);
    // The rhythm is a term of the deal. 26 / 52 / 104 epochs are 6 months, a year, two
    // years; the ceiling matches the ve lock's so a schedule can never outrun the lock it
    // is paid under. Zero is rejected here — only legacy accounts read 0, and they read it
    // because the field did not exist when they were written.
    require!(
        schedule_epochs > 0 && schedule_epochs <= MAX_LOCK_DURATION / EPOCH_DURATION,
        SoladromeError::InvalidAmount
    );
    require!(
        bribe_mint != Pubkey::default(),
        SoladromeError::InvalidAmount
    );
    require!(lp_mint != Pubkey::default(), SoladromeError::InvalidAmount);
    require!(
        lock_duration_secs >= MIN_LOCK_DURATION,
        SoladromeError::InvalidAmount
    );
    require!(
        lock_duration_secs <= MAX_LOCK_DURATION,
        SoladromeError::InvalidAmount
    );

    let pa = &mut ctx.accounts.partner_allocation;
    pa.partner = ctx.accounts.partner_wallet.key();
    pa.bribe_mint = bribe_mint;
    pa.lp_mint = lp_mint;
    pa.lp_threshold = lp_threshold;
    pa.retainer_per_epoch = retainer_per_epoch;
    pa.lp_withdrawn_epoch = 0;
    pa.lp_qualified_since_ts = 0;
    pa.epochs_qualified = 0;
    pa.base_hi_sola = base_hi_sola;
    pa.hi_sola_claimed = 0;
    pa.lock_duration_secs = lock_duration_secs;
    pa.start_ts = Clock::get()?.unix_timestamp;
    pa.schedule_epochs = schedule_epochs;
    pa.min_bribe_per_epoch = min_bribe_per_epoch;
    pa.stream_start_ts = 0;
    pa.bag_claimed = false;
    pa.bump = ctx.bumps.partner_allocation;

    msg!(
        "Partner registered: {} | bribe_mint={} | bag={} hiSOLA | retainer={}/epoch | lock={}s",
        pa.partner,
        pa.bribe_mint,
        pa.base_hi_sola,
        pa.retainer_per_epoch,
        pa.lock_duration_secs,
    );
    msg!(
        "Liquidity condition: {} of {} | bribe schedule: {} epochs × {} min",
        pa.lp_threshold,
        pa.lp_mint,
        pa.schedule_epochs,
        pa.min_bribe_per_epoch
    );
    Ok(())
}

/// Partner claims their signature bag — once, whole, the moment the schedule is escrowed.
///
/// hiSOLA never touches the wallet: it is written straight into the ve lock as
/// `permanent_amount`, so it votes from day one (up to 4×), borrows at 20 % through
/// `borrow_against_locked`, and can never be unlocked, unstaked or sold. It is unfinanced —
/// no USDC ever entered the floor for it — and permanence is what keeps that exposure on
/// the 20 % channel instead of the 100 % one.
///
/// ⚠️ It used to stream linearly over six months and to carry the bribe-earned tranche
/// alongside it. Both are gone (2026-08-27): the bag is now the unconditional part of the
/// deal and nothing else, and what a partner earns for performing is the retainer, credited
/// epoch by epoch against their liquidity by `crank_partner_epoch`.
///
/// ☢️ It earns protocol fees, which it did not before. Locked for life means `hi_sola` is 0
/// and unfinanced means `staked_amount` is 0, so `fee_basis` was 0 and — the lock being
/// permanent — could never become anything else. `fee_shares` is the exception that makes
/// the tranche worth something, matched by an increment to `total_hi_sola` so the share is
/// real rather than printed.
pub fn claim_partner_allocation(ctx: Context<ClaimPartnerAllocation>) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    let pa = &ctx.accounts.partner_allocation;
    // ☢️ No stream, no bag. A zero stamp means the partner never escrowed a bribe schedule:
    // the bag is the consideration for that schedule, so it cannot precede it. Without this
    // a partner could register, never bribe a unit, and still hold permanent voting power
    // and a fee share the floor financed nothing for. Legacy allocations read 0 and fail
    // closed; funding the stream is the only thing that opens this.
    require!(
        pa.stream_start_ts != 0,
        SoladromeError::PartnerStreamNotFunded
    );
    require!(!pa.bag_claimed, SoladromeError::VestingFullyClaimed);
    let amount = pa.base_hi_sola;
    let lock_duration = pa.lock_duration_secs;
    require!(amount > 0, SoladromeError::NothingToClaim);

    // Snapshot accumulator BEFORE any hiSOLA supply change (same invariant as stake_sola).
    let market_balance = ctx.accounts.market_vault.amount;
    let acc = math::advance_accumulator(
        ctx.accounts.protocol_state.fees_per_hi_sola,
        market_balance,
        ctx.accounts.protocol_state.last_market_vault_balance,
        ctx.accounts.protocol_state.total_hi_sola,
    );

    // ── The lock term runs from the commitment, not from the claim ───────────
    //
    // Anchored on `stream_start_ts` — the moment the partner escrowed their schedule — and
    // never on `now`, which is what it used to be. Under the old multi-claim bag, `now +
    // duration` was reassigned on every call, so honouring a weekly schedule pushed the
    // unlock out weekly and dumping everything in week one released the locked tranche a
    // full `lock_duration` sooner. The instrument rewarded the one behaviour the gauges
    // least wanted. The bag is permanent now, so this only sets the floor under a term the
    // partner may extend, but the anchor stays honest.
    let lock_end_ts = (pa.stream_start_ts as u64)
        .checked_add(lock_duration)
        .ok_or(SoladromeError::Overflow)? as i64;

    let bump = ctx.accounts.protocol_state.bump;
    let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

    // ── Mint SOLA to sola_vault (1:1 backing for the hiSOLA) ─────────────
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.sola_mint.to_account_info(),
                to: ctx.accounts.sola_vault.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    // ── The hiSOLA is the lock entry below — it never becomes a balance ──
    // `user_position.hi_sola` stays 0 → borrow_usdc naturally blocked for lock duration.

    // ── Create / update VeLockPosition ────────────────────────────────────
    {
        let lock = &mut ctx.accounts.lock_position;
        if lock.owner == Pubkey::default() {
            lock.owner = ctx.accounts.partner.key();
            lock.bump = ctx.bumps.lock_position;
        }
        lock.amount_locked = lock
            .amount_locked
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;
        // ☢️ Never shorten an existing lock. This VeLockPosition is the same account
        // `lock_hi_sola` writes, so a partner who separately locked their own hiSOLA for
        // four years must not see that term cut to the partnership's when they claim a
        // tranche. Assigning outright was safe only while the value was always `now +
        // duration` and therefore always in the future; a fixed term is not, so the
        // monotonic guard becomes load-bearing here rather than decorative.
        if lock_end_ts > lock.lock_end_ts {
            lock.lock_end_ts = lock_end_ts;
        }

        // ── The bag is permanent, and adds to whatever is already permanent ──
        // Adding rather than assigning: the same VeLockPosition also carries the retainer
        // epochs, each of them permanent too. Assigning here — which was correct while the
        // bag was the only permanent portion and its vested figure only grew — would wipe
        // every retainer epoch credited before the partner got round to claiming the bag,
        // handing them back a releasable, sellable balance nobody financed.
        lock.permanent_amount = lock
            .permanent_amount
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;
    }

    // ── The bag earns fees ───────────────────────────────────────────────
    // See `UserPosition::credit_fee_shares` for why the debt is carried rather than
    // re-stamped: this position may already be accruing, and `fees_debt` is one scalar for
    // the whole basis.
    {
        let pos = &mut ctx.accounts.partner_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.partner.key();
            pos.bump = ctx.bumps.partner_position;
        }
        pos.credit_fee_shares(acc, amount)?;
    }

    // ── Update protocol state ─────────────────────────────────────────────
    // total_sola += amount     (SOLA backing added to sola_vault)
    // total_hi_sola += amount  — the counterpart of the fee_shares credit above. The share
    //   is real, not printed: existing holders are diluted by exactly what the partner
    //   receives, which is the honest way to pay someone out of the fee stream.
    let s = &mut ctx.accounts.protocol_state;
    s.fees_per_hi_sola = acc;
    s.last_market_vault_balance = market_balance;
    s.total_hi_sola = s
        .total_hi_sola
        .checked_add(amount)
        .ok_or(SoladromeError::Overflow)?;
    s.total_sola = s
        .total_sola
        .checked_add(amount)
        .ok_or(SoladromeError::Overflow)?;

    ctx.accounts.partner_allocation.bag_claimed = true;
    ctx.accounts.partner_allocation.hi_sola_claimed = ctx
        .accounts
        .partner_allocation
        .hi_sola_claimed
        .checked_add(amount)
        .ok_or(SoladromeError::Overflow)?;

    msg!(
        "Partner bag claimed: {} | +{} hiSOLA permanent, lock until {} | total {}",
        ctx.accounts.partner.key(),
        amount,
        lock_end_ts,
        ctx.accounts.partner_allocation.hi_sola_claimed,
    );
    Ok(())
}

/// Partner escrows a bribe schedule: one payment now, one tranche per epoch forever after.
///
/// This is the instruction that makes a partnership run on its own. `partner_deposit_bribe`
/// can only ever credit the epoch it is called in, so a year of weekly bribes was 52
/// signatures with a gap every time one was missed. Here the partner transfers
/// `epochs_total × amount_per_epoch` into an escrow the program controls, and
/// `release_partner_bribe` pays it out one epoch at a time, called by anyone.
///
/// ☢️ **Funding this is what starts the deal.** `stream_start_ts` is stamped on the
/// allocation here, and both `claim_partner_allocation` (the bag) and `crank_partner_epoch`
/// (the retainer) refuse to pay anything while it is zero. Before this existed the bag
/// accrued from registration for everyone, so a partner who never bribed a unit still
/// collected permanent voting power against a floor that funded it.
///
/// One *live* stream per partner. Re-funding is allowed only once the previous schedule has
/// paid out every tranche it was funded for — that is the renewal path, and it pairs with
/// `close_partner_allocation`: a settled deal closes, re-registers on new terms, and funds
/// a fresh schedule. Without it, a re-registered partner would find the stream PDA already
/// taken and their new welcome bag locked shut for good.
///
/// Topping a *running* stream is deliberately refused: `stream_start_ts` anchors the ve
/// lock term, and re-stamping it would let a partner push their own unlock date around at
/// will. A partner who wants to bribe beyond their commitment uses `deposit_bribe` like
/// anyone else — there is no ceiling on strengthening your own gauge, and since 2026-08-27
/// no allocation credit for doing so either.
pub fn fund_partner_bribe_stream(
    ctx: Context<FundPartnerBribeStream>,
    epochs_total: u64,
    amount_per_epoch: u64,
) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(
        ctx.accounts.protocol_state.bribes_enabled,
        SoladromeError::FeatureDisabled
    );
    require!(epochs_total > 0, SoladromeError::InvalidAmount);
    require!(amount_per_epoch > 0, SoladromeError::InvalidAmount);

    // Re-funding is the renewal path, and only from a spent schedule. A default `partner`
    // means the account was just created by `init_if_needed`; anything else is a stream
    // that already ran, and it may only be replaced once it has paid out in full.
    // Refusing a top-up mid-stream is what stops a partner re-stamping `stream_start_ts`
    // to restart their own welcome-bag vesting — and, now that the ve lock is anchored on
    // that stamp, to push their own unlock date around at will.
    {
        let prev = &ctx.accounts.bribe_stream;
        if prev.partner != Pubkey::default() {
            require_keys_eq!(
                prev.partner,
                ctx.accounts.partner.key(),
                SoladromeError::Unauthorized
            );
            require!(
                prev.epochs_released >= prev.epochs_total,
                SoladromeError::BribeStreamStillRunning
            );
        }
    }

    // The escrowed token ends up in a bribe pot like any other, so it faces the same
    // admission gate — a fee-skimming mint would under-fund every tranche it later releases.
    require_supported_mint(&ctx.accounts.bribe_mint)?;

    // Only the token the deal was written in credits the allocation, so escrowing anything
    // else would lock funds that `release_partner_bribe` could never pay out.
    require_keys_eq!(
        ctx.accounts.bribe_mint.key(),
        ctx.accounts.partner_allocation.bribe_mint,
        SoladromeError::BribeMintMismatch
    );

    // ── The schedule must be the one that was negotiated ────────────────────
    // Length is fixed at registration, so the partner confirms a rhythm rather than
    // choosing one. Legacy allocations carry 0 and are left free, since the field did not
    // exist when they were written and an upgrade must not strand them.
    let pa = &ctx.accounts.partner_allocation;
    if pa.schedule_epochs != 0 {
        require!(
            epochs_total == pa.schedule_epochs,
            SoladromeError::ScheduleLengthMismatch
        );
    }

    // ── And each tranche must be the size that was committed ────────────────
    // The escrow IS the commitment, and the bag is released against it, so a schedule of
    // the right length but a derisory size is not the deal. This replaces the old check —
    // "escrow enough that the bribes earn the whole `cap_hi_sola`" — which was arithmetic
    // on a 1:1 rate that no longer exists. Overshooting is fine and encouraged: extra
    // bribes pay voters in full and buy the partner nothing beyond the votes they attract,
    // which is the loop the match used to pay for twice.
    require!(
        amount_per_epoch >= pa.min_bribe_per_epoch,
        SoladromeError::ScheduleUnderfunded
    );

    let total = (epochs_total as u128)
        .checked_mul(amount_per_epoch as u128)
        .ok_or(SoladromeError::Overflow)?;
    require!(total <= u64::MAX as u128, SoladromeError::Overflow);
    let total = total as u64;

    // The whole schedule is escrowed up front. This is what the partner is actually
    // committing to, and it is why the bag can be released against it.
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.partner_token.to_account_info(),
                mint: ctx.accounts.bribe_mint.to_account_info(),
                to: ctx.accounts.stream_vault.to_account_info(),
                authority: ctx.accounts.partner.to_account_info(),
            },
        ),
        total,
        ctx.accounts.bribe_mint.decimals,
    )?;

    let now_ts = Clock::get()?.unix_timestamp;
    let s = &mut ctx.accounts.bribe_stream;
    s.partner = ctx.accounts.partner.key();
    s.bribe_mint = ctx.accounts.bribe_mint.key();
    s.pool_id = ctx.accounts.pool_id.key();
    s.amount_per_epoch = amount_per_epoch;
    s.epochs_total = epochs_total;
    s.epochs_released = 0;
    // Zero means "never released". Epoch 0 is 1970 and unreachable, so the first crank in
    // any real epoch passes the `last_release_epoch < epoch` guard.
    s.last_release_epoch = 0;
    s.start_ts = now_ts;
    s.bump = ctx.bumps.bribe_stream;

    // ☢️ The gate. Until this line runs for a partner, their welcome bag vests nothing.
    ctx.accounts.partner_allocation.stream_start_ts = now_ts;

    msg!(
        "Bribe stream funded: {} | {} × {} = {} (mint {}) | pool {} | bag vesting starts now",
        s.partner,
        epochs_total,
        amount_per_epoch,
        total,
        s.bribe_mint,
        s.pool_id,
    );
    Ok(())
}

/// Permissionless: run a partner's epoch — release their bribe tranche, and credit every
/// epoch their escrowed LP has covered and that has not been credited yet.
///
/// **The two halves are independently gated, on purpose.**
/// - The bribe tranche is escrowed money that already belongs to the gauge. It is released
///   whether or not the liquidity condition holds, one tranche per epoch, and it slips if an
///   epoch is missed.
/// - The bag half is a function of time since 2026-11-09 (`retainer_epochs_earned`): full
///   epochs covered by the LP escrow, capped at `schedule_epochs`. Nothing is attested at the
///   instant of the crank, so nothing can be gamed at that instant either — the old
///   add-liquidity / crank / remove-liquidity transaction earns nothing, because the LP cannot
///   leave the escrow and an epoch counts only once it has fully elapsed.
///
/// If neither half can do anything, the call fails rather than burning a fee for nothing.
pub fn crank_partner_epoch(ctx: Context<CrankPartnerEpoch>, epoch: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(
        ctx.accounts.protocol_state.bribes_enabled,
        SoladromeError::FeatureDisabled
    );

    let clock = Clock::get()?;
    require!(
        epoch == current_epoch(clock.unix_timestamp),
        SoladromeError::WrongEpoch
    );
    // No stream, no deal — the same gate the bag passes through. Nothing to release either,
    // since an unfunded stream holds nothing.
    require!(
        ctx.accounts.partner_allocation.stream_start_ts != 0,
        SoladromeError::PartnerStreamNotFunded
    );

    // ── Half one: the escrowed bribe tranche ────────────────────────────────
    // Unconditional on liquidity, and it slips: `last_release_epoch < epoch` allows at most
    // one tranche per epoch, and a missed epoch is paid next time rather than batched.
    // Batching would re-concentrate the bribes, which is the failure the escrow exists to
    // prevent.
    let stream = &ctx.accounts.bribe_stream;
    let bribe_due = stream.epochs_released < stream.epochs_total
        && stream.last_release_epoch < epoch
        && stream.amount_per_epoch > 0;

    if bribe_due {
        let amount = stream.amount_per_epoch;
        let partner_key = stream.partner;
        let stream_bump = stream.bump;

        // First-time vault init, mirroring deposit_bribe.
        if ctx.accounts.bribe_vault.pool_id == Pubkey::default() {
            ctx.accounts.bribe_vault.pool_id = ctx.accounts.pool_id.key();
            ctx.accounts.bribe_vault.reward_mint = ctx.accounts.reward_mint.key();
            ctx.accounts.bribe_vault.epoch = epoch;
            ctx.accounts.bribe_vault.bump = ctx.bumps.bribe_vault;
        }

        // Escrow → this epoch's bribe vault, signed by the stream PDA that owns the escrow.
        let seeds: &[&[u8]] = &[BRIBE_STREAM_SEED, partner_key.as_ref(), &[stream_bump]];
        // ☢️ `bribe_token_program`, not `token_program`: this leg moves the partner's own
        // token, which may be Token-2022, while the retainer leg below mints SOLA through
        // classic SPL Token. The two programs are distinct accounts for that reason.
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.bribe_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.stream_vault.to_account_info(),
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.bribe_token_vault.to_account_info(),
                    authority: ctx.accounts.bribe_stream.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.reward_mint.decimals,
        )?;

        ctx.accounts.bribe_vault.total_bribed = ctx
            .accounts
            .bribe_vault
            .total_bribed
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;

        let s = &mut ctx.accounts.bribe_stream;
        s.epochs_released = s
            .epochs_released
            .checked_add(1)
            .ok_or(SoladromeError::Overflow)?;
        s.last_release_epoch = epoch;

        msg!(
            "Bribe tranche {}/{}: +{} to epoch {}",
            s.epochs_released,
            s.epochs_total,
            amount,
            epoch,
        );
    }

    // ── Half two: every epoch the LP escrow has covered, not yet credited ────
    // Computed from time, not attested: the LP sits in a vault the partner cannot draw before
    // the term is over, so an epoch that started after `lp_qualified_since_ts` and ended
    // before now (or before the LP left) WAS covered, whoever cranks and whenever. That is why
    // a late crank pays the whole backlog at once instead of losing it.
    let pa = &ctx.accounts.partner_allocation;
    let earned = retainer_epochs_earned(pa, epoch);
    let due_epochs = earned.saturating_sub(pa.epochs_qualified as u64);
    let retainer_due = due_epochs > 0 && pa.retainer_per_epoch > 0;

    require!(bribe_due || retainer_due, SoladromeError::NothingToCrank);

    if retainer_due {
        let amount = pa
            .retainer_per_epoch
            .checked_mul(due_epochs)
            .ok_or(SoladromeError::Overflow)?;
        let lock_end_ts = (pa.stream_start_ts as u64)
            .checked_add(pa.lock_duration_secs)
            .ok_or(SoladromeError::Overflow)? as i64;

        // Snapshot the accumulator before any hiSOLA supply change (stake_sola invariant).
        let market_balance = ctx.accounts.market_vault.amount;
        let acc = math::advance_accumulator(
            ctx.accounts.protocol_state.fees_per_hi_sola,
            market_balance,
            ctx.accounts.protocol_state.last_market_vault_balance,
            ctx.accounts.protocol_state.total_hi_sola,
        );

        let bump = ctx.accounts.protocol_state.bump;
        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

        // SOLA backing, 1:1, locked in sola_vault — as for every other hiSOLA grant.
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.sola_mint.to_account_info(),
                    to: ctx.accounts.sola_vault.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        // Permanent, like the bag: this epoch was never financed through the curve, so it
        // must never become a spendable balance that `sell_sola` could redeem against a
        // floor it did not fund. It votes and earns fees; it never borrows (unfinanced).
        {
            let lock = &mut ctx.accounts.lock_position;
            if lock.owner == Pubkey::default() {
                lock.owner = ctx.accounts.partner.key();
                lock.bump = ctx.bumps.lock_position;
            }
            lock.amount_locked = lock
                .amount_locked
                .checked_add(amount)
                .ok_or(SoladromeError::Overflow)?;
            lock.permanent_amount = lock
                .permanent_amount
                .checked_add(amount)
                .ok_or(SoladromeError::Overflow)?;
            // Never shorten a lock this partner may have set for longer themselves.
            if lock_end_ts > lock.lock_end_ts {
                lock.lock_end_ts = lock_end_ts;
            }
        }

        {
            let pos = &mut ctx.accounts.partner_position;
            if pos.owner == Pubkey::default() {
                pos.owner = ctx.accounts.partner.key();
                pos.bump = ctx.bumps.partner_position;
            }
            pos.credit_fee_shares(acc, amount)?;
        }

        let s = &mut ctx.accounts.protocol_state;
        s.fees_per_hi_sola = acc;
        s.last_market_vault_balance = market_balance;
        // The counterpart of the fee_shares credit: a real share, taken from the existing
        // holders in exactly the amount the partner receives, not printed alongside theirs.
        s.total_hi_sola = s
            .total_hi_sola
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;
        s.total_sola = s
            .total_sola
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;

        let pa = &mut ctx.accounts.partner_allocation;
        pa.epochs_qualified =
            u32::try_from(earned).map_err(|_| error!(SoladromeError::Overflow))?;
        pa.hi_sola_claimed = pa
            .hi_sola_claimed
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;

        msg!(
            "Partner {}: +{} hiSOLA permanent for {} epoch(s) | {}/{} epochs | total {}",
            pa.partner,
            amount,
            due_epochs,
            pa.epochs_qualified,
            pa.schedule_epochs,
            pa.hi_sola_claimed,
        );
    }

    Ok(())
}

/// Authority-only: close a `PartnerAllocation` PDA and return its rent to the authority
/// that paid for it at `register_partner`.
///
/// Closable when the deal owes nothing and holds nothing:
///
/// 1. **Never activated** (`stream_start_ts == 0`) — no schedule, no bag, and no LP (the
///    escrow only opens after the schedule is funded). This is what keeps a mistyped
///    registration correctable.
/// 2. Or **settled**: the bag claimed (or none), the bribe escrow spent, the LP escrow empty,
///    and every epoch it covered credited. The last two are what stop the authority deleting
///    a deal that still holds a partner's liquidity or owes them an epoch.
///
/// ⚠️ Closing frees the `[b"partner", partner_wallet]` seeds, so `register_partner` can open
/// the same PDA again with every counter at zero — a fresh deal, including a fresh bag. That
/// is the renewal path. The partner's `VeLockPosition` and `UserPosition` are untouched:
/// everything already credited stays locked, keeps voting, keeps earning fees.
///
/// Not pause-gated, matching `register_partner`: this is admin cleanup that moves no tokens.
pub fn close_partner_allocation(ctx: Context<ClosePartnerAllocation>) -> Result<()> {
    let pa = &ctx.accounts.partner_allocation;
    let epoch = current_epoch(Clock::get()?.unix_timestamp);

    let never_activated = pa.stream_start_ts == 0;
    let bag_settled = pa.bag_claimed || pa.base_hi_sola == 0;
    // ☢️ Read whether or not the deal was activated: an LP left in an escrow whose allocation
    // is gone could never be withdrawn — `withdraw_partner_lp` needs the allocation.
    let lp_returned = lp_balance_of(&ctx.accounts.partner_lp_vault)? == 0;
    let credits_settled = retainer_epochs_earned(pa, epoch) <= pa.epochs_qualified as u64;
    let escrow_spent = stream_is_spent(&ctx.accounts.bribe_stream)?;

    require!(lp_returned, SoladromeError::PartnerLpNotReturned);
    require!(
        never_activated || (bag_settled && credits_settled && escrow_spent),
        SoladromeError::PartnerAllocationNotSettled
    );

    msg!(
        "Partner allocation closed: {} | {} hiSOLA over {} epochs | bag {} | reason={}",
        pa.partner,
        pa.hi_sola_claimed,
        pa.epochs_qualified,
        if pa.bag_claimed { "claimed" } else { "none" },
        if never_activated {
            "never activated"
        } else {
            "settled"
        },
    );
    Ok(())
}

/// How many epochs of the deal the LP escrow has paid for so far, capped at the term.
///
/// An epoch counts when it STARTED at or after `lp_qualified_since_ts` (so the liquidity was
/// there all seven days) and has ENDED — before `now_epoch`, or before the epoch the LP left
/// in, whichever comes first. 0 for a deal whose escrow never reached the threshold, and for a
/// legacy deal with no term (`schedule_epochs == 0`): fail closed, never open.
pub fn retainer_epochs_earned(pa: &PartnerAllocation, now_epoch: u64) -> u64 {
    if pa.lp_qualified_since_ts <= 0 {
        return 0;
    }
    let since = pa.lp_qualified_since_ts as u64;
    // ceil(since / D): the first epoch that starts at or after the deposit.
    let first_full = since.saturating_add(EPOCH_DURATION - 1) / EPOCH_DURATION;
    let end = if pa.lp_withdrawn_epoch != 0 {
        pa.lp_withdrawn_epoch.min(now_epoch)
    } else {
        now_epoch
    };
    end.saturating_sub(first_full).min(pa.schedule_epochs)
}

/// Partner locks LP of the deal's pool in the protocol's escrow. Top-ups allowed until the deal
/// is over. The clock starts the first time the escrow holds `lp_threshold`, and the first
/// epoch that counts is the next one to start.
///
/// ⚠️ The partner should `claim_lp_rewards` first: LP emissions are paid on the wallet balance,
/// so LP moved into the escrow stops earning them, and an unclaimed accrual is lost at the next
/// harvest. The bag is what replaces them.
pub fn deposit_partner_lp(ctx: Context<DepositPartnerLp>, amount: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(amount > 0, SoladromeError::InvalidAmount);
    let pa = &ctx.accounts.partner_allocation;
    // The deal starts with the bribes. Locking liquidity for a schedule that does not exist
    // would earn nothing and only strand the LP.
    require!(
        pa.stream_start_ts != 0,
        SoladromeError::PartnerStreamNotFunded
    );
    require!(pa.lp_withdrawn_epoch == 0, SoladromeError::PartnerDealOver);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.partner_lp_token.to_account_info(),
                to: ctx.accounts.partner_lp_vault.to_account_info(),
                authority: ctx.accounts.partner.to_account_info(),
            },
        ),
        amount,
    )?;
    ctx.accounts.partner_lp_vault.reload()?;

    let escrowed = ctx.accounts.partner_lp_vault.amount;
    let pa = &mut ctx.accounts.partner_allocation;
    if pa.lp_qualified_since_ts == 0 && escrowed >= pa.lp_threshold {
        pa.lp_qualified_since_ts = Clock::get()?.unix_timestamp;
    }
    msg!(
        "Partner LP escrowed: {} | +{} | {} / {} | qualified since {}",
        pa.partner,
        amount,
        escrowed,
        pa.lp_threshold,
        pa.lp_qualified_since_ts,
    );
    Ok(())
}

/// Partner takes their whole LP back out of the escrow and the deal stops earning.
///
/// Allowed only when nothing more can be earned by staying, or the partner was never in:
/// - the term is over — `schedule_epochs` full epochs covered;
/// - or the escrow never reached `lp_threshold` (nothing started);
/// - or the protocol is paused — the one exit that does not wait, so an incident never traps a
///   partner's liquidity. Epochs already covered stay earned; the rest of the term is forfeit.
///
/// The epoch it leaves in is frozen into `lp_withdrawn_epoch`, so a crank afterwards still
/// pays exactly the epochs that were covered, and the deal cannot take liquidity again.
pub fn withdraw_partner_lp(ctx: Context<WithdrawPartnerLp>) -> Result<()> {
    let now_epoch = current_epoch(Clock::get()?.unix_timestamp);
    let pa = &ctx.accounts.partner_allocation;
    let never_qualified = pa.lp_qualified_since_ts == 0;
    let term_over = retainer_epochs_earned(pa, now_epoch) >= pa.schedule_epochs;
    require!(
        never_qualified || term_over || ctx.accounts.protocol_state.paused,
        SoladromeError::PartnerLpLocked
    );

    let amount = ctx.accounts.partner_lp_vault.amount;
    let bump = ctx.accounts.protocol_state.bump;
    let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
    if amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.partner_lp_vault.to_account_info(),
                    to: ctx.accounts.partner_lp_token.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
    }
    // Rent back to the partner, who paid it at the first deposit.
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.partner_lp_vault.to_account_info(),
            destination: ctx.accounts.partner.to_account_info(),
            authority: ctx.accounts.protocol_state.to_account_info(),
        },
        &[seeds],
    ))?;

    let pa = &mut ctx.accounts.partner_allocation;
    if !never_qualified {
        // `max(1)`: epoch 0 is the sentinel for "still escrowed", and is 1970 anyway.
        pa.lp_withdrawn_epoch = now_epoch.max(1);
    }
    msg!(
        "Partner LP returned: {} | {} LP | {} epochs earned of {}",
        pa.partner,
        amount,
        retainer_epochs_earned(pa, now_epoch),
        pa.schedule_epochs,
    );
    Ok(())
}

/// An SPL token account's balance, or 0 when the account does not exist yet.
///
/// A partner who never provided liquidity has no LP token account at all, and a typed
/// `Account<TokenAccount>` cannot express "may be absent" — it fails at the account level, which
/// would make exactly the partners with no liquidity the ones who could not be closed. Absent
/// means a balance of zero, which is the honest reading and the one that lets the close proceed.
///
/// Safe to be lenient here **only because the caller cannot choose which account this is**: the
/// context pins it to the partner's associated token account for the deal's LP mint. Without
/// that pin, an authority could present any uninitialised account to force a balance of 0 and
/// close a partner who was still qualifying.
fn lp_balance_of(info: &AccountInfo) -> Result<u64> {
    // Not a live SPL token account: uninitialised accounts are owned by the System Program.
    if info.owner != &anchor_spl::token::ID {
        return Ok(0);
    }
    let data = info.try_borrow_data()?;
    // 165 — the fixed SPL token account size. Written out rather than pulled through the `Pack`
    // trait, which would need importing solely for this constant.
    if data.len() != 165 {
        return Ok(0);
    }
    // SPL token layout: mint(32) · owner(32) · amount(8) at offset 64.
    Ok(u64::from_le_bytes(
        data[64..72]
            .try_into()
            .map_err(|_| error!(SoladromeError::Overflow))?,
    ))
}

/// Whether a partner's escrowed bribe schedule has paid out every tranche it was funded for —
/// `true` when the stream account does not exist, since an unfunded schedule owes nothing.
fn stream_is_spent(info: &AccountInfo) -> Result<bool> {
    if info.owner != &crate::ID {
        return Ok(true);
    }
    let data = info.try_borrow_data()?;
    if data.len() < 8 + PartnerBribeStream::LEN {
        return Ok(true);
    }
    if &data[..8] != PartnerBribeStream::DISCRIMINATOR {
        return Ok(true);
    }
    let stream = PartnerBribeStream::try_deserialize(&mut &data[..])?;
    Ok(stream.epochs_released >= stream.epochs_total)
}

/// The partner must later call `claim_partner_allocation` to lock their hiSOLA.
#[derive(Accounts)]
pub struct RegisterPartner<'info> {
    #[account(
        mut,
        address = protocol_state.authority @ SoladromeError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    /// CHECK: The partner's beneficiary wallet — identity enforced by PDA seeds.
    pub partner_wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + PartnerAllocation::LEN,
        seeds = [PARTNER_SEED, partner_wallet.key().as_ref()],
        bump,
    )]
    pub partner_allocation: Account<'info, PartnerAllocation>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Partner claims their one-time hiSOLA allocation.
///
/// Two halves, and only one of them is a token: SOLA equal to the bag is minted to
/// `sola_vault` as its 1:1 backing, while the hiSOLA side is a ledger credit added to
/// `VeLockPosition.amount_locked` and to `permanent_amount` (added, never assigned — the same
/// position carries the retainer epochs). `UserPosition.hi_sola` stays 0, so the bag never
/// becomes a spendable balance and `borrow_usdc` sees nothing to lend against; the 20 %
/// `borrow_against_locked` valve is the only channel. The bag also earns protocol fees via
/// `credit_fee_shares`, matched by a `total_hi_sola` increment so the share is real rather
/// than printed.
#[derive(Accounts)]
pub struct ClaimPartnerAllocation<'info> {
    #[account(mut)]
    pub partner: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    /// Locked SOLA backing — 1 SOLA minted here per hiSOLA allocated.
    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only snapshot for the fee accumulator advance.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// Partner's allocation PDA — verified by seeds + owner constraint.
    #[account(
        mut,
        seeds = [PARTNER_SEED, partner.key().as_ref()],
        bump = partner_allocation.bump,
        constraint = partner_allocation.partner == partner.key() @ SoladromeError::Unauthorized,
    )]
    pub partner_allocation: Box<Account<'info, PartnerAllocation>>,

    /// Ve lock metadata — created on first claim.
    #[account(
        init_if_needed,
        payer = partner,
        space = 8 + VeLockPosition::LEN,
        seeds = [VELOCK_SEED, partner.key().as_ref()],
        bump,
    )]
    pub lock_position: Box<Account<'info, VeLockPosition>>,

    /// Fee-share position — fees_debt snapshotted at claim so the partner starts
    /// earning fees only from `unlock_hi_sola` forward (not during the lock).
    #[account(
        init_if_needed,
        payer = partner,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, partner.key().as_ref()],
        bump,
    )]
    pub partner_position: Box<Account<'info, UserPosition>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Partner escrows their whole bribe schedule in one signature.
#[derive(Accounts)]
pub struct FundPartnerBribeStream<'info> {
    #[account(mut)]
    pub partner: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// Stamped with `stream_start_ts` here — this is what opens the welcome bag.
    #[account(
        mut,
        seeds = [PARTNER_SEED, partner.key().as_ref()],
        bump = partner_allocation.bump,
        constraint = partner_allocation.partner == partner.key() @ SoladromeError::Unauthorized,
    )]
    pub partner_allocation: Box<Account<'info, PartnerAllocation>>,

    /// CHECK: The gauge this stream will feed, fixed for its lifetime. Label only, exactly as
    /// on `deposit_bribe` — bribe vaults are keyed by it and nothing dereferences it.
    pub pool_id: UncheckedAccount<'info>,

    pub bribe_mint: Box<InterfaceAccount<'info, MintInterface>>,

    #[account(mut, token::mint = bribe_mint, token::authority = partner)]
    pub partner_token: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    #[account(
        init_if_needed,
        payer = partner,
        space = 8 + PartnerBribeStream::LEN,
        seeds = [BRIBE_STREAM_SEED, partner.key().as_ref()],
        bump,
    )]
    pub bribe_stream: Box<Account<'info, PartnerBribeStream>>,

    /// The escrow itself, owned by the stream PDA so only `release_partner_bribe` can move it.
    #[account(
        init_if_needed,
        payer = partner,
        token::mint = bribe_mint,
        token::authority = bribe_stream,
        seeds = [STREAM_TOKENS_SEED, partner.key().as_ref()],
        bump,
    )]
    pub stream_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Serves `bribe_mint` — the only token this instruction moves.
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Anyone runs a partner's epoch: one bribe tranche into this epoch's vault, and every epoch
/// the LP escrow has covered that is not yet credited.
#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct CrankPartnerEpoch<'info> {
    /// Keeper, voter, partner, anyone — pays the rent for a first-time bribe vault, and for the
    /// partner's lock/position PDAs if the retainer is the first thing to open them.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// CHECK: The stream's beneficiary. Never signs here; identity is enforced by the seeds
    /// of both PDAs below and re-asserted against the stored `partner` fields.
    pub partner: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [BRIBE_STREAM_SEED, partner.key().as_ref()],
        bump = bribe_stream.bump,
        constraint = bribe_stream.partner == partner.key() @ SoladromeError::Unauthorized,
        // The gauge and the token are fixed at funding time. Binding them here is what stops a
        // caller redirecting someone else's escrowed bribes to a pool of their own choosing.
        constraint = bribe_stream.pool_id == pool_id.key() @ SoladromeError::Unauthorized,
        constraint = bribe_stream.bribe_mint == reward_mint.key() @ SoladromeError::BribeMintMismatch,
    )]
    pub bribe_stream: Box<Account<'info, PartnerBribeStream>>,

    #[account(
        mut,
        seeds = [PARTNER_SEED, partner.key().as_ref()],
        bump = partner_allocation.bump,
        constraint = partner_allocation.partner == partner.key() @ SoladromeError::Unauthorized,
    )]
    pub partner_allocation: Box<Account<'info, PartnerAllocation>>,

    #[account(
        mut,
        seeds = [STREAM_TOKENS_SEED, partner.key().as_ref()],
        bump,
    )]
    pub stream_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// CHECK: Bribe label, as everywhere else in this system.
    pub pool_id: UncheckedAccount<'info>,

    pub reward_mint: Box<InterfaceAccount<'info, MintInterface>>,

    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + BribeVault::LEN,
        seeds = [b"bribe_vault", pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub bribe_vault: Box<Account<'info, BribeVault>>,

    #[account(
        init_if_needed,
        payer = caller,
        token::mint = reward_mint,
        token::authority = bribe_vault,
        token::token_program = bribe_token_program,
        seeds = [b"bribe_tokens", pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub bribe_token_vault: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    // ── The bag half (no LP account: credits are a function of time) ────────────
    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    /// Locked SOLA backing — 1 SOLA minted here per hiSOLA of retainer.
    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only snapshot for the fee accumulator advance.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// The partner's ve lock — each qualified epoch is added to it, permanently.
    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + VeLockPosition::LEN,
        seeds = [VELOCK_SEED, partner.key().as_ref()],
        bump,
    )]
    pub lock_position: Box<Account<'info, VeLockPosition>>,

    /// The partner's fee position — `fee_shares` grows one retainer epoch at a time.
    #[account(
        init_if_needed,
        payer = caller,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, partner.key().as_ref()],
        bump,
    )]
    pub partner_position: Box<Account<'info, UserPosition>>,

    /// Serves `reward_mint` — the partner's bribe token, classic SPL Token or Token-2022.
    pub bribe_token_program: Interface<'info, TokenInterface>,
    /// Serves SOLA and the LP mint, both always classic SPL Token.
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Authority reclaims the rent of a terminal `PartnerAllocation`.
/// Moves no tokens and touches no other PDA — see `close_partner_allocation` for the two
/// states this is allowed in, and for why re-registering the same wallet is a fresh deal.
#[derive(Accounts)]
pub struct ClosePartnerAllocation<'info> {
    /// Receives the reclaimed rent — the same account that paid it at `register_partner`.
    #[account(
        mut,
        address = protocol_state.authority @ SoladromeError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    /// CHECK: The partner's beneficiary wallet — identity enforced by the PDA seeds below
    /// and re-asserted against the stored `partner` field. Never signs, never receives.
    pub partner_wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        close = authority,
        seeds = [PARTNER_SEED, partner_wallet.key().as_ref()],
        bump = partner_allocation.bump,
        constraint = partner_allocation.partner == partner_wallet.key() @ SoladromeError::Unauthorized,
    )]
    pub partner_allocation: Account<'info, PartnerAllocation>,

    /// CHECK: The partner's LP escrow, read to refuse a close while it still holds liquidity.
    /// Untyped because most closes find it absent (never deposited, or already withdrawn —
    /// `withdraw_partner_lp` closes it), and pinned by seeds so the authority cannot present an
    /// empty account in its place.
    #[account(seeds = [PARTNER_LP_SEED, partner_wallet.key().as_ref()], bump)]
    pub partner_lp_vault: UncheckedAccount<'info>,

    /// CHECK: The partner's escrowed bribe schedule, if they ever funded one. Read to refuse a
    /// close while tranches remain: `crank_partner_epoch` needs the allocation, so closing early
    /// would strand money the partner has already paid in and the gauge's voters are owed.
    /// Untyped for the same reason as above — most allocations have no stream account.
    #[account(seeds = [BRIBE_STREAM_SEED, partner_wallet.key().as_ref()], bump)]
    pub bribe_stream: UncheckedAccount<'info>,
}

/// Partner moves LP into the deal's escrow.
#[derive(Accounts)]
pub struct DepositPartnerLp<'info> {
    #[account(mut)]
    pub partner: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(
        mut,
        seeds = [PARTNER_SEED, partner.key().as_ref()],
        bump = partner_allocation.bump,
        constraint = partner_allocation.partner == partner.key() @ SoladromeError::Unauthorized,
    )]
    pub partner_allocation: Box<Account<'info, PartnerAllocation>>,

    /// The LP mint named in the deal — nothing else can be escrowed against it.
    #[account(address = partner_allocation.lp_mint @ SoladromeError::LpMintMismatch)]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = lp_mint, token::authority = partner)]
    pub partner_lp_token: Box<Account<'info, TokenAccount>>,

    /// The escrow: owned by `protocol_state`, so only this program moves it, and only
    /// `withdraw_partner_lp` moves it out — to the partner.
    #[account(
        init_if_needed,
        payer = partner,
        token::mint = lp_mint,
        token::authority = protocol_state,
        seeds = [PARTNER_LP_SEED, partner.key().as_ref()],
        bump,
    )]
    pub partner_lp_vault: Box<Account<'info, TokenAccount>>,

    /// Protocol LP mints are always classic SPL Token.
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Partner takes their LP back once the deal's term is over.
#[derive(Accounts)]
pub struct WithdrawPartnerLp<'info> {
    #[account(mut)]
    pub partner: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(
        mut,
        seeds = [PARTNER_SEED, partner.key().as_ref()],
        bump = partner_allocation.bump,
        constraint = partner_allocation.partner == partner.key() @ SoladromeError::Unauthorized,
    )]
    pub partner_allocation: Box<Account<'info, PartnerAllocation>>,

    #[account(address = partner_allocation.lp_mint @ SoladromeError::LpMintMismatch)]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = lp_mint, token::authority = partner)]
    pub partner_lp_token: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = lp_mint,
        token::authority = protocol_state,
        seeds = [PARTNER_LP_SEED, partner.key().as_ref()],
        bump,
    )]
    pub partner_lp_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
