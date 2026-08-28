// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Account-layout migrations for deployments that predate a struct change.
//!
//! Dead on a fresh deployment: there is nothing to migrate, and every path reverts.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::state::*;

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

/// One-time account migration — expands an existing UserPosition from the
/// pre-`last_borrow_slot` layout (LEN=120, space=128) to the current layout
/// (LEN=128, space=136).  The 8 new bytes are zeroed so last_borrow_slot=0.
/// Permissionless per-user: the owner pays the extra rent and signs.
pub fn migrate_user_position(_ctx: Context<MigrateUserPosition>) -> Result<()> {
    Ok(())
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
