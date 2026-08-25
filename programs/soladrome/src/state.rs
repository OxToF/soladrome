// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

use anchor_lang::prelude::*;

/// Scaling factor for fee-per-token accumulator (avoids fractional USDC loss).
pub const PRECISION: u128 = 1_000_000_000_000; // 1e12

// ── Epoch helpers ─────────────────────────────────────────────────────────────
//
// ⚠️  TIME-SENSITIVE CONSTANTS — one value each, for every cluster.
//
// These were compile-time gated by a `devnet` feature that was ON BY DEFAULT, so `anchor build`
// produced 5-second cliffs and 5-second minimum locks while the mainnet build needed
// `--no-default-features`. Removed 2026-08-23: devnet and mainnet now run the identical binary,
// and the paths that must cross a 180-day cliff are tested under bankrun's warped clock
// (tests/bankrun_allocations.ts) rather than against shortened numbers.
//
// If a path is ever untestable against a real validator clock again: move the test, not the
// constant.

/// Epoch length: 7 days on both devnet and mainnet.
pub const EPOCH_DURATION: u64 = 7 * 24 * 60 * 60; // 604 800 s

// ── Founder vesting schedule ──────────────────────────────────────────────────

/// Cliff before any founder tokens unlock: 6 months, everywhere.
///
/// ⚠️ Until 2026-08-23 this was 5 s under the `devnet` feature, so that a test could cross
/// it against a real validator clock. That made devnet a different protocol from mainnet on
/// the single most sensitive number in the tokenomics. The cliff is now one value, and the
/// paths that must cross it are exercised under bankrun's warped clock — the test moves, the
/// constant does not.
pub const VESTING_CLIFF_SECS: u64 = 180 * 24 * 3_600;

/// Linear vesting window that starts after the cliff. 24 months.
pub const VESTING_DURATION_SECS: u64 = 720 * 24 * 3_600;

// ── Partner welcome-bag streaming window ──────────────────────────────────────
/// The one-time partner welcome bag streams linearly over the first 6 months
/// from `register_partner` (no cliff). Mirrors the founder cliff window so partner
/// governance ramps in step with the founder's, not instantly on day 1. 6 months, everywhere.
pub const BASE_BAG_VEST_SECS: u64 = 180 * 24 * 3_600;

// (Contributor vesting schedule removed 2026-07-18 — contributors now claim their whole
//  allocation at launch: hiSOLA into a lifetime ve lock + oSOLA. No cliff, no linear vest.)

// ── Ve-layer constants ────────────────────────────────────────────────────────
/// Minimum lock duration: 1 epoch (7 days), everywhere.
///
/// ⚠️ Was 5 s under the `devnet` feature, because 7 days made the ve lock/unlock cycle
/// untestable against a real validator — which is why the partner path had zero coverage
/// until 2026-07-17. The answer to "untestable against a real clock" is a warped clock, not
/// a different constant: the lock/unlock cycle now lives in the bankrun suite.
pub const MIN_LOCK_DURATION: u64 = EPOCH_DURATION;
/// Maximum lock duration: 208 epochs (4 years) → full 4× ve-power at max lock.
pub const MAX_LOCK_DURATION: u64 = 208 * EPOCH_DURATION;
/// Voting power multiplier at maximum lock (4× raw hiSOLA).
pub const MAX_VE_MULTIPLIER: u64 = 4;

// ── Flash arbitrage profit split ──────────────────────────────────────────────
/// Caller keeps 10 % of gross profit; remaining 90 % routes to market_vault → hiSOLA stakers.
pub const CALLER_ARB_SHARE_BPS: u64 = 1_000;

// ── Floor reserve buffer ──────────────────────────────────────────────────────
/// After any borrow, the floor vault must hold at least this fraction of
/// total_purchased_sola (floor-backed supply). 7 500 bps = 75 %.
/// At most 25 % of the floor vault can be lent out at once.
/// Guarantees users can always redeem ≥ 75 % of the float via sell_sola.
pub const FLOOR_RESERVE_MIN_BPS: u64 = 7_500;

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
    pub floor_vault: Pubkey,  // USDC: 1 USDC per SOLA in supply
    pub market_vault: Pubkey, // USDC: excess above floor (fee revenue)
    pub sola_vault: Pubkey,   // locked SOLA from stakers
    pub virtual_usdc: u64,    // virtual USDC in bonding curve
    pub virtual_sola: u64,    // virtual SOLA in bonding curve
    pub k: u128,              // constant product = virtual_usdc * virtual_sola
    pub total_sola: u64,      // real SOLA minted (not virtual)
    pub total_hi_sola: u64,
    pub accumulated_fees: u64,          // lifetime market vault inflows
    pub fees_per_hi_sola: u128,         // cumulative USDC-per-hiSOLA × PRECISION
    pub last_market_vault_balance: u64, // snapshot used to detect new fees
    pub bump: u8,
    /// Prevents mint_founder_allocation from being called more than once.
    pub founder_allocated: bool,
    /// Prevents mint_ecosystem_allocation from being called more than once.
    pub ecosystem_allocated: bool,
    /// Sum of all outstanding USDC borrows across all users.
    /// Invariant: floor_vault + total_usdc_borrowed >= total_sola at all times.
    pub total_usdc_borrowed: u64,
    /// SOLA minted exclusively via buy_sola or exercise_o_sola (floor-backed supply).
    /// Used as the invariant denominator in sell_sola, replacing total_sola which
    /// includes unfinanced founder/ecosystem allocations.
    pub total_purchased_sola: u64,
    /// Emergency pause flag — set by authority via `pause` instruction.
    /// When true, all state-mutating entry instructions revert with ProtocolPaused.
    /// Exit paths (sell_sola, unstake, repay, remove_liquidity, claim_*, unlock)
    /// are intentionally excluded so users can always withdraw their funds.
    pub paused: bool,

    // ── Epoch oSOLA emission decay ────────────────────────────────────────────
    /// Starting emission for the epoch-based gauge system (oSOLA per epoch).
    /// Set at `initialize`; overridable via `configure_emissions`.
    pub osola_emission_initial: u64,
    /// Decay factor applied each epoch (basis points, 10 000 = no decay).
    /// Default: 9 900 (−1 %/epoch ≈ −40 %/year).
    pub osola_emission_decay_bps: u16,
    /// Minimum emission as % of initial (basis points).
    /// Default: 2 500 (25 % of 20 000 = a 5 000 oSOLA/epoch steady state).
    ///
    /// Think of the FLOOR in absolute terms and the ratio as the taper speed: the pair
    /// (initial, floor_bps) fixes both the launch pull and where it lands. 20 000 @ 25 %
    /// and 10 000 @ 50 % settle at the same 5 000/epoch — the first just starts twice as
    /// high and takes 2.6 y instead of 1.3 y to get there.
    ///
    /// This doc said "1 000 (10 %)" until 2026-08-09 while `initialize` actually wrote
    /// 1 875 — the published emission schedule was wrong by nearly 2× on the perpetual
    /// tail for months. Keep this line and `initialize` in sync.
    pub osola_emission_floor_bps: u16,
    /// Epoch at which the decay clock started (reset by `configure_emissions`).
    pub osola_emission_start_epoch: u64,

    /// Founder break-glass voting switch. Default `false`: the hardcoded founder
    /// wallet cannot vote on gauges — its 7M hiSOLA is a dormant anti-capture
    /// reserve, not routine governance power. Authority may flip it to `true` via
    /// `set_founder_voting` ONLY to counter a detected takeover (sybil capture).
    pub founder_voting_enabled: bool,

    // ── Continuous (Masterchef) oSOLA emission — launch bootstrap ──────────────
    // Packed into the prior 16 spare bytes of this singleton (u32+u16 = 6 bytes;
    // u64+u64 would overflow LEN and the singleton cannot grow without a realloc
    // migration). Ranges are ample for a launch-bootstrap feature.
    /// Per-pool oSOLA emission rate (6 dec base units / second) for the continuous
    /// stream. Applies to each pool with `rewards_enabled = true`. Default 0 (off);
    /// set by `configure_continuous_emissions`. u32 max ≈ 4 290 oSOLA/s.
    pub continuous_rate_per_sec: u32,
    /// Epoch at which the continuous stream stops (exclusive): emissions accrue
    /// only while `current_epoch < continuous_end_epoch`. On-chain sunset so the
    /// launch bootstrap auto-expires without a manual toggle. Default 0 (off).
    /// u16 caps at epoch 65 535 (≈ year 3225) — irrelevant for a bootstrap window.
    pub continuous_end_epoch: u16,

    // ── Phase gating (private mainnet launch) ───────────────────────────────
    // Packed into the remaining spare bytes of this singleton — no realloc.
    // All default `false` at `initialize`. Two-stage launch:
    //   Stage 1 (partner-only window): authority enables lp/bribes/voting for
    //     founding partners; the bonding curve stays CLOSED (`curve_enabled`
    //     false) so nobody can front-run the bottom of the monotonic curve
    //     before the public open + airdrop.
    //   Stage 2 (public open): authority flips `curve_enabled` — curve opening,
    //     TGE and airdrop distribution happen as one event.
    /// Gates `create_pool` — no permissionless AMM pool can be created while false.
    pub lp_enabled: bool,
    /// Gates `deposit_bribe` and `partner_deposit_bribe`.
    pub bribes_enabled: bool,
    /// Gates `vote_gauge`.
    pub voting_enabled: bool,
    /// Gates `exercise_o_sola`.
    pub exercise_enabled: bool,
    /// Gates `buy_sola` (bonding-curve entry). `sell_sola` is intentionally NOT
    /// gated: redemption at floor is an exit path and must never be blockable
    /// (same policy as `paused`). Partners don't need the curve during stage 1 —
    /// they receive hiSOLA via `register_partner` and LP on non-SOLA pools.
    pub curve_enabled: bool,

    /// Cumulative oSOLA minted through `distribute_o_sola`, capped at `ECOSYSTEM_TOTAL`.
    /// Without this counter the published 1.75M ecosystem budget was decorative:
    /// `distribute_o_sola` only checked `amount > 0`, so the authority could mint oSOLA
    /// without limit — unbounded dilution of every holder's upside, and any fixed-supply
    /// claim false. Appended last and carved from the spare bytes, so existing accounts
    /// read 0 and no realloc is needed (same trick as the phase flags above).
    pub ecosystem_o_sola_minted: u64,

    /// Master switch for ALL oSOLA emission. Gates BOTH the epoch/gauge path
    /// (`emit_pool_rewards`) and the continuous-stream path (`continuous_active`
    /// in amm.rs). Default `false` at `initialize`: nothing emits until the
    /// authority explicitly arms it via `set_phase_flags`. Makes "emissions are
    /// dormant" provable at a glance instead of inferred from the transitive
    /// no-votes coupling in `emit_pool_rewards` — so the untested per-epoch
    /// cycle can stay descoped from the launch audit and be reviewed pre-Genesis
    /// when it is actually armed. Appended last, carved from the spare bytes so
    /// existing accounts read `false` with no realloc (same trick as above).
    pub emissions_enabled: bool,

    /// Exercise fee, in basis points **of the GAIN** — never of the strike, and never flat.
    ///
    /// `fee = exercise_fee_bps × (curve_price − 1) × amount`, where
    /// `curve_price = virtual_usdc / virtual_sola`. A flat fee would be regressive
    /// backwards: it makes exercise unprofitable exactly when the gain is thin (killing
    /// oSOLA as an LP incentive) and is trivial when the gain is large. Charging a
    /// fraction of the gain keeps exercise profitable at every price by construction,
    /// so no "exercise is now underwater" failure mode exists for any value below 10 000.
    ///
    /// ☢️ The fee is paid **on top of** the 1 USDC strike and is routed to `market_vault`.
    /// It is NEVER carved out of the strike — see the comment in `exercise_o_sola`.
    ///
    /// Capped at `MAX_EXERCISE_FEE_BPS` (50%) by `set_exercise_fee` so a compromised or
    /// careless authority cannot set 100% and silently kill the emission incentive.
    ///
    /// Appended last, carved from the spare bytes so existing accounts read 0 — i.e. the
    /// live devnet singleton keeps today's zero-fee behaviour until the authority arms it
    /// via `set_exercise_fee`. Same no-realloc trick as the fields above; see the 3003
    /// incident for what happens when a live singleton is grown instead.
    pub exercise_fee_bps: u16,

    /// The founder wallet — holder of the 7M ve-locked governance tranche and the 5M oSOLA
    /// vesting, and the address every founder guard keys on (`unlock_hi_sola`, `vote_gauge`,
    /// `burn_o_sola_for_votes`, `claim_founder_*`).
    ///
    /// Written once by `initialize` and **never writable again** — there is deliberately no
    /// setter. A mutable founder address would let whoever holds the authority redirect the
    /// whole allocation, which is precisely the property the old hardcoded constant had and
    /// which must survive the move into state.
    ///
    /// ☢️ THIS IS THE FIELD THAT REPLACED THE MOST DANGEROUS CONSTANT IN THE PROGRAM. It used
    /// to be a `#[cfg]` pair — throwaway devnet key vs mainnet Ledger — selected by a feature
    /// that was on by default, so the *safe* binary was the one you had to remember a flag
    /// for. Devnet and mainnet therefore ran different code. They no longer do; see the long
    /// note at the head of lib.rs.
    ///
    /// ⚠️ The 32 bytes did NOT fit in the 9 spare bytes this singleton had left, so unlike
    /// every field above it this one grew `LEN` (416 → 448) and needs a realloc on any live
    /// deployment — that is what `migrate_protocol_state` is for. Legacy accounts read all
    /// zeros here until migrated, and `Pubkey::default()` matches no signer, so every founder
    /// guard fails closed in the interval rather than open.
    pub founder_wallet: Pubkey,
}

impl ProtocolState {
    // Total account space INCLUDING the 8-byte Anchor discriminator.
    // Base:       8×Pubkey(256) + u64×6(48) + u128×2(32) + u8(1) + bool×3(3) + u64×2(16) = 356
    // Emission:   u64(8) + u16(2) + u16(2) + u64(8) = 20
    // Founder:    bool(1) = 1
    // Continuous: u32(4) + u16(2) = 6    ← carved from the prior 16 spare bytes
    // Phase gate: bool×5 = 5              ← carved from the remaining spare bytes
    // Ecosystem:  u64(8) = 8              ← ecosystem_o_sola_minted, appended
    // Emissions:  bool(1) = 1             ← emissions_enabled, appended last
    // Exercise:   u16(2) = 2              ← exercise_fee_bps, appended last
    // Founder pk: Pubkey(32) = 32         ← founder_wallet, 2026-08-23
    //
    // ⚠️ Update this value whenever a field is added or removed.
    //
    // ⚠️ 416 → 448 (2026-08-23). Every field before `founder_wallet` was carved from spare
    // bytes precisely to avoid this, but 9 spare bytes cannot hold a 32-byte key. Growing a
    // live singleton is what caused the 3003 devnet brick in July, so the growth goes through
    // `migrate_protocol_state` (realloc, zero-filled) and nothing else.
    pub const LEN: usize = 448;
}

// Compile-time guard: if ProtocolState grows past LEN the program will fail to
// deploy rather than silently corrupting accounts at runtime.
const _: () = assert!(
    ProtocolState::LEN >= 8 + std::mem::size_of::<ProtocolState>(),
    "ProtocolState::LEN is too small — update it to fit the struct"
);

#[account]
#[derive(Default, InitSpace)]
pub struct UserPosition {
    pub owner: Pubkey,
    pub usdc_borrowed: u64,
    pub fees_debt: u128, // fees_per_hi_sola at last claim / entry point
    pub bump: u8,
    /// Slot at which the most recent borrow was executed.
    /// repay_usdc requires current_slot > last_borrow_slot — blocks same-tx
    /// flash-borrow attacks where USDC is borrowed and repaid atomically.
    pub last_borrow_slot: u64,

    /// ⚠️ LEGACY — hiSOLA left in the global vote-escrow vault by the token era.
    ///
    /// Written only by the pre-ledger `vote_gauge`, which took custody of the SPL tokens
    /// backing a vote because a plain SPL balance could otherwise vote, move to a fresh
    /// wallet, and vote again. hiSOLA is no longer a token, so nothing writes this field any
    /// more: the only code that still READS it is `convert_hi_sola`, which pulls the stranded
    /// tokens out of that vault and credits them to `hi_sola` below.
    ///
    /// Deliberately NOT reused as the new vote-lock counter, even though the bytes are free
    /// once conversion has run. A wallet that voted before converting would have overwritten
    /// the amount still sitting in the vault, and its tokens would have been orphaned with no
    /// record of who owned them. New meaning, new bytes — see `vote_locked`.
    pub vote_escrowed: u64,
    /// ⚠️ LEGACY — epoch the escrow above was last topped up for. Dead: the release path it
    /// gated (`withdraw_vote_escrow`) is gone, replaced by `convert_hi_sola`. Kept so the
    /// byte layout of live positions is untouched.
    pub escrow_epoch: u64,

    /// hiSOLA this wallet obtained by actually paying into the protocol — incremented by
    /// `stake_sola`, decremented by `unstake_hi_sola`. This is the ceiling on `borrow_usdc`.
    ///
    /// WHY IT IS SEPARATE FROM `hi_sola`: the two differ for unfinanced supply. hiSOLA
    /// leaving a ve lock (`unlock_hi_sola` — partner bribe-earned tranches) lands in
    /// `hi_sola` but never here, because no USDC ever entered the floor for it. The 20% valve
    /// for unfinanced supply is `borrow_against_locked`, not a full-cap borrow.
    ///
    /// Historical note: this field was introduced when hiSOLA was still transferable, to stop
    /// the same balance being walked through fresh wallets, each hop drawing the floor down
    /// again. Non-transferability removes that attack outright; the field survives for the
    /// financed/unfinanced distinction above, which is a separate rule.
    pub staked_amount: u64,

    /// The wallet's hiSOLA balance. **This is the token.**
    ///
    /// hiSOLA is a position, not an SPL token: there is no mint, no ATA, no transfer. Staking
    /// credits this number, unstaking debits it, and nothing else can move it. Everything the
    /// token era needed to contain a transfer it could not block — vote escrow, custody
    /// vaults, `min(recorded deposit, balance)` guards on the fee basis — exists only because
    /// a balance could leave the wallet the protocol had accounted it to. It cannot now.
    ///
    /// Two holes closed by construction, both live on devnet under the token model:
    /// - hiSOLA moved to an external LP or a second wallet stopped earning fees, stopped
    ///   backing credit, and stopped voting for its holder — the Invictus failure mode.
    /// - `vote_gauge` priced power on the balance without ever consulting `staked_amount`, so
    ///   hiSOLA bought on a secondary market voted at full weight while owing nothing to the
    ///   floor: buy at a discount, vote, collect the bribes, sell.
    ///
    /// ve-locked hiSOLA is NOT counted here — it moves to `VeLockPosition.amount_locked`,
    /// which was already a ledger figure and stays one.
    ///
    /// Appended in spare bytes. Legacy positions read 0 until their owner calls
    /// `convert_hi_sola`, which burns their tokens and credits the balance here.
    pub hi_sola: u64,

    /// hiSOLA immobilised by the votes cast in `vote_lock_epoch`, in ledger units.
    ///
    /// Replaces the escrow vault: with no transfer to intercept, "you cannot take back the
    /// stake you voted with before the epoch ends" is a subtraction, not a custody transfer.
    /// `unstake_hi_sola` and `lock_hi_sola` both require `hi_sola − amount >= vote_locked`
    /// while the stamped epoch is still current, and ignore it once it has passed.
    ///
    /// Only the portion of the vote NOT backed by ve power is recorded: ve-locked hiSOLA is
    /// already immobilised in its own position, and counting it twice would make voting cost
    /// more balance than the voter has.
    pub vote_locked: u64,
    /// Epoch `vote_locked` was stamped for. A stale stamp means the lock has lapsed —
    /// the votes it backed belong to a closed epoch and their receipts are already immutable.
    pub vote_lock_epoch: u64,
}

impl UserPosition {
    // 32+8+16+1+8 + 8+8 (legacy escrow) + 8 (staked) + 8+8+8 (ledger + vote lock)
    // = 113 bytes used, 15 spare.
    pub const LEN: usize = 128;

    /// hiSOLA this position may not part with right now, because it is backing votes cast in
    /// the epoch still running. Returns 0 once the stamped epoch has passed — the votes it
    /// backed are closed and their receipts immutable, so releasing the balance cannot
    /// retro-alter a tally.
    ///
    /// The single reader of the pair `(vote_locked, vote_lock_epoch)`, so the "is the stamp
    /// still current" test cannot be written one way in `unstake_hi_sola` and another way in
    /// `lock_hi_sola`.
    pub fn vote_locked_now(&self, unix_ts: i64) -> u64 {
        if self.vote_lock_epoch == current_epoch(unix_ts) {
            self.vote_locked
        } else {
            0
        }
    }
}

// Same guard as ProtocolState: every field past `last_borrow_slot` was carved from spare
// bytes, so LEN is unchanged and no realloc is needed — but only while the struct still
// fits. Without this the overflow would surface as a runtime deserialisation failure on
// every vote, not a build error.
//
// ☢️ Measured with `INIT_SPACE` (the Borsh wire size, 113 bytes), NOT `size_of`. Borsh writes
// fields back to back, while `size_of` pads the struct out to the 16-byte alignment of
// `fees_debt` — 128 bytes, which is 15 bytes of Rust padding that never reach the account.
// Keeping the old `size_of` form here would have failed this build and forced LEN to 136,
// growing `space` from 136 to 144 and putting EVERY live position through a realloc
// migration on top of the hiSOLA conversion. Two migrations for one change, for padding
// that does not exist on chain.
const _: () = assert!(
    UserPosition::LEN >= UserPosition::INIT_SPACE,
    "UserPosition::LEN is too small — update it to fit the struct"
);

// ── Bribe system ──────────────────────────────────────────────────────────────

/// Bribe pot for one (pool_id, reward_mint, epoch) triplet.
/// Permissionless — any protocol can deposit. Multiple deposits per epoch are additive.
/// PDA: [b"bribe_vault", pool_id, reward_mint, epoch_le8]
#[account]
pub struct BribeVault {
    pub pool_id: Pubkey,     // External pool being incentivised (label only)
    pub reward_mint: Pubkey, // Token offered as bribe
    pub epoch: u64,          // Epoch this bribe applies to
    pub total_bribed: u64,   // Cumulative amount deposited this epoch
    pub bump: u8,
}
impl BribeVault {
    pub const LEN: usize = 128;
}

/// Aggregate hiSOLA vote-weight directed at a pool for one epoch.
/// PDA: [b"gauge", pool_id, epoch_le8]
#[account]
pub struct GaugeState {
    pub pool_id: Pubkey,
    pub epoch: u64,
    pub total_votes: u64,
    pub bump: u8,
}
impl GaugeState {
    pub const LEN: usize = 96;
}

/// Records one user's vote for a specific (pool, epoch) pair.
/// Created with `init` — immutable once written, prevents double-voting for same pool.
/// PDA: [b"vote", user, pool_id, epoch_le8]
#[account]
pub struct UserVoteReceipt {
    pub user: Pubkey,
    pub pool_id: Pubkey,
    pub epoch: u64,
    pub votes: u64, // hiSOLA weight committed to this pool
    pub bump: u8,
}
impl UserVoteReceipt {
    pub const LEN: usize = 128;
}

/// Tracks total vote-weight already allocated by one user in an epoch (across all pools).
/// Prevents voting more than the user's hiSOLA balance.
///
/// `total_power_snapshot` is captured on the **first** vote of the epoch (hiSOLA + ve-power
/// at that exact moment). All subsequent votes in the same epoch are checked against this
/// snapshot — preventing a user from over-spending if their lock expires or they transfer
/// hiSOLA between two separate `vote_gauge` calls.
///
/// PDA: [b"uev", user, epoch_le8]
#[account]
pub struct UserEpochVotes {
    pub epoch: u64,
    pub allocated: u64, // cumulative votes cast this epoch across all pools
    pub total_power_snapshot: u64, // hiSOLA + ve-power at time of first vote (immutable after init)
    /// The ve-weighted share of `total_power_snapshot`, frozen at first vote.
    ///
    /// Splitting the snapshot matters for escrow: ve power is already immobilised in
    /// the ve vault, so only the portion of the allocation exceeding it needs backing
    /// by escrowed hiSOLA. Frozen rather than recomputed because `ve_power` decays
    /// continuously — a live read would make the required escrow creep upward within
    /// the same epoch and fail otherwise-valid votes.
    pub ve_power_snapshot: u64,
    /// Extra voting power earned by burning oSOLA this epoch.
    /// Resets every epoch (new PDA). Not subject to the 30% hiSOLA cap —
    /// burning oSOLA is a deflationary act that justifies uncapped influence.
    pub o_sola_bonus: u64,
    pub bump: u8,
}
impl UserEpochVotes {
    pub const LEN: usize = 64;
} // 8+8+8+8+8+1 = 41 bytes used, 23 spare (ve_power_snapshot added 2026-08-09)

const _: () = assert!(
    UserEpochVotes::LEN >= 8 + std::mem::size_of::<UserEpochVotes>(),
    "UserEpochVotes::LEN is too small — update it to fit the struct"
);

/// Created during claim_bribe — its existence proves the claim was made.
/// PDA: [b"bribe_claim", user, pool_id, reward_mint, epoch_le8]
#[account]
pub struct UserBribeClaim {
    pub bump: u8,
}
impl UserBribeClaim {
    pub const LEN: usize = 32;
}

// ── Ve-layer ──────────────────────────────────────────────────────────────────

/// Per-user lock state for ve-weighted governance.
///
/// Locking hiSOLA transfers tokens to ve_lock_vault and removes them from the
/// fee accumulator denominator. Locked hiSOLA earns ve voting power instead.
/// PDA: [b"velock", user]
#[account]
pub struct VeLockPosition {
    pub owner: Pubkey,
    pub amount_locked: u64, // hiSOLA held in ve_lock_vault
    pub lock_end_ts: i64,   // Unix timestamp when lock expires
    pub bump: u8,
    /// Portion of `amount_locked` that can NEVER be unlocked, whatever `lock_end_ts` says.
    /// `unlock_hi_sola` releases at most `amount_locked - permanent_amount`.
    ///
    /// This is what "we sell permanent voting power" means mechanically: the partner
    /// welcome bag (and the team tranche) is unfinanced — no USDC ever entered the floor
    /// vault for it — so letting it reach a wallet would let it be redeemed 1:1 against
    /// backing that real buyers funded. Locking it forever leaves exactly one channel open,
    /// `borrow_against_locked` at 20%, the protocol's drain ceiling for unfinanced supply.
    ///
    /// Appended last and carved from the 47 spare bytes → existing positions read 0, i.e.
    /// fully releasable, which is exactly the pre-2026-07-17 behaviour. No realloc.
    pub permanent_amount: u64,
}
impl VeLockPosition {
    // 32 + 8 + 8 + 1 + 8 = 57 used of 96 (39 spare).
    pub const LEN: usize = 96;
}

// ── LP Emission checkpointing ─────────────────────────────────────────────────

/// Total hiSOLA vote-weight cast across ALL pools in one epoch.
/// Used as denominator when splitting LP_EMISSION_PER_EPOCH across pools.
/// PDA: [b"epoch_votes", epoch_le8]
#[account]
pub struct GlobalEpochVotes {
    pub epoch: u64,
    pub total_votes: u64,
    pub bump: u8,
}
impl GlobalEpochVotes {
    pub const LEN: usize = 32;
}

/// Continuous time-weighted LP balance for one (user, pool) pair.
/// Accumulates: weighted_balance += lp_balance × elapsed_secs each checkpoint.
/// Reset to 0 at the start of each new epoch.
/// PDA: [b"lp_ckpt", pool, user]
#[account]
pub struct LpUserCheckpoint {
    pub user: Pubkey,
    pub pool: Pubkey,
    pub weighted_balance: u128, // sum(lp_balance × elapsed_secs) for last_epoch
    pub last_update_ts: i64,
    pub last_epoch: u64,
    pub bump: u8,
}
impl LpUserCheckpoint {
    pub const LEN: usize = 32 + 32 + 16 + 8 + 8 + 1 + 7;
}

/// Time-weighted total LP supply for one pool in one epoch.
/// Finalized by emit_pool_rewards after epoch ends; records oSOLA allocation.
/// PDA: [b"lp_pool_epoch", pool, epoch_le8]
#[account]
pub struct LpPoolEpochAccum {
    pub pool: Pubkey,
    pub epoch: u64,
    pub total_weighted_supply: u128,
    pub last_update_ts: i64,
    pub last_lp_supply: u64,
    pub osola_allocated: u64,
    pub finalized: bool,
    pub bump: u8,
    /// Cumulative oSOLA already minted to LPs for this (pool, epoch). Hard-caps the pot:
    /// `claim_lp_emissions` can never mint more than `osola_allocated` in total, whatever
    /// the sum of user weighted balances happens to be. Defence in depth behind the
    /// checkpoint fix — the invariant "Σ user weights ≤ total_weighted_supply" is an
    /// off-account property nothing on-chain can verify at claim time, so the pot itself
    /// is made the ceiling.
    ///
    /// Appended last, carved from the 18 spare bytes → existing accums read 0, i.e. the
    /// full allocation still claimable. No realloc.
    pub osola_claimed: u64,
}
impl LpPoolEpochAccum {
    // 32 + 8 + 16 + 8 + 8 + 8 + 1 + 1 + 8 = 90 used of 100 (10 spare).
    pub const LEN: usize = 100;
}

/// Proof-of-claim for LP emissions — created by claim_lp_emissions, blocks replay.
/// PDA: [b"lp_claim", user, pool, epoch_le8]
#[account]
pub struct LpEpochClaim {
    pub bump: u8,
}
impl LpEpochClaim {
    pub const LEN: usize = 32;
}

// ── Continuous LP reward tracking (Masterchef-style) ─────────────────────────

/// Per-user oSOLA reward state for one (user, pool) pair.
/// Created on first add_liquidity, claim_lp_rewards, or remove_liquidity.
/// PDA: [b"lp_user", pool, user]
#[account]
#[derive(Default)]
pub struct LpUserInfo {
    pub reward_debt: u128, // pool.osola_reward_per_lp snapshot at last interaction
    pub bump: u8,
    /// LP tokens this user actually deposited through `add_liquidity`, maintained by the
    /// program (add → +lp_out, remove → −lp_burned). This — not the wallet's LP token
    /// balance — is the basis for every oSOLA reward computation.
    ///
    /// Why: LP tokens are ordinary transferable SPL tokens, while `reward_debt` lives in a
    /// per-wallet PDA that `init_if_needed` creates at 0. Paying on the wallet balance let
    /// anyone move LP to a fresh wallet and claim `osola_reward_per_lp × balance` — the
    /// accumulator since pool creation — then repeat, wallet after wallet: an unbounded
    /// oSOLA mint. Rewards are read as `min(lp_amount, wallet_balance)` so the payout needs
    /// BOTH a program-recorded deposit AND the tokens still in hand; transferred LP earns
    /// on neither side. Same lesson as the founder tranches: a rule enforced on a token
    /// balance is not enforced at all.
    ///
    /// Appended last, carved from the 15 spare bytes → existing accounts read 0 and no
    /// realloc is needed.
    ///
    /// ⚠️ MIGRATION — this is NOT free. The devnet stream is armed (rate 413 360/s, window
    /// open, 5 pools `rewards_enabled`, ~986 `LpUserInfo` live), so the ~986 existing LPs
    /// read `lp_amount = 0` after this upgrade and stop earning until they withdraw and
    /// redeposit. Seeding `lp_amount` from the wallet balance would be the obvious fix and
    /// is exactly the hole being closed — it would hand the full historical accumulator to
    /// anyone holding transferred LP. Decide the migration before deploying.
    pub lp_amount: u64,
    /// Unix seconds of the last `add_liquidity` / `remove_liquidity` by this user on this
    /// pool, as u32 (valid until 2106 — a u64 would not fit the spare bytes, and no realloc
    /// is worth it).
    ///
    /// `checkpoint_lp` starts its accrual window at `max(last checkpoint, this)`, so an
    /// interval is only ever billed at a size held for the whole interval. Without it,
    /// `lp_amount` alone is still gameable in both directions: deposit at epoch start,
    /// checkpoint, withdraw, redeposit and checkpoint at epoch end (the second checkpoint
    /// bills the whole interval at the redeposited size), or simply sit at zero, deposit at
    /// T−ε and checkpoint (the interval is billed at a size held for ε). Either buys a full
    /// epoch of weight with an instant of capital, repeatable wallet by wallet. The rule for
    /// honest LPs is symmetric and simple: checkpoint BEFORE changing your position.
    pub last_change_ts: u32,
}
impl LpUserInfo {
    // 16 + 1 + 8 + 4 = 29 used of 32 (3 spare).
    pub const LEN: usize = 32;
}

// ── Founder vesting ───────────────────────────────────────────────────────────

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
/// Vesting formula (after cliff):
///   total_vested = total_amount × min(elapsed, VESTING_DURATION_SECS) / VESTING_DURATION_SECS
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

// ── Persistent vote config (carry-over) ──────────────────────────────────────

/// Persistent gauge vote allocation for a hiSOLA holder.
///
/// Once set with `auto_replay = true`, any caller (keeper, partner, cron bot)
/// can invoke `replay_vote` each epoch to carry forward these preferences
/// without requiring the owner to sign — enabling fully passive participation,
/// identical to Beradrome / Velodrome auto-rolling vote behaviour.
///
/// The vote weight is recalculated from the owner's **current** hiSOLA balance
/// + ve-power each epoch, so the allocation scales correctly as positions change.
/// The 30% per-address anti-whale cap applies on every replay, same as `vote_gauge`.
///
/// PDA: [b"vote_config", user]
#[account]
pub struct UserVoteConfig {
    /// Pools to vote for — unused slots hold Pubkey::default().
    pub pools: [Pubkey; 5],
    /// Basis points per pool (active entries must sum to exactly 10 000).
    pub bps: [u16; 5],
    /// Number of active entries (1–5).
    pub n_pools: u8,
    /// When true, `replay_vote` is allowed by any caller.
    /// When false, the owner must call `vote_gauge` manually each epoch.
    pub auto_replay: bool,
    pub bump: u8,
}
impl UserVoteConfig {
    pub const MAX_POOLS: usize = 5;
    // 5×32 + 5×2 + 1 + 1 + 1 = 173 bytes used; 19 spare
    pub const LEN: usize = 192;
}

// ── Protocol Partner allocation ───────────────────────────────────────────────

/// One-time locked hiSOLA allocation for a protocol partner (Jito, Marinade, Solayer…).
///
/// Unlike the contributor system (cliff + linear vesting), the partner receives their
/// full allocation in a single `claim_partner_allocation` call — but hiSOLA is minted
/// DIRECTLY into their ve_lock_vault, bypassing the wallet entirely.
///
/// Consequences:
/// - Voting power is immediate via VeLockPosition (up to 4× ve multiplier).
/// - `borrow_usdc` (wallet path) is blocked (wallet balance = 0); liquidity comes
///   from `borrow_against_locked` instead — up to 20% of the locked position.
/// - `total_hi_sola` is NOT incremented — locked hiSOLA is excluded from the
///   fee accumulator denominator (same semantics as `lock_hi_sola`).
/// - After lock expiry: `unlock_hi_sola` → hiSOLA back to wallet → standard rules.
///
/// PDA: [b"partner", partner_wallet]
#[account]
pub struct PartnerAllocation {
    pub partner: Pubkey,            // beneficiary wallet (immutable after init)
    pub bribe_mint: Pubkey,         // committed bribe token — only this mint credits the allocation
    pub rate_num: u64,              // hiSOLA earned per bribe unit = rate_num / rate_den
    pub rate_den: u64,              // (1:1 = rate_num == rate_den)
    pub cap_hi_sola: u64, // hard cap on bribe-EARNED hiSOLA (= negotiated commitment); excludes base bag
    pub total_bribed_credited: u64, // cumulative bribe (bribe_mint base units) deposited via partner_deposit_bribe
    pub hi_sola_claimed: u64, // cumulative hiSOLA already minted + locked (base + bribe, monotonic)
    pub lock_duration_secs: u64, // lock duration per claim (validated in [MIN, MAX] at register)
    pub start_ts: i64,        // unix timestamp when register_partner was executed
    pub bump: u8,
    pub base_hi_sola: u64, // one-time welcome bag (streams over BASE_BAG_VEST_SECS); appended last for backward-compatible upgrades
    /// Unix timestamp at which the partner funded their bribe stream, or 0 if they never did.
    ///
    /// **This is the gate on the welcome bag.** The bag used to accrue from `start_ts` for
    /// everyone, which made it an unconditional gift: a partner could register, never bribe a
    /// unit, and still claim permanent voting power the floor had funded nothing for. It now
    /// vests from THIS timestamp, so it is earned by committing an escrowed bribe schedule
    /// (`fund_partner_bribe_stream`) and by nothing else. 0 means no stream, which means no
    /// bag — legacy accounts read 0 and therefore fail closed, never open.
    pub stream_start_ts: i64,
    /// How many epochs the partner's bribes must be spread over, agreed at registration.
    ///
    /// The rhythm is a term of the deal, not the partner's to pick: `fund_partner_bribe_stream`
    /// refuses any schedule of a different length. Typical values are 26 (6 months), 52 (a
    /// year) or 104 (two years). 0 means unset — legacy allocations only, which accept any
    /// length so an upgrade cannot strand a partner mid-negotiation.
    pub schedule_epochs: u64,
}
impl PartnerAllocation {
    // 32 + 32 + 8*7 + 8 + 8 + 8 + 1 = 145 bytes used; 15 spare.
    // Carved from the spare bytes on purpose: LEN does not move, so no account grows and no
    // realloc migration is needed. Growing a live singleton is what bricked devnet in July.
    pub const LEN: usize = 160;
}

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

// ── Protocol-Owned Liquidity ──────────────────────────────────────────────────

/// Singleton PDA controlling protocol-owned liquidity.
/// PDA: [b"pol"]
#[account]
pub struct PolState {
    /// Suggested % of market_vault fees to divert (informational, enforced off-chain).
    pub pol_split_bps: u16,
    /// AmmPool PDA that receives POL liquidity deposits.
    pub target_pool: Pubkey,
    /// Lifetime USDC routed through collect_to_pol.
    pub usdc_accumulated: u64,
    pub bump: u8,
}
impl PolState {
    pub const LEN: usize = 96;
}

// ── Contributor / Marketing vesting ──────────────────────────────────────────

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
