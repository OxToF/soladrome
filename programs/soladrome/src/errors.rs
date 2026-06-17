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
    // ── Ve-layer ──────────────────────────────────────────────────────────────
    #[msg("Lock has not expired yet")]
    LockNotExpired,
    // ── LP emissions ──────────────────────────────────────────────────────────
    #[msg("Pool epoch rewards not finalized — call emit_pool_rewards first")]
    EpochNotFinalized,
    #[msg("No votes recorded for this pool/epoch — cannot distribute emissions")]
    NoVotes,
    // ── Flash arbitrage ───────────────────────────────────────────────────────
    #[msg("AMM price too low — arbitrage not profitable after floor replenishment")]
    NotProfitable,
    #[msg("Pool must be a SOLA/USDC pair for flash arbitrage")]
    InvalidArbPool,
    // ── Founder vesting ───────────────────────────────────────────────────────
    #[msg("Vesting cliff has not been reached yet")]
    VestingCliffNotReached,
    #[msg("All vested tokens have already been claimed")]
    VestingFullyClaimed,
    // ── Founder borrow cap ────────────────────────────────────────────────────
    #[msg("Founder borrow cap exceeded: max 10% of total claimed hiSOLA")]
    FounderBorrowCapExceeded,
    // ── Flash-borrow guard ────────────────────────────────────────────────────
    #[msg("Flash-borrow detected: repay cannot occur in the same slot as borrow")]
    FlashBorrowDetected,
    // ── Contributor / marketing vesting ──────────────────────────────────────
    #[msg("Contributor borrow cap exceeded: max 10% of total claimed oSOLA")]
    ContributorBorrowCapExceeded,
    // ── Floor reserve buffer ──────────────────────────────────────────────────
    #[msg("Borrow would bring floor vault below 75% of floor-backed supply — repay existing borrows or wait for more SOLA purchases")]
    BorrowExceedsFloorBuffer,
    // ── Emergency pause ───────────────────────────────────────────────────────
    #[msg("Protocol is paused — only exit instructions (sell, unstake, repay, remove_liquidity, claim, unlock) are available")]
    ProtocolPaused,
    // ── Governance cap ────────────────────────────────────────────────────────
    #[msg("Vote would exceed the 30% per-address voting cap — no single address may control more than 30% of total hiSOLA voting power")]
    VoteWeightCapExceeded,
    // ── Bribe rollover ────────────────────────────────────────────────────────
    #[msg("Rollover too early — epoch had votes, wait ROLLOVER_DELAY_EPOCHS before recycling remainder")]
    RolloverTooEarly,
    // ── Partner allocation ────────────────────────────────────────────────────
    #[msg("Partner allocation already claimed — each partner may only claim once")]
    PartnerAlreadyClaimed,
    #[msg("Invalid conversion rate: rate_num and rate_den must both be > 0")]
    InvalidRate,
    #[msg("Bribe token does not match the partner's committed bribe_mint")]
    BribeMintMismatch,
    // ── Vote carry-over ───────────────────────────────────────────────────────
    #[msg("Pool not found in user vote config — update config with set_vote_config")]
    PoolNotInConfig,
    #[msg("Vote config auto-replay is disabled — owner must call vote_gauge manually")]
    VoteConfigDisabled,
    #[msg("Invalid vote config: n_pools out of range or bps do not sum to 10 000")]
    InvalidVoteConfig,
    // ── Founder vesting lock ──────────────────────────────────────────────────
    #[msg("Founder hiSOLA is vesting-locked — amount exceeds unlocked allocation")]
    FounderVestingLocked,
    // ── Founder governance ────────────────────────────────────────────────────
    #[msg("Founder voting is disabled — the founder stake is a dormant anti-capture reserve")]
    FounderVotingDisabled,
}
