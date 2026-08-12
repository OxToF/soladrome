#!/usr/bin/env python3
"""
Soladrome — rendement des emissions oSOLA en fonction de la TVL.

Modele
------
Emission par epoch (7 j) : E_n = max(INITIAL * 0.99^n, 0.10 * INITIAL)
Valeur d'un oSOLA        : P_SOLA - 1  (option, strike = floor = 1 USDC)
Prix SOLA sur la courbe  : P = (1 + U/N)^2   avec N = 1_000_000 (INIT_VIRTUAL_*)
                           => U = N * (sqrt(P) - 1)  USDC d'achats cumules requis
APR emissions            = (oSOLA emis sur 12 mois * (P - 1)) / TVL

Hypothese : toute la TVL est dans des pools jaugees. Sinon l'APR de la partie
jaugee est mecaniquement plus elevee (diviser par la fraction jaugee).
"""
import math

INITIAL_DEFAULT = 800_000      # oSOLA par epoch, valeur actuelle on-chain
DECAY = 0.99
FLOOR_FRAC = 0.10
EPOCHS_PER_YEAR = 365.25 / 7   # 52.18
N = 1_000_000                  # profondeur de courbe (USDC virtuels)


def emissions_year(initial, year=1):
    """oSOLA emis pendant l'annee `year` (1 = les 52 premiers epochs)."""
    start = int(EPOCHS_PER_YEAR * (year - 1))
    end = int(EPOCHS_PER_YEAR * year)
    floor = FLOOR_FRAC * initial
    return sum(max(initial * DECAY**n, floor) for n in range(start, end))


def usdc_required(price):
    """Achats cumules sur la courbe pour atteindre ce prix."""
    return N * (math.sqrt(price) - 1)


def apr(initial, tvl, price, year=1):
    """APR en POURCENT (pas en ratio)."""
    value_per_osola = price - 1.0
    return 100.0 * emissions_year(initial, year) * value_per_osola / tvl


def fmt_pct(x):
    if x >= 100:
        return f"{x:,.0f}%"
    if x >= 10:
        return f"{x:.1f}%"
    return f"{x:.2f}%"


def fmt_usd(x):
    for unit, div in (("B", 1e9), ("M", 1e6), ("k", 1e3)):
        if abs(x) >= div:
            return f"${x/div:.3g}{unit}"
    return f"${x:.0f}"


TVLS = [10e6, 100e6, 1e9]
PRICES = [1.10, 1.25, 1.50, 2.0, 3.0, 5.0, 10.0]

print("=" * 78)
print("CONTEXTE — ce qu'il faut acheter sur la courbe pour atteindre un prix")
print("=" * 78)
print(f"{'prix SOLA':>10} | {'USDC cumules achetes':>22} | {'valeur 1 oSOLA':>15}")
print("-" * 78)
for p in PRICES:
    print(f"{p:>9.2f}x | {fmt_usd(usdc_required(p)):>22} | {fmt_usd(p-1):>15}")

y1 = emissions_year(INITIAL_DEFAULT, 1)
print()
print("=" * 78)
print(f"TABLE 1 — APR emissions, ANNEE 1, config actuelle ({INITIAL_DEFAULT:,}/epoch)")
print(f"          soit {y1/1e6:.1f}M oSOLA emis sur 12 mois")
print("=" * 78)
head = f"{'prix SOLA':>10} |" + "".join(f"{'TVL '+fmt_usd(t):>14}|" for t in TVLS)
print(head)
print("-" * len(head))
for p in PRICES:
    row = f"{p:>9.2f}x |"
    for tvl in TVLS:
        row += f"{fmt_pct(apr(INITIAL_DEFAULT, tvl, p)):>14}|"
    print(row)

print()
print("=" * 78)
print("TABLE 2 — regime de croisiere (plancher atteint, 80k/epoch = 4.17M/an)")
print("=" * 78)
floor_year = FLOOR_FRAC * INITIAL_DEFAULT * EPOCHS_PER_YEAR
print(head)
print("-" * len(head))
for p in PRICES:
    row = f"{p:>9.2f}x |"
    for tvl in TVLS:
        row += f"{fmt_pct(100.0*floor_year*(p-1)/tvl):>14}|"
    print(row)

print()
print("=" * 78)
print("TABLE 3 — INVERSE : quel osola_emission_initial pour viser 8% d'APR ?")
print("         (emission de soutien ; le gros du yield vient des bribes)")
print("=" * 78)
TARGET = 0.08
# APR = emissions_year(I) * (P-1) / TVL, et emissions_year est lineaire en I
unit_year = emissions_year(1.0, 1)  # facteur annuel pour initial = 1
print(head)
print("-" * len(head))
for p in PRICES:
    row = f"{p:>9.2f}x |"
    for tvl in TVLS:
        need = TARGET * tvl / ((p - 1) * unit_year)
        row += f"{need:>13,.0f}|"
    print(row)
print()
print(f"(valeur actuelle : {INITIAL_DEFAULT:,} / epoch — a comparer ligne par ligne)")
