//! # Soladrome Fuzz Test — Vote / Borrow / Fee-accounting Invariants
//!
//! Covers the surface the other two targets do not: staking, borrowing, voting and fee
//! claims — and, critically, the one move that is NOT an instruction of this program: a
//! **plain SPL transfer of hiSOLA between two wallets**.
//!
//! That transfer is the attack primitive behind every bug found in this subsystem. hiSOLA
//! is an ordinary SPL token with no freeze authority, so the program is never invoked on a
//! transfer and cannot block one. Any rule the protocol enforces by reading a token
//! *balance* is only as strong as the holder's willingness to keep holding — which is to
//! say, not enforced. Two real bugs of exactly this shape were fixed on 2026-08-12
//! (`vote_gauge` opening a `UserPosition` without stamping `fees_debt`, and `borrow_usdc`
//! capping on the ATA balance).
//!
//! ## Why the flows are guided rather than uniformly random
//!
//! The first version of this target picked each instruction independently with random
//! amounts. It ran clean — and was worthless: a mutation test (borrow fix removed, program
//! rebuilt) did **not** reproduce the bug. Instruction success rates explained why — buy
//! succeeded 199 times in 12 553, vote 43 in 12 510, repay 0 in 12 464 — so the state
//! machine never advanced past "wallet holds USDC". The sequence that breaks the protocol
//! (finance a stake, borrow against it, move the collateral, borrow again from the
//! recipient) has four ordered steps and essentially never occurred.
//!
//! So each flow here establishes its own preconditions before acting: it buys if it needs
//! SOLA, stakes if it needs hiSOLA, and sizes every amount against live balances. Actors,
//! amounts and flow order stay random — what is fixed is only the *shape* of each scenario,
//! which is what lets the fuzzer reach deep states at all. A deliberate fraction of draws
//! is still out of range, so the guards keep being exercised and not just the happy path.
//!
//! **Acceptance criterion for this target: with either fix reverted, it must panic.**
//!
//! Invariants:
//!   I-1. usdc_borrowed <= staked_amount, per user. Credit follows the wallet that financed
//!        the floor, never whichever wallet currently holds transferable collateral.
//!   I-2. floor_vault + total_usdc_borrowed >= total_purchased_sola.
//!   I-3. SUM(pending_fees) <= market_vault — the fee accumulator is a promise to pay, and
//!        it must stay solvent. This is the invariant the `vote_gauge` bug broke.

use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;
mod types;
use types::soladrome::*;
use types::*;

use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signer::Signer;

const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
const PRECISION: u128 = 1_000_000_000_000;
const EPOCH_DURATION: i64 = 604_800;

fn program_id() -> Pubkey {
    soladrome::program_id()
}

fn derive(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &program_id()).0
}

/// Raw SPL Token `Transfer` (tag 3), built by hand: the point is that this path does not
/// touch the Soladrome program at all, exactly as a user's wallet would do it.
fn spl_transfer(source: Pubkey, dest: Pubkey, authority: Pubkey, amount: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(source, false),
            AccountMeta::new(dest, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data,
    }
}

/// Mirror of `math::advance_accumulator` — the invariant must price a claim exactly as
/// `claim_fees` does, and `claim_fees` advances before paying.
fn advance_accumulator(acc: u128, balance: u64, last_balance: u64, total_hi_sola: u64) -> u128 {
    if balance <= last_balance || total_hi_sola == 0 {
        return acc;
    }
    let new_fees = balance.saturating_sub(last_balance) as u128;
    acc.saturating_add(new_fees.saturating_mul(PRECISION) / total_hi_sola as u128)
}

/// Mirror of `math::pending_fees`.
fn pending_fees(acc: u128, debt: u128, basis: u64) -> u64 {
    let delta = acc.saturating_sub(debt);
    ((delta.saturating_mul(basis as u128)) / PRECISION) as u64
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    users: Vec<Pubkey>,
    usdc: Vec<Pubkey>,
    sola: Vec<Pubkey>,
    hi_sola: Vec<Pubkey>,
    positions: Vec<Pubkey>,
    /// Trident exposes `warp_to_slot` but no slot getter, and the flash-borrow guard
    /// compares slots, so the target drives the slot itself.
    slot_cursor: u64,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            users: Vec::new(),
            usdc: Vec::new(),
            sola: Vec::new(),
            hi_sola: Vec::new(),
            positions: Vec::new(),
            slot_cursor: 10_000,
        }
    }

    #[init]
    fn start(&mut self) {
        let authority = self.trident.payer().pubkey();

        let protocol_state = derive(&[b"state"]);
        let sola_mint = derive(&[b"sola_mint"]);
        let hi_sola_mint = derive(&[b"hi_sola_mint"]);
        let o_sola_mint = derive(&[b"o_sola_mint"]);
        let floor_vault = derive(&[b"floor_vault"]);
        let market_vault = derive(&[b"market_vault"]);
        let sola_vault = derive(&[b"sola_vault"]);
        let vote_escrow_vault = derive(&[b"vote_escrow"]);

        let usdc_mint = self.trident.random_keypair().pubkey();
        let mint_ixs = self
            .trident
            .initialize_mint(&authority, &usdc_mint, 6, &authority, None);
        self.trident
            .process_transaction(&mint_ixs, Some("create_usdc_mint"));

        let init_ix = InitializeInstruction::data(InitializeInstructionData::new())
            .accounts(InitializeInstructionAccounts::new(
                authority,
                protocol_state,
                usdc_mint,
                sola_mint,
                hi_sola_mint,
                o_sola_mint,
                floor_vault,
                market_vault,
                sola_vault,
            ))
            .instruction();
        if !self
            .trident
            .process_transaction(&[init_ix], Some("initialize"))
            .is_success()
        {
            return;
        }

        // Every phase flag defaults to false at `initialize`; without opening these two the
        // fuzzer explores nothing but FeatureDisabled.
        let flags_ix = SetPhaseFlagsInstruction::data(SetPhaseFlagsInstructionData::new(
            None,
            None,
            Some(true), // voting
            None,
            Some(true), // curve
            None,
        ))
        .accounts(SetPhaseFlagsInstructionAccounts::new(
            authority,
            protocol_state,
        ))
        .instruction();
        self.trident
            .process_transaction(&[flags_ix], Some("set_phase_flags"));

        let second = self.trident.random_keypair().pubkey();
        self.trident.airdrop(&second, 100 * LAMPORTS_PER_SOL);

        for owner in [authority, second] {
            let u = self
                .trident
                .get_associated_token_address(&usdc_mint, &owner, &TOKEN_PROGRAM_ID);
            let s = self
                .trident
                .get_associated_token_address(&sola_mint, &owner, &TOKEN_PROGRAM_ID);
            let h =
                self.trident
                    .get_associated_token_address(&hi_sola_mint, &owner, &TOKEN_PROGRAM_ID);

            for (mint, label) in [
                (usdc_mint, "usdc_ata"),
                (sola_mint, "sola_ata"),
                (hi_sola_mint, "hi_sola_ata"),
            ] {
                let ix = self
                    .trident
                    .initialize_associated_token_account(&authority, &mint, &owner);
                self.trident.process_transaction(&[ix], Some(label));
            }

            let ix = self
                .trident
                .mint_to(&u, &usdc_mint, &authority, 1_000_000_000_000);
            self.trident.process_transaction(&[ix], Some("fund_usdc"));

            self.users.push(owner);
            self.usdc.push(u);
            self.sola.push(s);
            self.hi_sola.push(h);
            self.positions.push(derive(&[b"position", owner.as_ref()]));
        }

        self.fuzz_accounts
            .protocol_state
            .insert_with_address(protocol_state);
        self.fuzz_accounts.sola_mint.insert_with_address(sola_mint);
        self.fuzz_accounts
            .hi_sola_mint
            .insert_with_address(hi_sola_mint);
        self.fuzz_accounts
            .floor_vault
            .insert_with_address(floor_vault);
        self.fuzz_accounts
            .market_vault
            .insert_with_address(market_vault);
        self.fuzz_accounts
            .sola_vault
            .insert_with_address(sola_vault);
        self.fuzz_accounts.usdc_mint.insert_with_address(usdc_mint);
        self.fuzz_accounts
            .vote_escrow_vault
            .insert_with_address(vote_escrow_vault);
    }

    // ── Primitives ────────────────────────────────────────────────────────

    fn ready(&self) -> bool {
        self.users.len() == 2
    }

    fn actor(&mut self) -> usize {
        self.trident.random_from_range(0..=1_usize)
    }

    fn balance_of(&mut self, ata: Pubkey) -> u64 {
        match self.trident.get_token_account(ata) {
            Ok(acc) => acc.account.amount,
            Err(_) => 0,
        }
    }

    fn floor_balance(&mut self) -> u64 {
        let Some(k) = self.fuzz_accounts.floor_vault.get(&mut self.trident) else {
            return 0;
        };
        self.balance_of(k)
    }

    fn position_of(&mut self, i: usize) -> Option<UserPosition> {
        self.trident
            .get_account_with_type::<UserPosition>(&self.positions[i], 8)
    }

    /// One draw in five is deliberately out of range so the guards keep being tested.
    fn wild(&mut self) -> bool {
        self.trident.random_from_range(0..=4_u8) == 0
    }

    fn sized(&mut self, cap: u64) -> u64 {
        if cap == 0 || self.wild() {
            return self.trident.random_from_range(1..=50_000_000_000_u64);
        }
        self.trident.random_from_range(1..=cap)
    }

    fn bump_slot(&mut self) {
        self.slot_cursor += 1;
        self.trident.warp_to_slot(self.slot_cursor);
        self.trident.forward_in_time(60);
    }

    // ── Building blocks used by the guided scenarios ──────────────────────

    fn do_buy(&mut self, i: usize, amount: u64) -> bool {
        let (Some(protocol_state), Some(sola_mint), Some(floor_vault), Some(market_vault)) = (
            self.fuzz_accounts.protocol_state.get(&mut self.trident),
            self.fuzz_accounts.sola_mint.get(&mut self.trident),
            self.fuzz_accounts.floor_vault.get(&mut self.trident),
            self.fuzz_accounts.market_vault.get(&mut self.trident),
        ) else {
            return false;
        };
        let ix = BuySolaInstruction::data(BuySolaInstructionData::new(amount, 0))
            .accounts(BuySolaInstructionAccounts::new(
                self.users[i],
                protocol_state,
                sola_mint,
                self.usdc[i],
                self.sola[i],
                floor_vault,
                market_vault,
            ))
            .instruction();
        self.trident
            .process_transaction(&[ix], Some("buy_sola"))
            .is_success()
    }

    fn do_stake(&mut self, i: usize, amount: u64) -> bool {
        let (
            Some(protocol_state),
            Some(sola_mint),
            Some(hi_sola_mint),
            Some(sola_vault),
            Some(market_vault),
            Some(usdc_mint),
        ) = (
            self.fuzz_accounts.protocol_state.get(&mut self.trident),
            self.fuzz_accounts.sola_mint.get(&mut self.trident),
            self.fuzz_accounts.hi_sola_mint.get(&mut self.trident),
            self.fuzz_accounts.sola_vault.get(&mut self.trident),
            self.fuzz_accounts.market_vault.get(&mut self.trident),
            self.fuzz_accounts.usdc_mint.get(&mut self.trident),
        ) else {
            return false;
        };
        let ix = StakeSolaInstruction::data(StakeSolaInstructionData::new(amount))
            .accounts(StakeSolaInstructionAccounts::new(
                self.users[i],
                protocol_state,
                sola_mint,
                hi_sola_mint,
                self.sola[i],
                self.hi_sola[i],
                sola_vault,
                market_vault,
                usdc_mint,
                self.usdc[i],
                self.positions[i],
            ))
            .instruction();
        self.trident
            .process_transaction(&[ix], Some("stake_sola"))
            .is_success()
    }

    fn do_borrow(&mut self, i: usize, amount: u64) -> bool {
        let (Some(protocol_state), Some(hi_sola_mint), Some(floor_vault), Some(market_vault)) = (
            self.fuzz_accounts.protocol_state.get(&mut self.trident),
            self.fuzz_accounts.hi_sola_mint.get(&mut self.trident),
            self.fuzz_accounts.floor_vault.get(&mut self.trident),
            self.fuzz_accounts.market_vault.get(&mut self.trident),
        ) else {
            return false;
        };
        self.bump_slot();
        // I-1 is a BORROW-TIME property, not a state invariant. A first version asserted
        // `usdc_borrowed <= staked_amount` globally in the `end` hook and produced false
        // positives on correct code: `staked_amount` is a cap input, not a conserved
        // quantity — unstaking tokens that arrived by transfer legitimately drives it to 0
        // while the debt stays covered by the tokens still held. The real rule is the one
        // the cap enforces at the moment of the draw, so it is checked here.
        let cap_before = {
            let held = self.balance_of(self.hi_sola[i]);
            match self.position_of(i) {
                Some(p) => p.staked_amount.min(held.saturating_add(p.vote_escrowed)),
                None => 0,
            }
        };
        let owed_before = self.position_of(i).map(|p| p.usdc_borrowed).unwrap_or(0);
        let ix = BorrowUsdcInstruction::data(BorrowUsdcInstructionData::new(amount))
            .accounts(BorrowUsdcInstructionAccounts::new(
                self.users[i],
                protocol_state,
                hi_sola_mint,
                self.hi_sola[i],
                floor_vault,
                market_vault,
                self.usdc[i],
                self.positions[i],
            ))
            .instruction();
        let ok = self
            .trident
            .process_transaction(&[ix], Some("borrow_usdc"))
            .is_success();
        if ok {
            let owed_after = self.position_of(i).map(|p| p.usdc_borrowed).unwrap_or(0);
            if owed_after > cap_before {
                self.report_violation(format!(
                    "INVARIANT VIOLATED [I-1]: user {} drew to {owed_after} USDC of debt past \
                     a cap of {cap_before} (was {owed_before}) — borrow capacity was granted \
                     against collateral this wallet never financed.",
                    self.users[i],
                ));
            }
        }
        ok
    }

    fn do_vote(&mut self, i: usize, votes: u64) -> bool {
        let (
            Some(protocol_state),
            Some(hi_sola_mint),
            Some(market_vault),
            Some(vote_escrow_vault),
        ) = (
            self.fuzz_accounts.protocol_state.get(&mut self.trident),
            self.fuzz_accounts.hi_sola_mint.get(&mut self.trident),
            self.fuzz_accounts.market_vault.get(&mut self.trident),
            self.fuzz_accounts.vote_escrow_vault.get(&mut self.trident),
        ) else {
            return false;
        };
        let epoch = (self.trident.get_current_timestamp() / EPOCH_DURATION) as u64;
        let epoch_le = epoch.to_le_bytes();
        // Fresh pool label per vote: UserVoteReceipt is `init`, so reuse would just fail.
        let pool_id = self.trident.random_pubkey();
        let user = self.users[i];

        let ix = VoteGaugeInstruction::data(VoteGaugeInstructionData::new(epoch, votes))
            .accounts(VoteGaugeInstructionAccounts::new(
                user,
                pool_id,
                protocol_state,
                hi_sola_mint,
                market_vault,
                self.hi_sola[i],
                vote_escrow_vault,
                self.positions[i],
                solana_sdk::system_program::ID,
                derive(&[b"gauge", pool_id.as_ref(), &epoch_le]),
                derive(&[b"vote", user.as_ref(), pool_id.as_ref(), &epoch_le]),
                derive(&[b"uev", user.as_ref(), &epoch_le]),
                derive(&[b"epoch_votes", &epoch_le]),
            ))
            .instruction();
        self.trident
            .process_transaction(&[ix], Some("vote_gauge"))
            .is_success()
    }

    fn do_claim_fees(&mut self, i: usize) -> bool {
        let (Some(protocol_state), Some(hi_sola_mint), Some(market_vault)) = (
            self.fuzz_accounts.protocol_state.get(&mut self.trident),
            self.fuzz_accounts.hi_sola_mint.get(&mut self.trident),
            self.fuzz_accounts.market_vault.get(&mut self.trident),
        ) else {
            return false;
        };
        let ix = ClaimFeesInstruction::data(ClaimFeesInstructionData::new())
            .accounts(ClaimFeesInstructionAccounts::new(
                self.users[i],
                protocol_state,
                hi_sola_mint,
                self.hi_sola[i],
                market_vault,
                self.usdc[i],
                self.positions[i],
            ))
            .instruction();
        self.trident
            .process_transaction(&[ix], Some("claim_fees"))
            .is_success()
    }

    fn do_move_hi_sola(&mut self, from: usize, to: usize, amount: u64) -> bool {
        let ix = spl_transfer(
            self.hi_sola[from],
            self.hi_sola[to],
            self.users[from],
            amount,
        );
        self.trident
            .process_transaction(&[ix], Some("spl_transfer_hi_sola"))
            .is_success()
    }

    /// Make sure actor `i` holds hiSOLA, financing it through the curve if needed.
    fn ensure_hi_sola(&mut self, i: usize) -> u64 {
        let held = self.balance_of(self.hi_sola[i]);
        if held > 0 {
            return held;
        }
        if self.balance_of(self.sola[i]) == 0 {
            let usdc = self.balance_of(self.usdc[i]);
            if usdc == 0 {
                return 0;
            }
            // Spend a slice, never the lot: later flows still need funds.
            let spend = self.trident.random_from_range(1..=(usdc / 4).max(1));
            self.do_buy(i, spend);
        }
        let sola = self.balance_of(self.sola[i]);
        if sola > 0 {
            self.do_stake(i, sola);
        }
        self.balance_of(self.hi_sola[i])
    }

    /// A draw small enough that the 75% floor buffer — which binds long before the
    /// collateral cap — does not reject every borrow.
    fn borrowable(&mut self, held: u64) -> u64 {
        let floor = self.floor_balance();
        held.min((floor / 8).max(1))
    }

    // ── Guided scenarios ──────────────────────────────────────────────────

    /// Finance a position the honest way.
    #[flow]
    fn flow_finance_position(&mut self) {
        if !self.ready() {
            return;
        }
        let i = self.actor();
        let usdc = self.balance_of(self.usdc[i]);
        if usdc == 0 {
            return;
        }
        let amount = if self.wild() {
            self.trident.random_from_range(1..=u64::MAX)
        } else {
            self.trident.random_from_range(1..=(usdc / 4).max(1))
        };
        if self.do_buy(i, amount) {
            let sola = self.balance_of(self.sola[i]);
            if sola > 0 {
                let stake = self.sized(sola);
                self.do_stake(i, stake);
            }
        }
    }

    /// Borrow against a financed position.
    #[flow]
    fn flow_borrow(&mut self) {
        if !self.ready() {
            return;
        }
        let i = self.actor();
        let held = self.ensure_hi_sola(i);
        if held == 0 {
            return;
        }
        let cap = self.borrowable(held);
        let amount = self.sized(cap);
        self.do_borrow(i, amount);
    }

    /// ☢️ The recycling scenario: finance, borrow, hand the collateral to a wallet that
    /// financed nothing, and let it borrow against it. I-1 fires if the cap ever reads a
    /// bare token balance again.
    #[flow]
    fn flow_borrow_then_move_collateral(&mut self) {
        if !self.ready() {
            return;
        }
        let a = self.actor();
        let b = 1 - a;

        let held = self.ensure_hi_sola(a);
        if held == 0 {
            return;
        }
        let cap = self.borrowable(held);
        let draw = self.trident.random_from_range(1..=cap.max(1));
        self.do_borrow(a, draw);

        // Move all of it, or a slice — the sender keeps the debt either way.
        let balance = self.balance_of(self.hi_sola[a]);
        if balance == 0 {
            return;
        }
        let moved = if self.trident.random_bool() {
            balance
        } else {
            self.trident.random_from_range(1..=balance)
        };
        if !self.do_move_hi_sola(a, b, moved) {
            return;
        }

        // The recipient now holds collateral it never paid for.
        let recipient = self.balance_of(self.hi_sola[b]);
        if recipient > 0 {
            let cap_b = self.borrowable(recipient);
            let amount = self.trident.random_from_range(1..=cap_b.max(1));
            self.do_borrow(b, amount);
        }
    }

    /// ☢️ The fee-history scenario: move a stake to a wallet the protocol has never seen,
    /// let it open its position through `vote_gauge`, then claim. I-3 fires if that
    /// position is ever born unstamped.
    #[flow]
    fn flow_move_then_vote_then_claim(&mut self) {
        if !self.ready() {
            return;
        }
        let a = self.actor();
        let b = 1 - a;

        let held = self.ensure_hi_sola(a);
        if held == 0 {
            return;
        }
        let moved = if self.trident.random_bool() {
            held
        } else {
            self.trident.random_from_range(1..=held)
        };
        if !self.do_move_hi_sola(a, b, moved) {
            return;
        }

        let recipient = self.balance_of(self.hi_sola[b]);
        if recipient == 0 {
            return;
        }
        let votes = self.sized(recipient);
        self.do_vote(b, votes);
        self.do_claim_fees(b);
    }

    /// Ordinary voting and claiming, so the accumulator actually moves.
    #[flow]
    fn flow_vote_and_claim(&mut self) {
        if !self.ready() {
            return;
        }
        let i = self.actor();
        let held = self.ensure_hi_sola(i);
        if held == 0 {
            return;
        }
        let votes = self.sized(held);
        self.do_vote(i, votes);
        if self.trident.random_bool() {
            self.do_claim_fees(i);
        }
    }

    /// Repay, so debt does not only ever grow.
    #[flow]
    fn flow_repay(&mut self) {
        if !self.ready() {
            return;
        }
        let i = self.actor();
        let Some(protocol_state) = self.fuzz_accounts.protocol_state.get(&mut self.trident) else { return };
        let Some(floor_vault) = self.fuzz_accounts.floor_vault.get(&mut self.trident) else { return };

        let owed = self.position_of(i).map(|p| p.usdc_borrowed).unwrap_or(0);
        let amount = self.sized(owed);
        self.bump_slot();

        let ix = RepayUsdcInstruction::data(RepayUsdcInstructionData::new(amount))
            .accounts(RepayUsdcInstructionAccounts::new(
                self.users[i],
                protocol_state,
                self.positions[i],
                floor_vault,
                self.usdc[i],
            ))
            .instruction();
        let _ = self.trident.process_transaction(&[ix], Some("repay_usdc"));
    }

    /// Exit, where the debt guard and the staked_amount decrement meet.
    #[flow]
    fn flow_unstake(&mut self) {
        if !self.ready() {
            return;
        }
        let i = self.actor();
        let (
            Some(protocol_state),
            Some(sola_mint),
            Some(hi_sola_mint),
            Some(sola_vault),
            Some(market_vault),
            Some(usdc_mint),
        ) = (
            self.fuzz_accounts.protocol_state.get(&mut self.trident),
            self.fuzz_accounts.sola_mint.get(&mut self.trident),
            self.fuzz_accounts.hi_sola_mint.get(&mut self.trident),
            self.fuzz_accounts.sola_vault.get(&mut self.trident),
            self.fuzz_accounts.market_vault.get(&mut self.trident),
            self.fuzz_accounts.usdc_mint.get(&mut self.trident),
        ) else {
            return;
        };
        let held = self.balance_of(self.hi_sola[i]);
        let amount = self.sized(held);

        let ix = UnstakeHiSolaInstruction::data(UnstakeHiSolaInstructionData::new(amount))
            .accounts(UnstakeHiSolaInstructionAccounts::new(
                self.users[i],
                protocol_state,
                sola_mint,
                hi_sola_mint,
                self.hi_sola[i],
                self.sola[i],
                sola_vault,
                market_vault,
                usdc_mint,
                self.usdc[i],
                self.positions[i],
                solana_sdk::system_program::ID,
            ))
            .instruction();
        let _ = self
            .trident
            .process_transaction(&[ix], Some("unstake_hi_sola"));
    }

    /// A bare transfer with no scenario around it, to keep unplanned orderings reachable.
    #[flow]
    fn flow_move_hi_sola(&mut self) {
        if !self.ready() {
            return;
        }
        let from = self.actor();
        let to = 1 - from;
        let balance = self.balance_of(self.hi_sola[from]);
        if balance == 0 {
            return;
        }
        let amount = self.trident.random_from_range(1..=balance);
        self.do_move_hi_sola(from, to, amount);
    }

    /// Report an invariant violation.
    ///
    /// ⚠️ Trident 0.12 swallows panics raised inside `#[end]`: a deliberate `assert!(false)`
    /// here produced no output, no crash artifact, and exit code 0, while the run printed a
    /// normal statistics table. Relying on `assert!` alone therefore makes violations
    /// invisible — which is exactly how two earlier mutation tests appeared to "pass".
    /// Every violation is written to a file so detection is observable; the panic is kept
    /// as well, for whenever the harness learns to surface it.
    fn report_violation(&self, msg: String) {
        use std::io::Write;
        let path = std::env::var("SOLADROME_FUZZ_VIOLATIONS")
            .unwrap_or_else(|_| "/tmp/soladrome_invariant_violations.txt".to_string());
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{msg}");
        }
        panic!("{msg}");
    }

    // ── Invariants ────────────────────────────────────────────────────────
    #[end]
    fn end(&mut self) {
        let Some(protocol_state_key) = self.fuzz_accounts.protocol_state.get(&mut self.trident) else { return };
        let Some(floor_vault_key) = self.fuzz_accounts.floor_vault.get(&mut self.trident) else { return };
        let Some(market_vault_key) = self.fuzz_accounts.market_vault.get(&mut self.trident) else { return };

        let Some(state): Option<ProtocolState> =
            self.trident.get_account_with_type(&protocol_state_key, 8)
        else {
            return;
        };
        let floor_balance = self.balance_of(floor_vault_key);
        let market_balance = self.balance_of(market_vault_key);

        // I-2: every SOLA redeemable at floor is either funded in the vault or booked as an
        // outstanding borrow.
        let backed = (floor_balance as u128) + (state.total_usdc_borrowed as u128);
        if backed < state.total_purchased_sola as u128 {
            self.report_violation(format!(
                "INVARIANT VIOLATED [I-2]: floor_vault ({floor_balance}) + total_usdc_borrowed \
                 ({}) < total_purchased_sola ({}) — purchased SOLA is under-collateralised.",
                state.total_usdc_borrowed, state.total_purchased_sola,
            ));
        }

        let live_acc = advance_accumulator(
            state.fees_per_hi_sola,
            market_balance,
            state.last_market_vault_balance,
            state.total_hi_sola,
        );

        let mut total_claimable: u128 = 0;
        let mut detail: Vec<String> = Vec::new();
        for i in 0..self.positions.len() {
            let Some(pos) = self.position_of(i) else {
                continue;
            };

            // I-1: credit follows the financed deposit, never a transferable balance.
            let basis = self
                .balance_of(self.hi_sola[i])
                .saturating_add(pos.vote_escrowed);
            let p = pending_fees(live_acc, pos.fees_debt, basis);
            detail.push(format!(
                "user{i}: debt={} basis={} escrowed={} staked={} pending={p}",
                pos.fees_debt, basis, pos.vote_escrowed, pos.staked_amount
            ));
            total_claimable += p as u128;
        }

        // I-3: if everyone claimed right now, the vault must be able to honour it. A
        // position opened without stamping `fees_debt` reads as staked since genesis and
        // blows this up immediately.
        if total_claimable > market_balance as u128 {
            self.report_violation(format!(
                "INVARIANT VIOLATED [I-3]: claimable fees ({total_claimable}) exceed \
                 market_vault ({market_balance}) — the fee promise is insolvent; some \
                 staker's claim_fees will revert on insufficient funds.\n  \
                 stored_acc={} live_acc={live_acc} last_bal={} total_hi_sola={} market={market_balance}\n  {}",
                state.fees_per_hi_sola, state.last_market_vault_balance, state.total_hi_sola,
                detail.join("\n  ")
            ));
        }
    }
}

fn main() {
    FuzzTest::fuzz(1000, 100);
}
