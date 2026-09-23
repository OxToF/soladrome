// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs

//! Per-position reward strategies.

use anchor_lang::prelude::*;

/// Liquidity: the position's rewards are sold and deposited into `target_pool`.
pub const STRATEGY_LIQUIDITY: u8 = 1;
/// Voting power: the position's rewards are exercised and staked as hiSOLA.
pub const STRATEGY_VOTE: u8 = 2;

/// What happens to ONE LP position's oSOLA rewards: "the rewards of my position in `source_pool`
/// go to liquidity in `target_pool`", or "…go to voting power".
///
/// ☢️ WHY PER POSITION, AND WHY AT THE SOURCE. Every pool pays its oSOLA into the same wallet
/// account, where it stops being attributable — nothing in a token balance says which pool an
/// oSOLA came from — so a strategy that reads the wallet can only have one destination for all of
/// it. A strategy here harvests its own position's accrual straight from the pool's accumulator
/// (`harvest_lp_rewards`), which the program already computes exactly per position. Two
/// positions' strategies therefore never touch each other's rewards.
///
/// And the liquidity strategy needs NO token allowance at all: the harvested oSOLA is minted
/// straight into the sale vault and never exists in the owner's wallet. The voting strategy
/// needs the USDC to pay the strike, through the same delegate as the standing order.
///
/// PDA: [b"strategy", owner, source_pool]
#[account]
pub struct PoolStrategy {
    pub owner: Pubkey,
    /// The pool whose position's rewards this strategy harvests.
    pub source_pool: Pubkey,
    /// Liquidity only: the pool the rewards are deposited into — `source_pool` itself by default,
    /// any pool that pairs USDC or SOL otherwise. The default key for a voting strategy.
    pub target_pool: Pubkey,
    /// `STRATEGY_LIQUIDITY` or `STRATEGY_VOTE`.
    pub mode: u8,
    /// Harvest only once at least this much oSOLA has accrued, so a round is worth its fee.
    pub min_harvest: u64,
    /// Shortest gap between two rounds, at least `MIN_CRANK_INTERVAL` for the same reason as a
    /// standing order: `Clock` does not move inside a transaction.
    pub min_interval: i64,
    pub last_ts: i64,
    pub rounds: u64,
    /// Lifetime oSOLA harvested. Informational.
    pub harvested: u64,
    /// Liquidity: the least share of exercise value the sale accepts (see `AutoCompound`).
    pub min_intrinsic_bps: u16,
    /// Vote: the highest exercise fee rate the owner accepts (see `AutoCompound`).
    pub max_fee_bps: u16,
    pub bump: u8,
}

impl PoolStrategy {
    // 32·3 + 1 + 8 + 8 + 8 + 8 + 8 + 2 + 2 + 1 = 142 used of 192: fifty spare bytes so the fields a
    // later version wants never need a realloc — the lesson of the 3003 devnet brick. New fields go
    // at the END, where an older account reads zeros.
    pub const LEN: usize = 192;

    /// Whether enough time has passed since the last round.
    pub fn due(&self, now: i64) -> bool {
        now.saturating_sub(self.last_ts) >= self.min_interval
    }
}
