// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs

//! Founder, contributor and partner allocation schedules.

use anchor_lang::prelude::*;

/// Running total of everything ever promised to contributors, so the cap is a protocol
/// invariant instead of a habit.
///
/// A separate singleton rather than two more fields on `ProtocolState`: that account has 9
/// spare bytes left and this needs 16. Growing it again would mean a second realloc migration
/// on the one account whose growth already bricked devnet in July — for a counter that is
/// written by an authority-only instruction and read by nothing else.
///
/// `register_contributor` uses `init`, so one wallet cannot be registered twice and these
/// totals cannot double-count.
///
/// PDA: [b"contributor_registry"]
#[account]
pub struct ContributorRegistry {
    pub hi_sola_allocated: u64,
    pub o_sola_allocated: u64,
    pub bump: u8,
}
impl ContributorRegistry {
    // 8 + 8 + 1 = 17 bytes used; 15 spare.
    pub const LEN: usize = 32;
}

/// Progressive hiSOLA distribution for the founder (7 M stake tranche).
/// Minting is deferred — no SOLA enters total_sola until claim_founder_hi_sola.
/// Each claim mints claimable SOLA to sola_vault + hiSOLA to founder 1:1.
/// PDA: [b"founder_hi_vesting"]
#[account]
pub struct FounderHiSolaVesting {
    pub total_amount: u64, // FOUNDER_STAKE = 7 000 000 SOLA (6 dec)
    pub claimed: u64,      // hiSOLA already minted to founder
    pub start_ts: i64,     // unix ts when mint_founder_allocation was executed
    pub bump: u8,
}
impl FounderHiSolaVesting {
    pub const LEN: usize = 8 + 8 + 8 + 1 + 7; // = 32 bytes
}

/// Progressive oSOLA vesting for the founder (5 M liquid tranche).
/// Founder claims oSOLA linearly; exercises via exercise_o_sola to get SOLA
/// at floor price — each exercise ADDS 1 USDC to floor_vault (net positive).
///
/// Vesting formula (after a 12-month cliff, `FOUNDER_O_SOLA_CLIFF_SECS`, since 2026-10-07):
///   total_vested = total_amount × min(elapsed, FOUNDER_O_SOLA_VESTING_SECS) / FOUNDER_O_SOLA_VESTING_SECS
///   (48 months; was the hiSOLA tranche's 24, see the constant for why)
///   claimable    = total_vested − already_claimed
///
/// PDA: [b"founder_vesting"]
#[account]
pub struct FounderVesting {
    /// Total oSOLA under vesting (= FOUNDER_LIQUID = 5 000 000).
    pub total_amount: u64,
    /// Cumulative oSOLA already minted to the founder.
    pub claimed: u64,
    /// Unix timestamp when `mint_founder_allocation` was executed.
    pub start_ts: i64,
    pub bump: u8,
}
impl FounderVesting {
    pub const LEN: usize = 8 + 8 + 8 + 1 + 7; // = 32 bytes with padding
}

/// A protocol partner's deal (Jito, Marinade, Solayer…): a closed bag, earned against
/// liquidity held in escrow (2026-11-09).
///
/// **The deal.** The partner escrows a bribe schedule of `schedule_epochs` epochs
/// (`fund_partner_bribe_stream`), then locks at least `lp_threshold` of `lp_mint` in the
/// protocol's LP escrow (`deposit_partner_lp`). For every full epoch the LP covers they are
/// credited `retainer_per_epoch` hiSOLA, up to `schedule_epochs` epochs — so the whole deal is
/// `base_hi_sola + retainer_per_epoch × schedule_epochs`, known at signature, and then it ends.
/// The LP comes back through `withdraw_partner_lp` once every epoch of the term is behind it.
///
/// ☢️ **Why the escrow.** Until 2026-11-09 the condition was the partner's own LP balance,
/// read at the instant of the crank, and the retainer had no end. An SPL balance has no
/// history, so a partner could add liquidity, crank and remove it in one transaction, and earn
/// every epoch for zero seconds of liquidity — forever. Holding the LP in a vault only the
/// program moves, with no exit before the term is over, turns "was the liquidity there?" from
/// an instant into an interval: credits are a function of time and nothing else.
///
/// What the partner keeps: the swap fees (they accrue to the pool's reserves, so the escrowed
/// LP grows in value), permanent voting power, protocol fees for life on everything credited
/// (`UserPosition.fee_shares`). What they give up: the oSOLA LP emissions on the escrowed part
/// (the bag replaces them), and borrowing — nothing unfinanced borrows since 2026-11-09.
///
/// PDA: [b"partner", partner_wallet]
#[account]
#[derive(InitSpace)]
pub struct PartnerAllocation {
    pub partner: Pubkey,    // beneficiary wallet (immutable after init)
    pub bribe_mint: Pubkey, // committed bribe token — the escrowed stream must be in this mint
    /// The LP token whose balance is attested every epoch, named in the deal at registration.
    ///
    /// Stored rather than derived. Deriving it — "the pool holding `bribe_mint` and the
    /// protocol's USDC" — would have saved 32 bytes and cost the partner the right to bribe in
    /// one token while providing liquidity in another, which is the normal shape of an LST
    /// deal (bribes in the governance token, liquidity in the staked one).
    pub lp_mint: Pubkey,
    /// LP tokens the partner must still hold when the epoch is cranked, or that epoch pays
    /// nothing. Fixed at registration: the tier is negotiated in dollars, the chain only ever
    /// sees LP units and there is no oracle, so what gets frozen here is the unit count that
    /// matched the agreed size on the day. Imprecise on value, exact on "did they withdraw".
    pub lp_threshold: u64,
    /// hiSOLA credited per qualified epoch — the rate, and the only figure that sets the pace.
    pub retainer_per_epoch: u64,
    /// The epoch in which the partner's LP left the escrow, or 0 while it is still there (or was
    /// never deposited). Renamed from `last_credited_epoch` on 2026-11-09, same slot.
    ///
    /// Credits are computed from time, not attested by a crank: the LP sits in a vault only
    /// `withdraw_partner_lp` can empty, so every epoch between `lp_qualified_since_ts` and
    /// this one is provably covered. Freezing the end here is what lets a crank that arrives
    /// late still pay the right count — and nothing more — after the LP is gone.
    pub lp_withdrawn_epoch: u64,
    /// How many epochs actually paid. Read by `close_partner_allocation` and by the UI; it is
    /// the only record that a retainer ever ran, since no total is ever written down.
    pub epochs_qualified: u32,
    pub hi_sola_claimed: u64, // cumulative hiSOLA locked for this deal (bag + retainer, monotonic)
    pub lock_duration_secs: u64, // lock duration per claim (validated in [MIN, MAX] at register)
    pub start_ts: i64,        // unix timestamp when register_partner was executed
    pub bump: u8,
    /// The signature bag: delivered whole, once, the moment the bribe schedule is escrowed.
    ///
    /// It used to stream over six months, back when it was the compensation. It is now the
    /// unconditional part of the deal and nothing else, which is precisely why it is small —
    /// 20 000 / 7 500 / 2 000 hiSOLA across the three tiers, against a retainer that pays the
    /// rest only while the liquidity is there.
    pub base_hi_sola: u64,
    /// Whether the bag has been delivered. Its own flag rather than a comparison against
    /// `hi_sola_claimed`, which now counts retainer epochs too and would otherwise let a
    /// partner who cranked first claim the bag a second time.
    pub bag_claimed: bool,
    /// Unix timestamp at which the partner funded their bribe stream, or 0 if they never did.
    ///
    /// **This is the gate on the whole deal** — the bag and the retainer both. A partner could
    /// otherwise register, never bribe a unit, and still collect permanent voting power the
    /// floor had funded nothing for. 0 means no stream, which means nothing accrues; legacy
    /// accounts read 0 and therefore fail closed, never open.
    pub stream_start_ts: i64,
    /// How many epochs the partner's bribes must be spread over, agreed at registration.
    ///
    /// The rhythm is a term of the deal, not the partner's to pick: `fund_partner_bribe_stream`
    /// refuses any schedule of a different length. Typical values are 26 (6 months), 52 (a
    /// year) or 104 (two years). 0 means unset — legacy allocations only, which accept any
    /// length so an upgrade cannot strand a partner mid-negotiation.
    pub schedule_epochs: u64,
    /// Smallest per-epoch bribe the escrow may be funded with, in the bribe mint's base units.
    ///
    /// The size of the bribe is the other half of the rhythm, and it needs its own floor. The
    /// old check derived one from `cap_hi_sola` and the 1:1 rate — "escrow enough that the
    /// bribes earn the whole cap" — which disappeared with the cap. Without a replacement, a
    /// partner could escrow 52 epochs of one lamport, satisfy every length check, and unlock
    /// the bag: the schedule would exist and mean nothing.
    pub min_bribe_per_epoch: u64,
    /// Unix timestamp at which the escrow first held `lp_threshold`, or 0 if it never has.
    ///
    /// The first epoch that counts is the first one to START at or after this instant: an epoch
    /// is credited only if the liquidity covered all seven days of it. Set once — the escrow
    /// cannot be drawn down before the term is over, so the condition cannot lapse mid-deal.
    pub lp_qualified_since_ts: i64,
}
impl PartnerAllocation {
    // 32*3 + 8*2 + 8 + 4 + 8*3 + 1 + 8*4 + 1 + 8 = 190 bytes used; 2 spare.
    // (2026-11-09: `lp_qualified_since_ts` carved from the spare — no resize, no migration.)
    //
    // ⚠️ 160 → 192 (2026-08-27). Dropping the 1:1 machinery freed 32 bytes (`rate_num`,
    // `rate_den`, `cap_hi_sola`, `total_bribed_credited`) and the retainer needs 36 of them,
    // because the deal now names the LP pool explicitly. `register_partner` uses `init`, so a
    // live allocation at the old size does not realloc — it must go through
    // `close_partner_allocation` and be re-registered on the new terms. That is the renewal
    // path this account already documents, not a workaround: every field the old account holds
    // would otherwise be read back under a new name with a stale value.
    pub const LEN: usize = 192;
}

// Measured against `INIT_SPACE` — the Borsh wire size — for the same reason as UserPosition:
// `size_of` pads to the struct's alignment and would demand LEN cover bytes that never reach
// the account. A resize this large deserves a build error rather than a runtime one.
const _: () = assert!(
    PartnerAllocation::LEN >= PartnerAllocation::INIT_SPACE,
    "PartnerAllocation::LEN is too small — update it to fit the struct"
);

// ── Partner bribe stream ──────────────────────────────────────────────────────

/// An escrowed, self-paced bribe schedule: the partner funds it once and it pays out one
/// tranche per epoch, forever after, without them signing again.
///
/// It exists because `partner_deposit_bribe` requires `epoch == current_epoch`, so a partner
/// could only ever bribe the week they were transacting in. Delivering "300 SOL a week for a
/// year" meant 52 signatures, and missing one meant that gauge got nothing. Worse, the
/// incentive ran the other way: every `claim_partner_allocation` resets `lock_end_ts` to
/// `now + lock_duration`, so bribing everything at once and claiming once released the
/// bribe-earned tranche 52 epochs sooner than paying weekly. The instrument rewarded exactly
/// the behaviour the gauges least wanted — one enormous mercenary week, then silence.
///
/// Release is **permissionless**, like `replay_vote`: the epoch's voters are the ones owed the
/// bribe, so anyone may crank it, and no single keeper can withhold it.
///
/// The schedule **slips** rather than catching up. If nobody cranks an epoch, the next call
/// pays the next tranche — at most one per epoch, never several at once. Nothing is lost and
/// nothing is written retroactively; the stream simply runs longer. Batching missed tranches
/// would re-concentrate the bribes, which is the failure this account exists to prevent.
///
/// PDA: [b"bribe_stream", partner]
#[account]
pub struct PartnerBribeStream {
    pub partner: Pubkey,    // beneficiary wallet, matching PartnerAllocation.partner
    pub bribe_mint: Pubkey, // must equal PartnerAllocation.bribe_mint — the committed token
    pub pool_id: Pubkey,    // the gauge this stream feeds, fixed for the life of the stream
    pub amount_per_epoch: u64, // released each epoch, in the bribe mint's base units
    pub epochs_total: u64,  // tranches funded at escrow time
    pub epochs_released: u64, // tranches paid out so far; stream is spent at epochs_total
    pub last_release_epoch: u64, // guards one release per epoch — this is what makes it slip
    pub start_ts: i64,      // when the escrow was funded; the welcome bag vests from here
    pub bump: u8,
}
impl PartnerBribeStream {
    // 32*3 + 8*4 + 8 + 1 = 137 bytes used; 23 spare for later fields.
    pub const LEN: usize = 160;
}

/// Per-contributor dual vesting schedule (marketing, community, service providers).
///
/// Mirrors the founder allocation — two tranches per contributor:
///   • hiSOLA: governance rights + borrow collateral (mints SOLA to sola_vault 1:1)
///   • oSOLA:  liquid options (exercisable at floor price via exercise_o_sola)
///
/// Borrow cap: 10 % of the monthly hiSOLA installment (hi_sola_amount / 12 × 10%).
/// Flash-borrow guard: same slot-based defence as regular `borrow_usdc`.
/// Repay:      uses the standard `repay_usdc` instruction (same UserPosition PDA).
///
/// PDA: [b"contributor", contributor_wallet]
#[account]
pub struct ContributorVesting {
    pub contributor: Pubkey,  // Beneficiary wallet (immutable after init)
    pub hi_sola_amount: u64,  // Total hiSOLA allocated
    pub o_sola_amount: u64,   // Total oSOLA allocated
    pub hi_sola_claimed: u64, // hiSOLA already minted
    pub o_sola_claimed: u64,  // oSOLA already minted
    pub start_ts: i64,        // Unix timestamp when register_contributor was called
    pub bump: u8,
}
impl ContributorVesting {
    pub const LEN: usize = 32 + 8 + 8 + 8 + 8 + 8 + 1 + 7; // = 80 bytes
}
