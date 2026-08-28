// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Authority-only lifecycle: initialization, pausing, phase flags and fee configuration.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::math::*;
use crate::state::*;

/// `founder_wallet` is write-once and has no setter — see the note at the head of this
/// file. On mainnet it must be the Ledger `46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4`;
/// verify it on-chain before calling `mint_founder_allocation`, because after that the
/// 12.25M is committed to whatever address is stored here.
pub fn initialize(ctx: Context<Initialize>, founder_wallet: Pubkey) -> Result<()> {
    // `Pubkey::default()` is the one value that must never be stored: it is what an
    // un-migrated legacy account reads, and the founder guards treat it as "fail closed".
    // Accepting it at init would create a protocol whose founder paths are permanently
    // dead with no way to fix them, since there is no setter.
    require_keys_neq!(
        founder_wallet,
        Pubkey::default(),
        SoladromeError::InvalidAmount
    );
    let clock = Clock::get()?;
    let s = &mut ctx.accounts.protocol_state;
    s.authority = ctx.accounts.authority.key();
    s.founder_wallet = founder_wallet;
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
    // ── Epoch emission decay — recalibrated 2026-08-09 ───────────────────
    // 20 000 oSOLA/epoch, −1%/epoch, floor 25% (5 000). Reaches the floor at epoch 137
    // (~2.6 y); ~0.81M emitted in year 1, ~1.5M by the floor, then 0.26M/year forever.
    //
    // The 20 000 start is a deliberate launch incentive to pull liquidity in: at the
    // $2-5M TVL a gated launch actually opens with, it pays 4-20% APR. The DECAY is what
    // makes it a launch boost rather than a permanent level — which is why the floor is
    // 25% and not 50%. Same starting pull, but it tapers 4× over 2.6 years and settles
    // at 5 000/epoch, the same steady-state a flat 10 000/epoch would have reached. A
    // 50% floor would have locked in 10 000/epoch forever — doubling the perpetual
    // commitment for no extra launch effect.
    //
    // WHY SO MUCH LOWER THAN THE PREVIOUS 800 000: emissions are a SUPPORT yield for
    // partner pools (LSTs, stables); the real partner return comes from bribes. An oSOLA
    // is an option struck at the 1 USDC floor, so its value is `price − 1` and the APR is
    // `annual_emission × (price − 1) / TVL`. At 800 000/epoch a $10M TVL paid 163% APR on
    // a mere ×1.5 move and 1 303% at ×5 — the "5 000% farm" profile this protocol
    // explicitly does not sell. The modelled band for 1-2% support yield over a
    // 10M→100M TVL path is 5 000–15 000/epoch. See `scripts/emissions/`.
    //
    // WHY THE FLOOR MOVED OFF 1 875: with TVL growing while emission decays, the two
    // compressions multiply (TVL ×10 and emission ÷10 = APR ÷100), so a low floor lets
    // the support yield collapse to noise. What matters is the floor in ABSOLUTE terms —
    // 5 000 oSOLA/epoch — not the ratio; the ratio only sets how fast the launch boost
    // decays into it.
    //
    // Adjustable at any time via `configure_emissions` (Squads multisig). Note the
    // asymmetry: raising reads as a gift, cutting reads as a nerf and drives LPs away —
    // so the perpetual tail is the number to keep conservative, not the starting point.
    s.osola_emission_initial = 20_000_000_000; // 20 000 oSOLA (6 dec)
    s.osola_emission_decay_bps = 9_900; // −1 % per epoch
    s.osola_emission_floor_bps = 2_500; // floor = 5 000 oSOLA (25 %)
    s.osola_emission_start_epoch = current_epoch(clock.unix_timestamp);
    // Continuous (Masterchef) bootstrap stream OFF until the authority calls
    // `configure_continuous_emissions`. rate 0 + end_epoch 0 => never accrues.
    s.continuous_rate_per_sec = 0;
    s.continuous_end_epoch = 0;

    // Closed launch: LP creation, bribes, voting, oSOLA exercise AND the
    // bonding curve all start disabled. Two-stage open via `set_phase_flags`:
    // stage 1 (partner-only window) enables lp/bribes/voting for founding
    // partners while the curve stays closed; stage 2 (public open) flips
    // `curve_enabled` — curve opening, TGE and airdrop are one event.
    s.lp_enabled = false;
    s.bribes_enabled = false;
    s.voting_enabled = false;
    s.exercise_enabled = false;
    s.curve_enabled = false;
    // oSOLA emission (both the epoch/gauge path and the continuous stream)
    // starts disabled — armed only via set_phase_flags, and only once the
    // per-epoch cycle has been audited (pre-Genesis, not pre-launch).
    s.emissions_enabled = false;
    // oSOLA exercise fee: 10 % of the gain (never of the strike — see
    // DEFAULT_EXERCISE_FEE_BPS). Tunable post-launch via `set_exercise_fee`.
    s.exercise_fee_bps = DEFAULT_EXERCISE_FEE_BPS;
    Ok(())
}

pub fn pause(ctx: Context<SetPaused>) -> Result<()> {
    ctx.accounts.protocol_state.paused = true;
    Ok(())
}

pub fn unpause(ctx: Context<SetPaused>) -> Result<()> {
    ctx.accounts.protocol_state.paused = false;
    Ok(())
}

/// Authority-only break-glass: enable/disable founder gauge voting.
/// Default is disabled — the founder's 7M hiSOLA is a dormant anti-capture
/// reserve. Flip to `true` only to counter a detected governance takeover.
pub fn set_founder_voting(ctx: Context<SetPaused>, enabled: bool) -> Result<()> {
    ctx.accounts.protocol_state.founder_voting_enabled = enabled;
    msg!("Founder voting enabled = {}", enabled);
    Ok(())
}

/// Authority-only: toggle the closed-launch feature gates independently.
/// `None` leaves a flag untouched, so a single call can flip only one gate
/// (e.g. enabling LP for one partner integration) without disturbing the rest.
pub fn set_phase_flags(
    ctx: Context<SetPaused>,
    lp_enabled: Option<bool>,
    bribes_enabled: Option<bool>,
    voting_enabled: Option<bool>,
    exercise_enabled: Option<bool>,
    curve_enabled: Option<bool>,
    emissions_enabled: Option<bool>,
) -> Result<()> {
    let state = &mut ctx.accounts.protocol_state;
    if let Some(v) = lp_enabled {
        state.lp_enabled = v;
    }
    if let Some(v) = bribes_enabled {
        state.bribes_enabled = v;
    }
    if let Some(v) = voting_enabled {
        state.voting_enabled = v;
    }
    if let Some(v) = exercise_enabled {
        state.exercise_enabled = v;
    }
    if let Some(v) = curve_enabled {
        state.curve_enabled = v;
    }
    if let Some(v) = emissions_enabled {
        state.emissions_enabled = v;
    }
    msg!(
        "Phase flags: lp={} bribes={} voting={} exercise={} curve={} emissions={}",
        state.lp_enabled,
        state.bribes_enabled,
        state.voting_enabled,
        state.exercise_enabled,
        state.curve_enabled,
        state.emissions_enabled,
    );
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

/// Authority-only: set the oSOLA exercise fee, in basis points **of the gain**.
///
/// `fee = bps × (curve_price − 1) × amount`, charged on top of the 1 USDC strike and
/// routed to `market_vault` → hiSOLA stakers. Because the fee scales with the gain,
/// any value below 10 000 leaves exercise profitable by construction; the
/// `MAX_EXERCISE_FEE_BPS` cap exists so the authority cannot destroy oSOLA's value as
/// an LP incentive, not to protect solvency (the floor is untouched either way).
///
/// `bps = 0` disables the fee and restores the pre-2026-08-05 behaviour exactly.
/// This is also what a live singleton reads before this instruction is ever called,
/// so the upgrade is a no-op until the authority arms it — unlike the phase flags,
/// nothing bricks if it is forgotten.
pub fn set_exercise_fee(ctx: Context<SetExerciseFee>, bps: u16) -> Result<()> {
    require!(bps <= MAX_EXERCISE_FEE_BPS, SoladromeError::InvalidAmount);
    let s = &mut ctx.accounts.protocol_state;
    let previous = s.exercise_fee_bps;
    s.exercise_fee_bps = bps;
    msg!("Exercise fee set: {} bps of gain (was {})", bps, previous);
    Ok(())
}

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

/// Authority-only: set the oSOLA exercise fee (basis points **of the gain**).
#[derive(Accounts)]
pub struct SetExerciseFee<'info> {
    #[account(
        mut,
        address = protocol_state.authority @ SoladromeError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,
}
