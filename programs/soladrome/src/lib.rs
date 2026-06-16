// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Christophe Hertecant

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer},
};

mod amm;
mod amm_math;
mod amm_state;
mod errors;
mod math;
mod pol;
mod state;
mod ve;

#[allow(ambiguous_glob_reexports)]
pub use amm::*;
use amm_state::AmmPool;
use errors::SoladromeError;
#[allow(ambiguous_glob_reexports)]
pub use pol::*;
use state::{
    current_epoch, BribeVault, ContributorVesting, FounderHiSolaVesting, FounderVesting,
    GaugeState, GlobalEpochVotes, LpEpochClaim, LpPoolEpochAccum, LpUserCheckpoint,
    PartnerAllocation, ProtocolState, UserBribeClaim, UserEpochVotes, UserPosition,
    UserVoteConfig, UserVoteReceipt, VeLockPosition, CONTRIBUTOR_DURATION_SECS,
    CONTRIBUTOR_TGE_BPS, EPOCH_DURATION, FLOOR_RESERVE_MIN_BPS, MAX_LOCK_DURATION,
    MIN_LOCK_DURATION, VESTING_CLIFF_SECS, VESTING_DURATION_SECS,
};
#[allow(ambiguous_glob_reexports)]
pub use ve::*;

/// Canonical dead address for MINIMUM_LIQUIDITY lock (System Program address).
pub const LP_DEAD_PUBKEY: Pubkey = anchor_lang::system_program::ID;

declare_id!("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");

// ── Security contact (https://github.com/neodyme-labs/solana-security-txt) ────
// Published on-chain so security researchers can find our contact info.
// Displayed on Solana Explorer → Program → Security.txt tab.
#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;
#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name:                "Soladrome",
    project_url:         "https://soladrome.finance",
    contacts:            "email:info@soladrome.finance",
    policy:              "https://github.com/OxToF/soladrome/blob/main/SECURITY.md",
    preferred_languages: "en,fr",
    source_code:         "https://github.com/OxToF/soladrome",
    auditors:            "None"
}

pub const STATE_SEED: &[u8] = b"state";
pub const POSITION_SEED: &[u8] = b"position";
pub const FLOOR_VAULT_SEED: &[u8] = b"floor_vault";
pub const MARKET_VAULT_SEED: &[u8] = b"market_vault";
pub const SOLA_VAULT_SEED: &[u8] = b"sola_vault";

pub const INIT_VIRTUAL_USDC: u64 = 100_000_000; // 100 USDC (6 dec)
pub const INIT_VIRTUAL_SOLA: u64 = 100_000_000; // 100 SOLA (6 dec)  – floor = 1:1

/// Total oSOLA minted per epoch, split proportionally across voted pools (legacy gauge system).
pub const LP_EMISSION_PER_EPOCH: u64 = 10_000 * 1_000_000; // 10 000 oSOLA (6 dec)

/// Maximum voting power any single address may allocate in one epoch,
/// expressed as a fraction of total_hi_sola (basis points, 10 000 = 100%).
/// 3 000 bps = 30% — prevents governance capture by a single actor while
/// remaining more restrictive than Aerodrome/Velodrome (which have no cap).
pub const VOTE_WEIGHT_CAP_BPS: u64 = 3_000;

/// Continuous Masterchef-style oSOLA emission per pool per second (6 decimals).
/// devnet : 0.1 oSOLA/s  — high rate for fast visibility during testing.
/// mainnet: 0.001 oSOLA/s ≈ 86 oSOLA/pool/day — conservative, adjust before launch.
#[cfg(feature = "devnet")]
pub const OSOLA_EMISSION_PER_SEC: u64 = 100_000;
#[cfg(not(feature = "devnet"))]
pub const OSOLA_EMISSION_PER_SEC: u64 = 1_000;

/// Precision factor for the oSOLA-per-LP accumulator.
pub const LP_REWARD_PRECISION: u128 = 1_000_000_000_000; // 1e12

/// Grace period before unfinished bribe tokens can be rolled to the next epoch.
/// Protects voters who haven't claimed yet from having funds recycled under them.
/// Pools with zero votes are exempt — their tokens are immediately rollable.
/// devnet: 2 epochs = 2 h · mainnet: 2 epochs = 14 days
pub const ROLLOVER_DELAY_EPOCHS: u64 = 2;

// Founder allocation — 12% of reference 100 M-token supply, 7% auto-staked.
/// Total founder allocation across all three tranches (reference only — never used as a cap).
/// 7M hiSOLA (vesting) + 5M oSOLA (vesting) + 250k SOLA (immediate liquid) = 12.25M
pub const FOUNDER_TOTAL: u64 = 12_250_000_000_000; // 12 250 000 SOLA (6 dec)
pub const FOUNDER_STAKE: u64 = 7_000_000_000_000; //  7 000 000 SOLA → hiSOLA (governance vesting)
/// 5 000 000 oSOLA — held in vesting vault, released linearly after cliff.
pub const FOUNDER_LIQUID: u64 = 5_000_000_000_000; //  5 000 000 oSOLA vesting tranche
pub const ECOSYSTEM_TOTAL: u64 = 1_750_000_000_000; //  1 750 000 SOLA — marketing + airdrop
/// Liquid SOLA sent directly to the founder wallet at ecosystem allocation time.
/// Separate from the 7M hiSOLA vesting — provides immediate income while vesting cliff runs.
pub const FOUNDER_IMMEDIATE_SOLA: u64 = 250_000_000_000; //    250 000 SOLA — liquid, no lock
/// One-time origination fee on each borrow (like Beradrome). Sent to market_vault → hiSOLA stakers.
pub const BORROW_FEE_BPS: u64 = 200; //  2 % of borrowed amount
/// Founder borrow cap: max 10 % of total *claimed* hiSOLA ever borrowed.
/// Ensures the founder cannot drain the floor vault before organic users arrive.
pub const FOUNDER_BORROW_CAP_BPS: u64 = 1_000; // 10 %

pub const FOUNDER_HI_VESTING_SEED: &[u8] = b"founder_hi_vesting";

// ⚠️ Mainnet founder wallet — hardcoded for security (cannot be redirected).
// Ledger Nano S — dedicated Soladrome wallet, never used on any other chain.
pub const FOUNDER_WALLET: &str = "46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4";

// ── Contributor / marketing allocation ────────────────────────────────────────
pub const CONTRIBUTOR_SEED: &[u8] = b"contributor";
/// Contributor borrow cap: max 10 % of total *claimed* hiSOLA at borrow time.
/// Mirrors the founder logic — scales dynamically with actual claims.
pub const CONTRIBUTOR_BORROW_CAP_BPS: u64 = 1_000; // 10 %

// ── Protocol Partner allocation ───────────────────────────────────────────────
pub const PARTNER_SEED: &[u8] = b"partner";

// ── Vote carry-over ───────────────────────────────────────────────────────────
pub const VOTE_CONFIG_SEED: &[u8] = b"vote_config";

#[program]
pub mod soladrome {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let clock = Clock::get()?;
        let s = &mut ctx.accounts.protocol_state;
        s.authority = ctx.accounts.authority.key();
        s.usdc_mint = ctx.accounts.usdc_mint.key();
        s.sola_mint = ctx.accounts.sola_mint.key();
        s.hi_sola_mint = ctx.accounts.hi_sola_mint.key();
        s.o_sola_mint = ctx.accounts.o_sola_mint.key();
        s.floor_vault = ctx.accounts.floor_vault.key();
        s.market_vault = ctx.accounts.market_vault.key();
        s.sola_vault = ctx.accounts.sola_vault.key();
        s.virtual_usdc = INIT_VIRTUAL_USDC;
        s.virtual_sola = INIT_VIRTUAL_SOLA;
        s.k = INIT_VIRTUAL_USDC as u128 * INIT_VIRTUAL_SOLA as u128;
        s.bump = ctx.bumps.protocol_state;
        // Epoch emission decay — 800 000 oSOLA/epoch at launch, −1%/epoch, floor 150 000.
        // Timeline: ~616k at 6 months, ~474k at 1 year, ~150k floor at ~3.2 years.
        // Override at any time via `configure_emissions` (Squads multisig).
        s.osola_emission_initial = 800_000_000_000; // 800 000 oSOLA (6 dec)
        s.osola_emission_decay_bps = 9_900;         // −1 % per epoch
        s.osola_emission_floor_bps = 1_875;         // floor = 150 000 oSOLA (18.75 %)
        s.osola_emission_start_epoch = current_epoch(clock.unix_timestamp);
        Ok(())
    }

    // ── Emergency pause controls ──────────────────────────────────────────────
    // Authority-only. Freezes all entry instructions while keeping exit paths
    // (sell_sola, unstake_hi_sola, repay_usdc, remove_liquidity, claim_*, unlock)
    // always accessible so users can never be trapped.

    pub fn pause(ctx: Context<SetPaused>) -> Result<()> {
        ctx.accounts.protocol_state.paused = true;
        Ok(())
    }

    pub fn unpause(ctx: Context<SetPaused>) -> Result<()> {
        ctx.accounts.protocol_state.paused = false;
        Ok(())
    }

    // Transfer protocol authority to a new address (e.g. Squads multisig vault).
    // Can only be called by the current authority.
    // After this call all admin instructions (pause, unpause, initialize_pol, etc.)
    // must be executed through the new authority — typically via Squads proposal flow.
    pub fn transfer_authority(ctx: Context<TransferAuthority>) -> Result<()> {
        // SECURITY: reject the zero/default pubkey — passing it would permanently lock all
        // authority-gated instructions with no recovery path (has_one = authority would
        // never be satisfiable again). A typo or social-engineering attack must not be
        // able to brick the protocol forever.
        require!(
            ctx.accounts.new_authority.key() != Pubkey::default(),
            SoladromeError::InvalidAmount
        );
        // Also reject transferring to the current authority (no-op that wastes a TX).
        require!(
            ctx.accounts.new_authority.key() != ctx.accounts.protocol_state.authority,
            SoladromeError::InvalidAmount
        );
        ctx.accounts.protocol_state.authority = ctx.accounts.new_authority.key();
        Ok(())
    }

    // Deposit USDC → receive SOLA via constant-product curve.
    // USDC splits: floor vault (1:1 backing) + market vault (excess fees).
    pub fn buy_sola(ctx: Context<BuySola>, usdc_in: u64, min_sola_out: u64) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.paused,
            SoladromeError::ProtocolPaused
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

    // Lock SOLA → mint hiSOLA 1:1 (governance + fee share + borrow rights).
    // Sets user's fees_debt to current accumulator so they don't claim past fees.
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

        // Pre-mint hiSOLA balance — basis for harvesting fees already accrued on
        // the user's EXISTING stake. Anchor does not reload the cached token
        // account after the mint CPI below, so this stays the pre-mint balance.
        let old_balance = ctx.accounts.user_hi_sola.amount;

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

        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.hi_sola_mint.to_account_info(),
                    to: ctx.accounts.user_hi_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
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
            let pending = if is_new {
                0
            } else {
                math::pending_fees(acc, position.fees_debt, old_balance)
            };
            // Entry/exit point: debt = current accumulator (no retroactive claim).
            position.fees_debt = acc;
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

    // Burn hiSOLA → unlock SOLA. Blocked if remaining collateral < debt.
    pub fn unstake_hi_sola(ctx: Context<UnstakeHiSola>, hi_sola_amount: u64) -> Result<()> {
        require!(hi_sola_amount > 0, SoladromeError::InvalidAmount);
        let bump = ctx.accounts.protocol_state.bump;

        // ── Advance accumulator before reducing total_hi_sola ────────────────
        // Without this, fees earned while more stakers were active would be
        // diluted when calculated against the post-unstake supply.
        // SECURITY: acc must be computed BEFORE the position init block so that
        // a freshly-created position (hiSOLA received via transfer, never staked)
        // has fees_debt = acc → pending = 0, preventing retroactive market_vault drain.
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
            // Snapshot the current accumulator so a wallet that received hiSOLA
            // via transfer (without ever calling stake_sola) cannot claim fees
            // that accrued before their first protocol interaction.
            ctx.accounts.user_position.fees_debt = acc;
        }

        let balance = ctx.accounts.user_hi_sola.amount;
        require!(balance >= hi_sola_amount, SoladromeError::InvalidAmount);
        let remaining = balance - hi_sola_amount;
        require!(
            ctx.accounts.user_position.usdc_borrowed <= remaining,
            SoladromeError::OutstandingDebt
        );

        // ── Founder vesting lock (mainnet only) ──────────────────────────────
        // Prevents the founder from unstaking more hiSOLA than the vesting
        // schedule has unlocked. Devnet skips this check for testing convenience.
        #[cfg(not(feature = "devnet"))]
        if ctx.accounts.user.key() == FOUNDER_WALLET.parse::<Pubkey>().unwrap() {
            // SECURITY: `founder_hi_vesting` is an UncheckedAccount, so its data
            // is NOT validated by Anchor. A manual `try_deserialize` only checks
            // the discriminator — NOT the account owner — so without the two
            // guards below the founder could pass a forged account (owned by any
            // program, e.g. one they deploy) carrying the FounderHiSolaVesting
            // discriminator with `claimed = 0`. That makes `locked = 0` and
            // bypasses the vesting lock entirely → founder unstakes early, sells
            // unfinanced SOLA, and drains floor_vault USDC ahead of real buyers.
            // We therefore pin the account to the canonical PDA and require it be
            // owned by this program before trusting its `claimed` value.
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
            // After unstaking, the remaining hiSOLA (balance - amount) must
            // not exceed what the vesting schedule allows at this moment.
            // Equivalently: amount ≤ balance - (claimed - max_unlocked).
            let locked = vesting.claimed.saturating_sub(max_unlocked);
            require!(
                balance.saturating_sub(hi_sola_amount) >= locked,
                SoladromeError::FounderVestingLocked
            );
        }

        // ── Auto-pay pending fees (Masterchef pattern) ───────────────────────
        // Compute on the FULL pre-unstake balance so the staker captures every
        // fee earned up to this moment — then set fees_debt = acc so future
        // claim_fees only credits post-unstake earnings on the residual balance.
        let pending = math::pending_fees(acc, ctx.accounts.user_position.fees_debt, balance);
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

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.hi_sola_mint.to_account_info(),
                    from: ctx.accounts.user_hi_sola.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            hi_sola_amount,
        )?;

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

    // Borrow USDC from floor reserve. Max = hiSOLA balance × 1 USDC (1:1 floor). No liquidation.
    pub fn borrow_usdc(ctx: Context<BorrowUsdc>, usdc_amount: u64) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.paused,
            SoladromeError::ProtocolPaused
        );
        require!(usdc_amount > 0, SoladromeError::InvalidAmount);
        let bump = ctx.accounts.protocol_state.bump;

        if ctx.accounts.user_position.owner == Pubkey::default() {
            ctx.accounts.user_position.owner = ctx.accounts.user.key();
            ctx.accounts.user_position.bump = ctx.bumps.user_position;
            // SECURITY: snapshot accumulator so a wallet that received hiSOLA via
            // transfer (without staking) cannot retroactively claim fees through
            // claim_fees after this position is initialized with fees_debt = 0.
            ctx.accounts.user_position.fees_debt = math::advance_accumulator(
                ctx.accounts.protocol_state.fees_per_hi_sola,
                ctx.accounts.market_vault.amount,
                ctx.accounts.protocol_state.last_market_vault_balance,
                ctx.accounts.protocol_state.total_hi_sola,
            );
        }

        let hi_sola_balance = ctx.accounts.user_hi_sola.amount;
        let new_borrowed = ctx
            .accounts
            .user_position
            .usdc_borrowed
            .checked_add(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;
        require!(
            new_borrowed <= hi_sola_balance,
            SoladromeError::BorrowLimitExceeded
        );
        require!(
            ctx.accounts.floor_vault.amount >= usdc_amount,
            SoladromeError::InsufficientFloorReserve
        );
        // ── 75% floor buffer guardrail ───────────────────────────────────────
        // Ensures sell_sola remains liquid for at least 75% of floor-backed supply.
        {
            let floor_after = ctx
                .accounts
                .floor_vault
                .amount
                .checked_sub(usdc_amount)
                .ok_or(SoladromeError::Overflow)?;
            let min_floor = (ctx.accounts.protocol_state.total_purchased_sola as u128)
                .checked_mul(FLOOR_RESERVE_MIN_BPS as u128)
                .ok_or(SoladromeError::Overflow)?
                .checked_div(10_000)
                .ok_or(SoladromeError::Overflow)? as u64;
            require!(
                floor_after >= min_floor,
                SoladromeError::BorrowExceedsFloorBuffer
            );
        }

        // ── 2 % origination fee (one-time, like Beradrome) ──────────────────
        // fee   → market_vault  → distributed to hiSOLA stakers via accumulator
        // net   → user_usdc
        // usdc_borrowed tracks the GROSS amount so repay fully restores floor_vault.
        let fee = usdc_amount
            .checked_mul(BORROW_FEE_BPS)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(10_000)
            .ok_or(SoladromeError::Overflow)?;
        let user_receives = usdc_amount
            .checked_sub(fee)
            .ok_or(SoladromeError::Overflow)?;

        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

        // Transfer net amount to user
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
            user_receives,
        )?;

        // Transfer fee to market_vault (→ hiSOLA stakers)
        if fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.floor_vault.to_account_info(),
                        to: ctx.accounts.market_vault.to_account_info(),
                        authority: ctx.accounts.protocol_state.to_account_info(),
                    },
                    &[seeds],
                ),
                fee,
            )?;
        }

        // usdc_borrowed = gross (user repays full amount → floor_vault fully restored)
        ctx.accounts.user_position.usdc_borrowed = new_borrowed;
        // Track global borrow total for floor-vault invariant.
        ctx.accounts.protocol_state.total_usdc_borrowed = ctx
            .accounts
            .protocol_state
            .total_usdc_borrowed
            .checked_add(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;
        // Flash-borrow guard: record the slot so repay_usdc cannot fire in the same tx.
        ctx.accounts.user_position.last_borrow_slot = Clock::get()?.slot;
        Ok(())
    }

    pub fn repay_usdc(ctx: Context<RepayUsdc>, usdc_amount: u64) -> Result<()> {
        require!(usdc_amount > 0, SoladromeError::InvalidAmount);
        let repay = usdc_amount.min(ctx.accounts.user_position.usdc_borrowed);
        require!(repay > 0, SoladromeError::InvalidAmount);
        // Flash-borrow guard: repay must be in a strictly later slot than borrow.
        require!(
            Clock::get()?.slot > ctx.accounts.user_position.last_borrow_slot,
            SoladromeError::FlashBorrowDetected
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.floor_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            repay,
        )?;

        ctx.accounts.user_position.usdc_borrowed = ctx
            .accounts
            .user_position
            .usdc_borrowed
            .checked_sub(repay)
            .ok_or(SoladromeError::Overflow)?;
        ctx.accounts.protocol_state.total_usdc_borrowed = ctx
            .accounts
            .protocol_state
            .total_usdc_borrowed
            .checked_sub(repay)
            .ok_or(SoladromeError::Overflow)?;
        Ok(())
    }

    // Burn oSOLA + pay floor USDC → receive SOLA. Strengthens floor reserve.
    pub fn exercise_o_sola(ctx: Context<ExerciseOSola>, o_sola_amount: u64) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.paused,
            SoladromeError::ProtocolPaused
        );
        require!(o_sola_amount > 0, SoladromeError::InvalidAmount);
        let bump = ctx.accounts.protocol_state.bump;
        let usdc_cost = o_sola_amount;

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

        let hi_sola_balance = ctx.accounts.user_hi_sola.amount;
        let claimable =
            math::pending_fees(acc, ctx.accounts.user_position.fees_debt, hi_sola_balance);
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

    // One-time initialisation of founder vesting schedules.
    // Does NOT mint any tokens — all minting is deferred to claim instructions.
    // Protected by `founder_allocated` flag (callable once).
    pub fn mint_founder_allocation(ctx: Context<MintFounderAllocation>) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.founder_allocated,
            SoladromeError::AlreadyAllocated
        );

        let clock = Clock::get()?;

        // ── hiSOLA progressive vesting (7M, cliff + linear) ─────────────────
        // Tokens are minted epoch-by-epoch via claim_founder_hi_sola.
        // Each claim mints SOLA to sola_vault + hiSOLA to founder simultaneously,
        // giving the protocol time to build floor_vault from user purchases.
        let hiv = &mut ctx.accounts.founder_hi_vesting;
        hiv.total_amount = FOUNDER_STAKE;
        hiv.claimed = 0;
        hiv.start_ts = clock.unix_timestamp;
        hiv.bump = ctx.bumps.founder_hi_vesting;

        // ── oSOLA progressive vesting (5M, cliff + linear) ──────────────────
        // Founder claims oSOLA linearly. To convert to USDC:
        //   exercise_o_sola (pay 1 USDC → floor_vault, mint 1 SOLA) → sell on AMM.
        // Each exercise is ADDITIVE to floor_vault (net positive for protocol).
        let ov = &mut ctx.accounts.founder_vesting;
        ov.total_amount = FOUNDER_LIQUID;
        ov.claimed = 0;
        ov.start_ts = clock.unix_timestamp;
        ov.bump = ctx.bumps.founder_vesting;

        ctx.accounts.protocol_state.founder_allocated = true;
        Ok(())
    }

    // One-time ecosystem allocation: 2 M SOLA liquid → authority wallet for marketing & airdrop.
    // Entirely separate from the founder allocation; protected by `ecosystem_allocated` flag.
    pub fn mint_ecosystem_allocation(ctx: Context<MintEcosystemAllocation>) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.paused,
            SoladromeError::ProtocolPaused
        );
        require!(
            !ctx.accounts.protocol_state.ecosystem_allocated,
            SoladromeError::AlreadyAllocated
        );

        let bump = ctx.accounts.protocol_state.bump;
        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

        // 1 750 000 SOLA → authority ATA (marketing + airdrop budget).
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.sola_mint.to_account_info(),
                    to: ctx.accounts.authority_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            ECOSYSTEM_TOTAL,
        )?;

        // 250 000 SOLA → founder wallet, liquid, no vesting.
        // Provides immediate income while the 7M hiSOLA vesting cliff runs (6 months).
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.sola_mint.to_account_info(),
                    to: ctx.accounts.founder_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            FOUNDER_IMMEDIATE_SOLA,
        )?;

        let s = &mut ctx.accounts.protocol_state;
        s.total_sola = s
            .total_sola
            .checked_add(ECOSYSTEM_TOTAL)
            .and_then(|v| v.checked_add(FOUNDER_IMMEDIATE_SOLA))
            .ok_or(SoladromeError::Overflow)?;
        s.ecosystem_allocated = true;

        Ok(())
    }

    // Claim linearly-vested hiSOLA (7M tranche).
    // Each call mints `claimable` SOLA to sola_vault + `claimable` hiSOLA to founder.
    // total_sola grows gradually, giving floor_vault time to accumulate from user buys.
    // Founder uses borrow_usdc against hiSOLA for immediate liquidity (no token selling needed).
    pub fn claim_founder_hi_sola(ctx: Context<ClaimFounderHiSola>) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.paused,
            SoladromeError::ProtocolPaused
        );
        let clock = Clock::get()?;
        let vesting = &ctx.accounts.founder_hi_vesting;
        let elapsed = ((clock.unix_timestamp - vesting.start_ts).max(0)) as u64;

        require!(
            elapsed >= VESTING_CLIFF_SECS,
            SoladromeError::VestingCliffNotReached
        );
        require!(
            vesting.claimed < vesting.total_amount,
            SoladromeError::VestingFullyClaimed
        );

        let vested_amount = if elapsed >= VESTING_DURATION_SECS {
            vesting.total_amount
        } else {
            (vesting.total_amount as u128)
                .checked_mul(elapsed as u128)
                .ok_or(SoladromeError::Overflow)?
                .checked_div(VESTING_DURATION_SECS as u128)
                .ok_or(SoladromeError::Overflow)? as u64
        };

        let claimable = vested_amount
            .checked_sub(vesting.claimed)
            .ok_or(SoladromeError::Overflow)?;
        require!(claimable > 0, SoladromeError::NothingToClaim);

        // Advance accumulator before adding hiSOLA (same pattern as stake_sola).
        let market_balance = ctx.accounts.market_vault.amount;
        let acc = math::advance_accumulator(
            ctx.accounts.protocol_state.fees_per_hi_sola,
            market_balance,
            ctx.accounts.protocol_state.last_market_vault_balance,
            ctx.accounts.protocol_state.total_hi_sola,
        );

        let bump = ctx.accounts.protocol_state.bump;
        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

        // Mint SOLA to sola_vault (locked backing for hiSOLA)
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
            claimable,
        )?;

        // Mint hiSOLA to founder
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.hi_sola_mint.to_account_info(),
                    to: ctx.accounts.founder_hi_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            claimable,
        )?;

        // Init/update founder position debt snapshot
        let pos = &mut ctx.accounts.founder_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.founder.key();
            pos.bump = ctx.bumps.founder_position;
        }
        pos.fees_debt = acc;

        let s = &mut ctx.accounts.protocol_state;
        s.fees_per_hi_sola = acc;
        s.last_market_vault_balance = market_balance;
        s.total_sola = s
            .total_sola
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;
        s.total_hi_sola = s
            .total_hi_sola
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;

        ctx.accounts.founder_hi_vesting.claimed = ctx
            .accounts
            .founder_hi_vesting
            .claimed
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;

        Ok(())
    }

    // Claim linearly-vested oSOLA (5M tranche).
    // Mints oSOLA directly to founder — no floor impact.
    // To realise USDC: exercise_o_sola (pay 1 USDC → floor_vault) → sell SOLA on AMM.
    // Each exercise is net positive for the floor vault.
    pub fn claim_founder_vesting(ctx: Context<ClaimFounderVesting>) -> Result<()> {
        let clock = Clock::get()?;
        let vesting = &ctx.accounts.founder_vesting;
        let elapsed = ((clock.unix_timestamp - vesting.start_ts).max(0)) as u64;

        require!(
            elapsed >= VESTING_CLIFF_SECS,
            SoladromeError::VestingCliffNotReached
        );
        require!(
            vesting.claimed < vesting.total_amount,
            SoladromeError::VestingFullyClaimed
        );

        let vested_amount = if elapsed >= VESTING_DURATION_SECS {
            vesting.total_amount
        } else {
            (vesting.total_amount as u128)
                .checked_mul(elapsed as u128)
                .ok_or(SoladromeError::Overflow)?
                .checked_div(VESTING_DURATION_SECS as u128)
                .ok_or(SoladromeError::Overflow)? as u64
        };

        let claimable = vested_amount
            .checked_sub(vesting.claimed)
            .ok_or(SoladromeError::Overflow)?;
        require!(claimable > 0, SoladromeError::NothingToClaim);

        // Mint oSOLA to founder — floor-neutral until exercised
        let bump = ctx.accounts.protocol_state.bump;
        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.o_sola_mint.to_account_info(),
                    to: ctx.accounts.founder_o_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            claimable,
        )?;

        ctx.accounts.founder_vesting.claimed = ctx
            .accounts
            .founder_vesting
            .claimed
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;

        Ok(())
    }

    // ── Founder borrow (capped) ───────────────────────────────────────────────

    /// Founder-only variant of borrow_usdc with a 10 % cap.
    /// Max cumulative borrow = FOUNDER_BORROW_CAP_BPS (10 %) × total hiSOLA claimed.
    /// With 7 M hiSOLA vesting linearly over 24 months (~291 k/mo), the founder
    /// can borrow at most ~29 k USDC per month — enough for running costs while
    /// the floor vault grows from organic user activity.
    pub fn founder_borrow_usdc(ctx: Context<FounderBorrowUsdc>, usdc_amount: u64) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.paused,
            SoladromeError::ProtocolPaused
        );
        require!(usdc_amount > 0, SoladromeError::InvalidAmount);
        let bump = ctx.accounts.protocol_state.bump;

        if ctx.accounts.founder_position.owner == Pubkey::default() {
            ctx.accounts.founder_position.owner = ctx.accounts.founder.key();
            ctx.accounts.founder_position.bump = ctx.bumps.founder_position;
        }

        // ── Founder-specific cap ─────────────────────────────────────────────
        let claimed = ctx.accounts.founder_hi_vesting.claimed;
        let max_borrow = (claimed as u128)
            .checked_mul(FOUNDER_BORROW_CAP_BPS as u128)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(10_000)
            .ok_or(SoladromeError::Overflow)? as u64;

        let new_borrowed = ctx
            .accounts
            .founder_position
            .usdc_borrowed
            .checked_add(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;

        require!(
            new_borrowed <= max_borrow,
            SoladromeError::FounderBorrowCapExceeded
        );

        // ── Standard borrow checks ───────────────────────────────────────────
        let hi_sola_balance = ctx.accounts.founder_hi_sola.amount;
        require!(
            new_borrowed <= hi_sola_balance,
            SoladromeError::BorrowLimitExceeded
        );
        require!(
            ctx.accounts.floor_vault.amount >= usdc_amount,
            SoladromeError::InsufficientFloorReserve
        );
        // ── 75% floor buffer guardrail ───────────────────────────────────────
        {
            let floor_after = ctx
                .accounts
                .floor_vault
                .amount
                .checked_sub(usdc_amount)
                .ok_or(SoladromeError::Overflow)?;
            let min_floor = (ctx.accounts.protocol_state.total_purchased_sola as u128)
                .checked_mul(FLOOR_RESERVE_MIN_BPS as u128)
                .ok_or(SoladromeError::Overflow)?
                .checked_div(10_000)
                .ok_or(SoladromeError::Overflow)? as u64;
            require!(
                floor_after >= min_floor,
                SoladromeError::BorrowExceedsFloorBuffer
            );
        }

        // ── 2 % origination fee → market_vault ──────────────────────────────
        let fee = usdc_amount
            .checked_mul(BORROW_FEE_BPS)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(10_000)
            .ok_or(SoladromeError::Overflow)?;
        let founder_receives = usdc_amount
            .checked_sub(fee)
            .ok_or(SoladromeError::Overflow)?;

        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.floor_vault.to_account_info(),
                    to: ctx.accounts.founder_usdc.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            founder_receives,
        )?;

        if fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.floor_vault.to_account_info(),
                        to: ctx.accounts.market_vault.to_account_info(),
                        authority: ctx.accounts.protocol_state.to_account_info(),
                    },
                    &[seeds],
                ),
                fee,
            )?;
        }

        ctx.accounts.founder_position.usdc_borrowed = new_borrowed;
        ctx.accounts.protocol_state.total_usdc_borrowed = ctx
            .accounts
            .protocol_state
            .total_usdc_borrowed
            .checked_add(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;
        // Flash-borrow guard: record the slot so repay_usdc cannot fire in the same tx.
        ctx.accounts.founder_position.last_borrow_slot = Clock::get()?.slot;

        Ok(())
    }

    // ── Contributor / marketing vesting ──────────────────────────────────────

    /// Authority-only: register a contributor wallet with a dual hiSOLA + oSOLA allocation.
    /// Mirrors the founder structure — hiSOLA (governance + borrow) + oSOLA (liquid options).
    /// Vesting starts immediately (start_ts = now) — call at launch time.
    pub fn register_contributor(
        ctx: Context<RegisterContributor>,
        hi_sola_amount: u64,
        o_sola_amount: u64,
    ) -> Result<()> {
        require!(
            hi_sola_amount > 0 || o_sola_amount > 0,
            SoladromeError::InvalidAmount
        );
        let v = &mut ctx.accounts.contributor_vesting;
        v.contributor = ctx.accounts.contributor_wallet.key();
        v.hi_sola_amount = hi_sola_amount;
        v.o_sola_amount = o_sola_amount;
        v.hi_sola_claimed = 0;
        v.o_sola_claimed = 0;
        v.start_ts = Clock::get()?.unix_timestamp;
        v.bump = ctx.bumps.contributor_vesting;
        msg!(
            "Contributor registered: {} | {} hiSOLA + {} oSOLA | start_ts={}",
            v.contributor,
            v.hi_sola_amount,
            v.o_sola_amount,
            v.start_ts
        );
        Ok(())
    }

    /// Contributor-only: claim vested hiSOLA (25 % TGE + 75 % linear over 6 months).
    /// Mints SOLA to sola_vault (locked backing) + hiSOLA to contributor wallet 1:1.
    /// Also snapshots the fee accumulator so the contributor earns fees from day one.
    pub fn claim_contributor_hi_sola(ctx: Context<ClaimContributorHiSola>) -> Result<()> {
        let clock = Clock::get()?;
        let vesting = &ctx.accounts.contributor_vesting;
        let elapsed = ((clock.unix_timestamp - vesting.start_ts).max(0)) as u64;

        require!(
            vesting.hi_sola_claimed < vesting.hi_sola_amount,
            SoladromeError::VestingFullyClaimed
        );

        // 25 % unlocked immediately at TGE; remaining 75 % vests linearly over 6 months.
        let tge_amount = (vesting.hi_sola_amount as u128)
            .checked_mul(CONTRIBUTOR_TGE_BPS as u128)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(10_000)
            .ok_or(SoladromeError::Overflow)? as u64;
        let remaining = vesting.hi_sola_amount.saturating_sub(tge_amount);

        let vested_amount = if elapsed >= CONTRIBUTOR_DURATION_SECS {
            vesting.hi_sola_amount
        } else {
            let linear = (remaining as u128)
                .checked_mul(elapsed as u128)
                .ok_or(SoladromeError::Overflow)?
                .checked_div(CONTRIBUTOR_DURATION_SECS as u128)
                .ok_or(SoladromeError::Overflow)? as u64;
            tge_amount.saturating_add(linear)
        };

        let claimable = vested_amount
            .checked_sub(vesting.hi_sola_claimed)
            .ok_or(SoladromeError::Overflow)?;
        require!(claimable > 0, SoladromeError::NothingToClaim);

        // Advance accumulator before adding to hiSOLA supply (same pattern as stake_sola)
        let market_balance = ctx.accounts.market_vault.amount;
        let acc = math::advance_accumulator(
            ctx.accounts.protocol_state.fees_per_hi_sola,
            market_balance,
            ctx.accounts.protocol_state.last_market_vault_balance,
            ctx.accounts.protocol_state.total_hi_sola,
        );

        let bump = ctx.accounts.protocol_state.bump;
        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

        // Mint SOLA to sola_vault (backing the hiSOLA 1:1)
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
            claimable,
        )?;

        // Mint hiSOLA to contributor
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.hi_sola_mint.to_account_info(),
                    to: ctx.accounts.contributor_hi_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            claimable,
        )?;

        // Init/update contributor position debt snapshot
        let pos = &mut ctx.accounts.contributor_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.contributor.key();
            pos.bump = ctx.bumps.contributor_position;
        }
        pos.fees_debt = acc;

        let s = &mut ctx.accounts.protocol_state;
        s.fees_per_hi_sola = acc;
        s.last_market_vault_balance = market_balance;
        s.total_sola = s
            .total_sola
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;
        s.total_hi_sola = s
            .total_hi_sola
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;

        ctx.accounts.contributor_vesting.hi_sola_claimed = vesting
            .hi_sola_claimed
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;

        Ok(())
    }

    /// Contributor-only: claim vested oSOLA (25 % TGE + 75 % linear over 6 months).
    /// Mints oSOLA to contributor wallet — floor-neutral until exercised.
    pub fn claim_contributor_vesting(ctx: Context<ClaimContributorVesting>) -> Result<()> {
        let clock = Clock::get()?;
        let vesting = &ctx.accounts.contributor_vesting;
        let elapsed = ((clock.unix_timestamp - vesting.start_ts).max(0)) as u64;

        require!(
            vesting.o_sola_claimed < vesting.o_sola_amount,
            SoladromeError::VestingFullyClaimed
        );

        // 25 % unlocked immediately at TGE; remaining 75 % vests linearly over 6 months.
        let tge_amount = (vesting.o_sola_amount as u128)
            .checked_mul(CONTRIBUTOR_TGE_BPS as u128)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(10_000)
            .ok_or(SoladromeError::Overflow)? as u64;
        let remaining = vesting.o_sola_amount.saturating_sub(tge_amount);

        let vested_amount = if elapsed >= CONTRIBUTOR_DURATION_SECS {
            vesting.o_sola_amount
        } else {
            let linear = (remaining as u128)
                .checked_mul(elapsed as u128)
                .ok_or(SoladromeError::Overflow)?
                .checked_div(CONTRIBUTOR_DURATION_SECS as u128)
                .ok_or(SoladromeError::Overflow)? as u64;
            tge_amount.saturating_add(linear)
        };

        let claimable = vested_amount
            .checked_sub(vesting.o_sola_claimed)
            .ok_or(SoladromeError::Overflow)?;
        require!(claimable > 0, SoladromeError::NothingToClaim);

        let bump = ctx.accounts.protocol_state.bump;
        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.o_sola_mint.to_account_info(),
                    to: ctx.accounts.contributor_o_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            claimable,
        )?;

        ctx.accounts.contributor_vesting.o_sola_claimed = vesting
            .o_sola_claimed
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;

        Ok(())
    }

    /// Contributor borrow: draw USDC from floor_vault against hiSOLA collateral.
    /// Max cumulative borrow = 10 % of total *claimed* hiSOLA (dynamic, mirrors founder logic).
    /// 2% origination fee → market_vault. Flash-borrow guard included.
    pub fn contributor_borrow_usdc(
        ctx: Context<ContributorBorrowUsdc>,
        usdc_amount: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.paused,
            SoladromeError::ProtocolPaused
        );
        require!(usdc_amount > 0, SoladromeError::InvalidAmount);

        let bump = ctx.accounts.protocol_state.bump;

        // Initialise position on first borrow
        if ctx.accounts.contributor_position.owner == Pubkey::default() {
            ctx.accounts.contributor_position.owner = ctx.accounts.contributor.key();
            ctx.accounts.contributor_position.bump = ctx.bumps.contributor_position;
        }

        // Cap = 10% of total hiSOLA *claimed so far* (dynamic, scales with actual vesting progress).
        // Using hi_sola_claimed (not total allocation) mirrors founder_borrow_usdc exactly and
        // prevents borrowing against unvested tokens.
        let max_borrow = (ctx.accounts.contributor_vesting.hi_sola_claimed as u128)
            .checked_mul(CONTRIBUTOR_BORROW_CAP_BPS as u128)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(10_000)
            .ok_or(SoladromeError::Overflow)? as u64;
        let new_borrowed = ctx
            .accounts
            .contributor_position
            .usdc_borrowed
            .checked_add(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;
        require!(
            new_borrowed <= max_borrow,
            SoladromeError::ContributorBorrowCapExceeded
        );
        // ── Collateral check: borrow cannot exceed real on-chain hiSOLA held ──
        // Without this, a contributor could claim hiSOLA, sell/transfer ALL of it,
        // then still borrow up to 10% of their *claimed* allocation against zero
        // collateral — debt with no backing. Mirrors founder_borrow_usdc and the
        // standard borrow_usdc 1:1 collateral ceiling.
        let hi_sola_balance = ctx.accounts.contributor_hi_sola.amount;
        require!(
            new_borrowed <= hi_sola_balance,
            SoladromeError::BorrowLimitExceeded
        );
        require!(
            ctx.accounts.floor_vault.amount >= usdc_amount,
            SoladromeError::InsufficientFloorReserve
        );
        // ── 75% floor buffer guardrail ───────────────────────────────────────
        {
            let floor_after = ctx
                .accounts
                .floor_vault
                .amount
                .checked_sub(usdc_amount)
                .ok_or(SoladromeError::Overflow)?;
            let min_floor = (ctx.accounts.protocol_state.total_purchased_sola as u128)
                .checked_mul(FLOOR_RESERVE_MIN_BPS as u128)
                .ok_or(SoladromeError::Overflow)?
                .checked_div(10_000)
                .ok_or(SoladromeError::Overflow)? as u64;
            require!(
                floor_after >= min_floor,
                SoladromeError::BorrowExceedsFloorBuffer
            );
        }

        // 2% origination fee to market_vault
        let fee = usdc_amount
            .checked_mul(BORROW_FEE_BPS)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(10_000)
            .ok_or(SoladromeError::Overflow)?;
        let net_amount = usdc_amount
            .checked_sub(fee)
            .ok_or(SoladromeError::Overflow)?;
        require!(net_amount > 0, SoladromeError::InvalidAmount);

        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

        // floor_vault → contributor (net amount)
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.floor_vault.to_account_info(),
                    to: ctx.accounts.contributor_usdc.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            net_amount,
        )?;

        // floor_vault → market_vault (2% fee)
        if fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.floor_vault.to_account_info(),
                        to: ctx.accounts.market_vault.to_account_info(),
                        authority: ctx.accounts.protocol_state.to_account_info(),
                    },
                    &[seeds],
                ),
                fee,
            )?;
        }

        ctx.accounts.contributor_position.usdc_borrowed = new_borrowed;
        ctx.accounts.protocol_state.total_usdc_borrowed = ctx
            .accounts
            .protocol_state
            .total_usdc_borrowed
            .checked_add(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;

        // Flash-borrow guard
        ctx.accounts.contributor_position.last_borrow_slot = Clock::get()?.slot;

        Ok(())
    }

    // ── Protocol Partner allocation ───────────────────────────────────────────

    /// Authority-only: register a protocol partner with a one-time locked hiSOLA allocation.
    ///
    /// Unlike contributors (cliff + linear vesting), the partner claims the full amount
    /// once via `claim_partner_allocation` — hiSOLA is minted directly to their
    /// ve_lock_vault (never touches the wallet), giving immediate voting power while
    /// borrow remains blocked for the entire lock duration.
    ///
    /// `lock_duration_secs` must be in [MIN_LOCK_DURATION, MAX_LOCK_DURATION].
    /// Suggested mainnet value for strategic partners: 104 × 604 800 = 62 899 200 s
    /// (≈ 24 months — the maximum lock, granting full 4× ve-power).
    pub fn register_partner(
        ctx: Context<RegisterPartner>,
        bribe_mint: Pubkey,
        rate_num: u64,
        rate_den: u64,
        cap_hi_sola: u64,
        lock_duration_secs: u64,
    ) -> Result<()> {
        require!(cap_hi_sola > 0, SoladromeError::InvalidAmount);
        require!(bribe_mint != Pubkey::default(), SoladromeError::InvalidAmount);
        require!(
            rate_num > 0 && rate_den > 0,
            SoladromeError::InvalidRate
        );
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
        pa.rate_num = rate_num;
        pa.rate_den = rate_den;
        pa.cap_hi_sola = cap_hi_sola;
        pa.total_bribed_credited = 0;
        pa.hi_sola_claimed = 0;
        pa.lock_duration_secs = lock_duration_secs;
        pa.start_ts = Clock::get()?.unix_timestamp;
        pa.bump = ctx.bumps.partner_allocation;

        msg!(
            "Partner registered: {} | bribe_mint={} | rate={}/{} | cap={} hiSOLA | lock={}s",
            pa.partner,
            pa.bribe_mint,
            pa.rate_num,
            pa.rate_den,
            pa.cap_hi_sola,
            pa.lock_duration_secs,
        );
        Ok(())
    }

    /// Partner claims their one-time hiSOLA allocation.
    ///
    /// hiSOLA is minted DIRECTLY into the partner's ve_lock_vault — the wallet
    /// receives nothing.  This means:
    /// - Voting power is available immediately via VeLockPosition (up to 4× at max lock).
    /// - `borrow_usdc` is naturally blocked (wallet hiSOLA balance = 0).
    /// - `total_hi_sola` is NOT incremented: locked hiSOLA is excluded from the fee
    ///   accumulator denominator, so existing stakers are not diluted during the lock.
    /// - `UserPosition.fees_debt` is snapshotted at the current accumulator so the
    ///   partner earns staking fees only from their eventual `unlock_hi_sola` forward.
    ///
    /// After lock expiry: call `unlock_hi_sola` → hiSOLA returns to wallet → standard
    /// rules apply (fee share, borrow up to 75 % floor buffer, re-lock for more ve).
    pub fn claim_partner_allocation(ctx: Context<ClaimPartnerAllocation>) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.paused,
            SoladromeError::ProtocolPaused
        );
        // Multi-claim: the entitlement grows with bribes actually deposited
        // (via partner_deposit_bribe), bounded by the negotiated cap.
        //   entitled = min(cap_hi_sola, total_bribed_credited × rate_num / rate_den)
        // rate_den is guaranteed > 0 at register_partner, so the division is safe.
        let pa = &ctx.accounts.partner_allocation;
        let entitled = (pa.total_bribed_credited as u128)
            .checked_mul(pa.rate_num as u128)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(pa.rate_den as u128)
            .ok_or(SoladromeError::Overflow)?
            .min(pa.cap_hi_sola as u128) as u64;
        // This call mints only the newly-earned tranche (entitled − already claimed).
        let amount = entitled.saturating_sub(pa.hi_sola_claimed);
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

        let clock = Clock::get()?;
        let lock_end_ts = (clock.unix_timestamp as u64)
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

        // ── Mint hiSOLA directly to ve_lock_vault — bypasses wallet ──────────
        // Wallet balance stays 0 → borrow_usdc naturally blocked for lock duration.
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.hi_sola_mint.to_account_info(),
                    to: ctx.accounts.ve_lock_vault.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

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
            lock.lock_end_ts = lock_end_ts;
        }

        // ── Snapshot fees_debt at current accumulator ─────────────────────────
        // The partner earns staking fees only from unlock forward — not during
        // the lock period when their hiSOLA is excluded from total_hi_sola.
        {
            let pos = &mut ctx.accounts.partner_position;
            if pos.owner == Pubkey::default() {
                pos.owner = ctx.accounts.partner.key();
                pos.bump = ctx.bumps.partner_position;
            }
            pos.fees_debt = acc;
        }

        // ── Update protocol state ─────────────────────────────────────────────
        // total_sola += amount   (SOLA backing added to sola_vault)
        // total_hi_sola: UNCHANGED — locked hiSOLA excluded from fee pool,
        //   matching the semantics of lock_hi_sola (which subtracts from total_hi_sola).
        let s = &mut ctx.accounts.protocol_state;
        s.fees_per_hi_sola = acc;
        s.last_market_vault_balance = market_balance;
        s.total_sola = s
            .total_sola
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;

        ctx.accounts.partner_allocation.hi_sola_claimed = ctx
            .accounts
            .partner_allocation
            .hi_sola_claimed
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;

        msg!(
            "Partner allocation claimed: {} | +{} hiSOLA locked until {} | total claimed {}",
            ctx.accounts.partner.key(),
            amount,
            lock_end_ts,
            ctx.accounts.partner_allocation.hi_sola_claimed,
        );
        Ok(())
    }

    // ── Bribe system ─────────────────────────────────────────────────────────

    /// Permissionless: any protocol deposits bribe tokens to attract hiSOLA votes.
    /// epoch must equal the current epoch — bribes target the live voting window.
    pub fn deposit_bribe(ctx: Context<DepositBribe>, epoch: u64, amount: u64) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.paused,
            SoladromeError::ProtocolPaused
        );
        require!(amount > 0, SoladromeError::InvalidAmount);
        let clock = Clock::get()?;
        require!(
            epoch == current_epoch(clock.unix_timestamp),
            SoladromeError::WrongEpoch
        );

        // First-time vault init (pool_id starts as default when account is blank)
        if ctx.accounts.bribe_vault.pool_id == Pubkey::default() {
            ctx.accounts.bribe_vault.pool_id = ctx.accounts.pool_id.key();
            ctx.accounts.bribe_vault.reward_mint = ctx.accounts.reward_mint.key();
            ctx.accounts.bribe_vault.epoch = epoch;
            ctx.accounts.bribe_vault.bump = ctx.bumps.bribe_vault;
        }

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor_token.to_account_info(),
                    to: ctx.accounts.bribe_token_vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
        )?;

        ctx.accounts.bribe_vault.total_bribed = ctx
            .accounts
            .bribe_vault
            .total_bribed
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;
        Ok(())
    }

    /// Partner deposits a bribe in their committed `bribe_mint` AND gets credited
    /// toward their streaming hiSOLA allocation. The tokens flow into the SAME bribe
    /// vault as `deposit_bribe` (voters benefit identically); the partner's
    /// `total_bribed_credited` is incremented atomically with the real transfer, so
    /// allocation can never be credited without genuinely bribing. Only the committed
    /// `bribe_mint` credits — any other token is rejected.
    pub fn partner_deposit_bribe(
        ctx: Context<PartnerDepositBribe>,
        epoch: u64,
        amount: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.paused,
            SoladromeError::ProtocolPaused
        );
        require!(amount > 0, SoladromeError::InvalidAmount);
        let clock = Clock::get()?;
        require!(
            epoch == current_epoch(clock.unix_timestamp),
            SoladromeError::WrongEpoch
        );
        require_keys_eq!(
            ctx.accounts.reward_mint.key(),
            ctx.accounts.partner_allocation.bribe_mint,
            SoladromeError::BribeMintMismatch
        );

        // First-time vault init (mirror of deposit_bribe).
        if ctx.accounts.bribe_vault.pool_id == Pubkey::default() {
            ctx.accounts.bribe_vault.pool_id = ctx.accounts.pool_id.key();
            ctx.accounts.bribe_vault.reward_mint = ctx.accounts.reward_mint.key();
            ctx.accounts.bribe_vault.epoch = epoch;
            ctx.accounts.bribe_vault.bump = ctx.bumps.bribe_vault;
        }

        // Real transfer into the bribe vault → voters receive it exactly as usual.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.partner_token.to_account_info(),
                    to: ctx.accounts.bribe_token_vault.to_account_info(),
                    authority: ctx.accounts.partner.to_account_info(),
                },
            ),
            amount,
        )?;

        ctx.accounts.bribe_vault.total_bribed = ctx
            .accounts
            .bribe_vault
            .total_bribed
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;

        // Credit the partner's streaming allocation — atomic with the transfer above.
        ctx.accounts.partner_allocation.total_bribed_credited = ctx
            .accounts
            .partner_allocation
            .total_bribed_credited
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;

        msg!(
            "Partner bribe: {} | +{} (mint {}) | credited total {}",
            ctx.accounts.partner.key(),
            amount,
            ctx.accounts.reward_mint.key(),
            ctx.accounts.partner_allocation.total_bribed_credited,
        );
        Ok(())
    }

    /// hiSOLA holder directs vote-weight at a pool gauge for the current epoch.
    /// Total allocated across all pools ≤ raw hiSOLA + ve-weighted locked hiSOLA.
    /// One UserVoteReceipt per (user, pool, epoch) — double-vote for same pool is blocked.
    pub fn vote_gauge(ctx: Context<VoteGauge>, epoch: u64, votes: u64) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.paused,
            SoladromeError::ProtocolPaused
        );
        require!(votes > 0, SoladromeError::InvalidAmount);
        let clock = Clock::get()?;
        require!(
            epoch == current_epoch(clock.unix_timestamp),
            SoladromeError::WrongEpoch
        );

        // Total power = unlocked hiSOLA (1×) + ve-weighted locked hiSOLA (up to 4×).
        let hi_sola_balance = ctx.accounts.user_hi_sola.amount;
        let ve_power = ve::try_load_ve_power(
            &ctx.accounts.lock_position,
            &ctx.accounts.user.key(),
            clock.unix_timestamp,
        );
        let total_power = hi_sola_balance.saturating_add(ve_power);

        // Init UserEpochVotes on first vote — snapshot total_power as the epoch-wide cap.
        // Snapshotting here prevents a user from: (a) voting with a lock, letting it expire,
        // then voting again with fresh hiSOLA balance that exceeds the original cap; or
        // (b) transferring hiSOLA out between two separate vote_gauge calls in the same epoch.
        // The snapshot is immutable once set; subsequent votes check against it, not live power.
        if ctx.accounts.user_epoch_votes.epoch == 0 {
            ctx.accounts.user_epoch_votes.epoch = epoch;
            ctx.accounts.user_epoch_votes.total_power_snapshot = total_power;
            ctx.accounts.user_epoch_votes.bump = ctx.bumps.user_epoch_votes;
        }

        // ── 30% per-address cap applies only to hiSOLA governance power ─────
        // oSOLA burn bonus is additive and uncapped: burning oSOLA is a
        // deflationary act (permanent value destruction) that earns extra
        // influence for the current epoch only.
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

    // ── Emission decay configuration ──────────────────────────────────────────

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
            decay_bps >= 1 && decay_bps <= 10_000,
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

    // ── Vote carry-over ───────────────────────────────────────────────────────

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
        let clock = Clock::get()?;
        require!(
            epoch == current_epoch(clock.unix_timestamp),
            SoladromeError::WrongEpoch
        );
        require!(
            ctx.accounts.vote_config.auto_replay,
            SoladromeError::VoteConfigDisabled
        );

        // Locate pool_id in config
        let pool_key = ctx.accounts.pool_id.key();
        let n = ctx.accounts.vote_config.n_pools as usize;
        let pool_idx = ctx.accounts.vote_config.pools[..n]
            .iter()
            .position(|p| p == &pool_key)
            .ok_or(SoladromeError::PoolNotInConfig)?;
        let pool_bps = ctx.accounts.vote_config.bps[pool_idx] as u128;

        // Compute voting power — same formula as vote_gauge
        let hi_sola_balance = ctx.accounts.user_hi_sola.amount;
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
        require!(amount > 0, SoladromeError::InvalidAmount);
        let clock = Clock::get()?;
        require!(
            epoch == current_epoch(clock.unix_timestamp),
            SoladromeError::WrongEpoch
        );

        // Burn the oSOLA — permanent, irreversible.
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint:      ctx.accounts.o_sola_mint.to_account_info(),
                    from:      ctx.accounts.user_o_sola.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        // Credit voting power for this epoch only.
        let uev = &mut ctx.accounts.user_epoch_votes;
        if uev.epoch == 0 {
            uev.epoch = epoch;
            uev.bump  = ctx.bumps.user_epoch_votes;
        }
        uev.o_sola_bonus = uev
            .o_sola_bonus
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;

        Ok(())
    }

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
        let user_lp = ctx.accounts.user_lp.amount;

        // ── Pool accumulator ────────────────────────────────────────────
        let pa = &mut ctx.accounts.pool_epoch_accum;
        if pa.epoch == 0 {
            pa.epoch = epoch;
            pa.pool = pool_key;
            pa.last_update_ts = epoch_start;
            pa.last_lp_supply = lp_supply;
            pa.bump = ctx.bumps.pool_epoch_accum;
        }
        require!(!pa.finalized, SoladromeError::EpochNotFinalized);

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
        let ckpt = &mut ctx.accounts.lp_user_checkpoint;
        if ckpt.pool == Pubkey::default() {
            ckpt.user = ctx.accounts.user.key();
            ckpt.pool = pool_key;
            ckpt.last_epoch = epoch;
            ckpt.last_update_ts = epoch_start;
            ckpt.bump = ctx.bumps.lp_user_checkpoint;
        }
        // Reset for a new epoch
        if ckpt.last_epoch < epoch {
            ckpt.weighted_balance = 0;
            ckpt.last_update_ts = epoch_start;
            ckpt.last_epoch = epoch;
        }

        let ckpt_elapsed = (now - ckpt.last_update_ts).max(0) as u128;
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
        let elapsed = epoch.saturating_sub(
            ctx.accounts.protocol_state.osola_emission_start_epoch,
        );
        let epoch_total = math::decayed_emission(
            ctx.accounts.protocol_state.osola_emission_initial,
            ctx.accounts.protocol_state.osola_emission_decay_bps,
            elapsed,
            ctx.accounts.protocol_state.osola_emission_floor_bps,
        );

        pool_accum.osola_allocated = (epoch_total as u128)
            .checked_mul(pool_votes)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(total_votes)
            .ok_or(SoladromeError::Overflow)? as u64;
        pool_accum.finalized = true;

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

        let user_osola = (pa.osola_allocated as u128)
            .checked_mul(ckpt.weighted_balance)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(pa.total_weighted_supply)
            .ok_or(SoladromeError::Overflow)? as u64;
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

        // M-01 FIX: reset weighted_balance after a successful claim so that
        // checkpoint_lp for the next epoch does not overwrite unclaimed data.
        // Double-claim is still blocked by the LpEpochClaim PDA (init = fails if exists).
        ctx.accounts.lp_user_checkpoint.weighted_balance = 0;

        ctx.accounts.lp_epoch_claim.bump = ctx.bumps.lp_epoch_claim;
        Ok(())
    }

    /// Claim pro-rata bribe after the voting epoch has ended.
    /// claimable = total_bribed × user_votes / total_votes  (safe u128 muldiv)
    /// Creating UserBribeClaim PDA is the idempotency guard (init = fails if exists).
    pub fn claim_bribe(ctx: Context<ClaimBribe>, epoch: u64) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            epoch < current_epoch(clock.unix_timestamp),
            SoladromeError::EpochNotEnded
        );

        let total_votes = ctx.accounts.gauge_state.total_votes;
        let user_votes = ctx.accounts.user_vote_receipt.votes;
        let total_bribed = ctx.accounts.bribe_vault.total_bribed;
        require!(
            total_votes > 0 && user_votes > 0 && total_bribed > 0,
            SoladromeError::NothingToClaim
        );

        // Pro-rata muldiv in u128 to avoid overflow
        let claimable = (total_bribed as u128)
            .checked_mul(user_votes as u128)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(total_votes as u128)
            .ok_or(SoladromeError::Overflow)? as u64;
        require!(claimable > 0, SoladromeError::NothingToClaim);

        // Sign with bribe_vault PDA
        let pool_key = ctx.accounts.pool_id.key();
        let mint_key = ctx.accounts.reward_mint.key();
        let epoch_le = epoch.to_le_bytes();
        let vault_bump = [ctx.accounts.bribe_vault.bump];
        let seeds: &[&[u8]] = &[
            b"bribe_vault",
            pool_key.as_ref(),
            mint_key.as_ref(),
            epoch_le.as_ref(),
            vault_bump.as_ref(),
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bribe_token_vault.to_account_info(),
                    to: ctx.accounts.user_reward_ata.to_account_info(),
                    authority: ctx.accounts.bribe_vault.to_account_info(),
                },
                &[seeds],
            ),
            claimable,
        )?;

        // Stamp the claim PDA (existence = guard against replay)
        ctx.accounts.user_bribe_claim.bump = ctx.bumps.user_bribe_claim;
        Ok(())
    }

    /// Move remaining (unclaimed) bribe tokens from a past epoch into the current epoch vault.
    ///
    /// Two cases:
    ///   • Zero-vote pool (gauge absent or total_votes == 0): rollover allowed immediately
    ///     after the epoch ends — nobody can ever claim, so recycling is safe.
    ///   • Pool with votes: a ROLLOVER_DELAY_EPOCHS grace period is enforced so that
    ///     slow voters are not robbed before they get a chance to claim.
    ///
    /// Permissionless — anyone can call this for any (pool, token, old_epoch) triple.
    pub fn rollover_bribe(
        ctx: Context<RolloverBribe>,
        old_epoch: u64,
        new_epoch: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let curr_epoch = current_epoch(clock.unix_timestamp);

        require!(new_epoch == curr_epoch, SoladromeError::WrongEpoch);
        require!(old_epoch < curr_epoch, SoladromeError::EpochNotEnded);

        // Verify old_gauge_state is the canonical PDA for (pool, old_epoch)
        let old_epoch_le = old_epoch.to_le_bytes();
        let (expected_gauge, _) = Pubkey::find_program_address(
            &[
                b"gauge",
                ctx.accounts.pool_id.key().as_ref(),
                old_epoch_le.as_ref(),
            ],
            ctx.program_id,
        );
        require_keys_eq!(
            ctx.accounts.old_gauge_state.key(),
            expected_gauge,
            SoladromeError::Unauthorized
        );

        // Check whether the old gauge recorded any votes.
        // Ownership must be verified first: the canonical PDA address can be
        // pre-occupied by a third-party program, and only an account actually
        // owned by THIS program holds real GaugeState vote data. A foreign or
        // uninitialized account ⇒ no real votes ⇒ rollover is allowed immediately
        // (prevents a forged account from faking votes to force the grace period).
        let owned_by_program = ctx.accounts.old_gauge_state.owner == ctx.program_id;
        let gauge_data = ctx.accounts.old_gauge_state.try_borrow_data()?;
        let has_votes = owned_by_program
            && gauge_data.len() >= 56
            && u64::from_le_bytes(gauge_data[48..56].try_into().unwrap()) > 0;
        drop(gauge_data);

        if has_votes {
            require!(
                curr_epoch >= old_epoch.saturating_add(ROLLOVER_DELAY_EPOCHS),
                SoladromeError::RolloverTooEarly
            );
        }

        let amount = ctx.accounts.old_bribe_token_vault.amount;
        require!(amount > 0, SoladromeError::NothingToClaim);

        // Transfer: sign as old_bribe_vault PDA
        let pool_key = ctx.accounts.pool_id.key();
        let mint_key = ctx.accounts.reward_mint.key();
        let vault_bump = [ctx.accounts.old_bribe_vault.bump];
        let seeds: &[&[u8]] = &[
            b"bribe_vault",
            pool_key.as_ref(),
            mint_key.as_ref(),
            old_epoch_le.as_ref(),
            vault_bump.as_ref(),
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.old_bribe_token_vault.to_account_info(),
                    to: ctx.accounts.new_bribe_token_vault.to_account_info(),
                    authority: ctx.accounts.old_bribe_vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        // Initialise new vault on first rollover/deposit
        if ctx.accounts.new_bribe_vault.pool_id == Pubkey::default() {
            ctx.accounts.new_bribe_vault.pool_id = ctx.accounts.pool_id.key();
            ctx.accounts.new_bribe_vault.reward_mint = ctx.accounts.reward_mint.key();
            ctx.accounts.new_bribe_vault.epoch = new_epoch;
            ctx.accounts.new_bribe_vault.bump = ctx.bumps.new_bribe_vault;
        }

        ctx.accounts.new_bribe_vault.total_bribed = ctx
            .accounts
            .new_bribe_vault
            .total_bribed
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;

        Ok(())
    }

    /// One-time account migration — expands an existing UserPosition from the
    /// pre-`last_borrow_slot` layout (LEN=120, space=128) to the current layout
    /// (LEN=128, space=136).  The 8 new bytes are zeroed so last_borrow_slot=0.
    /// Permissionless per-user: the owner pays the extra rent and signs.
    pub fn migrate_user_position(_ctx: Context<MigrateUserPosition>) -> Result<()> {
        Ok(())
    }

    // ── AMM multi-pool instructions ───────────────────────────────────────────

    pub fn create_pool(
        ctx: Context<CreatePool>,
        fee_rate: u16,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        amm::create_pool(ctx, fee_rate, protocol_fee_bps)
    }

    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount_a_desired: u64,
        amount_b_desired: u64,
        min_lp: u64,
    ) -> Result<()> {
        amm::add_liquidity(ctx, amount_a_desired, amount_b_desired, min_lp)
    }

    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        lp_amount: u64,
        min_a: u64,
        min_b: u64,
    ) -> Result<()> {
        amm::remove_liquidity(ctx, lp_amount, min_a, min_b)
    }

    /// Claim accumulated oSOLA LP rewards without changing liquidity.
    pub fn claim_lp_rewards(ctx: Context<ClaimLpRewards>) -> Result<()> {
        amm::claim_lp_rewards(ctx)
    }

    pub fn amm_swap(ctx: Context<Swap>, amount_in: u64, min_out: u64, a_to_b: bool) -> Result<()> {
        amm::swap(ctx, amount_in, min_out, a_to_b)
    }

    // Mint oSOLA to a recipient as LP reward. Authority-only.
    pub fn distribute_o_sola(ctx: Context<DistributeOSola>, amount: u64) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.paused,
            SoladromeError::ProtocolPaused
        );
        require!(amount > 0, SoladromeError::InvalidAmount);
        let bump = ctx.accounts.protocol_state.bump;

        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.o_sola_mint.to_account_info(),
                    to: ctx.accounts.recipient_o_sola.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }

    // ── Protocol-Owned Liquidity ──────────────────────────────────────────────

    /// One-time setup: create PolState and its token vaults. Authority-only.
    pub fn initialize_pol(
        ctx: Context<InitializePol>,
        pol_split_bps: u16,
        target_pool: Pubkey,
    ) -> Result<()> {
        pol::initialize_pol(ctx, pol_split_bps, target_pool)
    }

    /// Redirect a portion of market_vault fees to pol_usdc_vault. Authority-only.
    pub fn collect_to_pol(ctx: Context<CollectToPol>, amount: u64) -> Result<()> {
        pol::collect_to_pol(ctx, amount)
    }

    /// Buy SOLA via bonding curve and/or add LP to the target pool. Authority-only.
    pub fn deploy_pol(
        ctx: Context<DeployPol>,
        usdc_for_sola: u64,
        min_sola_out: u64,
        sola_for_lp: u64,
        usdc_for_lp: u64,
        min_lp: u64,
    ) -> Result<()> {
        pol::deploy_pol(
            ctx,
            usdc_for_sola,
            min_sola_out,
            sola_for_lp,
            usdc_for_lp,
            min_lp,
        )
    }

    // ── Ve-layer ──────────────────────────────────────────────────────────────

    /// Lock hiSOLA for ve-weighted governance power.
    /// Subsequent calls extend the lock or add tokens (never shorten).
    pub fn lock_hi_sola(
        ctx: Context<LockHiSola>,
        amount: u64,
        lock_duration_secs: u64,
    ) -> Result<()> {
        // Pause check is enforced inside ve::lock_hi_sola so all call-sites are covered.
        ve::lock_hi_sola(ctx, amount, lock_duration_secs)
    }

    /// Return locked hiSOLA after expiry. Restores tokens to the fee pool.
    pub fn unlock_hi_sola(ctx: Context<UnlockHiSola>) -> Result<()> {
        ve::unlock_hi_sola(ctx)
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

        let fee_rate = pool.fee_rate as u128;
        let fee_total = amount_osola as u128 * fee_rate / 10_000;
        let amount_net = (amount_osola as u128 - fee_total) as u64;

        let (reserve_in, reserve_out) = if sola_is_a {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };

        let usdc_out = amm_math::swap_out(reserve_in, reserve_out, amount_net)?;

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
        let fee_total_u64 = fee_total as u64;
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
        let pool = &mut ctx.accounts.pool;
        amm::advance_pool_rewards(pool, clock_now);
        if sola_is_a {
            pool.reserve_a = pool
                .reserve_a
                .checked_add(amount_net)
                .ok_or(SoladromeError::Overflow)?;
            pool.reserve_b = pool
                .reserve_b
                .checked_sub(usdc_out)
                .ok_or(SoladromeError::Overflow)?;
        } else {
            pool.reserve_b = pool
                .reserve_b
                .checked_add(amount_net)
                .ok_or(SoladromeError::Overflow)?;
            pool.reserve_a = pool
                .reserve_a
                .checked_sub(usdc_out)
                .ok_or(SoladromeError::Overflow)?;
        }

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
            .checked_mul(state::CALLER_ARB_SHARE_BPS as u128)
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
}

// ── Account Contexts ──────────────────────────────────────────────────────────

/// Shared context for pause / unpause — authority-only.
#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [STATE_SEED],
        bump = protocol_state.bump,
        has_one = authority @ SoladromeError::Unauthorized,
    )]
    pub protocol_state: Account<'info, ProtocolState>,
}

/// Transfer protocol authority to a new pubkey (e.g. Squads multisig vault).
/// Current authority must sign; new_authority is just a pubkey — no signature required
/// (Squads vault is a PDA and cannot sign directly).
#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    /// Current authority — must sign to approve the transfer.
    pub authority: Signer<'info>,

    /// CHECK: arbitrary pubkey — can be a Squads vault PDA or any wallet.
    /// Validation is intentionally minimal: the new authority takes effect immediately.
    pub new_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [STATE_SEED],
        bump = protocol_state.bump,
        has_one = authority @ SoladromeError::Unauthorized,
    )]
    pub protocol_state: Account<'info, ProtocolState>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = ProtocolState::LEN,
        seeds = [STATE_SEED],
        bump,
    )]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        mint::decimals = 6,
        mint::authority = protocol_state,
        seeds = [b"sola_mint"],
        bump,
    )]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        mint::decimals = 6,
        mint::authority = protocol_state,
        seeds = [b"hi_sola_mint"],
        bump,
    )]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        mint::decimals = 6,
        mint::authority = protocol_state,
        seeds = [b"o_sola_mint"],
        bump,
    )]
    pub o_sola_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = authority,
        token::mint = usdc_mint,
        token::authority = protocol_state,
        seeds = [FLOOR_VAULT_SEED],
        bump,
    )]
    pub floor_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        token::mint = usdc_mint,
        token::authority = protocol_state,
        seeds = [MARKET_VAULT_SEED],
        bump,
    )]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        token::mint = sola_mint,
        token::authority = protocol_state,
        seeds = [SOLA_VAULT_SEED],
        bump,
    )]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
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
pub struct StakeSola<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = sola_mint, token::authority = user)]
    pub user_sola: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = hi_sola_mint,
        associated_token::authority = user,
    )]
    pub user_hi_sola: Box<Account<'info, TokenAccount>>,

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

    #[account(mut, address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Account<'info, Mint>,

    #[account(mut, token::mint = hi_sola_mint, token::authority = user)]
    pub user_hi_sola: Box<Account<'info, TokenAccount>>,

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

    /// Founder vesting schedule — required when caller is FOUNDER_WALLET to
    /// enforce the hiSOLA vesting lock on mainnet. Non-founder callers must
    /// pass the SystemProgram pubkey; the check is skipped for them.
    /// CHECK: validated only when caller == FOUNDER_WALLET (mainnet).
    pub founder_hi_vesting: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BorrowUsdc<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Account<'info, Mint>,

    #[account(token::mint = hi_sola_mint, token::authority = user)]
    pub user_hi_sola: Account<'info, TokenAccount>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Account<'info, TokenAccount>,

    /// Receives the 2 % origination fee → distributed to hiSOLA stakers.
    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Account<'info, TokenAccount>,

    // M-04 FIX: enforce token::authority so borrowed USDC cannot be silently
    // routed to market_vault or any other protocol account, which would allow
    // converting a borrow into artificial fee income claimable via claim_fees.
    #[account(
        mut,
        constraint = user_usdc.mint  == protocol_state.usdc_mint @ SoladromeError::InvalidAmount,
        constraint = user_usdc.owner == user.key()               @ SoladromeError::Unauthorized,
    )]
    pub user_usdc: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump,
    )]
    pub user_position: Account<'info, UserPosition>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RepayUsdc<'info> {
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(
        mut,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump = user_position.bump,
    )]
    pub user_position: Account<'info, UserPosition>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_usdc.mint == protocol_state.usdc_mint @ SoladromeError::InvalidAmount,
        token::authority = user,
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

#[derive(Accounts)]
pub struct DistributeOSola<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Recipient wallet — validated implicitly by ATA derivation below.
    pub recipient: UncheckedAccount<'info>,

    #[account(
        seeds = [STATE_SEED],
        bump = protocol_state.bump,
        has_one = authority @ SoladromeError::Unauthorized,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = o_sola_mint,
        associated_token::authority = recipient,
    )]
    pub recipient_o_sola: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Account<'info, Mint>,

    /// User's hiSOLA balance determines their fee share.
    #[account(token::mint = hi_sola_mint, token::authority = user)]
    pub user_hi_sola: Account<'info, TokenAccount>,

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

// ── MintFounderAllocation ─────────────────────────────────────────────────────
// Initialises vesting schedules only — zero tokens minted here.
#[derive(Accounts)]
pub struct MintFounderAllocation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [STATE_SEED],
        bump = protocol_state.bump,
        has_one = authority @ SoladromeError::Unauthorized,
    )]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// Founder wallet — hardcoded, cannot be substituted.
    #[account(
        address = FOUNDER_WALLET.parse::<Pubkey>().unwrap() @ SoladromeError::Unauthorized,
    )]
    pub founder: SystemAccount<'info>,

    /// hiSOLA progressive vesting schedule (7M, cliff + linear).
    #[account(
        init,
        payer = authority,
        space = 8 + FounderHiSolaVesting::LEN,
        seeds = [FOUNDER_HI_VESTING_SEED],
        bump,
    )]
    pub founder_hi_vesting: Account<'info, FounderHiSolaVesting>,

    /// oSOLA progressive vesting schedule (5M, cliff + linear).
    #[account(
        init,
        payer = authority,
        space = 8 + FounderVesting::LEN,
        seeds = [b"founder_vesting"],
        bump,
    )]
    pub founder_vesting: Account<'info, FounderVesting>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ── Ecosystem allocation context ─────────────────────────────────────────────

#[derive(Accounts)]
pub struct MintEcosystemAllocation<'info> {
    #[account(mut, address = protocol_state.authority @ SoladromeError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    /// Authority's SOLA ATA — receives the ecosystem allocation (1 750 000 SOLA).
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = sola_mint,
        associated_token::authority = authority,
    )]
    pub authority_sola: Box<Account<'info, TokenAccount>>,

    /// CHECK: hardcoded founder wallet — receives FOUNDER_IMMEDIATE_SOLA (250 000 SOLA).
    #[account(address = FOUNDER_WALLET.parse::<Pubkey>().unwrap() @ SoladromeError::Unauthorized)]
    pub founder: UncheckedAccount<'info>,

    /// Founder's SOLA ATA — created here if it doesn't exist yet.
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = sola_mint,
        associated_token::authority = founder,
    )]
    pub founder_sola: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ── ClaimFounderHiSola ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ClaimFounderHiSola<'info> {
    /// Only the hardcoded founder wallet may call this.
    #[account(
        mut,
        address = FOUNDER_WALLET.parse::<Pubkey>().unwrap() @ SoladromeError::Unauthorized,
    )]
    pub founder: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

    /// Receives freshly locked SOLA backing the claimed hiSOLA.
    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only — needed for accumulator snapshot before hiSOLA supply changes.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// Founder's hiSOLA ATA — created on first claim if needed.
    #[account(
        init_if_needed,
        payer = founder,
        associated_token::mint = hi_sola_mint,
        associated_token::authority = founder,
    )]
    pub founder_hi_sola: Box<Account<'info, TokenAccount>>,

    /// Founder's fee-share position — tracks fees_debt for claim_fees.
    #[account(
        init_if_needed,
        payer = founder,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, founder.key().as_ref()],
        bump,
    )]
    pub founder_position: Account<'info, UserPosition>,

    #[account(
        mut,
        seeds = [FOUNDER_HI_VESTING_SEED],
        bump = founder_hi_vesting.bump,
    )]
    pub founder_hi_vesting: Account<'info, FounderHiSolaVesting>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ── ClaimFounderVesting (oSOLA) ───────────────────────────────────────────────

#[derive(Accounts)]
pub struct ClaimFounderVesting<'info> {
    /// Only the hardcoded founder wallet may call this.
    #[account(
        mut,
        address = FOUNDER_WALLET.parse::<Pubkey>().unwrap() @ SoladromeError::Unauthorized,
    )]
    pub founder: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"founder_vesting"],
        bump = founder_vesting.bump,
    )]
    pub founder_vesting: Account<'info, FounderVesting>,

    /// Founder's oSOLA ATA — created on first claim if needed.
    #[account(
        init_if_needed,
        payer = founder,
        associated_token::mint = o_sola_mint,
        associated_token::authority = founder,
    )]
    pub founder_o_sola: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ── Founder borrow (capped) context ──────────────────────────────────────────

#[derive(Accounts)]
pub struct FounderBorrowUsdc<'info> {
    /// Only the hardcoded founder wallet may call this.
    #[account(
        mut,
        address = FOUNDER_WALLET.parse::<Pubkey>().unwrap() @ SoladromeError::Unauthorized,
    )]
    pub founder: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Account<'info, Mint>,

    /// Founder's hiSOLA balance — used as collateral ceiling.
    #[account(token::mint = hi_sola_mint, token::authority = founder)]
    pub founder_hi_sola: Account<'info, TokenAccount>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Account<'info, TokenAccount>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Account<'info, TokenAccount>,

    /// USDC mint — needed to init founder_usdc ATA on first borrow.
    #[account(address = protocol_state.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    /// Founder's USDC ATA — created on first borrow if needed.
    #[account(
        init_if_needed,
        payer = founder,
        associated_token::mint      = usdc_mint,
        associated_token::authority = founder,
    )]
    pub founder_usdc: Account<'info, TokenAccount>,

    /// Tracks founder's cumulative borrow (same seed as regular UserPosition).
    #[account(
        init_if_needed,
        payer = founder,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, founder.key().as_ref()],
        bump,
    )]
    pub founder_position: Account<'info, UserPosition>,

    /// Vesting schedule — supplies the `claimed` amount used for the 10 % cap.
    #[account(
        seeds = [FOUNDER_HI_VESTING_SEED],
        bump = founder_hi_vesting.bump,
    )]
    pub founder_hi_vesting: Account<'info, FounderHiSolaVesting>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ── Bribe system contexts ─────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct DepositBribe<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// Read-only — used only for the pause check.
    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// CHECK: External pool address used as bribe label — validation by seeds only.
    pub pool_id: UncheckedAccount<'info>,

    pub reward_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = reward_mint, token::authority = depositor)]
    pub depositor_token: Box<Account<'info, TokenAccount>>,

    /// Bribe metadata account. init_if_needed = multiple depositors additive.
    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + BribeVault::LEN,
        seeds = [b"bribe_vault", pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub bribe_vault: Box<Account<'info, BribeVault>>,

    /// Token account holding the deposited bribe tokens. Owned by bribe_vault PDA.
    #[account(
        init_if_needed,
        payer = depositor,
        token::mint = reward_mint,
        token::authority = bribe_vault,
        seeds = [b"bribe_tokens", pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub bribe_token_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Partner bribes in their committed token and is credited toward the streaming
/// allocation. Bribe vaults use the SAME seeds as DepositBribe → partner bribes
/// and ordinary bribes share one vault per (pool, mint, epoch); voters claim normally.
#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct PartnerDepositBribe<'info> {
    #[account(mut)]
    pub partner: Signer<'info>,

    /// Read-only — used only for the pause check.
    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// Partner allocation PDA — credited here. Verified by seeds + owner.
    #[account(
        mut,
        seeds = [PARTNER_SEED, partner.key().as_ref()],
        bump = partner_allocation.bump,
        constraint = partner_allocation.partner == partner.key() @ SoladromeError::Unauthorized,
    )]
    pub partner_allocation: Box<Account<'info, PartnerAllocation>>,

    /// CHECK: External pool address used as bribe label — validation by seeds only.
    pub pool_id: UncheckedAccount<'info>,

    pub reward_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = reward_mint, token::authority = partner)]
    pub partner_token: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = partner,
        space = 8 + BribeVault::LEN,
        seeds = [b"bribe_vault", pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub bribe_vault: Box<Account<'info, BribeVault>>,

    #[account(
        init_if_needed,
        payer = partner,
        token::mint = reward_mint,
        token::authority = bribe_vault,
        seeds = [b"bribe_tokens", pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub bribe_token_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
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

    #[account(address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

    /// Caller's hiSOLA balance determines base vote power.
    #[account(constraint = user_hi_sola.mint == hi_sola_mint.key() && user_hi_sola.owner == user.key())]
    pub user_hi_sola: Box<Account<'info, TokenAccount>>,

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

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct ClaimBribe<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: Pool label — validated by seeds derivation.
    pub pool_id: UncheckedAccount<'info>,

    pub reward_mint: Box<Account<'info, Mint>>,

    #[account(
        seeds = [b"bribe_vault", pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump = bribe_vault.bump,
    )]
    pub bribe_vault: Box<Account<'info, BribeVault>>,

    #[account(
        mut,
        seeds = [b"bribe_tokens", pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = bribe_vault,
    )]
    pub bribe_token_vault: Box<Account<'info, TokenAccount>>,

    /// Destination — created if the user doesn't already hold this token.
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = reward_mint,
        associated_token::authority = user,
    )]
    pub user_reward_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        seeds = [b"gauge", pool_id.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump = gauge_state.bump,
    )]
    pub gauge_state: Box<Account<'info, GaugeState>>,

    #[account(
        seeds = [b"vote", user.key().as_ref(), pool_id.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump = user_vote_receipt.bump,
    )]
    pub user_vote_receipt: Box<Account<'info, UserVoteReceipt>>,

    /// Created by this instruction — its existence is the double-claim guard.
    #[account(
        init,
        payer = user,
        space = 8 + UserBribeClaim::LEN,
        seeds = [b"bribe_claim", user.key().as_ref(), pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub user_bribe_claim: Account<'info, UserBribeClaim>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Transfer remaining bribe tokens from a past epoch's vault into the current epoch's vault.
/// Permissionless — callable by anyone once the grace period has passed.
#[derive(Accounts)]
#[instruction(old_epoch: u64, new_epoch: u64)]
pub struct RolloverBribe<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Pool label — seeds validated in instruction body.
    pub pool_id: UncheckedAccount<'info>,

    pub reward_mint: Box<Account<'info, Mint>>,

    /// Source: old epoch bribe metadata.
    #[account(
        seeds = [b"bribe_vault", pool_id.key().as_ref(), reward_mint.key().as_ref(), old_epoch.to_le_bytes().as_ref()],
        bump = old_bribe_vault.bump,
    )]
    pub old_bribe_vault: Box<Account<'info, BribeVault>>,

    /// Source: old epoch token vault.
    #[account(
        mut,
        seeds = [b"bribe_tokens", pool_id.key().as_ref(), reward_mint.key().as_ref(), old_epoch.to_le_bytes().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = old_bribe_vault,
    )]
    pub old_bribe_token_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: GaugeState for (pool, old_epoch) — may be absent if no votes were cast.
    /// PDA seeds [b"gauge", pool_id, old_epoch_le8] verified in instruction body.
    pub old_gauge_state: UncheckedAccount<'info>,

    /// Destination: current epoch bribe metadata (created if not yet seeded).
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + BribeVault::LEN,
        seeds = [b"bribe_vault", pool_id.key().as_ref(), reward_mint.key().as_ref(), new_epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub new_bribe_vault: Box<Account<'info, BribeVault>>,

    /// Destination: current epoch token vault (created if not yet seeded).
    #[account(
        init_if_needed,
        payer = payer,
        token::mint = reward_mint,
        token::authority = new_bribe_vault,
        seeds = [b"bribe_tokens", pool_id.key().as_ref(), reward_mint.key().as_ref(), new_epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub new_bribe_token_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Expands an existing UserPosition account from the old 128-byte layout to
/// the current 136-byte layout.  The 8 extra bytes are zeroed (last_borrow_slot=0).
#[derive(Accounts)]
pub struct MigrateUserPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        realloc = 8 + UserPosition::LEN,
        realloc::payer = user,
        realloc::zero = true,
        seeds = [POSITION_SEED, user.key().as_ref()],
        bump = user_position.bump,
    )]
    pub user_position: Account<'info, UserPosition>,

    pub system_program: Program<'info, System>,
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

    /// Epoch vote tracker — created on first burn if it doesn't exist yet.
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserEpochVotes::LEN,
        seeds = [b"uev", user.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub user_epoch_votes: Box<Account<'info, UserEpochVotes>>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent:           Sysvar<'info, Rent>,
}

// ── LP Emission contexts ──────────────────────────────────────────────────────

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

    #[account(
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

// ── Contributor / marketing vesting contexts ──────────────────────────────────

/// Authority registers a contributor wallet with hiSOLA + oSOLA allocations.
/// Called once per contributor (at launch). Vesting starts immediately.
#[derive(Accounts)]
pub struct RegisterContributor<'info> {
    #[account(
        mut,
        address = protocol_state.authority @ SoladromeError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    /// CHECK: The beneficiary wallet — identity enforced by PDA seeds.
    pub contributor_wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + ContributorVesting::LEN,
        seeds = [CONTRIBUTOR_SEED, contributor_wallet.key().as_ref()],
        bump,
    )]
    pub contributor_vesting: Account<'info, ContributorVesting>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Contributor claims vested hiSOLA (governance + borrow collateral tranche).
/// Mints SOLA to sola_vault + hiSOLA to contributor 1:1. Advances fee accumulator.
#[derive(Accounts)]
pub struct ClaimContributorHiSola<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only — needed for accumulator snapshot before hiSOLA supply changes.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// Contributor's hiSOLA ATA — created on first claim if needed.
    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint      = hi_sola_mint,
        associated_token::authority = contributor,
    )]
    pub contributor_hi_sola: Box<Account<'info, TokenAccount>>,

    /// Fee-share position — init on first claim; tracks fees_debt.
    #[account(
        init_if_needed,
        payer = contributor,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, contributor.key().as_ref()],
        bump,
    )]
    pub contributor_position: Account<'info, UserPosition>,

    #[account(
        mut,
        seeds = [CONTRIBUTOR_SEED, contributor.key().as_ref()],
        bump = contributor_vesting.bump,
        constraint = contributor_vesting.contributor == contributor.key() @ SoladromeError::Unauthorized,
    )]
    pub contributor_vesting: Account<'info, ContributorVesting>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Contributor claims vested oSOLA (liquid options tranche).
/// Mints oSOLA to contributor — floor-neutral until exercised.
#[derive(Accounts)]
pub struct ClaimContributorVesting<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut, address = protocol_state.o_sola_mint)]
    pub o_sola_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [CONTRIBUTOR_SEED, contributor.key().as_ref()],
        bump = contributor_vesting.bump,
        constraint = contributor_vesting.contributor == contributor.key() @ SoladromeError::Unauthorized,
    )]
    pub contributor_vesting: Account<'info, ContributorVesting>,

    /// Contributor's oSOLA ATA — created on first claim if needed.
    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint      = o_sola_mint,
        associated_token::authority = contributor,
    )]
    pub contributor_o_sola: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Contributor borrows USDC against hiSOLA collateral.
/// Cap = 10% of monthly hiSOLA installment = hi_sola_amount / 120.
/// Flash-borrow guard: repay_usdc requires a strictly later slot.
#[derive(Accounts)]
pub struct ContributorBorrowUsdc<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Account<'info, Mint>,

    /// Contributor's hiSOLA balance — collateral ceiling for the borrow.
    /// Mirrors founder_borrow_usdc: borrow cannot exceed real on-chain hiSOLA held.
    #[account(token::mint = hi_sola_mint, token::authority = contributor)]
    pub contributor_hi_sola: Account<'info, TokenAccount>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Account<'info, TokenAccount>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Account<'info, TokenAccount>,

    /// USDC mint — needed to init contributor_usdc ATA on first borrow.
    #[account(address = protocol_state.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    /// Contributor's USDC ATA — created on first borrow if needed.
    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint      = usdc_mint,
        associated_token::authority = contributor,
    )]
    pub contributor_usdc: Account<'info, TokenAccount>,

    /// Shared UserPosition PDA — same seed as regular users, enables repay_usdc.
    #[account(
        init_if_needed,
        payer = contributor,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, contributor.key().as_ref()],
        bump,
    )]
    pub contributor_position: Account<'info, UserPosition>,

    #[account(
        mut,
        seeds = [CONTRIBUTOR_SEED, contributor.key().as_ref()],
        bump = contributor_vesting.bump,
        constraint = contributor_vesting.contributor == contributor.key() @ SoladromeError::Unauthorized,
    )]
    pub contributor_vesting: Account<'info, ContributorVesting>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ── Protocol Partner allocation ───────────────────────────────────────────────

/// Authority-only: register a protocol partner allocation.
/// Creates a PartnerAllocation PDA keyed on the partner's wallet.
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
/// hiSOLA is minted directly to ve_lock_vault — wallet never receives hiSOLA.
/// VeLockPosition is created; UserPosition.fees_debt is snapshotted.
#[derive(Accounts)]
pub struct ClaimPartnerAllocation<'info> {
    #[account(mut)]
    pub partner: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    #[account(mut, address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

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

    /// Token vault holding locked hiSOLA.
    /// hiSOLA is minted directly here — wallet balance stays 0, blocking borrow.
    #[account(
        init_if_needed,
        payer = partner,
        token::mint      = hi_sola_mint,
        token::authority = lock_position,
        seeds = [VE_VAULT_SEED, partner.key().as_ref()],
        bump,
    )]
    pub ve_lock_vault: Box<Account<'info, TokenAccount>>,

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


// ── Vote carry-over ───────────────────────────────────────────────────────────

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

    #[account(address = protocol_state.hi_sola_mint)]
    pub hi_sola_mint: Box<Account<'info, Mint>>,

    /// Owner's hiSOLA ATA — read-only, authority = user.
    #[account(
        constraint = user_hi_sola.mint == hi_sola_mint.key()
                  && user_hi_sola.owner == user.key()
    )]
    pub user_hi_sola: Box<Account<'info, TokenAccount>>,

    /// CHECK: Optional VeLockPosition [b"velock", user].
    /// Pass SystemProgram when owner has no lock.
    pub lock_position: UncheckedAccount<'info>,

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

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ── Emission decay configuration ──────────────────────────────────────────────

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
