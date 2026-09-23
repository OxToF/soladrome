"""C1 vs C3 = C1 + pool SOLA/oSOLA. Adds unstakers (1%/epoch of purchased SOLA) choosing their best exit."""
import math, random, statistics as st
import importlib.util, os
spec = importlib.util.spec_from_file_location("m", os.path.join(os.path.dirname(os.path.abspath(__file__)), "01_osola_vs_sola_markets.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
Pool, FEE = m.Pool, m.FEE

class W(m.World):
    def __init__(s, cfg, demand, fs, rng):
        super().__init__(1, demand, fs, rng)
        s.c3 = cfg == 3
        pc = s.pc(); po = s.opool.price()
        if s.c3:   # base SOLA, quote oSOLA ; 50k $ a side
            s.xpool = Pool(50_000 / pc, 50_000 / po); s.x0 = (s.xpool.x, s.xpool.y)
        s.stats.update(unstake_pool=0, unstake_floor=0, xgap=[])
    def buy_sola_chunk(s, usdc):
        if s.c3:
            via = s.xpool.price() * s.opool.price() / (1 - FEE) ** 2
            other = min(s.pc(), s.opool.price() / (1 - FEE) + 1 + s.exfee())
            if via < other:
                s.stats["buyer_usdc"] += usdc
                o, _ = s.opool.buy_base(usdc)
                s.xpool.buy_base(o)
                return
        super().buy_sola_chunk(usdc)
    def xp_usd(s):   # SOLA price in USD through the pool
        return s.xpool.price() * s.opool.price()
    def arb(s):
        super().arb()
        if not s.c3: return
        for _ in range(60):
            p, po = s.xpool.price(), s.opool.price()
            # exercise parity: 1 oSOLA + (1+fee) USDC -> 1 SOLA -> p oSOLA ; extra oSOLA sold on opool
            gain = (p * (1 - FEE) - 1) * po * (1 - FEE) - (1 + s.exfee())
            if gain > 0.002 * p * po:
                n = s.xpool.x * gain / (p * po) / 6
                s.exercise(n)
                o_out, _ = s.xpool.sell_base(n)
                s.opool.sell_base(o_out - n)
                s.stats["flash"] += n
                continue
            # SOLA under the floor in the pool: buy it with oSOLA (bought on opool), redeem at 1
            if p * po / (1 - FEE) ** 2 < 0.999:
                o_need = s.xpool.y * (1 / (p * po / (1 - FEE) ** 2) - 1) / 6
                o_got, _ = s.opool.buy_base(o_need * po / (1 - FEE))
                got, _ = s.xpool.buy_base(o_got)
                s.sell_floor(got)
                continue
            break
    def step(s, t):
        super().step(t)
        want = 0.01 * s.purchased
        for _ in range(m.SUB):
            q = want / m.SUB
            best_pool = s.xp_usd() * (1 - FEE) ** 2 if s.c3 else 0
            if best_pool > 1.0:
                o_out, _ = s.xpool.sell_base(q)
                s.opool.sell_base(o_out)
                s.stats["unstake_pool"] += q
            else:
                s.sell_floor(q); s.stats["unstake_floor"] += q
            s.arb()
        if s.c3: s.stats["xgap"].append((s.pc() - s.xp_usd()) / s.pc())

def run(cfg, d, fs, seed):
    w = W(cfg, d, fs, random.Random(seed))
    for t in range(m.EPOCHS): w.step(t)
    S = w.stats
    r = dict(rev=sum(w.rev.values()), curve=S["buyer_curve"] / S["buyer_usdc"], pc=w.pc(), po=w.opool.price(),
             s2=S["s2_usd"] / max(S["s2_sold"], 1), floor=S["unstake_floor"] + S["floor_out"] - S["unstake_floor"] * 0,
             upool=S["unstake_pool"], ufloor=S["unstake_floor"], flash=S["flash"])
    if w.c3:
        x0, y0 = w.x0; ps = w.xp_usd(); po = w.opool.price()
        r["il"] = (w.xpool.x * ps + w.xpool.y * po) / (x0 * ps + y0 * po) - 1
        r["gap"] = st.mean(S["xgap"])
    return r

for d in (15_000, 50_000, 150_000):
    for fs in (0.0, 0.5):
        for cfg in (1, 3):
            rs = [run(cfg, d, fs, 2000 + i) for i in range(30)]
            med = {k: st.median(x[k] for x in rs) for k in rs[0]}
            lo = {k: sorted(x[k] for x in rs)[3] for k in rs[0]}
            extra = f" | IL LP SOLA/oSOLA {med['il']*100:.0f}% (p10 {lo['il']*100:.0f}%) | gap to curve {med['gap']*100:.0f}%" if cfg == 3 else ""
            print(f"D={d//1000}k fs={fs} C{cfg} | rev {med['rev']/1e6:.2f}M | curve share {med['curve']*100:.0f}% | Pc {med['pc']:.2f} | Po {med['po']:.3f} | s2 $/o {med['s2']:.2f} | exits via pool {med['upool']/1e3:.0f}k at floor {med['ufloor']/1e3:.0f}k | exercised-then-sold {med['flash']/1e3:.0f}k{extra}")
