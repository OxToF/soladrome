"""Founder 5M oSOLA: 12-month cliff, 48 vs 96 months in all. Model of curve.rs / math.rs.

Curve: k = N^2, N = 1M. Buy: 1 % fee to stakers, net through the curve; floor gets 1/SOLA,
market_reserve gets the premium. Sell: back down the curve, floor pays 1/SOLA, reserve pays the
premium, minus 1 % capped at the premium. Exercise: 1 USDC strike (to floor) + 10 % of the gain
at the curve price; does NOT move the curve.

Buyers: a steady $B a month, never sell (worst case for them: they hold the premium the founder
can take). Emissions and other oSOLA ignored: this isolates the founder tranche.

Founder, rational: each month, exercises and sells exactly as much as is profitable, i.e. down
to the price where the next SOLA sold no longer pays strike + fee. Unexercised vested oSOLA is
kept for later (a bank). Exercise and sale are in different slots, so the fee is priced on the
pre-sale price.
"""
N = 1_000_000.0
K = N * N
FEE = 0.01
EX_FEE = 0.10
TOTAL = 5_000_000.0
CLIFF = 12


def vested(m, total_months):
    if m < CLIFF:
        return 0.0
    return TOTAL * min(m, total_months) / total_months


def run(B, total_months, months=96, founder=True, cap=None):
    vu = vs = N
    reserve = 0.0
    bank = 0.0          # vested, not yet exercised
    claimed = 0.0
    gain = 0.0          # founder net USDC above strike + fee
    premium_in = 0.0    # every premium buyers paid
    p13 = None
    prices = []
    for m in range(1, months + 1):
        # buyers, in 4 weekly chunks
        for _ in range(4):
            net = B / 4 * (1 - FEE)
            new_vu = vu + net
            new_vs = K / new_vu
            out = vs - new_vs
            prem = net - out
            reserve += prem
            premium_in += prem
            vu, vs = new_vu, new_vs
        if founder:
            v = vested(m, total_months)
            if cap is not None:
                v = max(claimed, min(v, cap * (N - vs)))
            bank += v - claimed
            claimed = v
            p0 = vu / vs
            cost = 1 + EX_FEE * (p0 - 1)            # per SOLA: strike + fee
            # sell down until marginal price (vu/vs) * (1 - FEE) == cost
            target = cost / (1 - FEE)
            if p0 > target and bank > 0:
                # price = vu/vs = K/vs^2 -> vs_target = sqrt(K/target)
                vs_t = (K / target) ** 0.5
                x = min(bank, vs_t - vs)
                new_vs = vs + x
                new_vu = K / new_vs
                proceeds = vu - new_vu            # curve proceeds
                prem = proceeds - x               # from the reserve
                fee = min(FEE * proceeds, prem)
                reserve -= prem                   # prem includes the fee leaving the reserve
                gain += (proceeds - fee) - x * cost
                bank -= x
                vu, vs = new_vu, new_vs
        p = vu / vs
        prices.append(p)
        if m == 13:
            p13 = p
    return dict(gain=gain, premium_in=premium_in, reserve=reserve, bank=bank,
                p12=prices[11], p13=p13, p24=prices[23], p48=prices[47], p96=prices[-1])


print(f"{'achats/mois':>12} {'durée':>6} | {'prix m12':>8} {'m13':>6} {'m24':>6} {'m48':>6} {'m96':>6} | {'gain founder':>12} {'% prime prise':>13} | {'banque fin':>10}")
import sys
for B in ([int(a) for a in sys.argv[1:]] or (10_000, 50_000, 100_000, 200_000, 500_000)):
    base = run(B, 48, founder=False)
    print(f"{B:>12,} {'aucun':>6} | {base['p12']:8.3f} {base['p13']:6.3f} {base['p24']:6.3f} {base['p48']:6.3f} {base['p96']:6.3f} |")
    for T, cap, lab in ((48, None, "48m"), (48, 0.05, "48+5%"), (48, 0.10, "48+10%"), (48, 0.20, "48+20%")):
        r = run(B, T, cap=cap)
        taken = 1 - r['reserve'] / r['premium_in']
        print(f"{'':>12} {lab:>6} | {r['p12']:8.3f} {r['p13']:6.3f} {r['p24']:6.3f} {r['p48']:6.3f} {r['p96']:6.3f} | {r['gain']:>12,.0f} {taken:>12.0%} | {r['bank']:>10,.0f}")
