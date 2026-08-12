# oSOLA emission calibration

Why `osola_emission_initial = 10_000` and `osola_emission_floor_bps = 5_000`
(`programs/soladrome/src/lib.rs`, written by `initialize`).

An auditor will ask where these numbers come from. They come from here. Run any script
with plain `python3`, no dependencies.

```bash
python3 scripts/emissions/01_apr_grid.py
```

## The model

An oSOLA is **an option, not a token**: burn 1 oSOLA + pay the 1 USDC floor → mint 1 SOLA.
Its intrinsic value is therefore `P − 1`, not `P`. Two consequences drive everything:

- At launch `P = 1` exactly (`INIT_VIRTUAL_USDC == INIT_VIRTUAL_SOLA`), so oSOLA is worth
  **zero** and no emission size produces any yield.
- `APR = annual_emission × (P − 1) / TVL`, with `P = (1 + U/N)²` and `N = 1_000_000`
  (`U` = cumulative USDC bought through the curve).

Comparing raw token counts against Beradrome is meaningless without that valuation — the
first pass of this analysis made exactly that mistake.

## Design intent

Emissions are a **support** yield for partner pools (LSTs, stablecoins), targeted at 1-2%.
The partner's real return comes from **bribes**. This protocol does not sell a 5 000% farm.

## The scripts

| Script | Question it answers |
|---|---|
| `01_apr_grid.py` | Static APR grid — what the config pays across TVL × price |
| `02_target_yield.py` | Inverse: what emission hits a target APR, plus the vote-power boost |
| `03_tvl_trajectory.py` | Dynamic: which decay policy holds 1-2% along a 10M→100M TVL path |
| `04_vote_cost.py` | Cost of the 30% vote cap, and where staking settles at equilibrium |

## Headline results

At the previous 800 000/epoch, a $10M TVL paid **163% APR** on a ×1.5 move and **1 303%**
at ×5 — only reasonable at $1B TVL. Note $414k of cumulative buys already doubles the price
at `N = 1M`.

Holding the 1-2% band over a growing TVL requires a **high floor**: with `floor_bps = 1_875`
the emission decays while TVL grows and the two compressions multiply (TVL ×10, emission
÷10 = APR ÷100). `floor_bps = 5_000` was the only setting that stayed in band across both
the conservative and base price scenarios.

## Known weakness

Cumulative curve buys `U` are modelled as a fixed fraction of TVL. That assumption drives
the result: between 1% and 10%, the optimal constant moves from 64 000 to 1 000 — a factor
of 64. Recalibrate against a real expectation of first-year buy volume when one exists.

`osola_emission_initial` is adjustable post-launch via `configure_emissions`; `k` is not.
Start low and raise — raising reads as a gift, cutting reads as a nerf.
