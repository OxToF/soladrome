# Solana Foundation Grant Application
## Soladrome — Perpetual Liquidity Engine with ve(3,3) Tokenomics + AMM

---

## 1. Project Overview

**Project Name:** Soladrome  
**Category:** DeFi / Infrastructure  
**Stage:** Live on Solana devnet — ready for audit and mainnet  
**Requested Amount:** $35,000 USD  
**GitHub:** https://github.com/OxToF/soladrome  
**Live Demo:** https://soladrome.finance  
**Contact:** christophe.hertecant@gmail.com

---

## 2. The Problem

Every DeFi protocol on Solana today shares the same structural weakness: **liquidity is rented, not owned.**

- AMMs depend on external LPs who can withdraw at any time (and do, during volatility)
- Token prices have no guaranteed floor — crashes destroy value and trust permanently
- ve(3,3) mechanisms exist on EVM (Velodrome, Beradrome) but **not on Solana**
- Borrowing protocols require over-collateralization + liquidation risk, excluding millions of users
- AMM fees flow to anonymous LPs with no long-term alignment with the protocol

The result: DeFi on Solana is a casino of mercenary capital with no structural stability.

---

## 3. Our Solution — Soladrome

Soladrome is a **protocol-owned perpetual liquidity engine** that combines four interlocking systems:

### 3.1 Constant-Product Bonding Curve
Every SOLA token is minted through a deterministic bonding curve (x·y=k).  
No external LP needed. No impermanent loss. Liquidity is permanent.

```
buy_sola: USDC → bonding curve → SOLA minted
  └─ 1 USDC per SOLA goes to floor_vault (guaranteed redemption)
  └─ price premium goes to market_vault (staker revenue)
```

### 3.2 Guaranteed Floor Price — No Liquidations
The floor vault guarantees **1 USDC per SOLA at all times**.  
Users can borrow up to their hiSOLA balance at floor price.  
**Zero liquidation risk** — the floor never breaks because buying SOLA funds it directly.

### 3.3 ve(3,3) Tokenomics — First on Solana
Three-token system inspired by Velodrome/Beradrome, rebuilt natively for Anchor:

| Token | Role |
|-------|------|
| **SOLA** | Base token — minted via bonding curve, redeemable at floor |
| **hiSOLA** | Governance + fee share + borrow collateral (stake SOLA to mint) |
| **oSOLA** | Call-option rewards distributed to liquidity providers |

### 3.4 Permissionless Bribe System
External protocols deposit bribe tokens to attract hiSOLA voting power toward their pools.  
Voters earn pro-rata bribe rewards after each 7-day epoch.  
**No admin needed** — treasury PDA signs all transfers on-chain.

### 3.5 Permissionless AMM Multi-Pool (volatile xy=k)
Anyone can create a token pair pool. Trading fees are split 80% to LPs / 20% to the protocol (→ hiSOLA holders). Same flywheel mechanics as Velodrome's ve(3,3) — now on Solana.

```
swap: amount_in → fee split → xy=k → amount_out
  └─ 80% fee stays in pool reserves (LP yield)
  └─ 20% fee → market_vault → hiSOLA stakers
```

---

## 4. Technical Architecture

### Smart Contract (Anchor 0.32.1 / Rust)
- **Language:** Rust / Anchor framework
- **Instructions:** 18 on-chain instructions, fully tested
- **Accounts:** 8 custom account types with PDA-based access control
- **Security patterns:**
  - Reward-per-token accumulator (O(1) fee distribution, no loops)
  - PDA-signed treasury (no admin keypair for protocol funds)
  - `founder_allocated` flag (one-time allocation guard)
  - Double-claim prevention via PDA existence check
  - u128 muldiv for all financial calculations (overflow-safe)
  - MINIMUM_LIQUIDITY lock on first AMM deposit (anti-manipulation)
  - Lexicographic mint sorting for unique pool PDA derivation

```
Core instructions:
initialize             → Deploy protocol with virtual reserves
buy_sola               → Bonding curve purchase, floor + market split
sell_sola              → Floor redemption (1:1 USDC)
stake_sola             → SOLA → hiSOLA (governance + fees)
unstake_hi_sola        → hiSOLA → SOLA (debt-gated)
borrow_usdc            → Against hiSOLA at floor price, no liquidation
repay_usdc             → Restore collateral
claim_fees             → Pro-rata market vault fees for hiSOLA holders
deposit_bribe          → External protocol deposits incentives
vote_gauge             → hiSOLA holders direct vote weight
claim_bribe            → Pro-rata bribe after epoch ends
distribute_o_sola      → Authority mints oSOLA to LP reward recipients
exercise_o_sola        → Call-option: burn oSOLA + pay USDC → get SOLA
mint_founder_allocation → One-time 12M SOLA founder grant (7M auto-staked)

AMM instructions (Phase 1 — volatile xy=k):
create_pool            → Permissionless pool creation for any token pair
add_liquidity          → Deposit token A + B, receive LP tokens
remove_liquidity       → Burn LP tokens, receive proportional A + B
amm_swap               → xy=k swap with fee split (80% LP / 20% protocol)
```

### Frontend (Next.js 14)
- Wallet adapter (Phantom, Solflare, Backpack)
- Self-discovering USDC mint (reads `protocolState.usdcMint` on-chain — no env vars)
- **9 pages:** Trade · Swap · Pools · Stake · Borrow · Liquidity · Vote · Bribe · Claim
- Token registry auto-populated (wSOL hardcoded, SOLA from PDA, USDC from protocol state)
- Dark theme, responsive, production-ready at https://soladrome.finance

### Test Suite
- 11 end-to-end tests on localnet
- Covers: full buy→stake→borrow→repay→unstake→sell cycle
- Protocol fee accumulation verified: 2.42 USDC claimed permissionlessly
- Slippage guard tested

---

## 5. What Makes Soladrome Unique on Solana

| Feature | Soladrome | Raydium | Orca | Jupiter |
|---------|-----------|---------|------|---------|
| Protocol-owned liquidity | ✅ | ❌ | ❌ | ❌ |
| Guaranteed floor price | ✅ | ❌ | ❌ | ❌ |
| No liquidation borrowing | ✅ | ❌ | ❌ | ❌ |
| ve(3,3) bribe system | ✅ | ❌ | ❌ | ❌ |
| AMM fees → governance | ✅ | ❌ | ❌ | ❌ |
| Permissionless treasury | ✅ | ❌ | ❌ | ❌ |
| Self-seeding liquidity | ✅ | ❌ | ❌ | ❌ |

The closest comparable is **Beradrome on Berachain** (EVM, $600k+ TVL).  
Soladrome is the **first native Solana implementation** of this model.

---

## 6. Grant Usage

| Item | Amount | Justification |
|------|--------|---------------|
| **Security audit** (partial) | $18,000 | OtterSec / Neodyme — non-negotiable before mainnet |
| **Developer compensation** (3 months) | $10,000 | Solo founder — full-stack + Rust/Anchor dev, minimum viable runway to reach mainnet |
| **Devnet deployment + RPC** | $2,000 | Helius dedicated node for 6 months |
| **Bug bounty program** | $3,000 | Immunefi listing, community review |
| **Legal review** (DeFi compliance) | $2,000 | Token classification, ToS |
| **TOTAL** | **$35,000** | |

> The protocol generates its own USDC revenue from day 1 through the bonding curve and AMM fees.  
> Developer compensation represents minimum viable runway for a solo founder to reach mainnet safely — no marketing spend, no team overhead.

---

## 7. Milestones & Timeline

### Milestone 1 — Devnet Deployment ✅ Complete
- ✅ All 18 instructions deployed to Solana devnet
- ✅ Frontend live at https://soladrome.finance
- ✅ Multi-wallet support (Phantom, Solflare, Backpack)
- ✅ AMM multi-pool live (create pool, add liquidity, xy=k swap)
- **Deliverable:** Public devnet address + live frontend

### Milestone 2 — Security Audit (Month 2–3)
- Full smart contract audit by OtterSec or Neodyme
- Fix all critical/high findings
- Fuzzing with Trident
- Re-review of fixes
- **Deliverable:** Published audit report

### Milestone 3 — Mainnet Launch (Month 4)
- Deploy to mainnet with real USDC mint
- Squads v4 multisig replacing single authority keypair
- Emergency pause mechanism
- Tune bonding curve parameters for mainnet depth
- Vesting contract for founder allocation
- Helius RPC integration
- **Deliverable:** Live protocol on mainnet, open-source repo

### Milestone 4 — Ecosystem Integration (Month 5–6)
- List SOLA on Jupiter aggregator
- Integrate with Raydium/Orca pools as bribe targets
- oSOLA distribution to early LPs
- Stable AMM curves (Phase 2 — correlated pairs)
- Community governance via hiSOLA
- **Deliverable:** 5+ external protocols using the bribe system

---

## 8. Team

**Founder / Lead Developer — Christophe Hertecant**
- Full-stack + Rust/Anchor development
- Built Soladrome from scratch: 18-instruction smart contract, test suite, 9-page frontend
- Solo founder — looking to expand team post-grant

*References and LinkedIn available on request.*

---

## 9. Traction & Validation

- ✅ Working protocol: 18 instructions, 8 account types, 11 passing end-to-end tests
- ✅ Fully tested on localnet (buy → stake → borrow → claim fees → bribe → vote → AMM swap)
- ✅ Frontend live at https://soladrome.finance (Devnet)
- ✅ AMM multi-pool live — permissionless pool creation, xy=k swaps, LP tokens
- ✅ Protocol fees distributed permissionlessly (2.42 USDC in localnet test)
- ✅ Inspired by Beradrome ($600k+ TVL on Berachain mainnet)
- ✅ Open source: https://github.com/OxToF/soladrome
- 🔄 Seeking first community members and testnet users

---

## 10. Long-Term Vision

Soladrome is not a memecoin launcher. It is **infrastructure**.

The bribe system creates a self-reinforcing flywheel:
```
More protocols bribe → More USDC rewards for hiSOLA holders
→ More SOLA bought → Deeper floor vault
→ More borrowing capacity → More protocol usage
→ AMM fees → market_vault → More incentive to hold hiSOLA
→ More voting power → More bribes
```

Long-term goal: become the **canonical liquidity layer** for the Solana DeFi ecosystem —  
the protocol that other protocols build on top of, not compete with.

**Roadmap beyond grant:**
- Phase 2: Stable AMM curves for correlated pairs (USDC/USDT, LSTs)
- Phase 3: Cross-program invocation hooks for external protocol integration
- Phase 4: DAO governance fully on-chain via hiSOLA

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
- **Twitter:** *(to be created)*
- **Discord:** *(to be created)*

---

*Application submitted by Christophe Hertecant — Solo founder, Soladrome Protocol.*  
*Contact: christophe.hertecant@gmail.com*
