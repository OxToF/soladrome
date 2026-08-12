# Soladrome — oSOLA Exercise Fee Design

> Status: **decided 2026-08-04, not implemented.** Supersedes the "hybrid
> exercise" decision of 2026-06-21 (see §5 for why the lock branch was dropped).
> Reference doc for implementation. Cross-ref [MAINNET_RUNBOOK.md](MAINNET_RUNBOOK.md).

---

## 1. The problem

`exercise_o_sola` today (verified `lib.rs:937-999`):

```rust
let usdc_cost = o_sola_amount;                        // 1:1, both 6 decimals
transfer(user_usdc → floor_vault, usdc_cost);         // 100% of strike to floor
burn(o_sola_amount);
mint_to(user_sola, o_sola_amount);
total_sola            += o_sola_amount;
total_purchased_sola  += o_sola_amount;
```

oSOLA is a call option with a **fixed strike of 1 USDC**. Once SOLA is worth more
than 1 USDC, every exercise is a free arbitrage, and **the protocol captures 0% of
the spread** — the entire gift goes to the holder. This is the mechanism that
cannibalised Beradrome's oBERO.

**Decision: charge a fee on exercise, routed to hiSOLA stakers.**

---

## 2. Design rules (each one is load-bearing)

### Rule 1 — The fee is proportional to the GAIN, never flat

A flat fee is regressive backwards. When SOLA is barely above 1 USDC it makes
exercise unprofitable → nobody exercises → oSOLA is worthless → oSOLA emissions
are worthless as an LP incentive → pools stay empty. When SOLA is at 10× the same
flat fee is trivial. It bites exactly where it must not.

```
fee = fee_bps × (curve_price − strike) × amount
```

### Rule 2 — The price reference is the curve, and it needs no oracle

`curve_price = virtual_usdc / virtual_sola` — internal protocol state.

This reference is unusually **manipulation-resistant**, structurally:
- To inflate it, an attacker must buy through the curve with real USDC — expensive,
  and it moves the price against their own position.
- To deflate it, there is **no lever at all**: `sell_sola` never touches the virtual
  reserves (only `buy_sola` / `deploy_pol` do).

So an attacker wanting to *reduce* their own exercise fee has no available action.
Most fee-on-gain designs need an external oracle and get exploited through it. This
one does not. (This is the same price source the frontend must switch to for mainnet
— see MAINNET_RUNBOOK §6.2.)

### Rule 3 — ☢️ The fee is charged ON TOP of the strike. It is NEVER carved out of it.

**This is the single most dangerous line in the feature.**

```rust
// ☢️ WRONG — reproduces the unfinanced-supply bug class closed 2026-07-17
transfer(user → floor_vault, usdc_cost − fee);   // floor receives 1 − fee
transfer(user → market_vault, fee);
total_purchased_sola += o_sola_amount;           // counter increments by 1 (FULL)
```

The floor would receive `1 − fee` per SOLA while the counter increments by `1`. That
is *exactly* the defect closed on 2026-07-17: **a counter incremented beyond what the
vault actually received.** It is cumulative, permanent, and invisible in tests because
the accounting stays self-consistent while the backing evaporates.

```rust
// ✅ RIGHT — floor untouched, fee is new money
transfer(user → floor_vault, usdc_cost);         // unchanged, full 1 USDC
transfer(user → market_vault, fee);              // additional payment
total_purchased_sola += o_sola_amount;
```

The user pays `1 + fee` instead of `1`. Backing per exercised SOLA stays exactly
1:1 and the invariant `floor_vault + total_usdc_borrowed >= total_purchased_sola`
is untouched, mathematically.

### Rule 4 — Advance the staker accumulator only on what actually lands

`market_vault` feeds `fees_per_hi_sola`, claimed via `claim_fees`. The accumulator
must be advanced on the fee **actually received**, never on a larger base. The known
unfixed `collect_to_pol` bug (`pol.rs:55`) is precisely this class — it credits
stakers on the full market balance and *then* transfers out, promising more than the
vault holds. Same trap, same file neighbourhood.

### Rule 5 — `fee_bps` lives in `ProtocolState`, authority-settable

Same pattern as `configure_emissions`, so it is tunable post-launch without a
redeploy. Start conservative.

---

## 3. Where the fee goes — decided: `market_vault`

Because the fee is **new money** (Rule 3), its destination is a free choice:

| Destination | Effect | Trade-off |
|---|---|---|
| **`market_vault`** ← **CHOSEN** | Revenue for hiSOLA stakers | Produces an on-chain, third-party-verifiable revenue line |
| `floor_vault` | Each exercised SOLA carries **>1 USDC** of backing — the floor becomes over-collateralised and strengthens over time | Most conservative, but produces no showable revenue |

Chosen `market_vault`: verifiable protocol revenue matters for the TrueMRR listing
and for investor conversations, and it plugs into the existing `claim_fees`
accumulator with no new sink and no new accounting.

**Do not ship a governable `fee_split_bps` at launch** — one more knob is one more
governance and audit surface. Pick one destination; it can evolve later.

---

## 4. The one real cost, stated honestly

The fee **slows floor growth**. Exercise is what finances the floor (1 USDC in per
SOLA minted), so discouraging it marginally means the floor accumulates more slowly.

This is a **rate effect, not a solvency effect** — the floor never decreases from
this, and the backing ratio per SOLA is unchanged (Rule 3). It stays bounded as long
as the fee is a modest fraction of the *gain*: at a curve price of 1.5 with a fee of
10% of the gain, the exerciser pays 1.05 to obtain something worth 1.5 and still
exercises comfortably.

Borrow-buffer impact: **neutral.** Exercise increments `total_purchased_sola` and
`floor_vault` by the same amount, so the 75% buffer ratio (`FLOOR_RESERVE_MIN_BPS`)
does not move.

**Death threshold:** if `fee >= gain`, nobody exercises, oSOLA goes to zero, and the
emission system loses its value as an LP incentive. The fee must always leave
exercise clearly profitable.

---

## 5. Why the "hybrid exercise" lock branch was dropped (2026-08-04)

The 2026-06-21 decision was a *hybrid*: a choice between (a) a liquid exit at a
modest discount plus a fee, and (b) a locked hiSOLA exit with better terms and
×1→×4 voting power. **Branch (b) is abandoned. Only the fee (a) is retained.**

Three reasons, in order of weight:

**1. Soladrome already has a lock, and it is better.** Beradrome's design has no
time-lock: the lock is *economic*, via borrowing. Verified in code —
`unstake_hi_sola` enforces:

```rust
require!(user_position.usdc_borrowed <= remaining, SoladromeError::OutstandingDebt);
```

You can only unstake down to the level that still covers your debt. So a borrow **is**
the lock: self-imposed, motivated by real capital extraction, reversible on the
user's own terms via `repay_usdc`, with no calendar. Grafting a ve time-lock onto
exercise would duplicate — worse — a function the protocol already performs.

**2. A lock defers the dump, it does not solve it.** Escrowed-token models (Camelot's
xGRAIL: 15-day redemption at 1:0.5, 6 months at 1:1) tax exactly the mercenary capital
that bootstraps you, and publish an unlock schedule the market prices in immediately.
The sharp criterion:

> **A lock only works if the locked position has an independent buyer.**

veCRV worked because Convex and stablecoin issuers genuinely wanted gauge control and
paid for it. Where nobody wants the governance, locking is a deferred sale at a
discount, plus a complexity tax that suppresses participation.

**3. Scope.** The full hybrid meant ve wiring plus five security guardrails (epoch-start
voting-power snapshot, per-pool emission caps, founder oSOLA excluded from gauges, no
transfer/delegate/merge on `VeLockPosition`, admin-gated emissions). The fee alone is a
price read, a multiply, one extra transfer and one accumulator advance inside a ~66-line
instruction — small enough to fit the single full audit without pushing mainnet past
Colosseum.

**The ve machinery keeps its narrow job:** escrowing *unfinanced allocations* (founder
7M, team 250K, partner welcome bags) so they can never reach a wallet. That is a
different problem from velocity control on user emissions, and it is not affected by
this decision.

---

## 6. Implementation checklist

- [ ] `fee_bps` field on `ProtocolState` (carve from spare bytes if available — check
      `LEN`; **never resize a live account**, see the devnet 3003 incident)
- [ ] `set_exercise_fee` authority-only instruction (mirror `configure_emissions`)
- [ ] Fee math in `exercise_o_sola`, using `virtual_usdc / virtual_sola`
- [ ] Guard: fee transfer is **additional**, `floor_vault` still receives the full strike
- [ ] Advance `fees_per_hi_sola` on the received fee only
- [ ] Comment above the transfer stating Rule 3 explicitly, so no future edit carves
      the fee out of the strike
- [ ] Tests: backing invariant holds after exercise-with-fee; staker claim matches the
      fee actually paid; fee = 0 path unchanged; exercise still profitable at small gains
- [ ] IDL rebuild + copy to `app/lib/soladrome.json` (see [[feedback-anchor-idl-rebuild]])
- [ ] Frontend: show the fee in the exercise UI before signing
