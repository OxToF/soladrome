// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

use anchor_lang::prelude::*;

mod amm_math;
mod constants;
mod errors;
mod instructions;
mod math;
mod state;

pub use constants::*;
use errors::SoladromeError;
#[allow(ambiguous_glob_reexports)]
pub use instructions::*;

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

#[program]
pub mod soladrome {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, founder_wallet: Pubkey) -> Result<()> {
        instructions::admin::initialize(ctx, founder_wallet)
    }

    pub fn pause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::admin::pause(ctx)
    }

    pub fn unpause(ctx: Context<SetPaused>) -> Result<()> {
        instructions::admin::unpause(ctx)
    }

    pub fn set_founder_voting(ctx: Context<SetPaused>, enabled: bool) -> Result<()> {
        instructions::admin::set_founder_voting(ctx, enabled)
    }

    pub fn set_phase_flags(
        ctx: Context<SetPaused>,
        lp_enabled: Option<bool>,
        bribes_enabled: Option<bool>,
        voting_enabled: Option<bool>,
        exercise_enabled: Option<bool>,
        curve_enabled: Option<bool>,
        emissions_enabled: Option<bool>,
    ) -> Result<()> {
        instructions::admin::set_phase_flags(
            ctx,
            lp_enabled,
            bribes_enabled,
            voting_enabled,
            exercise_enabled,
            curve_enabled,
            emissions_enabled,
        )
    }

    pub fn transfer_authority(ctx: Context<TransferAuthority>) -> Result<()> {
        instructions::admin::transfer_authority(ctx)
    }

    pub fn buy_sola(ctx: Context<BuySola>, usdc_in: u64, min_sola_out: u64) -> Result<()> {
        instructions::curve::buy_sola(ctx, usdc_in, min_sola_out)
    }

    pub fn sell_sola(ctx: Context<SellSola>, sola_amount: u64) -> Result<()> {
        instructions::curve::sell_sola(ctx, sola_amount)
    }

    pub fn stake_sola(ctx: Context<StakeSola>, sola_amount: u64) -> Result<()> {
        instructions::stake::stake_sola(ctx, sola_amount)
    }

    pub fn unstake_hi_sola(ctx: Context<UnstakeHiSola>, hi_sola_amount: u64) -> Result<()> {
        instructions::stake::unstake_hi_sola(ctx, hi_sola_amount)
    }

    pub fn borrow_usdc(ctx: Context<BorrowUsdc>, usdc_amount: u64) -> Result<()> {
        instructions::borrow::borrow_usdc(ctx, usdc_amount)
    }

    pub fn repay_usdc(ctx: Context<RepayUsdc>, usdc_amount: u64) -> Result<()> {
        instructions::borrow::repay_usdc(ctx, usdc_amount)
    }

    pub fn exercise_o_sola(ctx: Context<ExerciseOSola>, o_sola_amount: u64) -> Result<()> {
        instructions::curve::exercise_o_sola(ctx, o_sola_amount)
    }

    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        instructions::stake::claim_fees(ctx)
    }

    pub fn mint_founder_allocation(ctx: Context<MintFounderAllocation>) -> Result<()> {
        instructions::vesting::mint_founder_allocation(ctx)
    }

    pub fn mint_ecosystem_allocation(ctx: Context<MintEcosystemAllocation>) -> Result<()> {
        instructions::vesting::mint_ecosystem_allocation(ctx)
    }

    pub fn claim_founder_hi_sola(ctx: Context<ClaimFounderHiSola>) -> Result<()> {
        instructions::vesting::claim_founder_hi_sola(ctx)
    }

    pub fn claim_founder_vesting(ctx: Context<ClaimFounderVesting>) -> Result<()> {
        instructions::vesting::claim_founder_vesting(ctx)
    }

    pub fn register_contributor(
        ctx: Context<RegisterContributor>,
        hi_sola_amount: u64,
        o_sola_amount: u64,
    ) -> Result<()> {
        instructions::vesting::register_contributor(ctx, hi_sola_amount, o_sola_amount)
    }

    pub fn claim_contributor_hi_sola(ctx: Context<ClaimContributorHiSola>) -> Result<()> {
        instructions::vesting::claim_contributor_hi_sola(ctx)
    }

    pub fn claim_contributor_vesting(ctx: Context<ClaimContributorVesting>) -> Result<()> {
        instructions::vesting::claim_contributor_vesting(ctx)
    }

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
        instructions::partners::register_partner(
            ctx,
            bribe_mint,
            lp_mint,
            lp_threshold,
            retainer_per_epoch,
            base_hi_sola,
            lock_duration_secs,
            schedule_epochs,
            min_bribe_per_epoch,
        )
    }

    pub fn claim_partner_allocation(ctx: Context<ClaimPartnerAllocation>) -> Result<()> {
        instructions::partners::claim_partner_allocation(ctx)
    }

    pub fn fund_partner_bribe_stream(
        ctx: Context<FundPartnerBribeStream>,
        epochs_total: u64,
        amount_per_epoch: u64,
    ) -> Result<()> {
        instructions::partners::fund_partner_bribe_stream(ctx, epochs_total, amount_per_epoch)
    }

    pub fn crank_partner_epoch(ctx: Context<CrankPartnerEpoch>, epoch: u64) -> Result<()> {
        instructions::partners::crank_partner_epoch(ctx, epoch)
    }

    pub fn close_partner_allocation(ctx: Context<ClosePartnerAllocation>) -> Result<()> {
        instructions::partners::close_partner_allocation(ctx)
    }

    pub fn borrow_against_locked(
        ctx: Context<BorrowAgainstLocked>,
        usdc_amount: u64,
    ) -> Result<()> {
        instructions::borrow::borrow_against_locked(ctx, usdc_amount)
    }

    pub fn deposit_bribe(ctx: Context<DepositBribe>, epoch: u64, amount: u64) -> Result<()> {
        instructions::bribes::deposit_bribe(ctx, epoch, amount)
    }

    pub fn vote_gauge(ctx: Context<VoteGauge>, epoch: u64, votes: u64) -> Result<()> {
        instructions::gauges::vote_gauge(ctx, epoch, votes)
    }

    pub fn configure_emissions(
        ctx: Context<ConfigureEmissions>,
        initial: u64,
        decay_bps: u16,
        floor_bps: u16,
    ) -> Result<()> {
        instructions::emissions::configure_emissions(ctx, initial, decay_bps, floor_bps)
    }

    pub fn set_exercise_fee(ctx: Context<SetExerciseFee>, bps: u16) -> Result<()> {
        instructions::admin::set_exercise_fee(ctx, bps)
    }

    pub fn configure_continuous_emissions(
        ctx: Context<ConfigureContinuousEmissions>,
        rate_per_sec: u64,
        duration_epochs: u64,
    ) -> Result<()> {
        instructions::emissions::configure_continuous_emissions(ctx, rate_per_sec, duration_epochs)
    }

    pub fn set_vote_config(
        ctx: Context<SetVoteConfig>,
        pools: [Pubkey; 5],
        bps: [u16; 5],
        n_pools: u8,
        auto_replay: bool,
    ) -> Result<()> {
        instructions::gauges::set_vote_config(ctx, pools, bps, n_pools, auto_replay)
    }

    pub fn replay_vote(ctx: Context<ReplayVote>, epoch: u64) -> Result<()> {
        instructions::gauges::replay_vote(ctx, epoch)
    }

    pub fn burn_o_sola_for_votes(
        ctx: Context<BurnOSolaForVotes>,
        amount: u64,
        epoch: u64,
    ) -> Result<()> {
        instructions::gauges::burn_o_sola_for_votes(ctx, amount, epoch)
    }

    pub fn checkpoint_lp(ctx: Context<CheckpointLp>, epoch: u64) -> Result<()> {
        instructions::emissions::checkpoint_lp(ctx, epoch)
    }

    pub fn emit_pool_rewards(ctx: Context<EmitPoolRewards>, epoch: u64) -> Result<()> {
        instructions::emissions::emit_pool_rewards(ctx, epoch)
    }

    pub fn claim_lp_emissions(ctx: Context<ClaimLpEmissions>, _epoch: u64) -> Result<()> {
        instructions::emissions::claim_lp_emissions(ctx, _epoch)
    }

    pub fn claim_bribe(ctx: Context<ClaimBribe>, epoch: u64) -> Result<()> {
        instructions::bribes::claim_bribe(ctx, epoch)
    }

    pub fn rollover_bribe(
        ctx: Context<RolloverBribe>,
        old_epoch: u64,
        new_epoch: u64,
    ) -> Result<()> {
        instructions::bribes::rollover_bribe(ctx, old_epoch, new_epoch)
    }

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

    pub fn distribute_o_sola(ctx: Context<DistributeOSola>, amount: u64) -> Result<()> {
        instructions::vesting::distribute_o_sola(ctx, amount)
    }

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

    pub fn flash_arbitrage(
        ctx: Context<FlashArbitrage>,
        amount_osola: u64,
        min_profit_usdc: u64,
    ) -> Result<()> {
        instructions::curve::flash_arbitrage(ctx, amount_osola, min_profit_usdc)
    }
}
