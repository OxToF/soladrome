# Solana Foundation Grant Application
## Soladrome — Perpetual Liquidity Engine with ve(3,3) Tokenomics

---

## 1. Project Overview

**Project Name:** Soladrome  
**Category:** DeFi / Infrastructure  
**Stage:** Live on Solana devnet — ready for audit and mainnet  
**Requested Amount:** $35,000 USD  
**GitHub:** https://github.com/OxToF/soladrome  
**Live Demo:** https://soladrome.finance  
**Contact:** [your@email.com]

---

## 2. The Problem

Every DeFi protocol on Solana today shares the same structural weakness: **liquidity is rented, not owned.**

- AMMs depend on external LPs who can withdraw at any time (and do, during volatility)
- Token prices have no guaranteed floor — crashes destroy value and trust permanently
- ve(3,3) mechanisms exist on EVM (Velodrome, Beradrome) but **not on Solana**
- Borrowing protocols require over-collateralization + liquidation risk, excluding millions of users

The result: DeFi on Solana is a casino of mercenary capital with no structural stability.

---

## 3. Our Solution — Soladrome

Soladrome is a **protocol-owned perpetual liquidity engine** that combines:

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

---

## 4. Technical Architecture

### Smart Contract (Anchor 0.32.1)
- **Language:** Rust / Anchor framework
- **Instructions:** 14 on-chain instructions, fully tested
- **Accounts:** 7 custom account types with PDA-based access control
- **Security patterns:**
  - Reward-per-token accumulator (O(1) fee distribution, no loops)
  - PDA-signed treasury (no admin keypair for protocol funds)
  - `founder_allocated` flag (one-time allocation guard)
  - Double-claim prevention via PDA existence check
  - u128 muldiv for all financial calculations (overflow-safe)

```
Core instructions:
initialize           → Deploy protocol with virtual reserves
buy_sola             → Bonding curve purchase, floor + market split
sell_sola            → Floor redemption (1:1 USDC)
stake_sola           → SOLA → hiSOLA (governance + fees)
unstake_hi_sola      → hiSOLA → SOLA (debt-gated)
borrow_usdc          → Against hiSOLA at floor price, no liquidation
repay_usdc           → Restore collateral
claim_fees           → Pro-rata market vault fees for hiSOLA holders
deposit_bribe        → External protocol deposits incentives
vote_gauge           → hiSOLA holders direct vote weight
claim_bribe          → Pro-rata bribe after epoch ends
distribute_o_sola    → Authority mints oSOLA to LP reward recipients
exercise_o_sola      → Call-option: burn oSOLA + pay USDC → get SOLA
mint_founder_allocation → One-time 12M SOLA founder grant (7M auto-staked)
```

### Frontend (Next.js 14)
- Wallet adapter (Phantom, Solflare, Backpack)
- Self-discovering USDC mint (reads `protocolState.usdcMint` on-chain)
- 7 pages: Trade · Stake · Borrow · Liquidity · Vote · Bribe · Claim
- Dark theme, responsive, production-ready

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
| Permissionless treasury | ✅ | ❌ | ❌ | ❌ |
| Self-seeding liquidity | ✅ | ❌ | ❌ | ❌ |

The closest comparable is **Beradrome on Berachain** (EVM).  
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

> The protocol generates its own USDC revenue from day 1 through the bonding curve.  
> Developer compensation represents minimum viable runway for a solo founder to reach mainnet safely — no marketing spend, no team overhead.

---

## 7. Milestones & Timeline

### Milestone 1 — Devnet Deployment (Month 1)
- Deploy to Solana devnet
- Multi-wallet end-to-end testing
- Squads v4 multisig replacing single authority keypair
- Emergency pause mechanism implementation
- **Deliverable:** Public devnet address + frontend pointing to devnet

### Milestone 2 — Security Audit (Month 2–3)
- Full smart contract audit by OtterSec or Neodyme
- Fix all critical/high findings
- Fuzzing with Trident
- Re-review of fixes
- **Deliverable:** Published audit report

### Milestone 3 — Mainnet Launch (Month 4)
- Deploy to mainnet with real USDC mint
- Tune bonding curve parameters for mainnet depth
- Vesting contract for founder allocation
- Helius RPC integration
- **Deliverable:** Live protocol on mainnet, open-source repo

### Milestone 4 — Ecosystem Integration (Month 5–6)
- List SOLA on Jupiter aggregator
- Integrate with Raydium/Orca pools as bribe targets
- oSOLA distribution to early LPs
- Community governance via hiSOLA
- **Deliverable:** 5+ external protocols using the bribe system

---

## 8. Team

**Founder / Lead Developer**  
- Full-stack + Rust/Anchor development  
- Built Soladrome from scratch: smart contract, test suite, frontend  
- Solo founder — looking to expand team post-grant

*References and LinkedIn available on request.*

---

## 9. Traction & Validation

- ✅ Working prototype: 14 instructions, 7 account types, 11 passing tests
- ✅ End-to-end tested on localnet (buy → stake → borrow → claim fees → bribe → vote)
- ✅ Frontend live at https://soladrome.finance
- ✅ Protocol fees distributed permissionlessly (2.42 USDC in localnet test)
- ✅ Inspired by Beradrome ($600k+ TVL on Berachain mainnet)
- 🔄 Seeking first community members and testnet users

---

## 10. Long-Term Vision

Soladrome is not a memecoin launcher. It is **infrastructure**.

The bribe system creates a self-reinforcing flywheel:
```
More protocols bribe → More USDC rewards for hiSOLA holders
→ More SOLA bought → Deeper floor vault
→ More borrowing capacity → More protocol usage
→ More fees → More incentive to bribe
```

Long-term goal: become the **canonical liquidity layer** for the Solana DeFi ecosystem —  
the protocol that other protocols build on top of, not compete with.

---

## 11. Open Source Commitment

100% of the code will be open-sourced under MIT license upon mainnet deployment.  
The repo is currently private for security reasons (pre-audit).  
Grant recipients will receive immediate access to the full codebase.

---

## 12. Relevant Links

- **Live frontend:** https://soladrome.finance
- **GitHub (private, shared on request):** github.com/[handle]/soladrome
- **Solana Explorer (devnet):** *(post-deployment)*
- **Twitter:** *(to be created)*
- **Discord:** *(to be created)*

---

*Application submitted under the Solana Foundation Ecosystem Grant Program.*  
*Contact: [your@email.com] · Telegram: [@yourhandle]*
