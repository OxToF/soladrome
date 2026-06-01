use trident_fuzz::fuzzing::*;

/// Storage for all account addresses used in fuzz testing.
///
/// This struct serves as a centralized repository for account addresses,
/// enabling their reuse across different instruction flows and test scenarios.
///
/// Docs: https://ackee.xyz/trident/docs/latest/trident-api-macro/trident-types/fuzz-accounts/
#[derive(Default)]
pub struct AccountAddresses {
    pub user: AddressStorage,

    pub pool: AddressStorage,

    pub lp_mint: AddressStorage,

    pub token_a_vault: AddressStorage,

    pub token_b_vault: AddressStorage,

    pub user_token_a: AddressStorage,

    pub user_token_b: AddressStorage,

    pub user_lp: AddressStorage,

    pub lp_dead_ata: AddressStorage,

    pub lp_dead: AddressStorage,

    pub lp_user_info: AddressStorage,

    pub protocol_state: AddressStorage,

    pub o_sola_mint: AddressStorage,

    pub user_o_sola: AddressStorage,

    pub rent: AddressStorage,

    pub token_program: AddressStorage,

    pub associated_token_program: AddressStorage,

    pub system_program: AddressStorage,

    pub user_token_in: AddressStorage,

    pub user_token_out: AddressStorage,

    pub market_vault: AddressStorage,

    pub hi_sola_mint: AddressStorage,

    pub user_hi_sola: AddressStorage,

    pub floor_vault: AddressStorage,

    pub user_usdc: AddressStorage,

    pub user_position: AddressStorage,

    pub sola_mint: AddressStorage,

    pub user_sola: AddressStorage,

    pub lp_user_checkpoint: AddressStorage,

    pub pool_epoch_accum: AddressStorage,

    pub pool_id: AddressStorage,

    pub reward_mint: AddressStorage,

    pub bribe_vault: AddressStorage,

    pub bribe_token_vault: AddressStorage,

    pub user_reward_ata: AddressStorage,

    pub gauge_state: AddressStorage,

    pub user_vote_receipt: AddressStorage,

    pub user_bribe_claim: AddressStorage,

    pub contributor: AddressStorage,

    pub sola_vault: AddressStorage,

    pub contributor_hi_sola: AddressStorage,

    pub contributor_position: AddressStorage,

    pub contributor_vesting: AddressStorage,

    pub contributor_o_sola: AddressStorage,

    pub founder: AddressStorage,

    pub founder_hi_sola: AddressStorage,

    pub founder_position: AddressStorage,

    pub founder_hi_vesting: AddressStorage,

    pub founder_vesting: AddressStorage,

    pub founder_o_sola: AddressStorage,

    pub lp_epoch_claim: AddressStorage,

    pub authority: AddressStorage,

    pub pol_state: AddressStorage,

    pub pol_usdc_vault: AddressStorage,

    pub usdc_mint: AddressStorage,

    pub contributor_usdc: AddressStorage,

    pub creator: AddressStorage,

    pub token_a_mint: AddressStorage,

    pub token_b_mint: AddressStorage,

    pub pol_sola_ata: AddressStorage,

    pub pol_lp_vault: AddressStorage,

    pub pool_token_a_vault: AddressStorage,

    pub pool_token_b_vault: AddressStorage,

    pub depositor: AddressStorage,

    pub depositor_token: AddressStorage,

    pub recipient: AddressStorage,

    pub recipient_o_sola: AddressStorage,

    pub caller: AddressStorage,

    pub global_epoch_votes: AddressStorage,

    pub caller_o_sola: AddressStorage,

    pub caller_sola: AddressStorage,

    pub caller_usdc: AddressStorage,

    pub founder_usdc: AddressStorage,

    pub lock_position: AddressStorage,

    pub ve_lock_vault: AddressStorage,

    pub authority_sola: AddressStorage,

    pub contributor_wallet: AddressStorage,

    pub new_authority: AddressStorage,

    pub user_epoch_votes: AddressStorage,
}
