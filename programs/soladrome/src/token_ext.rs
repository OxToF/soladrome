// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

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
