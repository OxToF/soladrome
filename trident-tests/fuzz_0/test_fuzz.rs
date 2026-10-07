//! # Soladrome Fuzz Test — Bonding Curve Invariants
//!
//! Fuzzes random sequences of `buy_sola` and `sell_sola` and verifies that
//! the three core bonding-curve invariants always hold:
//!
//!   I-1. floor_vault.amount >= total_purchased_sola
//!        The 1:1 USDC backing for every SOLA that can be sold is never broken.
//!
//!   I-2. virtual_usdc > 0  (bonding curve never empties the virtual USDC side)
//!
//!   I-3. virtual_sola > 0  (bonding curve never empties the virtual SOLA side)
//!
//!   I-4. market_reserve >= virtual_usdc + virtual_sola − 2N
//!        Since 2026-10-07 a sale goes back down the curve and is paid its premium out of
//!        `market_reserve`; the reserve must always cover the rest of the curve.
//!
//! Any violation triggers an assertion panic, which Trident records as a crash
//! and saves the reproducing seed for debugging.

use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;
mod types;
use types::soladrome::*;
use types::*;

use solana_sdk::pubkey::Pubkey;
use solana_sdk::signer::Signer;

// ── Constants ─────────────────────────────────────────────────────────────
const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

fn program_id() -> Pubkey {
    soladrome::program_id()
}

/// Derive a PDA with the given seeds from the Soladrome program.
fn derive(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &program_id()).0
}

// ── Fuzz struct ───────────────────────────────────────────────────────────

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
        }
    }

    // ── Initialization: called once at the start of each fuzzing iteration ──
    #[init]
    fn start(&mut self) {
        // Use the Trident built-in payer as authority + user.
        // TridentSVM bypasses signature verification, so any funded account
        // can act as a signer in account metas.
        let authority = self.trident.payer().pubkey();

        // Derive all protocol PDAs deterministically from program seeds.
        let protocol_state = derive(&[b"state"]);
        let sola_mint      = derive(&[b"sola_mint"]);
        let hi_sola_mint   = derive(&[b"hi_sola_mint"]);
        let o_sola_mint    = derive(&[b"o_sola_mint"]);
        let floor_vault    = derive(&[b"floor_vault"]);
        let market_vault   = derive(&[b"market_vault"]);
        let sola_vault     = derive(&[b"sola_vault"]);
        let market_reserve = derive(&[b"market_reserve"]);

        // Create a fresh SPL USDC mint (6 decimals, authority as mint_authority).
        let usdc_keypair = self.trident.random_keypair();
        let usdc_mint    = usdc_keypair.pubkey();
        let mint_ixs = self.trident.initialize_mint(
            &authority, &usdc_mint, 6, &authority, None,
        );
        self.trident.process_transaction(&mint_ixs, Some("create_usdc_mint"));

        // Initialize the Soladrome protocol (creates all PDAs on-chain).
        // A founder key that is not the actor, as in the bankrun suites.
        let founder = self.trident.random_keypair().pubkey();
        let init_ix = InitializeInstruction::data(InitializeInstructionData::new(founder))
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
                market_reserve,
            ))
            .instruction();
        let result = self.trident.process_transaction(&[init_ix], Some("initialize"));
        if !result.is_success() {
            // Initialize failed — bail out gracefully so the fuzzer can retry.
            return;
        }

        // Open the curve. `initialize` leaves it closed (launch phase gate), so without this every
        // `buy_sola` is refused with FeatureDisabled and the fuzz exercises nothing.
        let flags_ix = SetPhaseFlagsInstruction::data(SetPhaseFlagsInstructionData::new(
            None, None, None, None, Some(true), None,
        ))
        .accounts(SetPhaseFlagsInstructionAccounts::new(authority, protocol_state))
        .instruction();
        self.trident.process_transaction(&[flags_ix], Some("set_phase_flags"));

        // Create user USDC ATA and fund with 1 000 000 USDC.
        let user_usdc = self.trident.get_associated_token_address(
            &usdc_mint, &authority, &TOKEN_PROGRAM_ID,
        );
        let ix = self.trident.initialize_associated_token_account(
            &authority, &usdc_mint, &authority,
        );
        self.trident.process_transaction(&[ix], Some("create_user_usdc_ata"));
        let ix = self.trident.mint_to(&user_usdc, &usdc_mint, &authority, 1_000_000_000_000);
        self.trident.process_transaction(&[ix], Some("fund_user_usdc"));

        // Create user SOLA ATA.
        let user_sola = self.trident.get_associated_token_address(
            &sola_mint, &authority, &TOKEN_PROGRAM_ID,
        );
        let ix = self.trident.initialize_associated_token_account(
            &authority, &sola_mint, &authority,
        );
        self.trident.process_transaction(&[ix], Some("create_user_sola_ata"));

        // Store all addresses so flows can retrieve them.
        self.fuzz_accounts.protocol_state.insert_with_address(protocol_state);
        self.fuzz_accounts.sola_mint.insert_with_address(sola_mint);
        self.fuzz_accounts.floor_vault.insert_with_address(floor_vault);
        self.fuzz_accounts.market_vault.insert_with_address(market_vault);
        self.fuzz_accounts.market_reserve.insert_with_address(market_reserve);
        self.fuzz_accounts.sola_vault.insert_with_address(sola_vault);
        self.fuzz_accounts.usdc_mint.insert_with_address(usdc_mint);
        self.fuzz_accounts.user_usdc.insert_with_address(user_usdc);
        self.fuzz_accounts.user_sola.insert_with_address(user_sola);
    }

    // ── Flow 1: buy_sola with a fuzzer-chosen USDC amount ────────────────
    #[flow]
    fn flow_buy_sola(&mut self) {
        let authority = self.trident.payer().pubkey();

        let Some(protocol_state) = self.fuzz_accounts.protocol_state.get(&mut self.trident) else { return };
        let Some(sola_mint)      = self.fuzz_accounts.sola_mint.get(&mut self.trident)      else { return };
        let Some(floor_vault)    = self.fuzz_accounts.floor_vault.get(&mut self.trident)    else { return };
        let Some(market_vault)   = self.fuzz_accounts.market_vault.get(&mut self.trident)   else { return };
        let Some(market_reserve) = self.fuzz_accounts.market_reserve.get(&mut self.trident) else { return };
        let Some(user_usdc)      = self.fuzz_accounts.user_usdc.get(&mut self.trident)      else { return };
        let Some(user_sola)      = self.fuzz_accounts.user_sola.get(&mut self.trident)      else { return };

        // Buy between 1 and 100 000 USDC worth of SOLA.
        // Upper bound keeps the user's 1M USDC balance alive for long sequences.
        let usdc_in: u64 = self.trident.random_from_range(1..=100_000_000_000_u64);

        let ix = BuySolaInstruction::data(BuySolaInstructionData::new(
            usdc_in,
            0, // min_sola_out = 0: accept any output (worst-case slippage scenario)
        ))
        .accounts(BuySolaInstructionAccounts::new(
            authority, protocol_state, sola_mint, user_usdc, user_sola, floor_vault, market_vault,
            market_reserve,
        ))
        .instruction();

        // Ignore program-level errors (insufficient balance, paused, etc.)
        // We only assert invariants, not that every instruction succeeds.
        let _ = self.trident.process_transaction(&[ix], Some("buy_sola"));
    }

    // ── Flow 2: sell_sola with a fuzzer-chosen SOLA amount ───────────────
    #[flow]
    fn flow_sell_sola(&mut self) {
        let authority = self.trident.payer().pubkey();

        let Some(protocol_state) = self.fuzz_accounts.protocol_state.get(&mut self.trident) else { return };
        let Some(sola_mint)      = self.fuzz_accounts.sola_mint.get(&mut self.trident)      else { return };
        let Some(floor_vault)    = self.fuzz_accounts.floor_vault.get(&mut self.trident)    else { return };
        let Some(market_vault)   = self.fuzz_accounts.market_vault.get(&mut self.trident)   else { return };
        let Some(market_reserve) = self.fuzz_accounts.market_reserve.get(&mut self.trident) else { return };
        let Some(user_usdc)      = self.fuzz_accounts.user_usdc.get(&mut self.trident)      else { return };
        let Some(user_sola)      = self.fuzz_accounts.user_sola.get(&mut self.trident)      else { return };

        // Sell between 1 and the whole balance. This drew from 1..=u64::MAX until 2026-10-07, so
        // every sale exceeded the balance and was refused: 49 831 sells, 0 successes, and the
        // fuzz had never exercised a sale at all.
        let held = match self.trident.get_token_account(user_sola) {
            Ok(acc) => acc.account.amount,
            Err(_) => return,
        };
        if held == 0 {
            return;
        }
        let sola_amount: u64 = self.trident.random_from_range(1..=held);

        // min_usdc_out = 0: accept any price, the worst case for the reserve.
        let ix = SellSolaInstruction::data(SellSolaInstructionData::new(sola_amount, 0))
            .accounts(SellSolaInstructionAccounts::new(
                authority, protocol_state, sola_mint, user_sola, floor_vault, user_usdc,
                market_reserve, market_vault,
            ))
            .instruction();

        let _ = self.trident.process_transaction(&[ix], Some("sell_sola"));
    }

    // ── End: verify invariants after the flow sequence ───────────────────
    #[end]
    fn end(&mut self) {
        let Some(protocol_state_key) = self.fuzz_accounts.protocol_state.get(&mut self.trident) else { return };
        let Some(floor_vault_key)    = self.fuzz_accounts.floor_vault.get(&mut self.trident)    else { return };
        let Some(reserve_key)        = self.fuzz_accounts.market_reserve.get(&mut self.trident) else { return };

        // Deserialize the on-chain ProtocolState (Borsh, 8-byte discriminator skipped internally).
        let Some(state): Option<ProtocolState> =
            self.trident.get_account_with_type(&protocol_state_key, 8)
        else {
            return; // Not yet initialised — nothing to check.
        };

        // Read the floor_vault SPL token balance.
        let floor_balance = match self.trident.get_token_account(floor_vault_key) {
            Ok(acc) => acc.account.amount,
            Err(_)  => return,
        };

        // I-1: floor backing invariant — the USDC in floor_vault must cover
        // every SOLA that was sold through the bonding curve (total_purchased_sola
        // tracks cumulative SOLA minted via buy_sola, which must be backed 1:1).
        assert!(
            floor_balance >= state.total_purchased_sola,
            "INVARIANT VIOLATED [I-1]: floor_vault ({floor_balance}) \
             < total_purchased_sola ({}) — floor reserve is under-collateralised.",
            state.total_purchased_sola,
        );

        // I-2: virtual USDC reserve must remain strictly positive.
        assert!(
            state.virtual_usdc > 0,
            "INVARIANT VIOLATED [I-2]: virtual_usdc == 0 — bonding curve collapsed \
             (next buy_sola would panic on division by zero).",
        );

        // I-3: virtual SOLA reserve must remain strictly positive.
        assert!(
            state.virtual_sola > 0,
            "INVARIANT VIOLATED [I-3]: virtual_sola == 0 — bonding curve collapsed \
             (no more SOLA can be minted via buy_sola).",
        );

        // I-4: the market reserve covers every premium the curve still owes its sellers.
        let reserve = match self.trident.get_token_account(reserve_key) {
            Ok(acc) => acc.account.amount as u128,
            Err(_) => return,
        };
        let owed = (state.virtual_usdc as u128 + state.virtual_sola as u128)
            .saturating_sub(2 * 1_000_000_000_000u128);
        assert!(
            reserve >= owed,
            "INVARIANT VIOLATED [I-4]: market_reserve ({reserve}) < owed premium ({owed}) — \
             the last sellers down the curve would not be paid.",
        );
    }
}

fn main() {
    FuzzTest::fuzz(1000, 100);
}
