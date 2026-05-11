use anchor_lang::prelude::*;

/// Scaling factor for fee-per-token accumulator (avoids fractional USDC loss).
pub const PRECISION: u128 = 1_000_000_000_000; // 1e12

// ── Epoch helpers ─────────────────────────────────────────────────────────────
pub const EPOCH_DURATION: u64 = 7 * 24 * 60 * 60; // 604 800 s = 7 days

pub fn current_epoch(unix_ts: i64) -> u64 {
    (unix_ts.max(0) as u64) / EPOCH_DURATION
}

#[account]
pub struct ProtocolState {
    pub authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub sola_mint: Pubkey,
    pub hi_sola_mint: Pubkey,
    pub o_sola_mint: Pubkey,
    pub floor_vault: Pubkey,          // USDC: 1 USDC per SOLA in supply
    pub market_vault: Pubkey,         // USDC: excess above floor (fee revenue)
    pub sola_vault: Pubkey,           // locked SOLA from stakers
    pub virtual_usdc: u64,            // virtual USDC in bonding curve
    pub virtual_sola: u64,            // virtual SOLA in bonding curve
    pub k: u128,                      // constant product = virtual_usdc * virtual_sola
    pub total_sola: u64,              // real SOLA minted (not virtual)
    pub total_hi_sola: u64,
    pub accumulated_fees: u64,        // lifetime market vault inflows
    pub fees_per_hi_sola: u128,       // cumulative USDC-per-hiSOLA × PRECISION
    pub last_market_vault_balance: u64, // snapshot used to detect new fees
    pub bump: u8,
    /// Prevents mint_founder_allocation from being called more than once.
    pub founder_allocated: bool,
}

impl ProtocolState {
    pub const LEN: usize = 400;
}

#[account]
#[derive(Default)]
pub struct UserPosition {
    pub owner: Pubkey,
    pub usdc_borrowed: u64,
    pub fees_debt: u128,  // fees_per_hi_sola at last claim / entry point
    pub bump: u8,
}

impl UserPosition {
    pub const LEN: usize = 128;
}

// ── Bribe system ──────────────────────────────────────────────────────────────

/// Bribe pot for one (pool_id, reward_mint, epoch) triplet.
/// Permissionless — any protocol can deposit. Multiple deposits per epoch are additive.
/// PDA: [b"bribe_vault", pool_id, reward_mint, epoch_le8]
#[account]
pub struct BribeVault {
    pub pool_id:      Pubkey,  // External pool being incentivised (label only)
    pub reward_mint:  Pubkey,  // Token offered as bribe
    pub epoch:        u64,     // Epoch this bribe applies to
    pub total_bribed: u64,     // Cumulative amount deposited this epoch
    pub bump:         u8,
}
impl BribeVault { pub const LEN: usize = 128; }

/// Aggregate hiSOLA vote-weight directed at a pool for one epoch.
/// PDA: [b"gauge", pool_id, epoch_le8]
#[account]
pub struct GaugeState {
    pub pool_id:     Pubkey,
    pub epoch:       u64,
    pub total_votes: u64,
    pub bump:        u8,
}
impl GaugeState { pub const LEN: usize = 96; }

/// Records one user's vote for a specific (pool, epoch) pair.
/// Created with `init` — immutable once written, prevents double-voting for same pool.
/// PDA: [b"vote", user, pool_id, epoch_le8]
#[account]
pub struct UserVoteReceipt {
    pub user:    Pubkey,
    pub pool_id: Pubkey,
    pub epoch:   u64,
    pub votes:   u64,  // hiSOLA weight committed to this pool
    pub bump:    u8,
}
impl UserVoteReceipt { pub const LEN: usize = 128; }

/// Tracks total vote-weight already allocated by one user in an epoch (across all pools).
/// Prevents voting more than the user's hiSOLA balance.
/// PDA: [b"uev", user, epoch_le8]
#[account]
pub struct UserEpochVotes {
    pub epoch:     u64,
    pub allocated: u64,  // sum of all votes cast this epoch
    pub bump:      u8,
}
impl UserEpochVotes { pub const LEN: usize = 64; }

/// Created during claim_bribe — its existence proves the claim was made.
/// PDA: [b"bribe_claim", user, pool_id, reward_mint, epoch_le8]
#[account]
pub struct UserBribeClaim {
    pub bump: u8,
}
impl UserBribeClaim { pub const LEN: usize = 32; }
