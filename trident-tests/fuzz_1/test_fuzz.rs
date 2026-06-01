//! # Soladrome Fuzz Test — Flash Arbitrage Invariants
//!
//! Fuzzes `flash_arbitrage` with random oSOLA amounts against a live AMM pool
//! and verifies the two core flash-arb invariants:
//!
//!   I-1. market_vault.amount is non-decreasing across iterations.
//!        Flash arb must NEVER drain the market vault — it either adds to it
//!        (90% of profit) or reverts cleanly with an error.
//!
//!   I-2. floor_vault.amount is non-decreasing across iterations.
//!        Flash arb exercises oSOLA → SOLA → AMM sell → buy back → profit.
//!        The floor vault must never lose USDC as a side-effect.
//!
//! Any violation triggers an assertion panic, saved as a crash seed by Trident.

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
const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

fn program_id() -> Pubkey {
    soladrome::program_id()
}

fn derive(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &program_id()).0
}

fn sort_mints(a: Pubkey, b: Pubkey) -> (Pubkey, Pubkey) {
    if a.to_bytes() <= b.to_bytes() { (a, b) } else { (b, a) }
}

// ── Fuzz struct ───────────────────────────────────────────────────────────

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    /// Snapshot of market_vault balance at start of each #[end] check.
    market_vault_baseline: u64,
    /// Snapshot of floor_vault balance at start of each #[end] check.
    floor_vault_baseline: u64,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            market_vault_baseline: 0,
            floor_vault_baseline: 0,
        }
    }

    // ── Initialization ───────────────────────────────────────────────────
    #[init]
    fn start(&mut self) {
        let authority = self.trident.payer().pubkey();

        // Protocol PDAs
        let protocol_state = derive(&[b"state"]);
        let sola_mint      = derive(&[b"sola_mint"]);
        let hi_sola_mint   = derive(&[b"hi_sola_mint"]);
        let o_sola_mint    = derive(&[b"o_sola_mint"]);
        let floor_vault    = derive(&[b"floor_vault"]);
        let market_vault   = derive(&[b"market_vault"]);
        let sola_vault     = derive(&[b"sola_vault"]);

        // USDC mint
        let usdc_keypair = self.trident.random_keypair();
        let usdc_mint    = usdc_keypair.pubkey();
        let ixs = self.trident.initialize_mint(&authority, &usdc_mint, 6, &authority, None);
        self.trident.process_transaction(&ixs, Some("create_usdc_mint"));

        // Initialize protocol
        let init_ix = InitializeInstruction::data(InitializeInstructionData::new())
            .accounts(InitializeInstructionAccounts::new(
                authority, protocol_state, usdc_mint,
                sola_mint, hi_sola_mint, o_sola_mint,
                floor_vault, market_vault, sola_vault,
            ))
            .instruction();
        let r = self.trident.process_transaction(&[init_ix], Some("initialize"));
        if !r.is_success() { return; }

        // Fund caller with USDC (10M) + buy some SOLA first so AMM pool has inventory
        let caller_usdc = self.trident.get_associated_token_address(&usdc_mint, &authority, &TOKEN_PROGRAM_ID);
        let ix = self.trident.initialize_associated_token_account(&authority, &usdc_mint, &authority);
        self.trident.process_transaction(&[ix], Some("create_caller_usdc_ata"));
        let ix = self.trident.mint_to(&caller_usdc, &usdc_mint, &authority, 10_000_000_000_000);
        self.trident.process_transaction(&[ix], Some("fund_caller_usdc"));

        // Create caller SOLA + oSOLA ATAs
        let caller_sola = self.trident.get_associated_token_address(&sola_mint, &authority, &TOKEN_PROGRAM_ID);
        let ix = self.trident.initialize_associated_token_account(&authority, &sola_mint, &authority);
        self.trident.process_transaction(&[ix], Some("create_caller_sola_ata"));

        let caller_o_sola = self.trident.get_associated_token_address(&o_sola_mint, &authority, &TOKEN_PROGRAM_ID);
        let ix = self.trident.initialize_associated_token_account(&authority, &o_sola_mint, &authority);
        self.trident.process_transaction(&[ix], Some("create_caller_osola_ata"));

        // Buy 500k USDC worth of SOLA to seed the floor vault and get SOLA
        let buy_ix = BuySolaInstruction::data(BuySolaInstructionData::new(500_000_000_000, 0))
            .accounts(BuySolaInstructionAccounts::new(
                authority, protocol_state, sola_mint,
                caller_usdc, caller_sola, floor_vault, market_vault,
            ))
            .instruction();
        self.trident.process_transaction(&[buy_ix], Some("seed_buy_sola"));

        // Stake some SOLA to get hiSOLA (needed for flash arb oSOLA exercise path)
        let caller_hi_sola = self.trident.get_associated_token_address(&hi_sola_mint, &authority, &TOKEN_PROGRAM_ID);
        let ix = self.trident.initialize_associated_token_account(&authority, &hi_sola_mint, &authority);
        self.trident.process_transaction(&[ix], Some("create_hi_sola_ata"));

        // Create an AMM pool: SOLA/USDC
        let (mint_a, mint_b) = sort_mints(sola_mint, usdc_mint);
        let pool_pda = Pubkey::find_program_address(
            &[b"amm_pool", mint_a.as_ref(), mint_b.as_ref()],
            &program_id(),
        ).0;
        let lp_mint_pda = Pubkey::find_program_address(&[b"lp_mint", pool_pda.as_ref()], &program_id()).0;
        let vault_a_pda = Pubkey::find_program_address(&[b"vault_a", pool_pda.as_ref()], &program_id()).0;
        let vault_b_pda = Pubkey::find_program_address(&[b"vault_b", pool_pda.as_ref()], &program_id()).0;

        let lp_dead = solana_sdk::system_program::id();
        let lp_dead_ata = self.trident.get_associated_token_address(&lp_mint_pda, &lp_dead, &TOKEN_PROGRAM_ID);

        // Create pool (30 bps fee, 10% protocol share)
        let create_pool_ix = CreatePoolInstruction::data(CreatePoolInstructionData::new(30, 1000))
            .accounts(CreatePoolInstructionAccounts::new(
                authority, protocol_state,
                mint_a, mint_b, pool_pda, lp_mint_pda, vault_a_pda, vault_b_pda,
            ))
            .instruction();
        let r = self.trident.process_transaction(&[create_pool_ix], Some("create_pool"));
        if !r.is_success() { return; }

        // Add liquidity: 100k USDC + equivalent SOLA
        let user_lp_ata = self.trident.get_associated_token_address(&lp_mint_pda, &authority, &TOKEN_PROGRAM_ID);
        let ix = self.trident.initialize_associated_token_account(&authority, &lp_mint_pda, &authority);
        self.trident.process_transaction(&[ix], Some("create_lp_ata"));

        let lp_user_info_pda = Pubkey::find_program_address(
            &[b"lp_user", pool_pda.as_ref(), authority.as_ref()],
            &program_id(),
        ).0;

        let add_liq_ix = AddLiquidityInstruction::data(AddLiquidityInstructionData::new(
            100_000_000_000, // 100k token A
            100_000_000_000, // 100k token B
            0,               // min_lp = 0
        ))
        .accounts(AddLiquidityInstructionAccounts::new(
            authority, pool_pda, lp_mint_pda, vault_a_pda, vault_b_pda,
            if mint_a == sola_mint { caller_sola } else { caller_usdc },
            if mint_b == usdc_mint { caller_usdc } else { caller_sola },
            user_lp_ata, lp_dead_ata, lp_user_info_pda,
            protocol_state, o_sola_mint, caller_o_sola,
        ))
        .instruction();
        self.trident.process_transaction(&[add_liq_ix], Some("add_liquidity"));

        // Snapshot baselines before fuzzing starts
        self.market_vault_baseline = self.trident
            .get_token_account(market_vault)
            .map(|a| a.account.amount)
            .unwrap_or(0);
        self.floor_vault_baseline = self.trident
            .get_token_account(floor_vault)
            .map(|a| a.account.amount)
            .unwrap_or(0);

        // Store addresses
        self.fuzz_accounts.protocol_state.insert_with_address(protocol_state);
        self.fuzz_accounts.sola_mint.insert_with_address(sola_mint);
        self.fuzz_accounts.o_sola_mint.insert_with_address(o_sola_mint);
        self.fuzz_accounts.usdc_mint.insert_with_address(usdc_mint);
        self.fuzz_accounts.floor_vault.insert_with_address(floor_vault);
        self.fuzz_accounts.market_vault.insert_with_address(market_vault);
        self.fuzz_accounts.pool.insert_with_address(pool_pda);
        self.fuzz_accounts.token_a_vault.insert_with_address(vault_a_pda);
        self.fuzz_accounts.token_b_vault.insert_with_address(vault_b_pda);
        self.fuzz_accounts.caller_sola.insert_with_address(caller_sola);
        self.fuzz_accounts.caller_usdc.insert_with_address(caller_usdc);
        self.fuzz_accounts.caller_o_sola.insert_with_address(caller_o_sola);
    }

    // ── Flow: flash_arbitrage with random oSOLA amount ───────────────────
    #[flow]
    fn flow_flash_arb(&mut self) {
        let authority = self.trident.payer().pubkey();

        let Some(protocol_state) = self.fuzz_accounts.protocol_state.get(&mut self.trident) else { return };
        let Some(o_sola_mint)    = self.fuzz_accounts.o_sola_mint.get(&mut self.trident)    else { return };
        let Some(sola_mint)      = self.fuzz_accounts.sola_mint.get(&mut self.trident)      else { return };
        let Some(usdc_mint)      = self.fuzz_accounts.usdc_mint.get(&mut self.trident)      else { return };
        let Some(pool)           = self.fuzz_accounts.pool.get(&mut self.trident)           else { return };
        let Some(vault_a)        = self.fuzz_accounts.token_a_vault.get(&mut self.trident)  else { return };
        let Some(vault_b)        = self.fuzz_accounts.token_b_vault.get(&mut self.trident)  else { return };
        let Some(floor_vault)    = self.fuzz_accounts.floor_vault.get(&mut self.trident)    else { return };
        let Some(market_vault)   = self.fuzz_accounts.market_vault.get(&mut self.trident)   else { return };
        let Some(caller_o_sola)  = self.fuzz_accounts.caller_o_sola.get(&mut self.trident)  else { return };
        let Some(caller_sola)    = self.fuzz_accounts.caller_sola.get(&mut self.trident)    else { return };
        let Some(caller_usdc)    = self.fuzz_accounts.caller_usdc.get(&mut self.trident)    else { return };

        // Random oSOLA amount to exercise (1 to 10 000 oSOLA).
        // Very large amounts are likely to hit NothingToClaim or InsufficientFloorReserve,
        // which are both safe error paths — we only care about invariants.
        let amount_osola: u64 = self.trident.random_from_range(1..=10_000_000_000_u64);

        let ix = FlashArbitrageInstruction::data(FlashArbitrageInstructionData::new(
            amount_osola,
            0, // min_profit_usdc = 0: accept any profit (even 1 lamport)
        ))
        .accounts(FlashArbitrageInstructionAccounts::new(
            authority, protocol_state, o_sola_mint, sola_mint,
            caller_o_sola, caller_sola, caller_usdc, usdc_mint,
            pool, vault_a, vault_b, floor_vault, market_vault,
        ))
        .instruction();

        let _ = self.trident.process_transaction(&[ix], Some("flash_arbitrage"));
    }

    // ── Invariant checks ─────────────────────────────────────────────────
    #[end]
    fn end(&mut self) {
        let Some(market_vault_key) = self.fuzz_accounts.market_vault.get(&mut self.trident) else { return };
        let Some(floor_vault_key)  = self.fuzz_accounts.floor_vault.get(&mut self.trident)  else { return };

        let market_balance = self.trident
            .get_token_account(market_vault_key)
            .map(|a| a.account.amount)
            .unwrap_or(0);
        let floor_balance = self.trident
            .get_token_account(floor_vault_key)
            .map(|a| a.account.amount)
            .unwrap_or(0);

        // I-1: market_vault must not decrease from flash arb.
        // Flash arb routes 90% of USDC profit to market_vault. It can never drain it.
        assert!(
            market_balance >= self.market_vault_baseline,
            "INVARIANT VIOLATED [I-1]: market_vault decreased from {} to {} via flash_arbitrage — \
             protocol would be drained.",
            self.market_vault_baseline, market_balance,
        );

        // I-2: floor_vault must not decrease from flash arb.
        // The arb path exercises oSOLA against the floor, then sells SOLA on the AMM,
        // then buys back SOLA cheaper via the bonding curve. The floor vault must only
        // receive USDC (from oSOLA exercise), never lose it.
        assert!(
            floor_balance >= self.floor_vault_baseline,
            "INVARIANT VIOLATED [I-2]: floor_vault decreased from {} to {} via flash_arbitrage — \
             floor reserve backing is being eroded.",
            self.floor_vault_baseline, floor_balance,
        );
    }
}

fn main() {
    FuzzTest::fuzz(1000, 100);
}
