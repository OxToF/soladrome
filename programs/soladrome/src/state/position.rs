// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs

//! Per-user staking, borrow and vote-lock state.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::SoladromeError;
use crate::math::current_epoch;

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

    /// ⚠️ LEGACY, INERT — hiSOLA left in the global vote-escrow vault by the token era.
    ///
    /// Written only by the pre-ledger `vote_gauge`, which took custody of the SPL tokens
    /// backing a vote because a plain SPL balance could otherwise vote, move to a fresh wallet,
    /// and vote again. hiSOLA is no longer a token. **No instruction in this program reads or
    /// writes either of these two fields** — they are 16 bytes that a fresh deployment leaves
    /// at zero for the life of the protocol. The one instruction that ever read them,
    /// `convert_hi_sola`, drained the stranded vault into `hi_sola` and lives on
    /// `devnet-legacy` with the other migrations.
    ///
    /// Kept rather than deleted so that the byte layout of a live devnet position is identical
    /// under both branches: `devnet-legacy` must be this artefact plus four instructions, not a
    /// different account layout. Deliberately NOT reused as the new vote-lock counter either —
    /// a wallet that voted before converting would have overwritten the amount still sitting in
    /// the vault and orphaned its tokens. New meaning, new bytes; see `vote_locked`.
    pub vote_escrowed: u64,
    /// ⚠️ LEGACY, INERT — epoch the escrow above was last topped up for. Same status as the
    /// field above: never read, never written, kept only to hold the layout.
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
    /// Appended in spare bytes, so `LEN` did not move. On a fresh deployment the only writers
    /// are `stake_sola`, `unstake_hi_sola` and the allocation claim paths.
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

    /// hiSOLA that earns protocol fees without being a spendable balance.
    ///
    /// Every other fee-earning hiSOLA sits in `hi_sola` and is capped by `staked_amount` — the
    /// financed-stake rule: fees follow USDC that actually reached the floor. A contributor's
    /// bag satisfies neither. It is locked for life in `VeLockPosition`, so `hi_sola` is 0, and
    /// it was never bought through the curve, so `staked_amount` is 0. Their fee basis was
    /// therefore 0, and being permanent, it would have stayed 0 forever.
    ///
    /// That made the bag worthless as compensation, which is the one job it has. Someone who
    /// funds an audit pays in a currency the floor never sees; the yield their locked hiSOLA
    /// generates is the entire return on it. `fee_shares` is that exception — added to the
    /// basis in `math::fee_basis`, and matched by an increment to `total_hi_sola` so the share
    /// is real rather than printed: every other holder is diluted by exactly what the
    /// contributor receives.
    ///
    /// Deliberately NOT granted to the founder's 7M, which is a dormant anti-capture reserve
    /// that takes no vote and no fees by design. Carved from spare bytes, so `LEN` does not
    /// move and no account reallocs.
    pub fee_shares: u64,
}

impl UserPosition {
    // 32+8+16+1+8 + 8+8 (legacy escrow) + 8 (staked) + 8+8+8 (ledger + vote lock)
    // + 8 (fee_shares) = 121 bytes used, 7 spare.
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

    /// Grant `amount` of hiSOLA that earns fees without being a spendable balance, carrying the
    /// position's already-accrued fees across the change.
    ///
    /// ☢️ `fees_debt` is a single scalar for the whole basis, so widening the basis without
    /// touching it would hand the new shares a retroactive claim on fees that accrued before
    /// they existed. Re-stamping it to `acc` instead would forfeit whatever this position had
    /// already earned — harmless for a fresh account, real for one that was already staking.
    /// So carry the accrual across exactly: pick the debt that reproduces the same pending
    /// amount against the new, larger basis. Rounds down, i.e. never in the claimant's favour.
    ///
    /// The caller is responsible for the counterpart — `ProtocolState.total_hi_sola` must grow
    /// by the same `amount`, so the share is real rather than printed and every other holder is
    /// diluted by exactly what this position receives.
    pub fn credit_fee_shares(&mut self, acc: u128, amount: u64) -> Result<()> {
        let old_basis = crate::math::fee_basis(self.staked_amount, self.hi_sola, self.fee_shares);
        let pending = crate::math::pending_fees(acc, self.fees_debt, old_basis);
        self.fee_shares = self
            .fee_shares
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;
        let new_basis = crate::math::fee_basis(self.staked_amount, self.hi_sola, self.fee_shares);
        self.fees_debt = if pending == 0 || new_basis == 0 {
            acc
        } else {
            acc.saturating_sub((pending as u128 * PRECISION) / new_basis as u128)
        };
        Ok(())
    }

    /// Move `amount` out of the spendable balance and into a ve lock **without changing the fee
    /// basis**. Returns the `fee_shares` actually credited, which the caller must NOT add to
    /// `total_hi_sola` — see below.
    ///
    /// ☢️ The credit is the *drop in basis*, not `amount`. Crediting `amount` outright would let
    /// unfinanced hiSOLA buy itself a fee share by locking: a position holding hiSOLA released
    /// by an expired lock has `staked_amount = 0`, so `fee_basis` is 0 and it earns nothing —
    /// locking it and crediting the full amount would turn 0 into `amount`, manufacturing a
    /// claim on the fee stream out of supply that never paid into the floor. The difference is
    /// zero in that case and exactly `amount` for financed stake, which is the whole rule.
    ///
    /// The counterpart for the caller: `total_hi_sola` must fall by `amount − credited`. For
    /// financed stake that is zero — locking no longer costs the holder their fees, which is
    /// the change this method exists for — and for unfinanced supply it is the full amount,
    /// exactly as before.
    pub fn lock_balance(&mut self, amount: u64) -> Result<u64> {
        let before = crate::math::fee_basis(self.staked_amount, self.hi_sola, self.fee_shares);
        self.hi_sola = self
            .hi_sola
            .checked_sub(amount)
            .ok_or(SoladromeError::InvalidAmount)?;
        let after = crate::math::fee_basis(self.staked_amount, self.hi_sola, self.fee_shares);
        let credited = before.saturating_sub(after);
        self.fee_shares = self
            .fee_shares
            .checked_add(credited)
            .ok_or(SoladromeError::Overflow)?;
        Ok(credited)
    }

    /// The exact inverse: return `amount` to the spendable balance and give back the shares the
    /// lock was standing in for. Returns the `fee_shares` debited, and `total_hi_sola` must rise
    /// by `amount − debited`.
    ///
    /// ☢️ The debit is the *rise in basis*, capped at what the position holds, so it can only
    /// ever reclaim what `lock_balance` granted. This matters because `fee_shares` also carries
    /// permanent grants — a contributor's bag, a partner's retainer — that are locked for life
    /// and must survive any unlock. The `min` in `fee_basis` saturates at `staked_amount`, so
    /// releasing hiSOLA that was never financed raises the basis by nothing and debits nothing.
    pub fn unlock_balance(&mut self, amount: u64) -> Result<u64> {
        let before = crate::math::fee_basis(self.staked_amount, self.hi_sola, self.fee_shares);
        self.hi_sola = self
            .hi_sola
            .checked_add(amount)
            .ok_or(SoladromeError::Overflow)?;
        let after = crate::math::fee_basis(self.staked_amount, self.hi_sola, self.fee_shares);
        let debited = after.saturating_sub(before).min(self.fee_shares);
        self.fee_shares = self.fee_shares.saturating_sub(debited);
        Ok(debited)
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
