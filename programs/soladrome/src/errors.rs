// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Christophe Hertecant

use anchor_lang::prelude::*;

#[error_code]
pub enum SoladromeError {
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Insufficient floor reserve")]
    InsufficientFloorReserve,
    #[msg("Borrow limit exceeded")]
    BorrowLimitExceeded,
    #[msg("Outstanding debt blocks this action")]
    OutstandingDebt,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Unauthorized: signer is not the protocol authority")]
    Unauthorized,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Founder allocation already minted")]
    AlreadyAllocated,
    // ── Bribe system ──────────────────────────────────────────────────────────
    #[msg("Epoch argument does not match current on-chain epoch")]
    WrongEpoch,
    #[msg("Epoch has not ended yet — claim after the epoch rolls over")]
    EpochNotEnded,
    #[msg("Vote amount exceeds available hiSOLA balance for this epoch")]
    VoteOverflow,
    // ── AMM ───────────────────────────────────────────────────────────────────
    #[msg("Insufficient liquidity in pool")]
    InsufficientLiquidity,
    #[msg("Invalid pool tokens: same mint or unsorted mints")]
    InvalidPoolTokens,
    #[msg("Zero liquidity: deposit amounts must be non-zero")]
    ZeroLiquidity,
}
