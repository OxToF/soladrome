#!/usr/bin/env python3
"""
Soladrome — ce que le staking total change reellement.

Faits releves dans le code :
  * decayed_emission(initial, decay, elapsed, floor) -> le POT ne depend PAS du staking.
  * VOTE_WEIGHT_CAP_BPS = 3_000 -> pouvoir hiSOLA d'UNE adresse plafonne a
    30% de protocol_state.total_hi_sola  (lib.rs:2074-2078)
  * ve_power = amount * (remaining / 208 epochs) * 4   -> jusqu'a x4 en lockant 4 ans
  * o_sola_bonus : ADDITIF et NON plafonne (bonus de burn, valable l'epoch courante)
"""
EPY = 365.25 / 7
CAP = 0.30          # VOTE_WEIGHT_CAP_BPS
MAX_MULT = 4        # MAX_VE_MULTIPLIER, lock 4 ans

EMISSION = 10_000   # oSOLA/epoch (recommandation en cours)


def fmt(x):
    for u, d in (("M", 1e6), ("k", 1e3)):
        if abs(x) >= d:
            return f"${x/d:.2f}{u}"
    return f"${x:,.0f}"


print("=" * 94)
print("1 — COUT POUR ATTEINDRE LE PLAFOND DE 30%, ET RENDEMENT DU CAPITAL DE VOTE")
print(f"    emission = {EMISSION:,}/epoch  ({EMISSION*EPY:,.0f} oSOLA/an)")
print("=" * 94)
print("  Lock 4 ans => x4 : il suffit de locker 30%/4 = 7,5% du total staked.\n")

for price in (2.0, 5.0):
    print(f"  --- prix SOLA = {price:.0f}x   (1 oSOLA = ${price-1:.0f}) ---")
    print(f"  {'total staked':>14} | {'SOLA a locker':>14} | {'capital':>10} | "
          f"{'emissions/an captees':>21} | {'ROI':>8}")
    print("  " + "-" * 88)
    for S in (250_000, 1_000_000, 5_000_000, 20_000_000):
        need = CAP * S / MAX_MULT           # SOLA a locker pour saturer le cap
        capital = need * price
        captured = CAP * EMISSION * EPY * (price - 1.0)
        roi = 100 * captured / capital
        print(f"  {S:>14,} | {need:>14,.0f} | {fmt(capital):>10} | "
              f"{fmt(captured):>21} | {roi:>7.1f}%")
    print()

print("=" * 94)
print("2 — LE PLAFOND N'EST PAS UNE PART DE VOTES : il depend de la participation")
print("=" * 94)
print("  part reelle = (30% x S) / (votes reellement exprimes)\n")
print(f"  {'participation':>14} | {'multipl. ve moyen':>18} | {'votes exprimes':>16} | {'part du LST':>12}")
print("  " + "-" * 74)
for turnout in (0.30, 0.50, 0.80, 1.00):
    for mult in (1.0, 2.0):
        cast = turnout * mult          # en unites de S
        share = min(CAP / cast, 1.0)
        print(f"  {turnout:>13.0%} | {mult:>17.1f}x | {cast:>15.2f}S | {share:>11.0%}")

print()
print("=" * 94)
print("3 — STAKING D'EQUILIBRE : ou le ROI du vote tombe au niveau d'un hurdle")
print("=" * 94)
print("  Le staking n'est pas un parametre choisi : il monte tant que voter rapporte.\n")
for price in (2.0, 5.0):
    captured = CAP * EMISSION * EPY * (price - 1.0)
    print(f"  prix {price:.0f}x  (emissions captees au plafond = {fmt(captured)}/an)")
    for hurdle in (0.30, 0.15, 0.08):
        # capital = 0.075*S*price ; ROI = captured/capital = hurdle
        S_eq = captured / (hurdle * (CAP / MAX_MULT) * price)
        print(f"     ROI cible {hurdle:>4.0%}  ->  total staked d'equilibre ~ {S_eq:>12,.0f} SOLA"
              f"   ({fmt(S_eq*price)} de capitalisation stakee)")
    print()
