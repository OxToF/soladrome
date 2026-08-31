// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Protocol singleton: authority, curve reserves, fee accumulators and phase flags.

use anchor_lang::prelude::*;

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
    /// every field above it this one grew `LEN` (416 → 448). On a fresh deployment `initialize`
    /// allocates at the current `LEN` and writes this field in the same instruction, so the
    /// question never arises. A singleton that predates the growth needs a realloc, which is
    /// what the `migrate_protocol_state` instruction on `devnet-legacy` is for; it is not part
    /// of this artefact. Either way `Pubkey::default()` matches no signer, so an unwritten
    /// field fails every founder guard closed rather than open.
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
    // live singleton is what caused the 3003 devnet brick in July — which is why nothing in
    // this program reallocs it. `initialize` allocates at LEN once; there is no resize path.
    pub const LEN: usize = 448;
}

// Compile-time guard: if ProtocolState grows past LEN the program will fail to
// deploy rather than silently corrupting accounts at runtime.
const _: () = assert!(
    ProtocolState::LEN >= 8 + std::mem::size_of::<ProtocolState>(),
    "ProtocolState::LEN is too small — update it to fit the struct"
);
