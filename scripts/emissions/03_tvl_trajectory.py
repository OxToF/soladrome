#!/usr/bin/env python3
"""
Soladrome — quelle politique d'emission tient la bande 1-2% sur une trajectoire reelle ?

Trajectoire : TVL 10M -> 100M sur 3 ans (croissance geometrique), puis plateau.
Prix        : pilote par les achats cumules sur la courbe U, modelises comme une
              fraction de la TVL (le parametre le plus incertain -> 3 scenarios).
              P = (1 + U/N)^2  avec N = 1_000_000
APR(t)      = E(t) * epochs_par_an * (P(t) - 1) / TVL(t)
"""
import math

N = 1_000_000
EPY = 365.25 / 7
HORIZON = int(EPY * 6)          # 6 ans
T_GROWTH = int(EPY * 3)         # croissance sur 3 ans
TVL0, TVL1 = 10e6, 100e6


def tvl(t):
    if t >= T_GROWTH:
        return TVL1
    return TVL0 * (TVL1 / TVL0) ** (t / T_GROWTH)


def price(t, frac):
    return (1.0 + frac * tvl(t) / N) ** 2


def emission(t, initial, decay_bps, floor_bps):
    if decay_bps >= 10_000:
        return initial
    d = (decay_bps / 10_000.0) ** t
    return max(initial * d, initial * floor_bps / 10_000.0)


def apr(t, initial, decay_bps, floor_bps, frac):
    p = price(t, frac)
    if p <= 1.0:
        return 0.0
    return 100.0 * emission(t, initial, decay_bps, floor_bps) * EPY * (p - 1.0) / tvl(t)


POLICIES = [
    ("A  actuel   800k, -1%/ep, floor 10%", 800_000, 9_900, 1_000),
    ("B  50k,      -1%/ep, floor 10%",       50_000, 9_900, 1_000),
    ("C  50k,      PAS de decay",            50_000, 10_000, 1_000),
    ("D  50k,      -1%/ep, floor 50%",       50_000, 9_900, 5_000),
]
SCEN = [("prudent  U=1% TVL", 0.01), ("base     U=3% TVL", 0.03), ("bull     U=10% TVL", 0.10)]
MARKS = [0, int(EPY), int(EPY*2), int(EPY*3), int(EPY*4), int(EPY*6)-1]

for name, frac in SCEN:
    print("=" * 92)
    print(f"SCENARIO {name}")
    print("=" * 92)
    print(f"  {'':38}" + "".join(f"{'an '+str(round(m/EPY)):>9}" for m in MARKS))
    print(f"  {'TVL':38}" + "".join(f"{tvl(m)/1e6:>8.0f}M" for m in MARKS))
    print(f"  {'prix SOLA':38}" + "".join(f"{price(m,frac):>8.1f}x" for m in MARKS))
    print(f"  {'valeur 1 oSOLA':38}" + "".join(f"{price(m,frac)-1:>8.2f}$" for m in MARKS))
    print("  " + "-" * 88)
    for pname, init, dec, flo in POLICIES:
        row = f"  {pname:38}"
        for m in MARKS:
            a = apr(m, init, dec, flo, frac)
            row += f"{a:>8.2f}%" if a < 1000 else f"{a/1000:>7.1f}k%"
        print(row)
    print()

print("=" * 92)
print("COMBIEN D'EPOCHS DANS LA BANDE 1-2% (sur 6 ans = 313 epochs)")
print("=" * 92)
hdr = f"  {'politique':38}" + "".join(f"{s[0].split()[0]:>12}" for s in SCEN)
print(hdr); print("  " + "-" * 88)
for pname, init, dec, flo in POLICIES:
    row = f"  {pname:38}"
    for _, frac in SCEN:
        n = sum(1 for t in range(HORIZON) if 1.0 <= apr(t, init, dec, flo, frac) <= 2.0)
        row += f"{n:>7} ep {100*n/HORIZON:>3.0f}%"
    print(row)

print()
print("=" * 92)
print("CONSTANTE OPTIMALE — celle qui maximise le temps passe dans 1-2%")
print("=" * 92)
for pname, _, dec, flo in POLICIES[1:]:
    label = pname.split(",", 1)[1].strip()
    print(f"\n  Politique : {label}")
    for sname, frac in SCEN:
        best, bestn = None, -1
        for I in range(1_000, 400_001, 1_000):
            n = sum(1 for t in range(HORIZON) if 1.0 <= apr(t, I, dec, flo, frac) <= 2.0)
            if n > bestn:
                best, bestn = I, n
        print(f"    {sname:22} -> {best:>7,}/epoch   ({bestn} ep = {100*bestn/HORIZON:.0f}% du temps)")
