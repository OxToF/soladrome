// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! SOLA ↔ hiSOLA and the protocol-fee accumulator.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, Mint, Token, TokenAccount, Transfer},
};

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::math;
use crate::state::*;

// Lock SOLA → credit hiSOLA 1:1 (governance + fee share + borrow rights).
// hiSOLA is a ledger balance on UserPosition, not a token: nothing is minted and there is
// nothing to transfer away. Sets fees_debt to the current accumulator so the new stake
// does not claim past fees.
pub fn stake_sola(ctx: Context<StakeSola>, sola_amount: u64) -> Result<()> {
    require!(
        !ctx.accounts.protocol_state.paused,
        SoladromeError::ProtocolPaused
    );
    require!(sola_amount > 0, SoladromeError::InvalidAmount);

    // Snapshot accumulator before staking so new hiSOLA only earns future fees.
    let market_balance = ctx.accounts.market_vault.amount;
    let acc = math::advance_accumulator(
        ctx.accounts.protocol_state.fees_per_hi_sola,
        market_balance,
        ctx.accounts.protocol_state.last_market_vault_balance,
        ctx.accounts.protocol_state.total_hi_sola,
    );

    let bump = ctx.accounts.protocol_state.bump;
    let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

    // Pre-credit hiSOLA balance — basis for harvesting fees already accrued on the
    // user's EXISTING stake, read before the credit below moves it.
    let old_balance = ctx.accounts.user_position.hi_sola;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_sola.to_account_info(),
                to: ctx.accounts.sola_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        sola_amount,
    )?;

    // ── Auto-harvest pending fees BEFORE moving fees_debt forward ─────────
    // Without this, an existing staker who adds more SOLA would silently
    // forfeit the fees already accrued on `old_balance` (they would be
    // redistributed to other stakers when fees_debt jumps to `acc`). This
    // mirrors the Masterchef pattern already used by unstake_hi_sola and
    // lock_hi_sola. A freshly-created position has no accrued fees.
    let pending = {
        let position = &mut ctx.accounts.user_position;
        let is_new = position.owner == Pubkey::default();
        if is_new {
            position.owner = ctx.accounts.user.key();
            position.bump = ctx.bumps.user_position;
        }
        // `fees_debt` jumps to `acc` on the next line, so anything not credited here is
        // forfeited to the other stakers — hence the harvest. A voter topping up their
        // stake must not pay for having voted, and does not: voting immobilises the
        // balance without moving it, so `old_balance` already includes it.
        let pending = if is_new {
            0
        } else {
            // `staked_amount` is still the pre-stake figure here: this harvest settles
            // what the OLD position earned, before the new deposit is recorded below.
            let basis = math::fee_basis(position.staked_amount, old_balance, position.fee_shares);
            math::pending_fees(acc, position.fees_debt, basis)
        };
        // Entry/exit point: debt = current accumulator (no retroactive claim).
        position.fees_debt = acc;
        // Credit the position itself — this IS the hiSOLA. No mint, no ATA.
        position.hi_sola = position
            .hi_sola
            .checked_add(sola_amount)
            .ok_or(SoladromeError::Overflow)?;
        // Record the financed deposit separately: `borrow_usdc` caps against it, and it
        // is what tells stake bought through the curve apart from hiSOLA released by an
        // expired ve lock, which was never financed.
        position.staked_amount = position
            .staked_amount
            .checked_add(sola_amount)
            .ok_or(SoladromeError::Overflow)?;
        pending
    };

    if pending > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            pending,
        )?;
    }

    let s = &mut ctx.accounts.protocol_state;
    s.fees_per_hi_sola = acc;
    // Subtract any auto-paid fees so they are not double-credited to the
    // remaining stakers on the next accumulator advance (same as unstake).
    s.last_market_vault_balance = market_balance.saturating_sub(pending);
    s.total_hi_sola = s
        .total_hi_sola
        .checked_add(sola_amount)
        .ok_or(SoladromeError::Overflow)?;
    Ok(())
}

// Debit hiSOLA → unlock SOLA. Blocked if remaining collateral < debt, or if the balance
// still backs votes cast in the running epoch.
pub fn unstake_hi_sola(ctx: Context<UnstakeHiSola>, hi_sola_amount: u64) -> Result<()> {
    require!(hi_sola_amount > 0, SoladromeError::InvalidAmount);
    let bump = ctx.accounts.protocol_state.bump;

    // ── Advance accumulator before reducing total_hi_sola ────────────────
    // Without this, fees earned while more stakers were active would be
    // diluted when calculated against the post-unstake supply.
    // SECURITY: acc must be computed BEFORE the position init block so that a
    // freshly-created position has fees_debt = acc → pending = 0, preventing a
    // retroactive market_vault drain.
    let market_balance = ctx.accounts.market_vault.amount;
    let acc = math::advance_accumulator(
        ctx.accounts.protocol_state.fees_per_hi_sola,
        market_balance,
        ctx.accounts.protocol_state.last_market_vault_balance,
        ctx.accounts.protocol_state.total_hi_sola,
    );

    if ctx.accounts.user_position.owner == Pubkey::default() {
        ctx.accounts.user_position.owner = ctx.accounts.user.key();
        ctx.accounts.user_position.bump = ctx.bumps.user_position;
        // Snapshot the current accumulator so a position opened here cannot claim fees
        // that accrued before its first protocol interaction. A fresh position holds no
        // hiSOLA, so this call goes on to fail on `balance >= hi_sola_amount` — the stamp
        // is kept because the position outlives the failed instruction only if some other
        // path created it, and being born unstamped is the defect.
        ctx.accounts.user_position.fees_debt = acc;
    }

    let balance = ctx.accounts.user_position.hi_sola;
    require!(balance >= hi_sola_amount, SoladromeError::InvalidAmount);
    let remaining = balance - hi_sola_amount;
    require!(
        ctx.accounts.user_position.usdc_borrowed <= remaining,
        SoladromeError::OutstandingDebt
    );

    // ── The stake you voted with stays until the epoch ends ───────────────
    // Under the token model this was a custody transfer into an escrow vault, because a
    // `require!` here could not stop the holder simply transferring the tokens to another
    // wallet and unstaking there. A ledger balance cannot leave, so the rule is now the
    // subtraction it always meant to be. A stamp from an earlier epoch is spent: the votes
    // it backed are closed and their receipts immutable.
    let vote_locked = ctx
        .accounts
        .user_position
        .vote_locked_now(Clock::get()?.unix_timestamp);
    require!(remaining >= vote_locked, SoladromeError::VoteEscrowLocked);

    // ── Founder vesting lock — defence in depth, and no longer cfg-gated ─────────────
    //
    // This was the ONLY piece of security logic that differed between the devnet and the
    // mainnet build (`#[cfg(not(feature = "devnet"))]`): the binary under test contained
    // a hole the shipped binary did not, and the shipped binary contained a guard nobody
    // had ever executed. Both halves of that are now gone — one build, one behaviour.
    //
    // ⚠️ It was also WRONG, and the cfg is why nobody hit it. The old form compared
    // `vesting.claimed` — up to 7 000 000 once the tranche is claimed — against the
    // founder's whole `hi_sola`, which normally holds nothing but SOLA they bought
    // through the curve like any other user. `balance - amount >= 7M` is false for every
    // amount, so on mainnet the founder could not have unstaked a single unit of their
    // OWN financed stake for the entire two-year vest.
    //
    // The corrected rule compares like with like: the schedule bounds only UNFINANCED
    // hiSOLA. `staked_amount` is incremented solely by `stake_sola` (bought through the
    // curve, so its USDC is in the floor) and never by `unlock_hi_sola`, so
    // `hi_sola - staked_amount` is exactly the unfinanced portion. Unstaking decrements
    // both by the same amount, which leaves that difference untouched while financed
    // stake is being withdrawn — so the founder can always exit their own money, and only
    // the unfinanced part is held against the clock.
    //
    // Why keep it at all, given the reserve cannot reach this balance today?
    // `claim_founder_hi_sola` credits `VeLockPosition.amount_locked` and leaves
    // `user_position.hi_sola` at 0, and `unlock_hi_sola` refuses the founder outright, so
    // the 7M has no route here. That containment lives in ONE `require!` in another
    // instruction. This is the second line: if that one is ever relaxed, the tranche
    // arrives as unfinanced hiSOLA and meets a schedule instead of an open door.
    if ctx.accounts.user.key() == ctx.accounts.protocol_state.founder_wallet {
        // SECURITY: `founder_hi_vesting` is an UncheckedAccount, so its data is NOT
        // validated by Anchor. A manual `try_deserialize` only checks the discriminator —
        // NOT the owner — so without the two guards below the founder could pass a forged
        // account (owned by a program they deploy) carrying the FounderHiSolaVesting
        // discriminator with `claimed = 0`, making `locked = 0` and bypassing the lock
        // entirely. Pin it to the canonical PDA and require this program owns it before
        // trusting a single byte.
        let (expected_vesting, _) =
            Pubkey::find_program_address(&[FOUNDER_HI_VESTING_SEED], &crate::ID);
        require_keys_eq!(
            ctx.accounts.founder_hi_vesting.key(),
            expected_vesting,
            SoladromeError::Unauthorized
        );
        require!(
            ctx.accounts.founder_hi_vesting.owner == &crate::ID,
            SoladromeError::Unauthorized
        );
        let vesting_data = ctx.accounts.founder_hi_vesting.try_borrow_data()?;
        let vesting = FounderHiSolaVesting::try_deserialize(&mut &vesting_data[..])?;
        let clock = Clock::get()?;
        let elapsed = ((clock.unix_timestamp - vesting.start_ts).max(0)) as u64;
        let max_unlocked = if elapsed >= VESTING_DURATION_SECS {
            vesting.total_amount
        } else {
            (vesting.total_amount as u128)
                .checked_mul(elapsed as u128)
                .ok_or(SoladromeError::Overflow)?
                .checked_div(VESTING_DURATION_SECS as u128)
                .ok_or(SoladromeError::Overflow)? as u64
        };
        // The claimed tranche that the schedule has not released yet.
        let still_locked = vesting.claimed.saturating_sub(max_unlocked);
        // Unfinanced holdings once this unstake settles. Mirrors the two writes below:
        // `hi_sola -= amount` and `staked_amount = staked_amount.saturating_sub(amount)`.
        let staked_after = ctx
            .accounts
            .user_position
            .staked_amount
            .saturating_sub(hi_sola_amount);
        let unfinanced_after = balance
            .saturating_sub(hi_sola_amount)
            .saturating_sub(staked_after);
        require!(
            unfinanced_after >= still_locked,
            SoladromeError::FounderVestingLocked
        );
    }

    // ── Auto-pay pending fees (Masterchef pattern) ───────────────────────
    // Compute on the FULL pre-unstake balance so the staker captures every
    // fee earned up to this moment — then set fees_debt = acc so future
    // claim_fees only credits post-unstake earnings on the residual balance.
    //
    // `fees_debt` is reset to `acc` a few lines down, which permanently closes the window
    // on everything not credited now. Capped by the financed stake — see
    // `math::fee_basis`.
    let fee_basis = math::fee_basis(
        ctx.accounts.user_position.staked_amount,
        balance,
        ctx.accounts.user_position.fee_shares,
    );
    let pending = math::pending_fees(acc, ctx.accounts.user_position.fees_debt, fee_basis);
    if pending > 0 {
        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            pending,
        )?;
        ctx.accounts.protocol_state.last_market_vault_balance =
            market_balance.saturating_sub(pending);
    }
    ctx.accounts.user_position.fees_debt = acc;

    // Debit the position — this replaces the burn. `remaining` was checked above against
    // both the outstanding debt and the standing vote lock.
    ctx.accounts.user_position.hi_sola = remaining;

    let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.sola_vault.to_account_info(),
                to: ctx.accounts.user_sola.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[seeds],
        ),
        hi_sola_amount,
    )?;

    // The financed deposit shrinks with the exit. `saturating_sub` because a position
    // may hold more hiSOLA than it financed (an expired ve lock releases unfinanced
    // hiSOLA into `hi_sola` without ever touching `staked_amount`), and because legacy
    // positions predate the field and read 0 — neither may underflow on exit.
    ctx.accounts.user_position.staked_amount = ctx
        .accounts
        .user_position
        .staked_amount
        .saturating_sub(hi_sola_amount);

    let s = &mut ctx.accounts.protocol_state;
    s.fees_per_hi_sola = acc;
    // Use post-payout balance as snapshot so the auto-paid USDC is not
    // double-credited to remaining stakers on the next accumulator advance.
    s.last_market_vault_balance = market_balance.saturating_sub(pending);
    s.total_hi_sola = s
        .total_hi_sola
        .checked_sub(hi_sola_amount)
        .ok_or(SoladromeError::Overflow)?;
    Ok(())
}

// Claim pro-rata share of market_vault fees. Permissionless — no admin needed.
// Uses reward-per-token accumulator: O(1), no loops, no snapshots.
pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
    let market_balance = ctx.accounts.market_vault.amount;

    // Advance accumulator with any new fees since last interaction
    let acc = math::advance_accumulator(
        ctx.accounts.protocol_state.fees_per_hi_sola,
        market_balance,
        ctx.accounts.protocol_state.last_market_vault_balance,
        ctx.accounts.protocol_state.total_hi_sola,
    );

    // Voting costs the staker nothing here: the balance stays on the position while the
    // vote stands, so a voter's basis is unchanged and `total_hi_sola` — the accumulator
    // denominator — is untouched, diluting nobody.
    //
    // Capped by `staked_amount` — see `math::fee_basis`.
    let basis = math::fee_basis(
        ctx.accounts.user_position.staked_amount,
        ctx.accounts.user_position.hi_sola,
        ctx.accounts.user_position.fee_shares,
    );
    let claimable = math::pending_fees(acc, ctx.accounts.user_position.fees_debt, basis);
    require!(claimable > 0, SoladromeError::NothingToClaim);

    let bump = ctx.accounts.protocol_state.bump;
    let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.market_vault.to_account_info(),
                to: ctx.accounts.user_usdc.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[seeds],
        ),
        claimable,
    )?;

    // Persist accumulator state
    let s = &mut ctx.accounts.protocol_state;
    s.fees_per_hi_sola = acc;
    s.last_market_vault_balance = market_balance
        .checked_sub(claimable)
        .ok_or(SoladromeError::Overflow)?;

    // Move user's debt forward so they can't double-claim
    ctx.accounts.user_position.fees_debt = acc;
    Ok(())
}

/// Convert a legacy hiSOLA token balance into the ledger position that replaced it.
///
/// MIGRATION ONLY, and it can only be called by the holder. The program has no freeze
/// authority and no permanent delegate on the old mint, so it cannot reach into anyone's
/// ATA — a wallet that never calls this keeps a token that no instruction reads any more.
/// A fresh deployment never needs it.
///
/// Sweeps both places the token era could leave hiSOLA:
///   - the holder's own ATA, burned with the holder's signature;
///   - the global vote-escrow vault, burned under the protocol PDA, for the amount this
///     position recorded as escrowed. Without this half, stake taken into custody by a
///     vote would have no way out at all — `withdraw_vote_escrow`, its only exit, is
///     replaced by this instruction.
///
/// Credits `hi_sola` and nothing else. `staked_amount` is untouched (the financed figure
/// is already recorded and does not change hands), and so are `total_hi_sola` and the fee
/// accumulator: the same stake is being expressed in a different unit, not created. That
/// is what makes it safe to run at any time, in any order, against a live protocol.
///
/// Deliberately NOT gated on `paused`: recovering your own stake is an exit path, and exit
/// paths stay open (same rule as `sell_sola` / `unstake_hi_sola`).
pub fn convert_hi_sola(ctx: Context<ConvertHiSola>) -> Result<()> {
    let bump = ctx.accounts.protocol_state.bump;
    let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

    let in_wallet = ctx.accounts.user_hi_sola.amount;
    // Bounded by what the vault actually holds, not by the counter alone: a mismatch
    // between the two must fail closed on the amount, never abort the whole conversion
    // and strand the wallet balance with it.
    let escrowed = ctx
        .accounts
        .user_position
        .vote_escrowed
        .min(ctx.accounts.vote_escrow_vault.amount);
    let total = in_wallet
        .checked_add(escrowed)
        .ok_or(SoladromeError::Overflow)?;
    require!(total > 0, SoladromeError::NothingToConvert);

    if ctx.accounts.user_position.owner == Pubkey::default() {
        ctx.accounts.user_position.owner = ctx.accounts.user.key();
        ctx.accounts.user_position.bump = ctx.bumps.user_position;
        // Same stamp as every other lazy position opener: a wallet holding hiSOLA it
        // never staked (received by transfer, back when that was possible) must not be
        // born claiming the whole fee history. Its `staked_amount` stays 0, so
        // `fee_basis` pays it nothing regardless — the stamp is defence in depth.
        ctx.accounts.user_position.fees_debt = math::advance_accumulator(
            ctx.accounts.protocol_state.fees_per_hi_sola,
            ctx.accounts.market_vault.amount,
            ctx.accounts.protocol_state.last_market_vault_balance,
            ctx.accounts.protocol_state.total_hi_sola,
        );
    }

    if in_wallet > 0 {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.hi_sola_mint.to_account_info(),
                    from: ctx.accounts.user_hi_sola.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            in_wallet,
        )?;
    }

    if escrowed > 0 {
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.hi_sola_mint.to_account_info(),
                    from: ctx.accounts.vote_escrow_vault.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            escrowed,
        )?;
    }

    // Zero the legacy counter in the same instruction that empties the vault it tracked,
    // so a second call converts nothing rather than crediting the escrow twice.
    ctx.accounts.user_position.vote_escrowed = 0;
    ctx.accounts.user_position.hi_sola = ctx
        .accounts
        .user_position
        .hi_sola
        .checked_add(total)
        .ok_or(SoladromeError::Overflow)?;

    msg!(
        "hiSOLA converted to position: {} (wallet {} + escrow {})",
        total,
        in_wallet,
        escrowed
    );
    Ok(())
}

#[derive(Accounts)]
pub struct StakeSola<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = sola_mint, token::authority = user)]
    pub user_sola: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Market vault — snapshots the accumulator AND is the source of any pending
    /// fees auto-paid to an existing staker who adds more SOLA. Must be mutable.
    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// USDC mint — needed to init user_usdc ATA on first stake if absent.
    #[account(address = protocol_state.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// User's USDC ATA — receives auto-harvested fees on stake. Created if absent.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint      = usdc_mint,
        associated_token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump,
    )]
    pub user_position: Account<'info, UserPosition>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnstakeHiSola<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = sola_mint,
        associated_token::authority = user,
    )]
    pub user_sola: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Source of pending fee payouts. Mutable so fees can be transferred out.
    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// USDC mint — needed to init user_usdc ATA on first unstake if absent.
    #[account(address = protocol_state.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    /// User's USDC ATA — receives any pending fees auto-paid on unstake.
    /// Created if it doesn't exist yet.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint      = usdc_mint,
        associated_token::authority = user,
    )]
    pub user_usdc: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    /// Founder hiSOLA vesting schedule. Read only when the caller is
    /// `protocol_state.founder_wallet`, to bound how much UNFINANCED hiSOLA they may still
    /// hold — see the guard in the handler. Any other caller may pass any account; it is
    /// never dereferenced for them.
    /// CHECK: pinned to the canonical PDA and required to be owned by this program inside the
    /// guard, before a single byte is trusted. It cannot be `Account<FounderHiSolaVesting>`:
    /// the account legitimately does not exist until `mint_founder_allocation` runs, and
    /// every ordinary staker must be able to unstake before then.
    pub founder_hi_vesting: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Account<'info, TokenAccount>,

    // ClaimFees: enforce owner so fee payouts cannot be silently routed to
    // a third-party account by a malicious caller.
    #[account(
        mut,
        constraint = user_usdc.mint  == protocol_state.usdc_mint @ SoladromeError::InvalidAmount,
        constraint = user_usdc.owner == user.key()               @ SoladromeError::Unauthorized,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump = user_position.bump,
    )]
    pub user_position: Account<'info, UserPosition>,

    pub token_program: Program<'info, Token>,
}

/// Return hiSOLA immobilised by voting, once the voted epoch has closed.
#[derive(Accounts)]
pub struct ConvertHiSola<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// The legacy mint. Kept `mut` because this instruction burns against it — it is the only
    /// instruction left that touches it at all.
    #[account(mut, address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

    /// The caller's old token account. Emptied here; nothing refills it.
    #[account(
        mut,
        constraint = user_hi_sola.mint == hi_sola_mint.key() && user_hi_sola.owner == user.key(),
    )]
    pub user_hi_sola: Box<Account<'info, TokenAccount>>,

    /// The old global escrow vault. `init_if_needed` would be wrong here — a deployment that
    /// never escrowed anything has no vault, and creating one just to burn zero from it would
    /// charge rent for nothing. Pinned by seeds so the only vault this can drain is the real
    /// one, and the amount is bounded by what this position recorded as escrowed.
    #[account(mut, seeds = [VOTE_ESCROW_SEED], bump)]
    pub vote_escrow_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only. Needed to stamp `fees_debt` when this instruction is what first opens the
    /// caller's UserPosition — a wallet holding hiSOLA it received by transfer may never have
    /// interacted with the protocol before.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
