# Solana Foundation Grant Application
## Soladrome — Perpetual Liquidity Engine with ve(3,3) Tokenomics + Flash-Arbitrage Reverse-Profit

---

## 1. Project Overview

**Project Name:** Soladrome  
**Category:** DeFi / Infrastructure  
**Stage:** Live on Solana devnet — ready for audit and mainnet  
**Requested Amount:** $35,000 USD  
**GitHub:** https://github.com/OxToF/soladrome  
**Live Demo:** https://soladrome.finance  
**Telegram:** https://t.me/+SW4sVvoypbRkZTQ0  
**Twitter/X:** https://x.com/soladrome  
**Contact:** christophe.hertecant@gmail.com

---

## 2. The Problem

Every DeFi protocol on Solana today shares the same structural weakness: **liquidity is rented, not owned.**

- AMMs depend on external LPs who can withdraw at any time (and do, during volatility)
- Token prices have no guaranteed floor — crashes destroy value and trust permanently
- ve(3,3) mechanisms exist on EVM (Velodrome, Beradrome) but **not on Solana**
- Borrowing protocols require over-collateralization + liquidation risk, excluding millions of users
- AMM fees flow to anonymous LPs with no long-term alignment with the protocol
- **Flash arbitrage profits go 100% to bots** — not redistributed to protocol stakeholders

The result: DeFi on Solana is a casino of mercenary capital with no structural stability and no mechanism to redirect MEV value back to users.

---

## 3. Our Solution — Soladrome

Soladrome is a **protocol-owned perpetual liquidity engine** built around one core insight: arbitrage is inevitable — it should benefit stakers, not bots.

### 3.1 Flash-Arbitrage Reverse-Profit (FARP) — First on Solana

The protocol's most unique primitive: every flash arbitrage between the bonding curve and the AMM is executed on-chain in a single atomic transaction. The profit split is hardcoded:

```
flash_arbitrage:
  └─ 10% → caller (incentive to run the arb bot)
  └─ 90% → market_vault → hiSOLA stakers (passive USDC yield)
```

**No other Solana protocol captures MEV for its stakers.** This creates a compounding flywheel: more trading volume → more arb opportunities → more USDC yield for hiSOLA holders → more demand to stake → deeper liquidity.

### 3.2 Constant-Product Bonding Curve with Floor Protection

Every SOLA token is minted through a deterministic bonding curve (x·y=k). The buy-split is protocol-guaranteed:

```
buy_sola: USDC → bonding curve → SOLA minted
  └─ 1 USDC per SOLA → floor_vault (1:1 guaranteed redemption, always)
  └─ price premium → market_vault (staker revenue + flash arb income)
```

**Floor vault integrity** is maintained by design: the vault fills proportionally with every purchase. A `dynamic fee backstop` ensures the floor ratio (USDC/SOLA) is defended before fees reach the market vault when below target.

### 3.3 Guaranteed Floor Price — Zero Liquidation

The floor vault guarantees **1 USDC per SOLA at all times**.  
Users borrow USDC against hiSOLA at floor price.  
**Zero liquidation risk** — the floor never breaks because every SOLA purchase funds it directly.

### 3.4 ve(3,3) Tokenomics — First on Solana

Three-token system inspired by Velodrome/Beradrome, rebuilt natively for Anchor:

| Token | Role |
|-------|------|
| **SOLA** | Base token — minted via bonding curve, redeemable at floor |
| **hiSOLA** | Governance + fee share + borrow collateral (stake SOLA to mint) |
| **oSOLA** | Call-option rewards distributed to liquidity providers |

**Founder allocation (12.25M SOLA total — three tranches):**
- **7M progressive hiSOLA** — minted in linear tranches via `claim_founder_hi_sola`. Each claim mints SOLA to `sola_vault` + hiSOLA 1:1 to founder. Schedule: 6-month cliff → 24-month linear vesting. Zero hiSOLA at launch; protocol accumulates USDC floor reserves naturally before each tranche unlocks. The founder's primary liquidity path is `borrow_usdc` — borrow USDC against hiSOLA at floor price, no interest, no liquidation.
- **5M progressive oSOLA** — minted as call-option tokens via `claim_founder_vesting`. Same schedule: 6-month cliff → 24-month linear. oSOLA is exercised via `exercise_o_sola`: burn oSOLA + pay 1 USDC → receive 1 SOLA. Each exercise **adds 1 USDC to `floor_vault`** — net positive for the protocol. Identical to Beradrome's OBERO model (which reached $600k+ TVL). Zero tokens at launch; zero supply impact until after cliff.
- **250k liquid SOLA** — minted at launch via `mint_ecosystem_allocation` directly to the founder wallet. No lock, no vesting. Represents ~2% of the total founder allocation; provides near-term operational income while the 6-month cliff runs. Not counted in `total_purchased_sola` — cannot deplete the floor vault via `sell_sola` (on-chain enforced).
- **Floor invariant fix:** `sell_sola` checks `total_purchased_sola >= sola_amount` before decrementing, then verifies `floor_vault + total_usdc_borrowed >= total_purchased_sola`. `total_purchased_sola` counts only SOLA minted via `buy_sola` or `exercise_o_sola` — not founder/ecosystem allocations. This eliminates the floor depletion vector entirely.

A soft vote-weight cap (max 30% per address) will be added pre-mainnet.

**Ecosystem allocation (1.75M SOLA):** A separate on-chain `mint_ecosystem_allocation` instruction — one-time, authority-only — reserves 1,750,000 SOLA for community airdrop (50%), marketing (25%), trading contests (12.5%) and ecosystem reserve (12.5%). The same instruction also delivers the 250k founder liquid tranche above. Total tokens minted by this instruction: 2,000,000 SOLA.

### 3.5 Permissionless Bribe System

External protocols deposit bribe tokens to attract hiSOLA voting power toward their pools.  
Voters earn pro-rata bribe rewards after each 7-day epoch.  
**No admin needed** — treasury PDA signs all transfers on-chain.

### 3.6 Permissionless AMM Multi-Pool (volatile xy=k)

Anyone can create a token pair pool. Trading fees: 80% to LPs / 20% to the protocol (→ hiSOLA holders). Same flywheel mechanics as Velodrome — now on Solana.

---

## 4. Technical Architecture

### Smart Contract (Anchor 0.32.1 / Rust)
- **Language:** Rust / Anchor framework
- **Instructions:** 22 on-chain instructions, fully tested
- **Accounts:** 9 custom account types with PDA-based access control
- **Security patterns:**
  - Reward-per-token accumulator (O(1) fee distribution, no loops)
  - PDA-signed treasury (no admin keypair for protocol funds)
  - `founder_allocated` + `ecosystem_allocated` flags (one-time allocation guards)
  - Double-claim prevention via PDA existence check
  - u128 muldiv for all financial calculations (overflow-safe)
  - MINIMUM_LIQUIDITY lock on first AMM deposit (anti-manipulation)
  - Lexicographic mint sorting for unique pool PDA derivation
  - Flash arbitrage atomic execution (single transaction, no reentrancy)
  - `total_purchased_sola` floor invariant: `sell_sola` checks `floor_vault + borrowed ≥ total_purchased_sola` — founder/ecosystem allocations never inflate the denominator, eliminating the floor depletion vector

```
Core instructions:
initialize                  → Deploy protocol with virtual reserves
buy_sola                    → Bonding curve purchase, floor + market split
sell_sola                   → Floor redemption (1:1 USDC)
stake_sola                  → SOLA → hiSOLA (governance + fees)
unstake_hi_sola             → hiSOLA → SOLA (debt-gated)
borrow_usdc                 → Against hiSOLA at floor price, no liquidation
repay_usdc                  → Restore collateral
claim_fees                  → Pro-rata market vault fees for hiSOLA holders
flash_arbitrage             → Atomic arb: 10% caller / 90% → stakers (FARP)
deposit_bribe               → External protocol deposits incentives
vote_gauge                  → hiSOLA holders direct vote weight
claim_bribe                 → Pro-rata bribe after epoch ends
distribute_o_sola           → Authority mints oSOLA to LP reward recipients
exercise_o_sola             → Call-option: burn oSOLA + pay USDC → get SOLA
mint_founder_allocation     → One-time: initialise two vesting PDAs (7M hiSOLA + 5M oSOLA schedules), zero minting at launch
claim_founder_hi_sola       → Progressive hiSOLA vest: cliff+linear → mint SOLA to sola_vault + hiSOLA to founder
claim_founder_vesting       → Progressive oSOLA vest: cliff+linear → mint oSOLA call-options to founder
mint_ecosystem_allocation   → One-time 2M SOLA for marketing & airdrop (on-chain)

AMM instructions (volatile xy=k):
create_pool            → Permissionless pool creation for any token pair
add_liquidity          → Deposit token A + B, receive LP tokens
remove_liquidity       → Burn LP tokens, receive proportional A + B
amm_swap               → xy=k swap with fee split (80% LP / 20% protocol)
```

### Frontend (Next.js 14)
- Wallet adapter (Phantom, Solflare, Backpack)
- Self-discovering USDC mint (reads `protocolState.usdcMint` on-chain — no env vars)
- **Supabase wallet tracking:** every connected wallet is registered server-side for airdrop eligibility
- **9 pages:** Trade · Swap · Pools · Stake · Borrow · Liquidity · Vote · Bribe · Claim
- Token registry auto-populated (wSOL hardcoded, SOLA from PDA, USDC from protocol state)
- Dark theme, responsive, production-ready at https://soladrome.finance

### Test Suite
- 11 end-to-end tests on localnet
- Covers: full buy→stake→borrow→repay→unstake→sell cycle
- Protocol fee accumulation verified: 2.42 USDC claimed permissionlessly
- Flash arbitrage atomic execution verified
- Slippage guard tested

---

## 5. What Makes Soladrome Unique on Solana

| Feature | Soladrome | Raydium | Orca | Jupiter |
|---------|-----------|---------|------|---------|
| Protocol-owned liquidity | ✅ | ❌ | ❌ | ❌ |
| Guaranteed floor price | ✅ | ❌ | ❌ | ❌ |
| No liquidation borrowing | ✅ | ❌ | ❌ | ❌ |
| Flash arb profit → stakers (FARP) | ✅ | ❌ | ❌ | ❌ |
| ve(3,3) bribe system | ✅ | ❌ | ❌ | ❌ |
| AMM fees → governance | ✅ | ❌ | ❌ | ❌ |
| Permissionless treasury | ✅ | ❌ | ❌ | ❌ |
| On-chain ecosystem allocation | ✅ | ❌ | ❌ | ❌ |
| Self-seeding liquidity | ✅ | ❌ | ❌ | ❌ |

The closest comparable is **Beradrome on Berachain** (EVM, $600k+ TVL).  
Soladrome is the **first native Solana implementation** of this model — and adds Flash-Arbitrage Reverse-Profit that Beradrome does not have.

---

## 6. Grant Usage

| Item | Amount | Justification |
|------|--------|---------------|
| **Security audit** (partial) | $18,000 | OtterSec / Neodyme — non-negotiable before mainnet. Focused on bonding curve, flash arb logic, and vault invariants |
| **Developer compensation** (3 months) | $10,000 | Solo founder — full-stack + Rust/Anchor dev, minimum viable runway to reach mainnet |
| **Devnet deployment + RPC** | $2,000 | Helius dedicated node for 6 months |
| **Bug bounty program** | $3,000 | Immunefi listing — targeting bonding curve manipulation, flash arb reentrancy, vault depletion vectors |
| **Legal review** (DeFi compliance) | $2,000 | Token classification, ToS |
| **TOTAL** | **$35,000** | |

> The protocol generates its own USDC revenue from day 1 through the bonding curve and AMM fees.  
> The 2M SOLA ecosystem allocation (on-chain, separate from founder) covers community growth independently of this grant.  
> Developer compensation represents minimum viable runway for a solo founder to reach mainnet safely.

---

## 7. Milestones & Timeline

### Milestone 1 — Devnet Deployment ✅ Complete
- ✅ 22 instructions deployed to Solana devnet
- ✅ Frontend live at https://soladrome.finance
- ✅ Multi-wallet support (Phantom, Solflare, Backpack)
- ✅ AMM multi-pool live (create pool, add liquidity, xy=k swap)
- ✅ Flash arbitrage (FARP) live — atomic, 90% to stakers
- ✅ 2M SOLA ecosystem allocation instruction deployed on-chain
- ✅ On-chain founder vesting live: 7M hiSOLA progressive (6mo cliff + 24mo linear) + 5M oSOLA progressive (same schedule); zero tokens minted at launch; floor invariant enforced via `total_purchased_sola`
- ✅ Supabase wallet collection active (airdrop eligibility tracking)
- ✅ Telegram community launched: https://t.me/+SW4sVvoypbRkZTQ0
- **Deliverable:** Public devnet address + live frontend + community

### Milestone 2 — MVP Hardening + Marketing (Month 1–2)
- Core-only focus: bonding curve · staking · flash arb (FARP) · single USDC/SOLA pool
- Community audit-by-peers (GitHub public, Solana builders review)
- Automated CI: 10k simulated swaps, 1k stakes on devnet
- Trading contest (devnet) — rewards from ecosystem allocation
- KOL outreach + Twitter/X campaign around FARP narrative
- **Deliverable:** Hardened core, growing community (500+ Telegram members)

### Milestone 3 — Security Audit (Month 2–3)
- Full smart contract audit by OtterSec or Neodyme
- Priority: bonding curve invariants, flash arb atomicity, floor vault depletion scenarios
- Fix all critical/high findings
- ~~On-chain vesting for founder allocation~~ **✅ Deployed in Milestone 1** — 7M hiSOLA + 5M oSOLA progressive vesting, cliff + linear enforced on-chain; `total_purchased_sola` floor invariant deployed
- Vote-weight cap (30% max per address) pre-mainnet
- Fuzzing with Trident
- **Deliverable:** Published audit report + vesting contract live

### Milestone 4 — Mainnet Launch (Month 4)
- Deploy to mainnet with real USDC mint
- Squads v4 multisig replacing single authority keypair
- Emergency pause mechanism
- Tune bonding curve parameters for mainnet depth
- Helius RPC integration
- Airdrop snapshot + distribution to devnet early users
- **Deliverable:** Live protocol on mainnet, open-source repo, airdrop completed

### Milestone 5 — Ecosystem Integration (Month 5–6)
- List SOLA on Jupiter aggregator
- Integrate with Raydium/Orca pools as bribe targets
- Enable full ve(3,3) suite: gauge/bribe, veSOLA lock-up, POL auto-LP
- Stable AMM curves (Phase 2 — correlated pairs: USDC/USDT, LSTs)
- Community governance via hiSOLA
- **Deliverable:** 5+ external protocols using the bribe system

---

## 8. Team

**Founder / Lead Developer — Christophe Hertecant**
- Full-stack + Rust/Anchor development
- Built Soladrome from scratch: 20-instruction smart contract, test suite, 9-page frontend
- Solo founder — looking to expand team post-grant

*References and LinkedIn available on request.*

---

## 9. Traction & Validation

- ✅ Working protocol: 22 instructions, 9 account types, 11 passing end-to-end tests
- ✅ Fully tested on localnet (buy → stake → borrow → claim fees → flash arb → bribe → vote → AMM swap)
- ✅ Frontend live at https://soladrome.finance (Devnet)
- ✅ AMM multi-pool live — permissionless pool creation, xy=k swaps, LP tokens
- ✅ Flash arbitrage (FARP) live — 90% of arb profit routes atomically to stakers
- ✅ 2M SOLA ecosystem allocation deployed on-chain (separate from founder)
- ✅ Wallet collection active — early users automatically registered for airdrop
- ✅ Telegram community live: https://t.me/+SW4sVvoypbRkZTQ0
- ✅ Protocol fees distributed permissionlessly (2.42 USDC in localnet test)
- ✅ Inspired by Beradrome ($600k+ TVL on Berachain mainnet) — adds FARP which Beradrome lacks
- ✅ Open source: https://github.com/OxToF/soladrome

---

## 10. Long-Term Vision

Soladrome is not a memecoin launcher. It is **infrastructure** with a self-reinforcing flywheel unique to Solana:

```
More trading volume → More flash arb opportunities (FARP)
→ 90% of arb profit → hiSOLA stakers (passive USDC yield)
→ More demand to hold hiSOLA → More SOLA bonded → Deeper floor vault
→ More borrowing capacity → More protocol usage → More AMM fees
→ AMM fees → market_vault → More incentive to stake hiSOLA
→ More voting power → More bribes from external protocols
→ More trading volume (loop)
```

The FARP mechanism transforms Soladrome from a passive ve(3,3) clone into an **active MEV-capture engine** that benefits its community rather than external bots.

**Long-term goal:** become the **canonical liquidity layer** for the Solana DeFi ecosystem —  
the protocol that other protocols build on top of, not compete with.

**Roadmap beyond grant:**
- Phase 2: Stable AMM curves for correlated pairs (USDC/USDT, LSTs)
- Phase 3: Cross-program invocation hooks for external protocol integration
- Phase 4: DAO governance fully on-chain via hiSOLA + full airdrop distribution

---

## 11. Open Source & Licensing

The codebase is **fully open source** and publicly available at https://github.com/OxToF/soladrome:

- **Smart contracts:** Business Source License 1.1 (BUSL-1.1)
  - Licensor: Christophe Hertecant
  - Change Date: 2030-05-13 → converts to GPL v2.0 or later
  - Additional Use Grant: non-commercial use, research, personal use, and interacting with deployed instances are permitted
- **Frontend:** GNU General Public License v3.0

---

## 12. Relevant Links

- **Live frontend:** https://soladrome.finance
- **About / Whitepaper:** https://soladrome.finance/about.html
- **GitHub (public):** https://github.com/OxToF/soladrome
- **Program ID (devnet):** `4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd`
- **Telegram:** https://t.me/+SW4sVvoypbRkZTQ0
- **Twitter/X:** https://x.com/soladrome
- **Discord:** https://discord.com/channels/1506249630218715218/1506249803451994132

---

*Application submitted by Christophe Hertecant — Solo founder, Soladrome Protocol.*  
*Contact: christophe.hertecant@gmail.com*
