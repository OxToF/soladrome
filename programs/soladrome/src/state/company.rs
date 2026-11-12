// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs

//! The operating company's share of the pool fees the protocol collects.

use anchor_lang::prelude::*;

/// Who runs the protocol, and what share of the collected pool fees pays for it.
///
/// Decided 2026-11-11: the protocol should be able to pay a legal entity that operates it
/// (engineers, infrastructure, audits) out of its fees, but that entity does not exist yet. So
/// the mechanism ships now and pays nobody: until the authority calls `set_company_fee`, this
/// PDA does not exist and `collect_pool_fees` sends everything to the pool's voters.
///
/// ☢️ It is a separate PDA, not two fields of `ProtocolState`, because the singleton has one
/// spare byte and no resize path (the July 3003 brick). And `collect_pool_fees` reads it at its
/// canonical address whether or not the caller wants it to: a permissionless crank that took
/// the config as an OPTIONAL account would let any caller omit it and send the company's share
/// to the voters.
///
/// The share applies to fees booked in the pool ledger (`AmmPool::protocol_fees_a/b`) only.
/// USDC fees still go straight to `market_vault` at swap time and stay 100 % with stakers:
/// carving a company share out of them would touch the stakers' fee accumulator, which every
/// claim depends on, for a percentage that is 0 today.
///
/// PDA: [b"company_config"]
#[account]
pub struct CompanyConfig {
    /// Owner of the token accounts the company's share is paid into, one per mint.
    pub wallet: Pubkey,
    /// Share of every collected pool fee paid to `wallet`, in bps, ≤ `MAX_COMPANY_FEE_BPS`.
    pub fee_bps: u16,
    pub bump: u8,
}
impl CompanyConfig {
    // 32 + 2 + 1 = 35 used, rounded up for later fields.
    pub const LEN: usize = 64;
}
