"""
Launch pool configurations, simulated. Pure python, no dependencies.

  C1 : oSOLA/USDC + SOL/USDC + LST/SOL pools            — no SOLA market
  C2 : C1 + SOLA/jitoSOL + SOLA/fBOMB                     — SOLA markets
  C0 : neither (the plan before 2026-09-23), for reference

Mechanics taken from the program, not assumed:
  · curve: constant product on virtual reserves, INIT 1M/1M, price = vu/vs; only buys move it
  · buy_sola: 1 USDC per SOLA to the floor, the premium to market_vault (stakers)
  · exercise: burn oSOLA + 1 USDC to the floor + fee = 10% x (P_curve - 1) to market_vault
  · sell_sola: 1 USDC per SOLA from the floor, never touches the curve
  · pools: xy=k, 0.30% fee, 20% of it to the protocol
  · emissions: 20k oSOLA/epoch, -1%/epoch ; founder 5M oSOLA: 25% at the 26-epoch cliff, then linear
  · airdrop: 875k oSOLA (half the ecosystem budget) at epoch 4
"""
import math, random, statistics as st, sys

FEE = 0.003
PROTO = 0.20
EX_BPS = 0.10
EPOCHS = 78
SUB = 12


class Pool:
    def __init__(s, x, y):  # x = base token, y = quote token (quote in its own units)
        s.x, s.y = x, y
    def price(s):
        return s.y / s.x
    def sell_base(s, dx):   # base in, quote out
        net = dx * (1 - FEE)
        dy = s.y * net / (s.x + net)
        s.x += net + dx * FEE * (1 - PROTO)
        s.y -= dy
        return dy, dx * FEE * PROTO  # quote out, protocol fee in base units
    def buy_base(s, dy):    # quote in, base out
        net = dy * (1 - FEE)
        dx = s.x * net / (s.y + net)
        s.y += net + dy * FEE * (1 - PROTO)
        s.x -= dx
        return dx, dy * FEE * PROTO


class World:
    def __init__(s, cfg, demand, founder_sell, rng, raise0=250_000):
        s.cfg, s.rng, s.demand0, s.founder_sell = cfg, rng, demand, founder_sell
        k = 1e12
        s.vu = 1e6 + raise0
        s.vs = k / s.vu
        s.k = k
        s.floor = 1e6 * 0 + (1e6 - s.vs)  # SOLA sold by the launch raise, 1 USDC each
        s.purchased = 1e6 - s.vs
        s.rev = {"curve": raise0 - s.purchased, "exercise": 0.0, "swap": 0.0}
        s.sol, s.fbomb = 150.0, 0.02
        pc = s.pc()
        po = 0.6 * (pc - 1) * (1 - EX_BPS)
        s.opool = Pool(50_000 / po, 50_000)               # oSOLA / USDC, 50k a side
        s.open0 = (s.opool.x, s.opool.y)
        if cfg == 2:
            s.jpool = Pool(100_000 / pc, 100_000 / (s.sol * 1.1))  # SOLA / jitoSOL
            s.fpool = Pool(25_000 / pc, 25_000 / s.fbomb)          # SOLA / fBOMB
            s.j0 = (s.jpool.x, s.jpool.y, s.sol)
            s.f0 = (s.fpool.x, s.fpool.y, s.fbomb)
        s.inv = {"s2": 0.0, "dump": 0.0, "founder": 0.0, "air": 0.0}
        s.stats = dict(buyer_usdc=0, buyer_curve=0, s2_sold=0, s2_usd=0, flash=0,
                       floor_out=0, gap=[], po=[], ps=[], pc=[])

    # ── prices ──
    def pc(s):
        return s.vu / s.vs
    def exfee(s):
        return EX_BPS * max(s.pc() - 1, 0)
    def jito(s):
        return s.sol * 1.1
    def sola_pools(s):
        if s.cfg != 2:
            return []
        return [(s.jpool, s.jito), (s.fpool, lambda: s.fbomb)]

    # ── primitives ──
    def curve_buy(s, usdc):
        nvu = s.vu + usdc
        out = s.vs - s.k / nvu
        s.vu, s.vs = nvu, s.k / nvu
        s.floor += out
        s.purchased += out
        s.rev["curve"] += usdc - out
        return out
    def exercise(s, n):
        f = s.exfee() * n
        s.floor += n
        s.purchased += n
        s.rev["exercise"] += f
        return n + f  # USDC cost
    def sell_floor(s, n):
        s.floor -= n
        s.purchased -= n
        s.stats["floor_out"] += n

    # ── routing: one chunk of USDC from a buyer who wants SOLA to stake ──
    def buy_sola_chunk(s, usdc):
        opts = [("curve", s.pc())]
        po_ask = s.opool.price() / (1 - FEE)
        if s.cfg != 0:
            opts.append(("opt", po_ask + 1 + s.exfee()))
        for i, (p, q) in enumerate(s.sola_pools()):
            opts.append((i, p.price() * q() / (1 - FEE)))
        route = min(opts, key=lambda o: o[1])[0]
        s.stats["buyer_usdc"] += usdc
        if route == "curve":
            s.stats["buyer_curve"] += usdc
            s.curve_buy(usdc)
        elif route == "opt":
            per = po_ask + 1 + s.exfee()
            n_guess = usdc / per
            spend = n_guess * po_ask
            n, pf = s.opool.buy_base(spend)
            s.rev["swap"] += pf
            s.exercise(n)
        else:
            p, q = s.sola_pools()[route]
            out, pf = p.buy_base(usdc / q())
            s.rev["swap"] += pf * q()

    # ── routing: sell one chunk of oSOLA for the best USD, or keep it ──
    def sell_osola_chunk(s, n, who):
        best = ("opool", s.opool.price() * (1 - FEE)) if s.cfg != 0 else ("none", 0.0)
        for i, (p, q) in enumerate(s.sola_pools()):
            v = p.price() * q() * (1 - FEE) - 1 - s.exfee()
            if v > best[1]:
                best = (i, v)
        if best[1] < 0.01:
            return 0.0, 0.0
        if best[0] == "opool":
            usd, pf = s.opool.sell_base(n)
            s.rev["swap"] += pf * s.opool.price()
        else:
            p, q = s.sola_pools()[best[0]]
            cost = s.exercise(n)
            out, pf = p.sell_base(n)
            s.rev["swap"] += pf * p.price() * q()
            usd = out * q() - cost
            s.stats["flash"] += n
        if who == "s2":
            s.stats["s2_sold"] += n
            s.stats["s2_usd"] += usd
        return n, usd

    # ── arbitrage to (near) equilibrium ──
    def arb(s):
        for _ in range(60):
            moved = False
            for p, q in s.sola_pools():
                pu = p.price() * q()
                # pool above curve: buy on the curve, sell into the pool (ratchets the curve)
                if pu * (1 - FEE) > s.pc() * 1.001:
                    n = p.x * (pu * (1 - FEE) / s.pc() - 1) / 4
                    usd = n * s.pc()
                    got = s.curve_buy(usd)
                    out, pf = p.sell_base(got)
                    s.rev["swap"] += pf * p.price() * q()
                    moved = True
                # pool under the floor: buy in the pool, redeem at the floor
                elif pu / (1 - FEE) < 0.999:
                    dq = p.y * (1 / (pu / (1 - FEE)) - 1) / 4
                    got, pf = p.buy_base(dq)
                    s.rev["swap"] += pf * q()
                    s.sell_floor(got)
                    moved = True
                # oSOLA cheap vs a SOLA pool: buy oSOLA, exercise, sell SOLA (mint-and-dump arb)
                po_ask = s.opool.price() / (1 - FEE)
                edge = p.price() * q() * (1 - FEE) - 1 - s.exfee() - po_ask
                if edge > 0.002 * pu:
                    dy = s.opool.y * min(edge / po_ask, 1) / 8
                    n, pf = s.opool.buy_base(dy)
                    s.rev["swap"] += pf
                    s.exercise(n)
                    out, pf2 = p.sell_base(n)
                    s.rev["swap"] += pf2 * p.price() * q()
                    s.stats["flash"] += n
                    moved = True
            if s.cfg == 2:
                a, b = s.jpool.price() * s.jito(), s.fpool.price() * s.fbomb
                if abs(a - b) / min(a, b) > 0.008:
                    hi, hq, lo, lq = (s.jpool, s.jito, s.fpool, lambda: s.fbomb) if a > b \
                        else (s.fpool, lambda: s.fbomb, s.jpool, s.jito)
                    usd = min(hi.y * hq(), lo.y * lq()) * abs(a - b) / max(a, b) / 6
                    got, pf = lo.buy_base(usd / lq())
                    out, pf2 = hi.sell_base(got)
                    s.rev["swap"] += pf * lq() + pf2 * hi.price() * hq()
                    moved = True
            if not moved:
                break

    def step(s, t):
        r = s.rng
        s.sol *= math.exp(r.gauss(0, 0.10) - 0.005)
        s.fbomb *= math.exp(r.gauss(0, 0.25) - 0.031)
        emis = 20_000 * 0.99 ** t
        s.inv["s2"] += emis * 0.4
        s.inv["dump"] += emis * 0.3
        s1 = emis * 0.3  # strategy 1: exercise + stake, always
        s.exercise(s1)
        if t == 4:
            s.inv["air"] += 875_000
        if t == 26:
            s.inv["founder"] += 1_250_000 * s.founder_sell
        elif 26 < t < 103:
            s.inv["founder"] += 5_000_000 / 103 * s.founder_sell
        d = s.demand0 * math.exp(r.gauss(0, 0.5) - 0.125)
        for _ in range(SUB):
            s.buy_sola_chunk(d / SUB)
            for who, frac in (("s2", 1 / SUB), ("dump", 1 / SUB), ("founder", 1 / SUB), ("air", 0.6 / 8 / SUB)):
                amt = s.inv[who] * frac if who != "air" else min(s.inv["air"], 875_000 * frac)
                if amt > 1:
                    sold, _ = s.sell_osola_chunk(amt, who)
                    s.inv[who] -= sold
            s.arb()
        # sanity: the floor never under-backs purchased supply
        assert s.floor >= s.purchased - 1e-6, (s.floor, s.purchased)
        s.stats["pc"].append(s.pc())
        s.stats["po"].append(s.opool.price())
        if s.cfg == 2:
            ps = s.jpool.price() * s.jito()
            s.stats["ps"].append(ps)
            s.stats["gap"].append((s.pc() - ps) / s.pc())

    def il(s, pool, x0, y0, q_now, q0):
        lp = pool.x * s.sola_usd() + pool.y * q_now
        hold = x0 * s.sola_usd() + y0 * q_now
        return lp / hold - 1

    def sola_usd(s):
        return s.jpool.price() * s.jito() if s.cfg == 2 else s.pc()


def run(cfg, demand, founder_sell, seed):
    w = World(cfg, demand, founder_sell, random.Random(seed))
    for t in range(EPOCHS):
        w.step(t)
    S = w.stats
    out = dict(
        rev=sum(w.rev.values()),
        rev_curve=w.rev["curve"],
        rev_ex=w.rev["exercise"],
        curve_share=S["buyer_curve"] / max(S["buyer_usdc"], 1),
        pc=w.pc(),
        po=w.opool.price(),
        s2_per=S["s2_usd"] / max(S["s2_sold"], 1),
        s2_usd=S["s2_usd"],
        s2_unsold=w.inv["s2"],
        floor_out=S["floor_out"],
        flash=S["flash"],
        o_lp=(w.opool.x * w.opool.price() + w.opool.y) / (w.open0[0] * w.opool.price() + w.open0[1]) - 1,
    )
    if cfg == 2:
        out["gap"] = st.mean(S["gap"])
        out["ps"] = S["ps"][-1]
        x0, y0, _ = w.j0
        out["il_j"] = w.il(w.jpool, x0, y0, w.jito(), None)
        x0, y0, _ = w.f0
        out["il_f"] = w.il(w.fpool, x0, y0, w.fbomb, None)
    return out


def summarise(cfg, demand, fs, n=40):
    runs = [run(cfg, demand, fs, 1000 + i) for i in range(n)]
    med = lambda k: st.median(r[k] for r in runs)
    p10 = lambda k: sorted(r[k] for r in runs)[n // 10]
    p90 = lambda k: sorted(r[k] for r in runs)[n - 1 - n // 10]
    row = {k: (med(k), p10(k), p90(k)) for k in runs[0]}
    return row


if __name__ == "__main__":
    for demand in (15_000, 50_000, 150_000):
        for fs in (0.0, 0.5):
            for cfg in (0, 1, 2):
                r = summarise(cfg, demand, fs)
                g = lambda k: "%.3g [%.3g..%.3g]" % r[k]
                line = [f"C{cfg} D={demand//1000}k fs={fs}",
                        "rev " + g("rev"), "curveShare " + g("curve_share"), "Pc " + g("pc"),
                        "Po " + g("po"), "s2$/o " + g("s2_per"), "s2$ " + g("s2_usd"),
                        "s2unsold " + g("s2_unsold"), "floorOut " + g("floor_out"),
                        "flash " + g("flash"), "oLP " + g("o_lp")]
                if cfg == 2:
                    line += ["gap " + g("gap"), "Ps " + g("ps"), "ILj " + g("il_j"), "ILf " + g("il_f")]
                print(" | ".join(line)); sys.stdout.flush()
