# STATUS — where Soladrome actually is

One living document. If something here disagrees with another file in this repository, this
file is the one to trust, and the other file is the one to fix.

**Last measured: 2026-09-24.** Every figure below was read from the tree or the chain on that
date, not carried forward from a previous note.

☢️ **THE DEVNET BINARY NO LONGER MATCHES THE AUDIT TAG. Since 2026-09-21 it never will again.**
Until that date the two were the same artefact, and this file said so. Standing compound orders
added four instructions and one account type, and devnet was upgraded to carry them — a
deliberate decision, taken with the trade-off named: the tag is what an auditor was handed, and
what runs on devnet is now that tag plus this feature. Anything quoting "the audited binary is
what is deployed" is stale from this date onward.

---

## The artefact

| | |
|---|---|
| Audit tag | **`audit-2026-09-01`** — the tree handed to the auditor, and **no longer what devnet runs** |
| Previous tag | `audit-2026-08-30b`, a verified **ancestor** of the audit tag |
| Branch | `main` — one trunk, and the deployed tree |
| Program id (devnet) | `DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe` |
| Devnet binary | sha256 `fa483503…`, 1 921 288 bytes, SBPFv3, deployed 2026-09-24 at slot `503048080` from commit `832a775` (branch `feat/pool-strategies`), verified byte-for-byte by dump |
| Instructions | **65** (54 at the audit tag, plus four standing-order, three LP-order and four per-position strategy instructions) |
| Account parameters | 503 at the audit tag; the four new instructions add their own |
| Error variants | **68** (58 at the audit tag, plus the ten `Auto*` / `PartialBasisClaim` / `Strategy*` variants) |
| On-chain account types | **24** (22 at the audit tag, plus `AutoCompound` and `PoolStrategy`) |
| Tests | **114 bankrun cases passing, 0 failing** — 13 per-position strategy (incl. the duplicate-pool regression), 9 LP order, 8 standing order, 4 permissionless claim; mutations on every guard · 80 cargo unit tests · 48 frontend unit tests |

**☢️ FOUND AND FIXED IN REVIEW (2026-09-24): a pool passed twice reverted a route's reserves.**
`AmmPool` is owned by this program, so Anchor writes every mutable copy back at exit, in field
order — **and does not refuse a duplicate**. With a USDC destination `route_into_lp` never read the
hop, so a cranker could pass the sale pool as `hop_pool`: its stale copy, written after the real
one, reverted the sale's reserve update (bankrun: USDC reserve 38 000.000000 against a vault of
37 999.876010). Permissionless and repeatable with cheap orders of one's own — enough to drain the
sale pool's USDC. It affected `crank_auto_compound_lp` (on devnet since 2026-09-23) and
`crank_pool_strategy_lp`. Fixed in `832a775`: the hop accounts must be absent unless the route
needs them, and every pool on the route is a distinct account. Every devnet pool was checked —
reserves equal vaults, never exploited — and the fix was deployed within the hour (slot
`503048080`). ⚠️ The general rule for this program: any instruction taking two program-owned
accounts of the same type must prove they are distinct; Anchor will not.

**☢️ Each LP position has its own reward strategy since 2026-09-24.** A wallet-based order can
only have one destination — every pool pays oSOLA into the same account, where it no longer says
which pool it came from — so a user compounding jitoSOL/SOL saw their USDC/SOLA rewards follow.
`PoolStrategy` (`[b"strategy", owner, source_pool]`) harvests ONE position's accrual at the source,
so two strategies never touch each other's rewards. `set_pool_strategy` / `close_pool_strategy`
(owner), `crank_pool_strategy_lp` / `crank_pool_strategy_vote` (permissionless). The liquidity
strategy mints the harvest straight into the sale vault — no allowance, nothing reaches the wallet
— and deposits into the owner's chosen pool (its own by default); a backlog over one leg is capped
and the excess minted to the owner. The voting strategy exercises the harvest directly into financed
hiSOLA, never minting oSOLA. ☢️ The same pool is never two accounts in one instruction (same-pool
strategies pass it once; a position in the sale or hop pool cannot compound through it:
`StrategyRouteConflict`). Every harvest is a stranger's (`harvest_lp_rewards`, `owner_present =
false`). Refactors: `route_into_lp`, `exercise_into_stake`, `harvest_lp_rewards` — one body each.
**Proven on devnet** from a stranger's key: cross-pool xStock → jitoSOL/SOL harvested 3 477.12 oSOLA,
sold 692.12 (the 1 % leg), +77.85 LP, 2 785.00 oSOLA backlog to the owner (tx `3UXFqDoB…`); voting
harvested 2 742.28 oSOLA → +2 742.28 financed hiSOLA, strike in full to the floor, 10.91 USDC fee,
no oSOLA minted (tx `4J7GjZT2…`). ⚠️ Disclosed interaction: any deposit into a pool — including the
wallet order's — collects that position's pending into the wallet first, bypassing its strategy.
Nothing is lost; the Rewards card warns when the wallet order points at a pool with a strategy.

**☢️ A standing order can compound into LIQUIDITY since 2026-09-23.** Three instructions:
`set_auto_compound_lp`, `clear_auto_compound_lp` and the permissionless `crank_auto_compound_lp`,
which sells the owner's oSOLA on the oSOLA/USDC pool, buys SOL on the SOL/USDC pool when the
destination pairs SOL, and deposits that single side (`amm_math::zap_in`, priced exactly as
swap-then-add). No exercise, so no USDC is asked of the owner. The destination lives in two fields
carved from `AutoCompound`'s spare bytes (126/128, no realloc), so every order armed before reads
"staking". What the cranker cannot choose: the destination (`AutoWrongDestination`, both cranks),
the route (derived, `AutoInvalidRoute`), the price (≥ `min_intrinsic_bps` of the exercise value, a
curve reference no trade can push down, `AutoBelowIntrinsic`), the size (1 % of each reserve,
`AutoImpactTooHigh`) and the harvest (`credit_lp_deposit` with `owner_present = false`, so
`PartialBasisClaim` applies). **Proven on devnet**: `AutoBelowIntrinsic` refused a round at 70 %
against the devnet oSOLA pool (which pays ~22 % of exercise value), then a round at 20 % fired from
a stranger's key — tx `4TmvPY7s…`, 10 oSOLA → 0.090690 USDC → +0.424661 LP to the owner, protocol
fee 0.000027 USDC routed, 57.8k CU. ⚠️ Residual, disclosed: the SOL hop and the deposit have no
oracle, so a sandwich remains possible within the 1 % leg cap. The launch pool set this assumes
(oSOLA/USDC + SOL/USDC + LST/SOL, no SOLA pool) is justified in `scripts/launch_pools/`.

**⚠️ A standing order's pacing is now a rule of the chain (2026-09-22).** `configure_auto_compound`
used to accept `min_interval == 0`, and `AutoCompound::ready` compares `now - last_crank_ts >=
min_interval` against a `Clock` that does not advance inside a transaction — so `0 >= 0` was true
and a single transaction could fire an order as many times as the balance, the SPL allowance and
the compute budget allowed. The total spend was never at risk (the allowance is enforced by SPL
Token itself), but "once an hour" was a convention of our frontend rather than a property of the
order. `MIN_CRANK_INTERVAL = 60` is now the floor on what may be configured — the shortest period
the interface offers. Proven by mutation: reverting the bound to `>= 0` fails the new case.

**☢️ `claim_lp_rewards` lost its signer (2026-09-21).** `user` is now an `UncheckedAccount`:
**anyone may claim on anyone's behalf.** Nothing else changed, and nothing else had to — every
account was already bound to that key by something other than a signature (the LP balance by
`token::authority`, the reward record by its seeds, the oSOLA destination by
`associated_token::authority`), so the signer was the only thing making it self-service and it
was buying nothing. A caller who is not the owner causes them to receive **their own** rewards
into **their own** account, pays the fee, and gains nothing. A separate `payer: Signer` funds
the two accounts the instruction may create, so a stranger may fund someone's records and never
spend from them.

☢️ **And it opened a grief vector, found in review before deploying, fixed, proven by
mutation.** `user_lp` was bound by `token::authority = user` — an account the user owns, not
their associated one — which was safe only while the owner had to sign, because nobody grieves
themselves. Permissionless, it became cheap: **anyone may create a token account and name
someone else as its owner** (`initializeAccount` takes the owner as a parameter, not as a
signer), fund it with a small fraction of the pool's LP, and claim on it. The handler advances
`reward_debt` to the full accumulator **whatever basis it paid on**, so the victim is paid one
percent and forfeits the other ninety-nine. `user_lp` is now bound to the associated account,
which leaves one possible address and nothing to choose between. Covered by
`[stream] ☢️ a griefer cannot wipe someone's accrual by claiming on a decoy LP account`, and
that case was **verified by mutation**: it fails against the old constraint and passes against
the new one. ⚠️ The first version of the test used 10 base units and passed against BOTH,
because `pending > 0` refused it on rounding before the constraint spoke — a test that proves
nothing looks exactly like a test that proves something.

☢️ **A second finding, from the automated review, that the first fix did NOT close.** Binding
`user_lp` to the associated account stopped an attacker MANUFACTURING a small basis. It does not
stop them WAITING for one. `reward_basis` is `min(recorded deposit, wallet balance)`, and an LP
who parks some of their tokens elsewhere — a hardware wallet, a multisig — sits at
`wallet < recorded` in plain view of anyone polling two public accounts. A claim fired then pays
the smaller figure and still advances `reward_debt` to the whole accumulator, forfeiting the
rest. ⚠️ **Our own keeper would have done this by accident**, claiming every pool it found
claimable without ever reading that ratio.

Closed by `PartialBasisClaim`: a third party may claim only while the wallet still holds the
whole recorded deposit, where the two bases are equal and nothing is lost. The owner keeps
self-service at any basis — which moment to claim is worth something, and it is theirs. Proven
by mutation, and the keeper now skips those pools with a reason in its log instead of
discovering the refusal in simulation.

`crank_auto_compound` was tightened the same way in the same pass. Nothing exploitable was
found there — a decoy account holds no delegation, so the burn fails — but the argument that
establishes it is long and the constraint that removes the need for it is one line.

Why: a standing order could not feed itself. The crank exercises what is in the wallet and
claims nothing, so the rewards meant to refill it sat one uncallable instruction away — an
order fired until the wallet ran dry, then went quiet for good. Proven both ways in
`tests/bankrun_continuous.ts`: a stranger claiming for someone lands the rewards in the owner's
account, and a stranger substituting their own destination is refused.

**Standing compound orders (2026-09-21).** `configure_auto_compound`,
`set_auto_compound_enabled`, `crank_auto_compound` and `close_auto_compound`. The crank is the
first instruction here that **any signer may call on behalf of someone else** — that is the
feature, since a standing order needs a caller and the only honest way to have one without
holding a key is to let everyone be it. Authority comes from an SPL **delegate** the user grants
from their own wallet, capped by them and revocable by them; nothing is escrowed and this
program never takes custody. `AutoCompound.max_cost_per_unit` is the bound `exercise_o_sola`
does not have, and it is why this shape was chosen over pre-signed transactions: the exercise
fee is priced off the curve at landing, so a pre-signed transaction authorises an amount at an
unbounded price and whoever broadcasts it picks which.

There is **one binary**. Devnet and mainnet run the identical artefact; the `devnet` cargo
feature was removed on 2026-08-23 and must never come back. See CLAUDE.md for the full story of
why a build-time cluster flag was a security problem rather than a convenience.

## Branches, and what each is for

| Branch | Role |
|---|---|
| `main` | The trunk. Everything ships from here, and a push deploys the frontend to production. |
| `devnet-legacy` | The four account-layout migrations plus their tests. ⛔ **Never merge into `main`** — those migrations are devnet-only and are deliberately outside the audited binary. |
| `chore/cargo-fmt` | Held open on purpose. |
| `feat/vote-escrow-pda` | Research, not a candidate for merge. |

## Continuous integration

CI runs `cargo fmt --check`, `clippy -D warnings`, `anchor build`, the Rust unit tests, **the
bankrun suite**, **the validator integration suite**, and the frontend type-check and build.

The two test jobs were added on 2026-08-31. Before that date CI was green without running a
single one of the 112 cases, so a pull request that broke the whole suite passed. Worth
remembering when reading any test claim made in a document written before then.

⚠️ On **Node 22.18–23.x** the suites need `NODE_OPTIONS=--no-experimental-strip-types`. Native
TypeScript type-stripping claims the `.ts` file before ts-node's require hook, serves it as ESM,
and the run dies on `SyntaxError: Named export 'BN' not found` — `@coral-xyz/anchor` is
CommonJS. Node 24 resolves it the other way, so identical code is green on 24 and red on 22.

## Recently landed

**Token-2022 support (2026-09-01).** Third-party mints are accepted across the three surfaces
that take one: `amm.rs`, `bribes.rs` and `partners.rs`. A pool carries two token programs, since
its sides may be served by different ones. Admission policy lives in one file, `token_ext.rs`.
The protocol's own mints — SOLA, oSOLA, every LP mint — stay classic SPL Token.

☢️ **The residual risk that is not closable in code:** the xStocks ship with an *unarmed*
transfer-hook slot the issuer may arm at any time. A mint that is already armed is refused; one
armed *after* its pool exists would make that pool's transfers fail, `remove_liquidity`
included. Disclosed to the auditor, not solved.

**`recycle_lp_emissions` (2026-09-01).** An unclaimed LP emission pot was never minted at all —
a budget leak, not a vulnerability. The residue now rolls forward into the same pool's current
epoch, after the same grace period a bribe rollover waits.

## Open decisions, with no deadline yet

**The licence Change Date is fixed, and that is a decision by default.** `LICENSE` is BUSL-1.1
with a Change Date of **2030-05-13** — an absolute date, not a rolling window. It approaches on
its own: mainnet has not launched, so whatever protection remains shrinks every day without
anyone choosing it. A rolling conversion (N years after each version's first release) is the
alternative worth considering. Out of audit scope — nobody audits a `LICENSE` — so it can change
without contradicting anything already handed over, but it should be an actual decision.

## Decided

**A pool on a pausable Token-2022 mint stays gauge-eligible. Decided 2026-09-14.**

This closes the question that stood open here: if such a pool is eligible, emissions can be voted
toward a market its issuer has frozen. It is eligible anyway.

The reasoning is that a pause is a transient state, not a property of the asset. Tokenized
equities are moving toward trading around the clock, so the closed-market window that makes this
question interesting is shrinking on its own. Building a permanent eligibility rule to handle a
temporary condition would outlive the condition.

Two things make the exposure bounded rather than open-ended. A frozen pool earns no trading fees,
so voters have no reason to keep directing emissions at it — the vote market corrects a stale
allocation faster than any rule could, and it corrects it with the people who are paying for it.
And the halt authority belongs to the issuer, not to this protocol: `token_ext.rs` admits
`PausableConfig` deliberately, because freezing its own market is the issuer's prerogative. A rule
here would be this protocol second-guessing a decision it does not own.

**No code implements this decision, which is the point.** Neither `vote_gauge` nor
`emit_pool_rewards` reads anything about pausability, so the behaviour above is already what the
deployed binary does. What changes is that it is now a choice on the record rather than an
accident of omission — the distinction an auditor will ask about.

⚠️ The cost, stated so nobody rediscovers it as a finding: for the duration of a pause, oSOLA can
accrue to LPs in a pool whose tokens cannot move, and bribes can be paid for votes on it. Nothing
is lost or stuck — `remove_liquidity` resumes when the issuer unpauses — but an epoch of emission
can be spent on a market that did no trading.

## Subsystems shipped but not enabled

Both are in the audited binary and both are in scope. A runtime flag does not put code out of
scope: a gated instruction is still deployed bytecode, and flipping the flag is one transaction.

- **POL** (`pol.rs`) — protocol-owned liquidity.
- **The per-epoch oSOLA emission cycle** — the gauge-directed pot, distinct from the continuous
  per-pool stream.

## Points

**Kept, and switched on after the audit** — the mainnet pre-TGE phase, not dead code.

What is actually deployed today: `app/lib/points.ts`, both `api/points` routes and
`supabase/points_phase2.sql` are on `main` and therefore live. What is **not** built: the cron
that drives accrual, and the Points page in the frontend. So the engine exists and nothing
currently runs it.

## Archived documents

`docs/archive/` holds planning documents that have been superseded and are kept only because
their reasoning explains how the current numbers were arrived at. **Nothing in `docs/archive/`
should be read as a description of the code as it stands** — every surface figure in there
predates the 2026-08-30 restructure.

Two of them are deliberately excluded from this public repository by `.gitignore`, because they
carry commercial detail that does not belong in public. They exist on the maintainer's disk and
in the audit handoff, not here.

## Where the auditor's documents live

Not in this repository. The handoff package is its own repository so the code has exactly one
home and there is no second copy to drift: scope, architecture, threat model, known issues and
testing instructions, all pinned to `audit-2026-09-01`.
