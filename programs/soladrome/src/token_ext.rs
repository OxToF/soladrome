// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs

//! Token-2022 admission control.
//!
//! The protocol accepts third-party mints in exactly three places — AMM pools (`amm.rs`),
//! bribe pots (`bribes.rs`) and the partner bribe stream (`partners.rs`) — and every one of
//! them books an amount in program state and expects the token vault to agree with that
//! figure forever after. Token-2022 lets a mint break that agreement in ways plain SPL Token
//! cannot, so a mint is admitted only after this module has read its extensions.
//!
//! ## Why the gate is at admission and not at transfer time
//!
//! Both AMM pool seeds and bribe-vault seeds are `init`. A mint that is discovered to be
//! unusable *after* the accounts exist leaves a residue on those seeds that can never be
//! cleared, so the pair or the (pool, mint, epoch) triple becomes permanently unopenable —
//! the same shape as the 2026-07-19 devnet brick. Refusing at the door is the only refusal
//! that leaves no wreckage.
//!
//! ## What is refused, and why each one
//!
//! - **`TransferFeeConfig`** — the vault receives less than the amount the instruction just
//!   wrote into `reserve_a` / `total_bribed`. The gap is silent, compounds on every transfer
//!   and is unrecoverable: AMM withdrawals price against a reserve figure the vault cannot
//!   cover, and the last bribe claimer of an epoch finds the pot short.
//! - **`TransferHook` with a program set** — an armed hook needs extra accounts this program
//!   does not pass, so every transfer fails. Accepting such a mint would create a pool whose
//!   `remove_liquidity` reverts, i.e. locked LP funds.
//! - **`DefaultAccountState::Frozen`** — the vault is born frozen. `create_pool` succeeds, and
//!   the pool it leaves behind can never move a token.
//!
//! ## What is deliberately ALLOWED, and must be disclosed rather than blocked
//!
//! - **`PermanentDelegate`** — the mint authority can move tokens out of any account, vault
//!   included. Refusing it would exclude the xStocks, which is the entire reason this
//!   migration exists. The mitigation is a policy one: **never place protocol-owned liquidity
//!   in a pool whose mint carries a permanent delegate.**
//! - **`PausableConfig`** — the issuer can freeze all transfers globally. A frozen market is
//!   the issuer's prerogative, not a defect in this program.
//! - **`ScaledUiAmountConfig`** — the AMM prices in base units throughout, so the invariant is
//!   unaffected by a display multiplier. ⚠️ Off-chain pricing that reads decimals without the
//!   scale factor will be wrong by the split ratio.
//! - **An unarmed `TransferHook`** (program = `None`) — this is the state the xStocks ship in
//!   today. ☢️ The slot stays armable: the authority can point it at a program at any time,
//!   after which this pool's transfers, `remove_liquidity` included, begin to fail. That
//!   residual risk is real, is not closable from inside this program, and is disclosed.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_interface::Mint;
use spl_token_2022::extension::{
    default_account_state::DefaultAccountState, transfer_fee::TransferFeeConfig,
    transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
};
use spl_token_2022::state::AccountState;

use crate::errors::SoladromeError;

/// Admit a third-party mint, or refuse it with `UnsupportedMintExtension`.
///
/// A mint owned by the classic SPL Token program is admitted without inspection: that program
/// has no extensions, so there is nothing to read and the historical behaviour is unchanged
/// byte for byte. Only a Token-2022 mint is unpacked.
pub fn require_supported_mint(mint: &InterfaceAccount<Mint>) -> Result<()> {
    let info = mint.to_account_info();

    // Classic SPL Token: no extension machinery exists. Nothing to check.
    if info.owner == &anchor_spl::token::ID {
        return Ok(());
    }

    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)
        .map_err(|_| error!(SoladromeError::UnsupportedMintExtension))?;

    // A fee on transfer desynchronises every booked amount from the vault that holds it.
    require!(
        state.get_extension::<TransferFeeConfig>().is_err(),
        SoladromeError::UnsupportedMintExtension
    );

    // An armed hook makes every transfer fail for want of the accounts it demands.
    // `Option<Pubkey>` here is `None` for the all-zero pubkey, which is the unarmed state.
    if let Ok(hook) = state.get_extension::<TransferHook>() {
        let program_id: Option<Pubkey> = hook.program_id.into();
        require!(
            program_id.is_none(),
            SoladromeError::UnsupportedMintExtension
        );
    }

    // A default-frozen mint hands us a vault that cannot transfer, on seeds we can never reuse.
    if let Ok(default_state) = state.get_extension::<DefaultAccountState>() {
        let raw = default_state.state;
        require!(
            raw != u8::from(AccountState::Frozen),
            SoladromeError::UnsupportedMintExtension
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assert_err;
    use anchor_lang::solana_program::account_info::AccountInfo;
    use anchor_spl::token::spl_token;
    use spl_pod::optional_keys::OptionalNonZeroPubkey;
    use spl_token_2022::extension::{
        pausable::PausableConfig, permanent_delegate::PermanentDelegate,
        BaseStateWithExtensionsMut, ExtensionType, StateWithExtensionsMut,
    };
    use spl_token_2022::state::Mint as MintState;

    /// Build the raw account data of an initialized Token-2022 mint carrying `extensions`,
    /// handing each freshly-initialized extension to `configure` so a test can arm it.
    ///
    /// The order matters and mirrors `initialize_mint` in spl-token-2022: allocate, init the
    /// extensions, then write the base and stamp the account type. Doing it any other way
    /// produces bytes the real program would reject for reasons unrelated to the policy
    /// under test.
    fn t22_mint_bytes<F>(extensions: &[ExtensionType], configure: F) -> Vec<u8>
    where
        F: FnOnce(&mut StateWithExtensionsMut<'_, MintState>),
    {
        let space = ExtensionType::try_calculate_account_len::<MintState>(extensions).unwrap();
        let mut data = vec![0u8; space];
        {
            let mut state =
                StateWithExtensionsMut::<MintState>::unpack_uninitialized(&mut data).unwrap();
            configure(&mut state);
            state.base = MintState {
                decimals: 6,
                is_initialized: true,
                ..Default::default()
            };
            state.pack_base();
            state.init_account_type().unwrap();
        }
        data
    }

    /// A classic SPL Token mint — 82 bytes, no extension machinery at all.
    fn spl_mint_bytes() -> Vec<u8> {
        use anchor_lang::solana_program::program_pack::Pack;
        let mut data = vec![0u8; spl_token::state::Mint::LEN];
        let mint = spl_token::state::Mint {
            decimals: 6,
            is_initialized: true,
            ..Default::default()
        };
        spl_token::state::Mint::pack(mint, &mut data).unwrap();
        data
    }

    /// Run the real admission policy over `data` owned by `owner`, exactly as an instruction
    /// would: deserialize into the `InterfaceAccount<Mint>` the handlers receive, then gate.
    fn admit(owner: Pubkey, data: &mut [u8]) -> Result<()> {
        let key = Pubkey::new_unique();
        let mut lamports = 1_461_600u64;
        let info = AccountInfo::new(&key, false, false, &mut lamports, data, &owner, false, 0);
        let mint = InterfaceAccount::<Mint>::try_from(&info)?;
        require_supported_mint(&mint)
    }

    fn t22() -> Pubkey {
        anchor_spl::token_2022::ID
    }

    // ── Admitted ──────────────────────────────────────────────────────────

    #[test]
    fn a_classic_spl_mint_is_admitted_without_inspection() {
        // The historical path. Classic SPL Token has no extension machinery, so there is
        // nothing to read — and USDC, wSOL and every protocol mint come through here.
        let mut data = spl_mint_bytes();
        assert!(admit(anchor_spl::token::ID, &mut data).is_ok());
    }

    #[test]
    fn a_plain_token_2022_mint_is_admitted() {
        let mut data = t22_mint_bytes(&[], |_| {});
        assert!(admit(t22(), &mut data).is_ok());
    }

    #[test]
    fn an_unarmed_transfer_hook_is_admitted() {
        // ☢️ This is the state the xStocks ship in today, and the single case the whole
        // Token-2022 migration exists to serve. A test that only proved refusals would let
        // an over-strict tightening silently lock the feature out.
        let mut data = t22_mint_bytes(&[ExtensionType::TransferHook], |state| {
            state.init_extension::<TransferHook>(true).unwrap();
        });
        assert!(
            admit(t22(), &mut data).is_ok(),
            "a hook with no program set must be admitted"
        );
    }

    #[test]
    fn a_permanent_delegate_is_admitted_deliberately() {
        // Allowed with eyes open: the issuer can move tokens out of any account, vaults
        // included. Refusing it would exclude the xStocks. The mitigation is policy —
        // never put protocol-owned liquidity in such a pool — not a gate.
        let mut data = t22_mint_bytes(&[ExtensionType::PermanentDelegate], |state| {
            let ext = state.init_extension::<PermanentDelegate>(true).unwrap();
            ext.delegate = OptionalNonZeroPubkey::try_from(Some(Pubkey::new_unique())).unwrap();
        });
        assert!(admit(t22(), &mut data).is_ok());
    }

    #[test]
    fn a_pausable_mint_is_admitted_deliberately() {
        // A frozen market is the issuer's prerogative, not a defect in this program.
        let mut data = t22_mint_bytes(&[ExtensionType::Pausable], |state| {
            state.init_extension::<PausableConfig>(true).unwrap();
        });
        assert!(admit(t22(), &mut data).is_ok());
    }

    #[test]
    fn a_default_unfrozen_account_state_is_admitted() {
        let mut data = t22_mint_bytes(&[ExtensionType::DefaultAccountState], |state| {
            let ext = state.init_extension::<DefaultAccountState>(true).unwrap();
            ext.state = u8::from(AccountState::Initialized);
        });
        assert!(admit(t22(), &mut data).is_ok());
    }

    // ── Refused ───────────────────────────────────────────────────────────

    #[test]
    fn a_transfer_fee_is_refused() {
        // ☢️ The vault would receive less than the figure just written into `reserve_a` or
        // `total_bribed`. The gap is silent, compounds on every transfer, and is
        // unrecoverable: withdrawals price against a reserve the vault cannot cover.
        let mut data = t22_mint_bytes(&[ExtensionType::TransferFeeConfig], |state| {
            state.init_extension::<TransferFeeConfig>(true).unwrap();
        });
        assert_err!(
            admit(t22(), &mut data),
            SoladromeError::UnsupportedMintExtension
        );
    }

    #[test]
    fn a_transfer_fee_of_zero_bps_is_still_refused() {
        // The extension is refused for existing, not for its current rate: the fee authority
        // can raise it after the pool is open, and by then the seeds are unrecoverable.
        let mut data = t22_mint_bytes(&[ExtensionType::TransferFeeConfig], |state| {
            let ext = state.init_extension::<TransferFeeConfig>(true).unwrap();
            ext.older_transfer_fee.transfer_fee_basis_points = 0.into();
            ext.newer_transfer_fee.transfer_fee_basis_points = 0.into();
        });
        assert_err!(
            admit(t22(), &mut data),
            SoladromeError::UnsupportedMintExtension
        );
    }

    #[test]
    fn an_armed_transfer_hook_is_refused() {
        // ☢️ An armed hook demands accounts this program does not pass, so every transfer
        // fails — including `remove_liquidity`. Admitting one creates a pool whose LP funds
        // can never be withdrawn.
        let mut data = t22_mint_bytes(&[ExtensionType::TransferHook], |state| {
            let ext = state.init_extension::<TransferHook>(true).unwrap();
            ext.program_id = OptionalNonZeroPubkey::try_from(Some(Pubkey::new_unique())).unwrap();
        });
        assert_err!(
            admit(t22(), &mut data),
            SoladromeError::UnsupportedMintExtension
        );
    }

    #[test]
    fn a_hook_authority_alone_does_not_refuse_the_mint() {
        // Only `program_id` arms a hook. An authority with an empty program slot is the
        // xStocks' shape, and refusing on the authority would exclude every one of them.
        let mut data = t22_mint_bytes(&[ExtensionType::TransferHook], |state| {
            let ext = state.init_extension::<TransferHook>(true).unwrap();
            ext.authority = OptionalNonZeroPubkey::try_from(Some(Pubkey::new_unique())).unwrap();
        });
        assert!(admit(t22(), &mut data).is_ok());
    }

    #[test]
    fn a_default_frozen_mint_is_refused() {
        // ☢️ The vault would be born frozen: `create_pool` succeeds and leaves behind a pool
        // that can never move a token, on `init` seeds that can never be reused.
        let mut data = t22_mint_bytes(&[ExtensionType::DefaultAccountState], |state| {
            let ext = state.init_extension::<DefaultAccountState>(true).unwrap();
            ext.state = u8::from(AccountState::Frozen);
        });
        assert_err!(
            admit(t22(), &mut data),
            SoladromeError::UnsupportedMintExtension
        );
    }

    #[test]
    fn one_bad_extension_condemns_an_otherwise_acceptable_mint() {
        // A mint carrying both an allowed and a refused extension must be refused: the gate
        // is a conjunction, and the order the extensions appear in the TLV must not matter.
        let mut data = t22_mint_bytes(
            &[
                ExtensionType::PermanentDelegate,
                ExtensionType::TransferHook,
            ],
            |state| {
                state.init_extension::<PermanentDelegate>(true).unwrap();
                let hook = state.init_extension::<TransferHook>(true).unwrap();
                hook.program_id =
                    OptionalNonZeroPubkey::try_from(Some(Pubkey::new_unique())).unwrap();
            },
        );
        assert_err!(
            admit(t22(), &mut data),
            SoladromeError::UnsupportedMintExtension
        );
    }
}
