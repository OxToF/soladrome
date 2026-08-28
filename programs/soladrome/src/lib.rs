// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

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
    current_epoch, BribeVault, ContributorRegistry, ContributorVesting, FounderHiSolaVesting,
    FounderVesting, GaugeState, GlobalEpochVotes, LpEpochClaim, LpPoolEpochAccum, LpUserCheckpoint,
    LpUserInfo, PartnerAllocation, PartnerBribeStream, ProtocolState, UserBribeClaim,
    UserEpochVotes, UserPosition, UserVoteConfig, UserVoteReceipt, VeLockPosition, EPOCH_DURATION,
    FLOOR_RESERVE_MIN_BPS, MAX_LOCK_DURATION, MIN_LOCK_DURATION, PRECISION, VESTING_CLIFF_SECS,
    VESTING_DURATION_SECS,
};
#[allow(ambiguous_glob_reexports)]
pub use ve::*;

/// Canonical dead address for MINIMUM_LIQUIDITY lock (System Program address).
pub const LP_DEAD_PUBKEY: Pubkey = anchor_lang::system_program::ID;

declare_id!("DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe");

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
/// Global custody vault for hiSOLA immobilised by voting. Per-user amounts live in
/// `UserPosition.vote_escrowed`; the vault itself is a single protocol-owned account.
pub const VOTE_ESCROW_SEED: &[u8] = b"vote_escrow";

// Market-curve depth. Must stay equal so the start price = floor = 1 USDC/SOLA.
// N = 1M sizes price discovery, NOT supply: exercise_o_sola mints outside the curve.
// price = (1 + U/N)² and SOLA emitted = N × (1 − 1/√price), U = cumulative USDC bought.
// At N = 1M: ×2 needs 414k USDC, ×10 needs 2.16M. k = 1e24, set once at `initialize`.
pub const INIT_VIRTUAL_USDC: u64 = 1_000_000_000_000; // 1 000 000 USDC (6 dec)
pub const INIT_VIRTUAL_SOLA: u64 = 1_000_000_000_000; // 1 000 000 SOLA (6 dec)  – floor = 1:1

/// Total oSOLA minted per epoch, split proportionally across voted pools (legacy gauge system).
pub const LP_EMISSION_PER_EPOCH: u64 = 10_000 * 1_000_000; // 10 000 oSOLA (6 dec)

/// Maximum voting power any single address may allocate in one epoch,
/// expressed as a fraction of total_hi_sola (basis points, 10 000 = 100%).
/// 3 000 bps = 30% — prevents governance capture by a single actor while
/// remaining more restrictive than Aerodrome/Velodrome (which have no cap).
pub const VOTE_WEIGHT_CAP_BPS: u64 = 3_000;

// Continuous Masterchef-style oSOLA emission is now authority-configured at
// runtime (`ProtocolState.continuous_rate_per_sec`, set via
// `configure_continuous_emissions`) and gated by a per-pool flag + an on-chain
// expiry epoch. The old compile-time `OSOLA_EMISSION_PER_SEC` const was removed.

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
/// Team tranche, delivered at ecosystem-allocation time as hiSOLA locked FOR LIFE into a ve
/// position (`permanent_amount` = full tranche — never liquid SOLA, see
/// mint_ecosystem_allocation). Pays the people who worked unpaid until launch. Votes as an
/// ordinary user; borrows 20% via borrow_against_locked.
pub const FOUNDER_IMMEDIATE_SOLA: u64 = 250_000_000_000; //    250 000 → hiSOLA, lifetime ve lock
/// One-time origination fee on each borrow (like Beradrome). Sent to market_vault → hiSOLA stakers.
pub const BORROW_FEE_BPS: u64 = 200; //  2 % of borrowed amount

/// Default oSOLA exercise fee — 10 % **of the gain**, not of the notional.
///
/// ⚠️ Do NOT read this as "the same 2 % as BORROW_FEE_BPS with a different number".
/// The two fees have unrelated bases: `BORROW_FEE_BPS` is a share of the amount
/// borrowed, while this is a share of `(curve_price − 1) × amount`, i.e. of the
/// arbitrage spread the option holder captures. At a curve price of 2, 10 % here is
/// 0.10 USDC per SOLA and the exerciser still pays 1.10 for an asset worth 2 (+82 %).
/// The equivalent number on the notional would be ~2 000 bps of the strike.
///
/// Only written by `initialize`; live singletons read 0 (no fee) until the authority
/// calls `set_exercise_fee`.
pub const DEFAULT_EXERCISE_FEE_BPS: u16 = 1_000; // 10 % of the gain
/// Hard ceiling on `exercise_fee_bps`. Below 10 000 exercise stays profitable by
/// construction (the fee is a fraction of the gain), so this is not a solvency bound —
/// it is a guard against an authority setting a value that makes oSOLA worthless as an
/// LP incentive, which would be an economic self-inflicted wound, not an exploit.
pub const MAX_EXERCISE_FEE_BPS: u16 = 5_000; // 50 % of the gain
                                             // (FOUNDER_BORROW_CAP_BPS removed 2026-07-18 with founder_borrow_usdc — the 7M are ve-escrowed,
                                             //  so the founder's only borrow path is borrow_against_locked at PARTNER_BORROW_CAP_BPS, 20%.)

pub const FOUNDER_HI_VESTING_SEED: &[u8] = b"founder_hi_vesting";

// ── The founder wallet is NOT a constant any more (changed 2026-08-23) ───────
//
// It lives in `ProtocolState.founder_wallet`, written once by `initialize` and never
// writable again. What used to be here was the most dangerous constant in the program: two
// `#[cfg]` arms, a throwaway devnet key and the mainnet Ledger, selected by a feature that
// was ON BY DEFAULT. A plain `anchor build` produced the throwaway; shipping it to mainnet
// handed 12 250 000 SOLA to a key whose secret sits on a laptop, with the vesting cliff
// compiled down to 5 seconds in the same stroke.
//
// Inverting the default would only have swapped which mistake was silent. The real defect
// was that devnet and mainnet ran DIFFERENT CODE, so the binary under test was never the
// binary to be audited or deployed. Devnet 2 exists to run the mainnet build.
//
// The constant could not simply be set to the Ledger address either: no test can sign for a
// hardware wallet, in any harness — bankrun cannot forge a signature — so the entire 12.25M
// path would have gone back to zero coverage, which is exactly why the feature flag was
// introduced in the first place. Moving the address into state is what breaks that
// deadlock: one binary, and a test can initialise with a keypair it holds.
//
// The trust assumption is unchanged and the visibility is better. Whoever ran `initialize`
// is whoever used to run `anchor build`; the difference is that the result is now a public
// on-chain value anyone can read and check against the published address, instead of a
// string baked into a binary you would have to disassemble to verify.
//
// ⚠️ MAINNET DEPLOY: `initialize` takes the founder wallet as an argument and it is
// IMMUTABLE afterwards — there is no setter, by design. Passing the wrong address is not
// recoverable except by redeploying the whole protocol before anything is allocated. The
// value to pass is the Ledger Nano S dedicated to Soladrome, never used on another chain:
//
//     46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4
//
// It holds the 7M hiSOLA governance tranche (ve-locked for life, non-voting anti-capture
// reserve) and the 5M oSOLA vesting. Verify it on-chain right after init, before calling
// `mint_founder_allocation`:
//     solana account <ProtocolState PDA>   → founder_wallet must read 46Aqf…

// Team wallet — receives the 250k tranche as hiSOLA locked FOR LIFE (not liquid SOLA).
// Distinct from FOUNDER_WALLET so it can vote as an ordinary user: the founder-voting
// guard blocks only FOUNDER_WALLET, never this one. That asymmetry is deliberate — the 7M
// is a dormant anti-capture reserve, this is contributor compensation.
pub const TEAM_WALLET: &str = "BVaJbgw3NF7Ng28sHorBnzJrHgvu7S3L5wpdB6923LjA";

// ── Contributor / marketing allocation ────────────────────────────────────────
pub const CONTRIBUTOR_SEED: &[u8] = b"contributor";
pub const CONTRIBUTOR_REGISTRY_SEED: &[u8] = b"contributor_registry";
// (CONTRIBUTOR_BORROW_CAP_BPS removed 2026-07-18 with contributor_borrow_usdc — the
//  contributor bag is ve-escrowed, so its only borrow path is borrow_against_locked, 20%.)

/// Ceiling on contributor hiSOLA, summed over every contributor ever registered.
///
/// Until 2026-08-27 there was none: `register_contributor` checked only that one of the two
/// amounts was non-zero, so the published "a handful of people, small amounts" was enforced by
/// the shape of a form field and nothing else. The tranche now earns protocol fees
/// (`fee_shares`), which turns an unbounded field into unbounded dilution of every staker.
///
/// 100 000 of each is what the tranche is supposed to be. It is the one number in the
/// allocation matrix constrained by nothing but intent, which is exactly why it belongs in a
/// `require!` rather than in a document.
pub const CONTRIBUTOR_HI_SOLA_CAP: u64 = 100_000_000_000; // 100 000 hiSOLA (6 dec)
/// Ceiling on contributor oSOLA, summed over every contributor ever registered.
/// Not drawn from `ECOSYSTEM_TOTAL`, which caps `distribute_o_sola` alone.
pub const CONTRIBUTOR_O_SOLA_CAP: u64 = 100_000_000_000; // 100 000 oSOLA (6 dec)

// ── Protocol Partner allocation ───────────────────────────────────────────────
pub const PARTNER_SEED: &[u8] = b"partner";
pub const BRIBE_STREAM_SEED: &[u8] = b"bribe_stream";
pub const STREAM_TOKENS_SEED: &[u8] = b"stream_tokens";
/// Partner borrow cap: max 20 % of their vote-locked hiSOLA position.
/// Partner positions are locked (wallet balance = 0), so they borrow against the
/// ve_lock_vault via `borrow_against_locked`. The 75 % floor buffer still applies.
pub const PARTNER_BORROW_CAP_BPS: u64 = 2_000; // 20 %

// ── Vote carry-over ───────────────────────────────────────────────────────────
pub const VOTE_CONFIG_SEED: &[u8] = b"vote_config";

#[program]
pub mod soladrome {
    use super::*;

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

    /// Authority-only: grow the `protocol_state` singleton to the current
    /// `ProtocolState::LEN`.
    ///
    /// A program redeploy never changes the size of an existing account, and
    /// `LEN` only sizes NEW accounts at `init` — so when a field is appended
    /// past an already-allocated singleton's capacity, the account must be
    /// resized in place or every instruction that loads it fails with
    /// AccountDidNotDeserialize (3003).
    ///
    /// `protocol_state` is an `UncheckedAccount` because `Account<ProtocolState>`
    /// would itself fail to deserialize the short account — the very bug this
    /// fixes. Safety is preserved anyway: the seeds constraint pins the
    /// canonical PDA, and the handler checks program ownership, the account
    /// discriminator, and that the signer matches the stored authority (first
    /// field after the discriminator, bytes 8..40). Grown bytes are
    /// zero-initialized by the runtime, so appended fields read their correct
    /// zero default. Idempotent: once the account is at LEN, calls are no-ops.
    pub fn migrate_protocol_state(
        ctx: Context<MigrateProtocolState>,
        founder_wallet: Pubkey,
    ) -> Result<()> {
        let info = ctx.accounts.protocol_state.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, SoladromeError::Unauthorized);
        {
            let data = info.try_borrow_data()?;
            require!(
                data.len() >= 40 && data[..8] == ProtocolState::DISCRIMINATOR[..],
                SoladromeError::Unauthorized
            );
            let stored_authority = Pubkey::new_from_array(data[8..40].try_into().unwrap());
            require_keys_eq!(
                stored_authority,
                ctx.accounts.authority.key(),
                SoladromeError::Unauthorized
            );
        }
        let new_len = ProtocolState::LEN;
        if info.data_len() < new_len {
            // Top up rent-exemption for the new size before growing.
            let rent_needed = Rent::get()?.minimum_balance(new_len);
            let delta = rent_needed.saturating_sub(info.lamports());
            if delta > 0 {
                anchor_lang::system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        anchor_lang::system_program::Transfer {
                            from: ctx.accounts.authority.to_account_info(),
                            to: info.clone(),
                        },
                    ),
                    delta,
                )?;
            }
            info.resize(new_len)?;
            msg!("protocol_state resized to {} bytes", new_len);
        }

        // ── Backfill `founder_wallet` on a deployment that predates the field ──────────
        //
        // The realloc above zero-fills, so a migrated singleton reads `Pubkey::default()`
        // here — which matches no signer, so every founder guard fails CLOSED until this
        // runs. That ordering is deliberate: an un-backfilled protocol refuses founder
        // actions rather than accepting anyone's.
        //
        // Write-once, exactly like `initialize`: only a still-default field may be set, and
        // only while `founder_allocated` is false. After the allocation is minted the address
        // is frozen for good, so this migration can never redirect a live 12.25M tranche —
        // the same immutability the hardcoded constant had, which is the whole property that
        // had to survive the move into state.
        {
            let mut data = info.try_borrow_mut_data()?;
            let mut state = ProtocolState::try_deserialize(&mut &data[..])?;
            if state.founder_wallet == Pubkey::default() {
                require!(!state.founder_allocated, SoladromeError::Unauthorized);
                require_keys_neq!(
                    founder_wallet,
                    Pubkey::default(),
                    SoladromeError::InvalidAmount
                );
                state.founder_wallet = founder_wallet;
                let mut cursor: &mut [u8] = &mut data;
                state.try_serialize(&mut cursor)?;
                msg!("founder_wallet set to {}", founder_wallet);
            } else {
                msg!("founder_wallet already set — left untouched");
            }
        }
        Ok(())
    }

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
                let basis =
                    math::fee_basis(position.staked_amount, old_balance, position.fee_shares);
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

    // Borrow USDC from floor reserve. Max = financed stake still in hand. No liquidation.
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
            // SECURITY: snapshot accumulator so a position opened here cannot retroactively
            // claim fees through claim_fees after being initialised with fees_debt = 0.
            ctx.accounts.user_position.fees_debt = math::advance_accumulator(
                ctx.accounts.protocol_state.fees_per_hi_sola,
                ctx.accounts.market_vault.amount,
                ctx.accounts.protocol_state.last_market_vault_balance,
                ctx.accounts.protocol_state.total_hi_sola,
            );
        }

        // Voting does not reduce this: a vote immobilises the balance in place
        // (`vote_locked`), it no longer moves it into custody. Borrowing and voting are
        // therefore independent, which is what we want — a vote-directed emission system must
        // never give borrowers a reason to abstain.
        //
        // ☢️ The cap keeps BOTH halves. `staked_amount` counts hiSOLA financed through the
        // curve; `hi_sola` is the whole balance, which also carries the unfinanced hiSOLA an
        // expired ve lock releases. The minimum is what confines the 100% channel to
        // collateral whose USDC is actually sitting in the floor vault — everything else goes
        // through `borrow_against_locked` at 20%.
        let borrow_cap = ctx
            .accounts
            .user_position
            .staked_amount
            .min(ctx.accounts.user_position.hi_sola);
        let new_borrowed = ctx
            .accounts
            .user_position
            .usdc_borrowed
            .checked_add(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;
        require!(
            new_borrowed <= borrow_cap,
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

    // One-time team allocation: 250 000 hiSOLA → TEAM_WALLET, locked for life, earning fees.
    //
    // ⚠️ The name is the last trace of what this used to be. It minted 2 M liquid SOLA into the
    // authority's wallet for "marketing & airdrop" until 2026-07-17, which was the single
    // largest floor-drain vector in the protocol; the ecosystem budget moved to oSOLA via
    // `distribute_o_sola` and this header went on describing the version that was deleted. The
    // body's own comment has contradicted it fifteen lines down ever since.
    //
    // Protected by `ecosystem_allocated`; entirely separate from the founder allocation.
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

        // ── The 1.75M ecosystem budget is NOT minted here (changed 2026-07-17) ──
        // It used to be minted as liquid SOLA into the authority's ATA, which made it the
        // single largest floor-drain vector: 1.75M of supply never added to
        // `total_purchased_sola`, yet redeemable 1:1 against a floor funded by real buyers.
        // The budget is now issued as **oSOLA** via `distribute_o_sola`, capped by
        // ECOSYSTEM_TOTAL. Recipients pay 1 USDC into the floor to exercise, so every SOLA
        // that reaches circulation through this path is financed. Same as Beradrome (oBERO).

        // ── 250 000 → TEAM_WALLET, as hiSOLA locked FOR LIFE (never liquid SOLA) ──
        // Pays the people who worked unpaid until launch. Wallet balance stays 0 → borrow_usdc
        // is blind to it (the 20% cap is not sidesteppable), never liquid SOLA → sell_sola is
        // unreachable → it cannot drain the floor. permanent_amount covers the whole tranche,
        // so unlock_hi_sola can never release it. Unlike the 7M it DOES vote (up to 4×): the
        // vote guard keys on the founder wallet, and this is a distinct one.
        //
        // ☢️ And since 2026-08-27 it earns fees. It did not, for the same reason the
        // contributor bag did not: locked for life means `hi_sola` is 0, unfinanced means
        // `staked_amount` is 0, so `fee_basis` was 0 and could never become anything else.
        // A tranche whose whole purpose is to pay people paid them nothing — governance rights
        // and no yield. `fee_shares` fixes that, matched by an increment to `total_hi_sola`.
        let now_ts = Clock::get()?.unix_timestamp;
        let team_lock_end_ts = (now_ts as u64)
            .checked_add(MAX_LOCK_DURATION)
            .ok_or(SoladromeError::Overflow)? as i64;

        // Snapshot the accumulator before any hiSOLA supply change (stake_sola invariant).
        let market_balance = ctx.accounts.market_vault.amount;
        let acc = math::advance_accumulator(
            ctx.accounts.protocol_state.fees_per_hi_sola,
            market_balance,
            ctx.accounts.protocol_state.last_market_vault_balance,
            ctx.accounts.protocol_state.total_hi_sola,
        );

        // SOLA backing for the hiSOLA, locked in sola_vault.
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
            FOUNDER_IMMEDIATE_SOLA,
        )?;

        // The hiSOLA side is now purely the lock entry written below — there is no token to
        // mint and no vault to mint it into. The SOLA backing above is unchanged: it is a
        // real token and still goes to `sola_vault`.

        {
            let lock = &mut ctx.accounts.team_lock_position;
            lock.owner = ctx.accounts.team_wallet.key();
            lock.bump = ctx.bumps.team_lock_position;
            lock.amount_locked = lock
                .amount_locked
                .checked_add(FOUNDER_IMMEDIATE_SOLA)
                .ok_or(SoladromeError::Overflow)?;
            lock.lock_end_ts = team_lock_end_ts;
            // Locked for LIFE: the whole tranche is permanent, so the deferred drain
            // (unlock → unstake → sell_sola) is closed for good. Only borrow_against_locked
            // at 20% remains. Voting stays fully active (wallet ≠ FOUNDER_WALLET).
            lock.permanent_amount = FOUNDER_IMMEDIATE_SOLA;
        }

        // The tranche's fee share, with the accrual carried across — see
        // `UserPosition::credit_fee_shares`.
        {
            let pos = &mut ctx.accounts.team_position;
            if pos.owner == Pubkey::default() {
                pos.owner = ctx.accounts.team_wallet.key();
                pos.bump = ctx.bumps.team_position;
            }
            pos.credit_fee_shares(acc, FOUNDER_IMMEDIATE_SOLA)?;
        }

        let s = &mut ctx.accounts.protocol_state;
        s.fees_per_hi_sola = acc;
        s.last_market_vault_balance = market_balance;
        // The counterpart of the credit above: a real share of the fee stream, taken from the
        // existing holders in exactly the amount the team receives.
        s.total_hi_sola = s
            .total_hi_sola
            .checked_add(FOUNDER_IMMEDIATE_SOLA)
            .ok_or(SoladromeError::Overflow)?;
        s.total_sola = s
            .total_sola
            .checked_add(FOUNDER_IMMEDIATE_SOLA)
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

        // ── The hiSOLA goes straight into the lock, never a balance ──────────
        // Identical to claim_partner_allocation. `user_position.hi_sola` stays 0, which is
        // what makes the reserve inert: borrow_usdc cannot see it (so the 20% cap is not
        // bypassable), and unstake → sell_sola is unreachable. Combined with the
        // FOUNDER_WALLET guards on vote_gauge / replay_vote / burn_o_sola_for_votes and on
        // unlock_hi_sola, the 7M cannot vote, cannot earn, cannot be sold. Liquidity comes
        // solely from borrow_against_locked (20%, any ve-locker).
        //
        // Under the token model this was a mint into a vault the wallet did not control.
        // The guarantee is now structural rather than custodial: `amount_locked` is the only
        // record of this hiSOLA, and the sole instruction that can move it to a spendable
        // balance is `unlock_hi_sola`, which `permanent_amount` blocks for this tranche.

        // ── Create / extend the VeLockPosition ────────────────────────────────
        // MAX_LOCK_DURATION (4 y) is the ve ceiling; "locked for life" is enforced by the
        // FOUNDER_WALLET guard in unlock_hi_sola, not by this timestamp.
        let lock_end_ts = (clock.unix_timestamp as u64)
            .checked_add(MAX_LOCK_DURATION)
            .ok_or(SoladromeError::Overflow)? as i64;
        {
            let lock = &mut ctx.accounts.lock_position;
            if lock.owner == Pubkey::default() {
                lock.owner = ctx.accounts.founder.key();
                lock.bump = ctx.bumps.lock_position;
            }
            lock.amount_locked = lock
                .amount_locked
                .checked_add(claimable)
                .ok_or(SoladromeError::Overflow)?;
            lock.lock_end_ts = lock_end_ts;
        }

        // Init/update founder position debt snapshot
        let pos = &mut ctx.accounts.founder_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.founder.key();
            pos.bump = ctx.bumps.founder_position;
        }
        pos.fees_debt = acc;

        // total_hi_sola: UNCHANGED — locked hiSOLA is excluded from the fee accumulator
        // denominator, matching claim_partner_allocation and lock_hi_sola. This is what
        // stops the 7M from capturing ~89% of protocol fees.
        let s = &mut ctx.accounts.protocol_state;
        s.fees_per_hi_sola = acc;
        s.last_market_vault_balance = market_balance;
        s.total_sola = s
            .total_sola
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

    // ── Contributor / marketing vesting ──────────────────────────────────────

    /// Authority-only: register a contributor wallet with a dual hiSOLA + oSOLA allocation.
    ///
    /// ⚠️ There is no vesting, despite the account being named `ContributorVesting`. The cliff
    /// and linear schedule were removed on 2026-07-18 and both tranches are now claimable in
    /// full immediately; `start_ts` is kept as a record of when the deal was struck and is read
    /// by nothing. This comment claimed otherwise until 2026-08-25, as did the two claim
    /// instructions below — the account name is the last trace of a mechanism that is gone.
    ///
    /// The two sides are not the same kind of thing:
    /// - **hiSOLA** goes into a LIFETIME ve lock (`permanent_amount` covers the whole tranche),
    ///   so it can never be unlocked or sold. It votes forever, borrows at 20 %, and earns a
    ///   real share of protocol fees through `fee_shares` (since 2026-08-25).
    /// - **oSOLA** is an option, not a payment: exercising burns it and pays 1 USDC per unit
    ///   into the floor, so the contributor funds every SOLA they take. It is worth nothing at
    ///   or below the floor.
    ///
    /// Note this oSOLA is NOT drawn against `ecosystem_o_sola_minted` — `ECOSYSTEM_TOTAL` caps
    /// `distribute_o_sola` only. Its bound is `CONTRIBUTOR_O_SOLA_CAP`, enforced below.
    ///
    /// ☢️ Two `require!`s were added on 2026-08-27, and both matter more than they look:
    /// - **A cumulative cap.** There was none: the only limit on what could be promised to
    ///   contributors was the form field the authority typed into. That was survivable while
    ///   the tranche earned nothing; now that it earns protocol fees it is unbounded dilution
    ///   of every staker — exactly the kind of promise that has to live in code to exist.
    /// - **The 50/50 split.** The two sides are not interchangeable. hiSOLA is permanent
    ///   governance plus a real share of revenue; oSOLA is an option the holder pays 1 USDC a
    ///   unit to exercise, financing the floor as they do. Letting one side run without the
    ///   other turns compensation into either pure dilution or a pure lottery ticket.
    pub fn register_contributor(
        ctx: Context<RegisterContributor>,
        hi_sola_amount: u64,
        o_sola_amount: u64,
    ) -> Result<()> {
        require!(
            hi_sola_amount > 0 || o_sola_amount > 0,
            SoladromeError::InvalidAmount
        );
        require!(
            hi_sola_amount == o_sola_amount,
            SoladromeError::ContributorSplitMismatch
        );

        // Cumulative across every contributor ever registered. `init` on the vesting PDA means
        // one wallet cannot be registered twice, so these totals cannot double-count.
        {
            let reg = &mut ctx.accounts.contributor_registry;
            if reg.bump == 0 {
                reg.bump = ctx.bumps.contributor_registry;
            }
            let hi_total = reg
                .hi_sola_allocated
                .checked_add(hi_sola_amount)
                .ok_or(SoladromeError::Overflow)?;
            let o_total = reg
                .o_sola_allocated
                .checked_add(o_sola_amount)
                .ok_or(SoladromeError::Overflow)?;
            require!(
                hi_total <= CONTRIBUTOR_HI_SOLA_CAP && o_total <= CONTRIBUTOR_O_SOLA_CAP,
                SoladromeError::ContributorCapExceeded
            );
            reg.hi_sola_allocated = hi_total;
            reg.o_sola_allocated = o_total;
            msg!(
                "Contributor budget: {} / {} hiSOLA · {} / {} oSOLA",
                hi_total,
                CONTRIBUTOR_HI_SOLA_CAP,
                o_total,
                CONTRIBUTOR_O_SOLA_CAP,
            );
        }

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

    /// Contributor-only: claim the whole hiSOLA tranche at once into a LIFETIME ve lock.
    ///
    /// ⚠️ Not "25 % TGE + 75 % linear over 6 months", which is what this said until 2026-08-25
    /// and has not been true since the schedule was removed on 2026-07-18. There is no cliff
    /// and no vesting: `claimable` is the entire unclaimed remainder.
    ///
    /// Mints SOLA to sola_vault as 1:1 backing and records the hiSOLA as `permanent_amount`,
    /// so `unlock_hi_sola` can never release any of it. `total_hi_sola` is NOT incremented and
    /// never will be, which means this tranche earns no protocol fees at any point — it buys
    /// permanent voting power and a 20 % borrow valve, nothing else.
    pub fn claim_contributor_hi_sola(ctx: Context<ClaimContributorHiSola>) -> Result<()> {
        let clock = Clock::get()?;
        let vesting = &ctx.accounts.contributor_vesting;

        require!(
            vesting.hi_sola_claimed < vesting.hi_sola_amount,
            SoladromeError::VestingFullyClaimed
        );

        // Claimed all at once (no cliff, no vesting) — a contributor is a first-class
        // member of the project. The hiSOLA is minted straight into a lifetime ve lock
        // (team/partner-bag pattern): wallet balance stays 0, so it earns no fees, cannot
        // be sold, and cannot drain the floor; it votes (up to 4×) and borrows 20% via
        // borrow_against_locked. This is unfinanced supply, so locking it for life keeps
        // the only exposure at the protocol's 20% ceiling.
        let claimable = vesting
            .hi_sola_amount
            .saturating_sub(vesting.hi_sola_claimed);
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

        let lock_end_ts = (clock.unix_timestamp as u64)
            .checked_add(MAX_LOCK_DURATION)
            .ok_or(SoladromeError::Overflow)? as i64;

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

        // The hiSOLA side is the lock entry below — no token, no vault, no wallet balance.

        // Create the lifetime ve lock — permanent_amount covers the whole tranche.
        {
            let lock = &mut ctx.accounts.lock_position;
            if lock.owner == Pubkey::default() {
                lock.owner = ctx.accounts.contributor.key();
                lock.bump = ctx.bumps.lock_position;
            }
            lock.amount_locked = lock
                .amount_locked
                .checked_add(claimable)
                .ok_or(SoladromeError::Overflow)?;
            lock.lock_end_ts = lock_end_ts;
            lock.permanent_amount = lock
                .permanent_amount
                .checked_add(claimable)
                .ok_or(SoladromeError::Overflow)?;
        }

        // ── The bag earns fees ───────────────────────────────────────────────
        // It did not until 2026-08-25, and that made it worthless as compensation. The tranche
        // is locked for life, so `hi_sola` stays 0; it was never bought through the curve, so
        // `staked_amount` stays 0. `fee_basis` is the min of the two, so a contributor's basis
        // was 0 and — the lock being permanent — could never become anything else. Someone who
        // funds an audit would have received governance and no yield whatsoever.
        let pos = &mut ctx.accounts.contributor_position;
        if pos.owner == Pubkey::default() {
            pos.owner = ctx.accounts.contributor.key();
            pos.bump = ctx.bumps.contributor_position;
        }

        // Adding to the basis while `fees_debt` is a single scalar would hand the new shares a
        // retroactive claim on fees accrued before they existed. Re-stamping to `acc` instead
        // would forfeit whatever this position had already accrued — harmless for a fresh
        // contributor, real for one who was already staking. So carry the accrual across
        // exactly: pick the debt that reproduces the same pending amount against the new,
        // larger basis. Rounds down, i.e. never in the claimant's favour.
        let old_basis = math::fee_basis(pos.staked_amount, pos.hi_sola, pos.fee_shares);
        let pending = math::pending_fees(acc, pos.fees_debt, old_basis);
        pos.fee_shares = pos
            .fee_shares
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;
        let new_basis = math::fee_basis(pos.staked_amount, pos.hi_sola, pos.fee_shares);
        pos.fees_debt = if pending == 0 || new_basis == 0 {
            acc
        } else {
            acc.saturating_sub((pending as u128 * PRECISION) / new_basis as u128)
        };

        // total_hi_sola GROWS by the tranche — the counterpart of the line above. The share is
        // real, not printed: existing holders are diluted by exactly what the contributor now
        // receives, which is the honest way to pay someone out of the fee stream.
        let s = &mut ctx.accounts.protocol_state;
        s.fees_per_hi_sola = acc;
        s.last_market_vault_balance = market_balance;
        s.total_hi_sola = s
            .total_hi_sola
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;
        s.total_sola = s
            .total_sola
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;

        ctx.accounts.contributor_vesting.hi_sola_claimed = vesting
            .hi_sola_claimed
            .checked_add(claimable)
            .ok_or(SoladromeError::Overflow)?;

        Ok(())
    }

    /// Contributor-only: claim the full oSOLA tranche at once (no cliff, no vesting).
    /// Mints oSOLA to the contributor wallet — floor-neutral until exercised, like the
    /// founder's 5M oSOLA. Exercising pays 1 USDC into the floor, so it is self-financing.
    pub fn claim_contributor_vesting(ctx: Context<ClaimContributorVesting>) -> Result<()> {
        let vesting = &ctx.accounts.contributor_vesting;

        require!(
            vesting.o_sola_claimed < vesting.o_sola_amount,
            SoladromeError::VestingFullyClaimed
        );

        let claimable = vesting.o_sola_amount.saturating_sub(vesting.o_sola_claimed);
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

    // ── Protocol Partner allocation ───────────────────────────────────────────

    /// Authority-only: register a protocol partner — a signature bag plus a liquidity retainer.
    ///
    /// The deal has exactly two money terms. `base_hi_sola` is the bag: delivered whole by
    /// `claim_partner_allocation` the moment the partner escrows their bribe schedule, and
    /// small because it is the only unconditional part. `retainer_per_epoch` is the rate:
    /// credited one epoch at a time by `crank_partner_epoch`, and only for an epoch in which
    /// the partner still holds `lp_threshold` of `lp_mint`.
    ///
    /// ⚠️ No total is written down anywhere, and that is deliberate — see `PartnerAllocation`.
    /// The tiers of 2026-08-26 read 10 / 15 / 20 % of the committed LP over a year of
    /// maintained liquidity: 1 M LP → 20 000 bag + 3 450/epoch, 500 K → 7 500 + 1 300,
    /// 200 K → 2 000 + 350. A partner who stays longer simply earns longer.
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
        pa.last_credited_epoch = 0;
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
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.partner_token.to_account_info(),
                    to: ctx.accounts.stream_vault.to_account_info(),
                    authority: ctx.accounts.partner.to_account_info(),
                },
            ),
            total,
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

    /// Permissionless: run a partner's epoch — release their bribe tranche, and buy this epoch
    /// of their retainer if their liquidity is still there.
    ///
    /// **Why the two are one instruction.** The bribe stream already had to be cranked every
    /// epoch by somebody. Making the retainer a second weekly crank would have doubled the
    /// operational load and left the two able to drift apart; merged, one transaction per epoch
    /// per partner runs the whole deal, and the bribe — which someone always has an incentive
    /// to trigger, since it is the epoch's voters who are owed it — is what keeps the retainer's
    /// attestation from being forgotten.
    ///
    /// **The two halves are independently gated, on purpose.**
    /// - The bribe tranche is escrowed money that already belongs to the gauge. It is released
    ///   whether or not the liquidity condition holds: a partner who pulls their LP still owes
    ///   the voters what they escrowed.
    /// - The retainer is bought fresh each epoch against `lp_threshold` of `lp_mint`, still
    ///   held. It keeps paying after the bribe schedule is exhausted — a partner who stays for
    ///   three years earns for three years — and stops the epoch their liquidity leaves.
    ///
    /// If neither half can do anything, the call fails rather than burning a fee for nothing.
    ///
    /// ☢️ **A missed epoch is lost, not deferred.** The bribe side slips (the stream simply runs
    /// one epoch longer), but the retainer cannot: the chain keeps no history of an SPL balance,
    /// so there is no way to establish afterwards that the LP was present five epochs ago. The
    /// crank *is* the attestation. This is why the front-end fires it automatically.
    ///
    /// ⚠️ **What the attestation does and does not prove.** It proves the balance existed at the
    /// instant of the crank. A partner cranking their own epoch can hold the LP for exactly that
    /// transaction — add liquidity, crank, remove liquidity — and the program cannot tell.
    /// Closing that would require custody of the LP, which is the one thing the deal promises
    /// not to take. What is left is: the counterparty is a named protocol the authority
    /// registered by hand, the manoeuvre is legible on-chain to anyone reading the pool, and the
    /// remedy is the renewal — the authority simply does not re-register them. That is a
    /// reputational guarantee, not a cryptographic one, and it should be described as such.
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
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.stream_vault.to_account_info(),
                        to: ctx.accounts.bribe_token_vault.to_account_info(),
                        authority: ctx.accounts.bribe_stream.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
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

        // ── Half two: this epoch of the retainer ────────────────────────────────
        let pa = &ctx.accounts.partner_allocation;
        let lp_ok = ctx.accounts.partner_lp_token.amount >= pa.lp_threshold;
        // `<` and not `!=`: an epoch is credited once and never retroactively, so a crank that
        // arrives late in the week is fine and a second one in the same week does nothing.
        let epoch_open = pa.last_credited_epoch < epoch;
        let retainer_due = lp_ok && epoch_open && pa.retainer_per_epoch > 0;

        require!(bribe_due || retainer_due, SoladromeError::NothingToCrank);

        if retainer_due {
            let amount = pa.retainer_per_epoch;
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
            // floor it did not fund. It votes, it earns fees, it borrows at 20 %.
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
            pa.last_credited_epoch = epoch;
            pa.epochs_qualified = pa
                .epochs_qualified
                .checked_add(1)
                .ok_or(SoladromeError::Overflow)?;
            pa.hi_sola_claimed = pa
                .hi_sola_claimed
                .checked_add(amount)
                .ok_or(SoladromeError::Overflow)?;

            msg!(
                "Retainer epoch {}: {} | +{} hiSOLA permanent | {} epochs qualified | total {}",
                epoch,
                pa.partner,
                amount,
                pa.epochs_qualified,
                pa.hi_sola_claimed,
            );
        } else if epoch_open {
            // Said out loud, because this is the epoch the partner just lost.
            msg!(
                "Retainer epoch {} NOT credited: LP {} < threshold {}",
                epoch,
                ctx.accounts.partner_lp_token.amount,
                ctx.accounts.partner_allocation.lp_threshold,
            );
        }

        Ok(())
    }

    /// Authority-only: close a `PartnerAllocation` PDA and return its rent to the authority
    /// that paid for it at `register_partner`.
    ///
    /// ☢️ **A retainer has no total, which changes what "terminal" can mean.** The old test read
    /// `hi_sola_claimed >= base_hi_sola + cap_hi_sola` — a promised total, reached or not. There
    /// is no promised total now: each epoch is bought separately, so the moment a partner stops
    /// qualifying there is nothing outstanding to protect. What has to be protected is narrower
    /// and sharper: **an epoch the partner could still be credited for.**
    ///
    /// So the account is closable when the deal cannot pay anything more *right now*:
    ///
    /// 1. The bag is settled — claimed, or there never was one (`base_hi_sola == 0`). An
    ///    unclaimed bag is a live entitlement and blocks the close outright.
    /// 2. The current epoch's retainer is already decided — either it was credited
    ///    (`last_credited_epoch == current_epoch`), or the partner no longer holds the
    ///    liquidity that would qualify them (`lp_balance < lp_threshold`).
    ///
    /// The second condition is why this instruction now reads the partner's LP account. Without
    /// it, the authority could close the account mid-week and take away an epoch the partner had
    /// already earned by keeping their liquidity in place; with it, a partner who is still
    /// performing cannot be cut off, and one who has withdrawn can be tidied away immediately
    /// instead of leaving a dead PDA open forever.
    ///
    /// The guarantee that mattered before still holds, in its proper form: **the authority
    /// cannot delete a claim the partner has already earned.** What it can now do — and could
    /// not before — is close the account of a partner who simply stopped, which under a retainer
    /// costs that partner nothing, because there never was a remainder.
    ///
    /// ⚠️ Closing frees the `[b"partner", partner_wallet]` seeds, so `register_partner` can open
    /// the same PDA again with every counter at zero — a **fresh deal**, including a fresh
    /// `base_hi_sola` bag. That is the renewal path (and the migration path for allocations
    /// written at the old 160-byte layout), but it means close-then-re-register is the one way
    /// to hand the same wallet a second bag. It takes the authority signature twice and is
    /// visible on-chain in both instructions.
    ///
    /// The partner's `VeLockPosition` and `UserPosition` are separate PDAs and are untouched:
    /// everything already credited stays locked, keeps voting, keeps earning fees, and keeps
    /// borrowing at 20 %. Nothing is burned here.
    ///
    /// Not pause-gated, matching `register_partner`: this is admin cleanup that moves no tokens.
    pub fn close_partner_allocation(ctx: Context<ClosePartnerAllocation>) -> Result<()> {
        let pa = &ctx.accounts.partner_allocation;
        let epoch = current_epoch(Clock::get()?.unix_timestamp);

        // ☢️ **Never activated.** No schedule was ever escrowed, so nothing has accrued and
        // nothing is owed: the bag is the consideration for a commitment that does not exist,
        // `claim_partner_allocation` refuses it, and `crank_partner_epoch` refuses too. This
        // clause is the whole reason a mistyped registration is correctable at all. Without it —
        // and it was missing until 2026-08-28 — an allocation registered with, say, an LP
        // threshold larger than the pool's entire supply could never be claimed (no stream), and
        // never be closed (unclaimed bag), and the authority could not fix its own typo for the
        // life of the protocol. It was found by registering exactly that on devnet.
        let never_activated = pa.stream_start_ts == 0;

        // An unclaimed bag IS a debt once a schedule has been escrowed against it.
        let bag_settled = pa.bag_claimed || pa.base_hi_sola == 0;
        // Nothing further can be credited for the epoch in progress: either it already was, or
        // the liquidity that would have qualified it is gone. A partner with no LP account at
        // all reads 0 here, which is exactly right — see `ClosePartnerAllocation`.
        let epoch_decided = pa.last_credited_epoch == epoch
            || lp_balance_of(&ctx.accounts.partner_lp_token)? < pa.lp_threshold;
        // ☢️ And the escrow must be spent. `crank_partner_epoch` needs this allocation to run,
        // so closing while tranches remain would strand them: the gauge's voters never receive
        // money the partner has already paid in, and the partner cannot recover it either.
        // Withdrawing their LP stops the retainer; it does not cancel a bribe commitment they
        // have already funded.
        let escrow_spent = stream_is_spent(&ctx.accounts.bribe_stream)?;

        require!(
            never_activated || (bag_settled && epoch_decided && escrow_spent),
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

    /// Authority-only: close a `PartnerAllocation` written under a layout too small to read.
    ///
    /// ☢️ **This exists because `close_partner_allocation` cannot help such an account.** That
    /// instruction takes a typed `Account<PartnerAllocation>`, so Anchor deserializes before a
    /// single line of it runs — and an account written at 160 bytes has no `lp_mint`, no
    /// `retainer_per_epoch`, no `min_bribe_per_epoch` to read. It fails at the account level,
    /// permanently. `register_partner` uses `init`, so the seeds cannot be reopened either:
    /// without this, growing the struct on 2026-08-27 would have **bricked every allocation
    /// that predated it**, and the "close and re-register" renewal path the design leans on
    /// would have been a path that did not exist.
    ///
    /// **The size check is the entire safety property, and it is `<`, not `!=`.**
    /// `register_partner` only ever creates accounts at exactly `8 + PartnerAllocation::LEN`, so
    /// while the layout stands this instruction cannot fire on anything — it is structurally
    /// inert, not merely guarded by an authority signature. `<` rather than `!=` so that a
    /// future *shrink* of `LEN` could not suddenly make live, readable accounts deletable:
    /// strictly smaller means "written under a layout too small to be read now", which is the
    /// only condition that justifies deleting an account without looking at what is inside it.
    ///
    /// That is worth stating plainly, because the shape is the dangerous one: an authority
    /// instruction that removes a partner's account without reading their entitlement. Every
    /// other partner path refuses to do that, deliberately (see `close_partner_allocation`). The
    /// justification here is that there is no entitlement left to read — the account cannot be
    /// interpreted at all, by anyone, ever again.
    ///
    /// The discriminator is still checked, so this cannot be pointed at an account of some other
    /// type that happens to sit at the right seeds. Closing frees `[b"partner", wallet]` and
    /// `register_partner` reopens it at the current layout — a fresh deal, with a fresh bag,
    /// exactly as after an ordinary close.
    pub fn close_legacy_partner_allocation(
        ctx: Context<CloseLegacyPartnerAllocation>,
    ) -> Result<()> {
        let info = ctx.accounts.partner_allocation.to_account_info();

        // Owned by this program — otherwise the seeds derivation means nothing.
        require_keys_eq!(*info.owner, crate::ID, SoladromeError::Unauthorized);
        // ☢️ The guard. See the note above for why this is `<`.
        require!(
            info.data_len() < 8 + PartnerAllocation::LEN,
            SoladromeError::PartnerAllocationNotLegacy
        );
        // And it must actually be one of ours, not some other account at these seeds.
        {
            let data = info.try_borrow_data()?;
            require!(data.len() >= 8, SoladromeError::PartnerAllocationNotLegacy);
            require!(
                &data[..8] == PartnerAllocation::DISCRIMINATOR,
                SoladromeError::PartnerAllocationNotLegacy
            );
        }

        // What Anchor's `close = authority` attribute does, by hand — it needs the typed
        // account this instruction cannot produce. Same three steps, same order: lamports to
        // the authority, data resized to 0, ownership back to the System Program. Resizing to
        // zero is what makes the account unrevivable within the transaction: there is no
        // discriminator left to re-read, and `is_closed` reads exactly this shape.
        let bytes = info.data_len();
        let lamports = info.lamports();
        let authority = ctx.accounts.authority.to_account_info();
        **authority.try_borrow_mut_lamports()? = authority
            .lamports()
            .checked_add(lamports)
            .ok_or(SoladromeError::Overflow)?;
        **info.try_borrow_mut_lamports()? = 0;
        info.assign(&anchor_lang::system_program::ID);
        info.resize(0)?;

        msg!(
            "Legacy partner allocation closed: {} | {} bytes, {} lamports reclaimed",
            ctx.accounts.partner_wallet.key(),
            bytes,
            lamports,
        );
        Ok(())
    }

    /// Borrow USDC against a vote-locked hiSOLA position (the partner liquidity valve).
    ///
    /// Partner hiSOLA lives in the ve_lock_vault (wallet balance = 0), so the normal
    /// `borrow_usdc` path is unavailable. This draws USDC from the floor reserve using
    /// the LOCKED position (`VeLockPosition.amount_locked`) as collateral, capped at
    /// `PARTNER_BORROW_CAP_BPS` (20%). Repay via the standard `repay_usdc` (same
    /// UserPosition PDA). 2% origination fee → market_vault, 75% floor buffer, no
    /// interest, no liquidation. Available to any ve-locker, not just partners.
    pub fn borrow_against_locked(
        ctx: Context<BorrowAgainstLocked>,
        usdc_amount: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.protocol_state.paused,
            SoladromeError::ProtocolPaused
        );
        require!(usdc_amount > 0, SoladromeError::InvalidAmount);
        let bump = ctx.accounts.protocol_state.bump;

        if ctx.accounts.partner_position.owner == Pubkey::default() {
            ctx.accounts.partner_position.owner = ctx.accounts.partner.key();
            ctx.accounts.partner_position.bump = ctx.bumps.partner_position;
        }

        // ── Cap: 20% of the locked hiSOLA position ──────────────────────────
        let locked = ctx.accounts.lock_position.amount_locked;
        let max_borrow = (locked as u128)
            .checked_mul(PARTNER_BORROW_CAP_BPS as u128)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(10_000)
            .ok_or(SoladromeError::Overflow)? as u64;

        let new_borrowed = ctx
            .accounts
            .partner_position
            .usdc_borrowed
            .checked_add(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;
        require!(
            new_borrowed <= max_borrow,
            SoladromeError::BorrowLimitExceeded
        );
        require!(
            ctx.accounts.floor_vault.amount >= usdc_amount,
            SoladromeError::InsufficientFloorReserve
        );

        // ── 75% floor buffer guardrail ──────────────────────────────────────
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

        // ── 2% origination fee → market_vault ───────────────────────────────
        let fee = usdc_amount
            .checked_mul(BORROW_FEE_BPS)
            .ok_or(SoladromeError::Overflow)?
            .checked_div(10_000)
            .ok_or(SoladromeError::Overflow)?;
        let user_receives = usdc_amount
            .checked_sub(fee)
            .ok_or(SoladromeError::Overflow)?;

        let seeds: &[&[u8]] = &[STATE_SEED, &[bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.floor_vault.to_account_info(),
                    to: ctx.accounts.partner_usdc.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                &[seeds],
            ),
            user_receives,
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

        ctx.accounts.partner_position.usdc_borrowed = new_borrowed;
        ctx.accounts.protocol_state.total_usdc_borrowed = ctx
            .accounts
            .protocol_state
            .total_usdc_borrowed
            .checked_add(usdc_amount)
            .ok_or(SoladromeError::Overflow)?;
        ctx.accounts.partner_position.last_borrow_slot = Clock::get()?.slot;
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
        require!(
            ctx.accounts.protocol_state.bribes_enabled,
            SoladromeError::FeatureDisabled
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

    // (`partner_deposit_bribe` removed 2026-08-27. It was `deposit_bribe` plus a credit to
    //  `total_bribed_credited` — the 1:1 match. With the match gone the two instructions were
    //  byte-for-byte the same operation under different names, and a partner who wants to bribe
    //  beyond their escrowed schedule uses `deposit_bribe` like every other protocol. One less
    //  instruction on the audit surface for zero loss of function.)

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

    /// Authority-only: approve/revoke a pool for continuous oSOLA emissions.
    /// Pools are created permissionlessly but earn NO emissions until approved —
    /// this bounds total oSOLA inflation to a curated set of "house" LP pools.
    pub fn set_pool_rewards(ctx: Context<SetPoolRewards>, enabled: bool) -> Result<()> {
        amm::set_pool_rewards(ctx, enabled)
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

        // ── ECOSYSTEM_TOTAL cap ───────────────────────────────────────────────
        // This is the ecosystem/airdrop budget, issued as oSOLA rather than SOLA so it
        // is self-financing: the recipient pays 1 USDC into the floor to exercise, so no
        // unfinanced supply can ever be redeemed against backing it never contributed.
        // Until 2026-07-17 the only check here was `amount > 0` — the published 1.75M was
        // a constant that constrained nothing, and the authority could dilute without limit.
        let minted = ctx
            .accounts
            .protocol_state
            .ecosystem_o_sola_minted
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;
        require!(
            minted <= ECOSYSTEM_TOTAL,
            SoladromeError::EcosystemBudgetExceeded
        );

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

        ctx.accounts.protocol_state.ecosystem_o_sola_minted = minted;
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
    /// Locked for life — the founder can never unlock.
    ///
    /// The 7M are minted straight into a ve lock by `claim_founder_hi_sola` and must
    /// never return to a wallet. Unlocking would undo all three guarantees at once:
    /// the hiSOLA re-enters `total_hi_sola` (fee accrual resumes), `borrow_usdc`
    /// regains sight of it (the 20% cap becomes bypassable), and unstake → sell_sola
    /// turns the reserve into a floor drain. The guard is on FOUNDER_WALLET only —
    /// TEAM_WALLET and partners release their non-permanent portions normally.
    pub fn unlock_hi_sola(ctx: Context<UnlockHiSola>) -> Result<()> {
        require!(
            ctx.accounts.user.key() != ctx.accounts.protocol_state.founder_wallet,
            SoladromeError::FounderVestingLocked
        );
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
        let cont_rate = ctx.accounts.protocol_state.continuous_rate_per_sec;
        let cont_active = amm::continuous_active(&ctx.accounts.protocol_state, clock_now);
        let pool = &mut ctx.accounts.pool;
        amm::advance_pool_rewards(pool, clock_now, cont_rate, cont_active);
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

// ── Vote lock helper ──────────────────────────────────────────────────────────

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

/// Resize the protocol_state singleton to the current ProtocolState::LEN.
#[derive(Accounts)]
pub struct MigrateProtocolState<'info> {
    /// Must match the authority stored in protocol_state (checked in the
    /// handler against the raw bytes); also pays the rent top-up.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: canonical singleton pinned by PDA seeds; program ownership,
    /// discriminator and stored authority are verified in the handler. Cannot
    /// be `Account<ProtocolState>`: a pre-migration account is too short to
    /// deserialize — that is the bug this instruction fixes.
    #[account(mut, seeds = [STATE_SEED], bump)]
    pub protocol_state: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
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
pub struct BorrowUsdc<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

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

#[derive(Accounts)]
pub struct DistributeOSola<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Recipient wallet — validated implicitly by ATA derivation below.
    pub recipient: UncheckedAccount<'info>,

    /// `mut` is load-bearing: without it Anchor never serializes the account back, so
    /// `ecosystem_o_sola_minted` would silently stay 0 and the ECOSYSTEM_TOTAL cap would
    /// never fire — a cap reading a counter that never increments.
    #[account(
        mut,
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

    /// Founder wallet — pinned to the address `initialize` wrote, cannot be substituted.
    #[account(
        address = protocol_state.founder_wallet @ SoladromeError::Unauthorized,
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

    /// Receives the SOLA backing the team's locked hiSOLA.
    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only — accumulator snapshot before the hiSOLA supply changes.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: hardcoded team wallet — receives the 250K tranche as a lifetime ve lock.
    /// Distinct from FOUNDER_WALLET by design: the vote_gauge guard keys on FOUNDER_WALLET,
    /// so this tranche votes as an ordinary user.
    #[account(address = TEAM_WALLET.parse::<Pubkey>().unwrap() @ SoladromeError::Unauthorized)]
    pub team_wallet: UncheckedAccount<'info>,

    /// Team ve lock metadata. Mirrors ClaimPartnerAllocation.
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + VeLockPosition::LEN,
        seeds = [VELOCK_SEED, team_wallet.key().as_ref()],
        bump,
    )]
    pub team_lock_position: Box<Account<'info, VeLockPosition>>,

    /// Team fee-share position — fees_debt snapshotted at allocation.
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, team_wallet.key().as_ref()],
        bump,
    )]
    pub team_position: Box<Account<'info, UserPosition>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ── ClaimFounderHiSola ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ClaimFounderHiSola<'info> {
    // ⚠️ `protocol_state` is declared FIRST on purpose: the `founder` constraint below reads
    // `protocol_state.founder_wallet`, and Anchor resolves constraints in declaration order.
    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// Only the founder wallet recorded at `initialize` may call this.
    #[account(
        mut,
        address = protocol_state.founder_wallet @ SoladromeError::Unauthorized,
    )]
    pub founder: Signer<'info>,

    #[account(mut, address = protocol_state.sola_mint)]
    pub sola_mint: Box<Account<'info, Mint>>,

    /// Receives freshly locked SOLA backing the claimed hiSOLA.
    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only — needed for accumulator snapshot before hiSOLA supply changes.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// Lifetime ve lock metadata — created on first claim. Mirrors ClaimPartnerAllocation.
    #[account(
        init_if_needed,
        payer = founder,
        space = 8 + VeLockPosition::LEN,
        seeds = [VELOCK_SEED, founder.key().as_ref()],
        bump,
    )]
    pub lock_position: Box<Account<'info, VeLockPosition>>,

    /// Founder's fee-share position — fees_debt snapshotted at claim. The reserve never
    /// unlocks, so this never becomes a fee claim; it exists for symmetry with partners.
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
    // ⚠️ `protocol_state` first — the `founder` constraint reads `founder_wallet` from it and
    // Anchor resolves constraints in declaration order.
    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Only the founder wallet recorded at `initialize` may call this.
    #[account(
        mut,
        address = protocol_state.founder_wallet @ SoladromeError::Unauthorized,
    )]
    pub founder: Signer<'info>,

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

    pub bribe_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = bribe_mint, token::authority = partner)]
    pub partner_token: Box<Account<'info, TokenAccount>>,

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
    pub stream_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Anyone runs a partner's epoch: one bribe tranche into this epoch's vault, and one epoch of
/// retainer if the liquidity condition still holds.
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
    pub stream_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: Bribe label, as everywhere else in this system.
    pub pool_id: UncheckedAccount<'info>,

    pub reward_mint: Box<Account<'info, Mint>>,

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
        seeds = [b"bribe_tokens", pool_id.key().as_ref(), reward_mint.key().as_ref(), epoch.to_le_bytes().as_ref()],
        bump,
    )]
    pub bribe_token_vault: Box<Account<'info, TokenAccount>>,

    // ── The retainer half ───────────────────────────────────────────────────────
    /// The LP token named in the deal. Pinned to the allocation so the caller cannot swap in a
    /// mint the partner happens to hold a lot of.
    #[account(address = partner_allocation.lp_mint @ SoladromeError::LpMintMismatch)]
    pub lp_mint: Box<Account<'info, Mint>>,

    /// The partner's own LP account, and the whole of the liquidity condition. Read-only: the
    /// protocol never takes custody of it, it only looks.
    #[account(token::mint = lp_mint, token::authority = partner)]
    pub partner_lp_token: Box<Account<'info, TokenAccount>>,

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

    /// The running total the cap is enforced against. Opened by the first registration.
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + ContributorRegistry::LEN,
        seeds = [CONTRIBUTOR_REGISTRY_SEED],
        bump,
    )]
    pub contributor_registry: Account<'info, ContributorRegistry>,

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

    #[account(mut, address = protocol_state.sola_vault)]
    pub sola_vault: Box<Account<'info, TokenAccount>>,

    /// Read-only — needed for accumulator snapshot before hiSOLA supply changes.
    #[account(address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    /// Lifetime ve lock metadata — created on claim. Mirrors the team/partner pattern.
    #[account(
        init_if_needed,
        payer = contributor,
        space = 8 + VeLockPosition::LEN,
        seeds = [VELOCK_SEED, contributor.key().as_ref()],
        bump,
    )]
    pub lock_position: Box<Account<'info, VeLockPosition>>,

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

// ── Protocol Partner allocation ───────────────────────────────────────────────

/// Authority-only: register a protocol partner allocation.
/// Creates a PartnerAllocation PDA keyed on the partner's wallet.
#[derive(Accounts)]
pub struct BorrowAgainstLocked<'info> {
    #[account(mut)]
    pub partner: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    /// The vote-locked position used as collateral (collateral ceiling = amount_locked).
    #[account(
        seeds = [VELOCK_SEED, partner.key().as_ref()],
        bump = lock_position.bump,
    )]
    pub lock_position: Box<Account<'info, VeLockPosition>>,

    #[account(mut, address = protocol_state.floor_vault)]
    pub floor_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = protocol_state.market_vault)]
    pub market_vault: Box<Account<'info, TokenAccount>>,

    #[account(address = protocol_state.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = partner,
        associated_token::mint      = usdc_mint,
        associated_token::authority = partner,
    )]
    pub partner_usdc: Box<Account<'info, TokenAccount>>,

    /// Tracks cumulative borrow (same PDA as UserPosition → repay via repay_usdc).
    #[account(
        init_if_needed,
        payer = partner,
        space = 8 + UserPosition::LEN,
        seeds = [POSITION_SEED, partner.key().as_ref()],
        bump,
    )]
    pub partner_position: Box<Account<'info, UserPosition>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
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

    /// CHECK: The LP token named in the deal. Only its address is used — to derive the account
    /// below — so it is never deserialized, which also means a close is not blocked by anything
    /// about the mint itself.
    #[account(address = partner_allocation.lp_mint @ SoladromeError::LpMintMismatch)]
    pub lp_mint: UncheckedAccount<'info>,

    /// CHECK: The partner's associated token account for that mint, read to establish that this
    /// epoch's retainer can no longer be earned. **Untyped on purpose, and pinned by address.**
    /// Untyped because a partner who never provided liquidity has no such account, and a typed
    /// account would fail at the account level — making the partners with no liquidity precisely
    /// the ones who could not be closed. Pinned because the authority chooses what to pass here:
    /// without the address constraint they could present any empty account, read a balance of 0
    /// and close a partner who was still qualifying. `lp_balance_of` returns 0 for an absent
    /// account, which is the honest reading of "they hold none".
    #[account(
        address = anchor_spl::associated_token::get_associated_token_address(
            &partner_wallet.key(), &lp_mint.key()
        ),
    )]
    pub partner_lp_token: UncheckedAccount<'info>,

    /// CHECK: The partner's escrowed bribe schedule, if they ever funded one. Read to refuse a
    /// close while tranches remain: `crank_partner_epoch` needs the allocation, so closing early
    /// would strand money the partner has already paid in and the gauge's voters are owed.
    /// Untyped for the same reason as above — most allocations have no stream account.
    #[account(seeds = [BRIBE_STREAM_SEED, partner_wallet.key().as_ref()], bump)]
    pub bribe_stream: UncheckedAccount<'info>,
}

/// Authority reclaims the rent of a `PartnerAllocation` too small to deserialize.
/// Untyped by necessity — see `close_legacy_partner_allocation` for why, and for why the size
/// check rather than the signature is what makes this safe.
#[derive(Accounts)]
pub struct CloseLegacyPartnerAllocation<'info> {
    #[account(
        mut,
        address = protocol_state.authority @ SoladromeError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(seeds = [STATE_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    /// CHECK: The partner's beneficiary wallet — identity enforced by the PDA seeds below.
    /// It cannot be re-asserted against the stored `partner` field here, because reading that
    /// field is exactly what this instruction exists to work around.
    pub partner_wallet: UncheckedAccount<'info>,

    /// CHECK: Untyped on purpose — the account is smaller than the current struct, so Anchor
    /// cannot deserialize it. Validated in the body: owned by this program, carrying the
    /// `PartnerAllocation` discriminator, and strictly smaller than the current layout.
    #[account(mut, seeds = [PARTNER_SEED, partner_wallet.key().as_ref()], bump)]
    pub partner_allocation: UncheckedAccount<'info>,
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

// ── Vote escrow release ───────────────────────────────────────────────────────

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
