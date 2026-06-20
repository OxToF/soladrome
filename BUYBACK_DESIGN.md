# Soladrome — Protocol Buyback Design
## "Burn the Supply, Strengthen the Floor"

> Inspired by HyperLiquid's fee-to-buyback model.  
> Status: **Design phase** — targeted for V2 post-mainnet.

---

## 1. Concept

HyperLiquid allocates 100 % of spot trading fees to buy back HYPE from the market.
Soladrome's variant: a configurable % of `market_vault` inflows is diverted to buy back
SOLA from the AMM and burn it.

**Net effects:**
- SOLA supply decreases → floor per remaining SOLA improves mechanically
- Permanent buy-side pressure on the AMM above floor
- Deflationary signal → aligns long-term holders and stakers
- Distinct advantage over HyperLiquid: Soladrome has a *hard* 1 USDC floor, so
  the buyback operates entirely in the "above floor" zone — no death spiral risk.

---

## 2. Economic Flow

```
market_vault inflows (AMM fees + borrow origination fees)
  │
  ├─ (100 - BUYBACK_SPLIT_BPS / 100) % → hiSOLA stakers  [existing claim_fees]
  │
  └─ BUYBACK_SPLIT_BPS %  → buyback_vault (new USDC token account)
                                │
                         execute_buyback (permissionless)
                                │
                         amm_swap: USDC → SOLA  (via existing AMM pool)
                                │
                         burn SOLA
                         total_sola          -= amount
                         total_purchased_sola -= amount  (was floor-backed)
                         floor_vault stays intact → floor per unit IMPROVES
```

**Default split:** `BUYBACK_SPLIT_BPS = 2_000` (20 % to buyback / 80 % to stakers).  
Adjustable by governance via `set_buyback_split`.

---

## 3. New Account: `BuybackState`

```rust
/// Singleton PDA controlling the buyback mechanism.
/// PDA: [b"buyback"]
#[account]
pub struct BuybackState {
    /// % of market_vault inflows diverted to buyback (in BPS, e.g. 2000 = 20%).
    pub split_bps:          u16,
    /// Lifetime USDC routed to buyback_vault.
    pub usdc_accumulated:   u64,
    /// Lifetime SOLA burned via buyback.
    pub sola_burned:        u64,
    /// AMM pool used for buyback swaps (must be SOLA/USDC pair).
    pub target_pool:        Pubkey,
    /// Minimum USDC threshold before execute_buyback can be called (anti-dust).
    pub min_trigger_amount: u64,
    pub bump:               u8,
}
impl BuybackState { pub const LEN: usize = 128; }
```

**PDA seed:** `[b"buyback"]`  
**USDC vault PDA seed:** `[b"buyback_vault"]`

---

## 4. New Instructions

### 4.1 `initialize_buyback`
- **Who:** authority only (one-time)
- **What:** creates `BuybackState` + `buyback_vault` token account
- **Params:** `split_bps: u16`, `target_pool: Pubkey`, `min_trigger_amount: u64`

### 4.2 `set_buyback_split` (governance)
- **Who:** authority (post-mainnet: DAO via hiSOLA vote)
- **What:** updates `split_bps` (0–5000 max, capped at 50 %)
- **Guard:** cannot set split that would reduce staker APR below a floor (e.g. min 50 % to stakers)

### 4.3 `route_to_buyback`
- **Who:** permissionless (anyone can call)
- **What:** reads `buyback_state.split_bps`, transfers the corresponding % from
  `market_vault` to `buyback_vault`
- **When:** called alongside or after `claim_fees` / any market_vault accumulation event
- **Note:** this is a *pull* model — no automatic hook needed, stays simple

### 4.4 `execute_buyback`
- **Who:** permissionless (anyone can trigger once threshold is met)
- **What:**
  1. Check `buyback_vault.amount >= buyback_state.min_trigger_amount`
  2. CPI into `amm_swap` with `buyback_vault` USDC → SOLA
  3. Burn all SOLA received
  4. Decrement `protocol_state.total_sola` and `total_purchased_sola`
  5. Update `buyback_state.usdc_accumulated` and `sola_burned`
- **Slippage guard:** `min_sola_out` param, caller sets acceptable slippage

---

## 5. Integration with Existing Code

### 5.1 `advance_accumulator` hook (optional, V2.1)
Currently `advance_accumulator` in `math.rs` snapshots the market_vault balance
and distributes fees to hiSOLA stakers.

Post-buyback: before distributing to stakers, deduct the buyback split:
```
effective_fees = new_market_vault_balance - last_snapshot
buyback_share  = effective_fees * split_bps / 10_000
staker_share   = effective_fees - buyback_share

// Transfer buyback_share to buyback_vault silently
// fees_per_hi_sola advances on staker_share only
```

This keeps the accumulator math exact and requires no UI changes for stakers.

### 5.2 `total_purchased_sola` after burn
When SOLA is burned via buyback:
```rust
protocol_state.total_sola            -= sola_burned;
protocol_state.total_purchased_sola  -= sola_burned;
```

The floor vault doesn't change, so `floor_vault / total_purchased_sola` ratio
**improves** after every buyback execution. This is the core deflationary mechanic.

---

## 6. Security Considerations

| Risk | Mitigation |
|---|---|
| Buyback drains market_vault, hurting staker APR | Hard cap: `split_bps ≤ 5_000` (50 %) |
| `execute_buyback` called with bad slippage → MEV sandwich | Caller sets `min_sola_out`; failed txs revert cleanly |
| `target_pool` set to a malicious pool | `execute_buyback` validates pool is a SOLA/USDC pair (existing `InvalidArbPool` check) |
| `route_to_buyback` spam (dust attacks) | `min_trigger_amount` prevents micro-executions |
| Governance changes `split_bps` to 100 % | Hard cap + time-lock on governance changes |

---

## 7. On-Chain Analytics

The `BuybackState` account provides on-chain transparency:
- `usdc_accumulated`: total USDC spent buying back SOLA (lifetime)
- `sola_burned`: total SOLA removed from supply (lifetime)
- Implied: effective buyback price = `usdc_accumulated / sola_burned`

These values can be displayed in the frontend Stats component.

---

## 8. Implementation Checklist

### Pre-implementation (design validation)
- [ ] Council review of split_bps default (20 %)
- [ ] Confirm `min_trigger_amount` (suggest 1_000_000 = 1 USDC for devnet, 100_000_000 = 100 USDC for mainnet)
- [ ] Decide: automatic hook in `advance_accumulator` vs manual `route_to_buyback` call

### Implementation (V2 sprint)
- [ ] Add `BuybackState` to `state.rs`
- [ ] Add `buyback_vault` PDA token account seed to CLAUDE.md
- [ ] Implement `initialize_buyback` + context
- [ ] Implement `set_buyback_split` + context
- [ ] Implement `route_to_buyback` + context
- [ ] Implement `execute_buyback` + context (reuses AMM swap CPI)
- [ ] Update `advance_accumulator` to split fees automatically (V2.1)
- [ ] Add buyback stats to `Stats.tsx` frontend component
- [ ] Add `BuybackState` to GRANT_APPLICATION.md V2 roadmap

### Testing
- [ ] Unit test: route_to_buyback splits correctly at 20 %
- [ ] Unit test: execute_buyback burns SOLA, decrements total_purchased_sola
- [ ] Unit test: floor_vault unchanged after buyback → floor per unit improves
- [ ] Fuzz: large buybacks don't break floor invariant

---

## 9. Communication Angle

> *"Every swap fee, every borrow fee — 20% goes to permanently remove SOLA from
> existence. The protocol buys back its own token. Forever."*

This is the HyperLiquid narrative adapted to a floor-guaranteed asset.
Competitors (Velodrome, Beradrome) distribute 100% to stakers.
Soladrome routes 20% to make the remaining supply more valuable for everyone.

**Tagline for marketing:** *"Soladrome burns the supply. HyperLiquid burns the fees."*

---

*Design authored by Soladrome Labs — Soladrome Protocol.*  
*Targeted implementation: V2, post-mainnet audit.*
