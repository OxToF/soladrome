#!/usr/bin/env python3
"""
Soladrome — calibrer l'emission pour un yield de SOUTIEN de 1-2%,
les LST boostant ensuite via voting power.

APR_emissions = emission_annuelle * (P - 1) / TVL
"""
import math

DECAY = 0.99
FLOOR_FRAC = 0.10
EPOCHS_PER_YEAR = 365.25 / 7
N = 1_000_000


def year1_factor():
    """oSOLA emis en annee 1 pour initial = 1/epoch."""
    return sum(max(DECAY**n, FLOOR_FRAC) for n in range(int(EPOCHS_PER_YEAR)))


F = year1_factor()


def need(target_pct, tvl, price):
    """emission/epoch requise pour atteindre target_pct d'APR."""
    if price <= 1.0:
        return float("inf")
    return (target_pct / 100.0) * tvl / ((price - 1.0) * F)


def apr(initial, tvl, price):
    return 100.0 * initial * F * (price - 1.0) / tvl


def fmt(x):
    if x == float("inf"):
        return "impossible"
    if x >= 1e6:
        return f"{x/1e6:.1f}M"
    return f"{x:,.0f}"


def fpct(x):
    if x >= 100:
        return f"{x:,.0f}%"
    if x >= 10:
        return f"{x:.1f}%"
    return f"{x:.2f}%"


TVLS = [10e6, 50e6, 100e6, 500e6]
PRICES = [1.02, 1.10, 1.25, 1.50, 2.0, 3.0, 5.0]

print("=" * 86)
print("A — Emission/epoch requise pour 1,5% d'APR de soutien")
print("=" * 86)
h = f"{'prix':>7} |" + "".join(f"{'TVL $'+str(int(t/1e6))+'M':>14}|" for t in TVLS)
print(h); print("-" * len(h))
for p in PRICES:
    print(f"{p:>6.2f}x |" + "".join(f"{fmt(need(1.5,t,p)):>14}|" for t in TVLS))

print()
print("=" * 86)
print("B — Si on FIGE l'emission a 50 000/epoch : APR reellement obtenu")
print("=" * 86)
print(h); print("-" * len(h))
for p in PRICES:
    print(f"{p:>6.2f}x |" + "".join(f"{fpct(apr(50_000,t,p)):>14}|" for t in TVLS))

print()
print("=" * 86)
print("C — Meme exercice a 150 000/epoch")
print("=" * 86)
print(h); print("-" * len(h))
for p in PRICES:
    print(f"{p:>6.2f}x |" + "".join(f"{fpct(apr(150_000,t,p)):>14}|" for t in TVLS))

print()
print("=" * 86)
print("D — LE BOOST : multiplicateur = part des votes / part de la TVL")
print("=" * 86)
print("Un pool touche  emission x (ses votes / total votes).")
print("Son APR = APR_base x (part_votes / part_TVL).\n")
base = 1.5
print(f"{'part TVL':>9} | {'part votes':>10} | {'multipl.':>9} | {'APR emissions':>14} | {'+ LST 5,5% =':>13}")
print("-" * 70)
for tvl_share, vote_share in [(0.20,0.20),(0.20,0.35),(0.20,0.50),(0.20,0.70),
                              (0.10,0.30),(0.10,0.50),(0.30,0.60)]:
    m = vote_share / tvl_share
    a = base * m
    print(f"{tvl_share:>8.0%} | {vote_share:>10.0%} | {m:>8.1f}x | {a:>13.2f}% | {5.5+a:>12.2f}%")

print()
print("=" * 86)
print("E — Cout d'entree : $ d'achats sur la courbe pour chaque prix")
print("=" * 86)
for p in PRICES:
    u = N * (math.sqrt(p) - 1)
    print(f"  {p:>5.2f}x  ->  ${u:>12,.0f} achetes    (1 oSOLA = ${p-1:.2f})")
