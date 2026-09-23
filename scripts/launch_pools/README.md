# Launch pools — which markets may exist on day one

**Decided 2026-09-23: C1.** oSOLA/USDC + SOL/USDC + LST/SOL (jitoSOL, mSOL, …) pools.
**No pool that holds SOLA**, in any pairing.

This supersedes the 2026-07 line "oSOLA: no LP, exercise-only". What changed is the second
farming strategy — compounding LP rewards into more LP — which needs oSOLA to have a cash
exit. Without one an oSOLA is worth nothing in cash (the only exit for SOLA is the 1 USDC
floor, so exercising to sell nets minus the fee), and the strategy cannot exist at all.

Run with plain `python3`, no dependencies:

```bash
python3 scripts/launch_pools/01_osola_vs_sola_markets.py   # C0 / C1 / C2
python3 scripts/launch_pools/02_sola_osola_pool.py         # C1 vs C1 + SOLA/oSOLA
```

## The model

Agent-based, 78 epochs, 30–40 seeds per scenario. Mechanics are the program's: curve
`INIT 1M/1M`, 1:1 floor, exercise fee 10 % of the gain, xy=k pools at 0.30 %, emissions
20k oSOLA/epoch decaying 1 %/epoch, 875k oSOLA airdrop, founder 5M oSOLA (25 % at the
26-epoch cliff, then linear). SOL at ~72 % annualised volatility.

⚠️ **Demand for SOLA is exogenous and price-insensitive.** That inflates C0, where the whole
demand goes through the curve and pushes it to absurd prices. The *mechanisms* below are
robust; the absolute dollar figures are not. Compare configurations, do not quote amounts.

## Results — base demand 50k USDC/epoch, founder does not sell (medians)

| | C0 no market | **C1** | C2 + SOLA/jitoSOL + SOLA/fBOMB |
|---|---|---|---|
| Demand served by the curve | 100 % | 25 % | 11 % |
| $ per oSOLA for LP compounding | impossible | 1.04 | 1.75 |
| SOLA pool price vs curve | — | — | −11 % |
| SOLA redeemed at the floor | 0 | 0 | 439k |
| oSOLA exercised then sold | 0 | 0 | 1.73M |
| oSOLA/USDC LP vs hold | — | −45 % | −44 % |
| SOLA/fBOMB LP vs hold | — | — | −53 % |

C1 + SOLA/oSOLA (script 02, with unstakers exiting 1 %/epoch): staker revenue −48 % vs C1,
oSOLA price 3.40 → 0.93, $ per compounded oSOLA 0.93 → 0.50, SOLA/oSOLA LP −20 % vs hold.

## What the numbers say

- **Every SOLA market, whatever it is paired with, recycles supply and competes with the
  curve.** SOLA/oSOLA is a SOLA/USDC pool in two hops. Only oSOLA can have a market without
  breaking this, because exercise is one-way: oSOLA → SOLA exists, SOLA → oSOLA does not.
- **SOLA/oSOLA is not low-IL.** The two move together in direction, not in ratio: oSOLA is
  worth about `P − 1`, a leveraged SOLA. From P = 1.5 to 1.1 the ratio moves ×4 and a
  SOLA/oSOLA LP loses 17.9 % where SOLA/USDC loses 1.2 %. It becomes low-IL only above P ≈ 3.
- **The exercise fee is the dial between LPs and stakers.** C1 at base demand: 10 % → 0.91 M$
  to stakers / 1.04 $ per oSOLA; 30 % → 1.26 M$ / 0.70 $; 50 % → 1.51 M$ / 0.42 $.

## Conditions attached to C1

1. **The oSOLA/USDC pool needs protocol-owned liquidity.** Its LP loses 45–72 % against
   holding in every scenario — an option token that trends is textbook impermanent loss, and
   nobody provides it voluntarily. The ecosystem oSOLA budget can fund the oSOLA side.
2. **The founder's 5M oSOLA is the dominant variable.** In C1 it becomes liquid at the cliff;
   selling half of it drops the curve's share of demand from 25 % to 1 %.
3. **With weak demand (15k/epoch) LP compounding yields ~0.04 $ per oSOLA.** The strategy is
   only as good as the demand for SOLA behind it.
