# Soladrome — Mainnet Runbook

> First pass at a single source of truth for mainnet go-live. Previously this
> checklist only existed scattered across session notes; consolidated here
> 2026-07-06. Keep this file, not chat history, as the checklist going forward.

---

## 1. Blocking prerequisites (must clear before any mainnet deploy)

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | **Security audit — FULL SCOPE** | ⏳ Open — **scope decided 2026-08-04** | Quotes in hand from more than one firm; vendor selection and pricing are tracked off-repo. Blocks: mainnet deploy, Jupiter routing/listing, any external volume. **DECISION 2026-08-04: do ONE full-scope audit — the split gated/delta packaging is abandoned.** Rationale: splitting *raised* the total (~+10-20%, a delta re-audit carries a fixed re-familiarization cost) while complicating the mainnet deploy, and the reduced package left `emissions_enabled = false`, i.e. **no LP incentive at launch → empty pools → nothing for Jupiter to route → no fees**. The full audit is the *enabling* purchase, not the expensive option: it is what lets emissions be on at launch. Scope reasoning kept in `docs/archive/AUDIT_PACKAGES.md` / `docs/archive/AUDIT_SCOPE.md` (both historical, and both deliberately outside this public repository). **Phase flags stay — but for launch sequencing only (§3b), never again as an audit-scope-reduction device.** See [[project-soladrome-funding-gtm]]. |
| 2 | **`deploy_pol` rewrite for jitoSOL leg** | ⏳ Open | Currently hardcoded to SOLA/USDC (`pol.rs`). Needed before the SOLA/jitoSOL house pool can be POL-funded. Blocks: house pool liquidity, Jupiter routing (nothing worth routing to without it). |
| 3 | **Jupiter `Amm` adapter** | ⏳ Design only — **priority raised 2026-08-04** | See [JUPITER_ADAPTER_DESIGN.md](JUPITER_ADAPTER_DESIGN.md). Depends on #1 and #2. Not started in code. **Founder decision: move this EARLIER in the roadmap** — indexing the ecosystem AMM pools on Jupiter from day one routes external swap volume through them, and every routed swap pays the protocol fee into `market_vault` → hiSOLA stakers. Maximizing fees from launch is the goal. ⚠️ Scope note to settle when we resume: this is about the **ecosystem pools (LST/stable/partner)**, NOT SOLA — SOLA stays out of Jupiter routing (no SOLA pool, §4). Open question kept from §4: these pools are shallow vs incumbent Raydium/Orca LST pools, so weigh expected routed volume before spending the adapter effort. Decision is to prioritize; the volume question is to be answered, not ignored. |

---

## 2. Contract-level checklist

Consolidated from prior session notes; already-shipped items kept for the record.

- [x] Emergency pause (`pause`/`unpause`, `SetPaused`) — shipped 2026-05-30
- [x] `transfer_authority` instruction — shipped 2026-06-01
- [x] Squads v4 multisig (1-of-2), vault `BxYTiKyDxWpK4hPDZEiYVW9qBj8YpzhSHEBCWpaZbWQ4`
- [x] Security review findings (10 findings, 2026-05-29/30) — all corrected
- [x] Trident fuzzing — bonding curve + flash arb, 0 panics / 0 invariant violations over ~200k calls
- [x] Vote-weight cap 30% per address
- [x] `EPOCH_DURATION` — already 604800s (7 days) in `state.rs`, correct for mainnet as-is
- [x] **Phase gating flags** (`lp_enabled` / `bribes_enabled` / `voting_enabled` / `exercise_enabled` / `curve_enabled` / `emissions_enabled` + `set_phase_flags`) — flags 1–5 coded 2026-07-08; **`emissions_enabled` added 2026-07-24** (6th flag, master switch for ALL oSOLA emission — gates `emit_pool_rewards` AND the continuous stream via `continuous_active`; makes "emission dormant" explicit rather than inferred from the transitive no-votes coupling, so the untested per-epoch cycle stays descoped from the launch audit → reviewed pre-Genesis). Local only (not built/deployed/pushed by explicit founder decision). All default `false`; `curve_enabled` gates `buy_sola`; `flash_arbitrage` honors `exercise_enabled`; `voting_enabled` gates `vote_gauge` **and** `replay_vote` + `burn_o_sola_for_votes`. **IDL rebuilt + copied to `app/lib/soladrome.json` 2026-07-24** (`set_phase_flags` signature grew to 6 args; `ProtocolState::LEN` stays 416 — bool carved from spare bytes, `cargo check` clean, no realloc/migration).
  - ⚠️ **Post-upgrade flag-flip is MANDATORY — the upgrade bricks entry paths otherwise.** The six flags are written only in `initialize` (one-time, already ran on the live devnet `ProtocolState`). After `solana program deploy` the existing account's spare bytes read `false`, so `buy_sola` / `create_pool` / `exercise_o_sola` / `deposit_bribe` / `vote_gauge` / `replay_vote` / `burn_o_sola_for_votes` / `flash_arbitrage` all revert `FeatureDisabled` **and both emission paths (`emit_pool_rewards` + the continuous stream) stay dormant** until the authority calls `set_phase_flags`. There is no migration in `initialize` for the already-initialized singleton.
    - **Devnet (keep tester flow alive):** immediately after deploy run `yarn ts-node scripts/set_phase_flags.ts` (enables all six, emission included — otherwise devnet oSOLA emission dies after the upgrade). Verify the printed `post-state` shows all `true`.
    - **Mainnet (two-stage, deliberate):** at stage-1 go-live run `scripts/set_phase_flags.ts lp bribes voting` (curve + exercise + **emissions** stay `false`); at stage-2 public open flip curve/exercise as one event with TGE + airdrop (`scripts/set_phase_flags.ts curve exercise`). **`emissions` stays `false` until the per-epoch emission cycle (Finding A) is audited pre-Genesis + the bankrun harness is written** — never flip it at launch. Never run the enable-all form on mainnet.
- [ ] **`OSOLA_EMISSION_PER_SEC` / continuous emission rate** — calibrate at mainnet deploy time (devnet value is a high test rate, not a mainnet number)
- [x] **Founder unstake lock** — ✅ **solved structurally 2026-07-17, no vesting-aware check needed.** `claim_founder_hi_sola` now mints the 7M straight into the founder's `ve_lock_vault` (the `claim_partner_allocation` pattern), so the hiSOLA never reaches a wallet: `unstake_hi_sola` has nothing to act on and the unstake→SOLA→sell bypass is unreachable rather than merely checked. `unlock_hi_sola` additionally rejects `FOUNDER_WALLET` outright (locked for life). Two further consequences fall out for free: the 7M stay out of `total_hi_sola`, so the reserve **captures no protocol fees** (it was on track for ~89% of them), and the wallet balance stays 0, so `borrow_usdc` is blind to it and the 20% `founder_borrow_usdc` cap **stops being bypassable via the uncapped sibling instruction**. Liquidity remains available through `borrow_against_locked` (20%, open to any ve-locker). Covered by tests — see §2c.
- [x] **`collect_to_pol` over-credits stakers — fee-accounting solvency bug** — ✅ **FIXED 2026-07-18 in commit `3b32b03`** (shipped alongside the ve escrow work; this line said "NOT fixed" until 2026-08-05, which was simply stale — the code had been correct for two and a half weeks). The bug: the accumulator advanced on the **full** `market_balance` and only then transferred `amount` out, so `fees_per_hi_sola` promised more than `market_vault` held and `claim_fees` / `stake_sola` reverted with a raw SPL "insufficient funds" once cumulative POL collections exceeded the unclaimed remainder. **The fix** ([pol.rs:66](programs/soladrome/src/pol.rs)) advances on `market_balance - amount`, plus a solvency guard the original analysis did not propose: `require!(market_balance - amount >= last_market_vault_balance)`. That guard settles the economic question that was left open here — **POL is junior to fees already credited and senior only within the fresh, uncredited growth**. It can never skim a USDC a staker has been promised. Operational consequence: `collect_to_pol` **reverts** when there is no uncredited growth (e.g. right after a `stake_sola` or `claim_fees` advanced the accumulator to the full balance), so POL collection is opportunistic, not schedulable. Test hardened to collect **100% of the uncredited growth** — the worst case — instead of the ~10% that used to mask it.
- [ ] **M-05 double-vote** — hiSOLA is a standard SPL token (transferable), theoretical double-vote risk. Accepted as a low-severity architectural limitation; address post-mainnet only if governance capture becomes a real concern.
- [ ] **Genesis Airdrop on-chain distribution instruction** — mint/transfer 200K SOLA (180K Genesis Tester pool split equally among sybil-filtered eligible wallets, 20K bug bounty manual) directly on-chain, no manual claim. Eligibility = `onchain_eligible.json` from the anti-sybil scripts, **not** the raw `quest_completions` table (97% bot rate found there previously). To be built **after** the devnet snapshot, not before.
- [ ] **Meme-art contest payout — 3 winners × 50 SOLA (150 total), due at TGE** (judged 2026-08-28). Announced to testers as "50 $SOLA each", so it must land as **SOLA, not oSOLA** — the ecosystem 1.75M budget can only issue oSOLA (`distribute_o_sola`), and 50 oSOLA would cost the winner 50 USDC to exercise, which is not what was promised. Fund it from the team tranche or a curve buy, not from the ecosystem budget. Winner wallet list is held **off-repo** (deliberately: a public list of addresses owed tokens at TGE is a phishing target) — see the founder's notes; source of truth is `meme_submissions` in Supabase.
- [ ] **Jupiter `Amm` adapter** — see §1 and [JUPITER_ADAPTER_DESIGN.md](JUPITER_ADAPTER_DESIGN.md). **Clarified 2026-08-04: the adapter is an OFF-CHAIN crate** (no CPI, not in the program binary — design §2), so it adds **nothing** to the audit quote. Build it on the v1 timeline, but keep two separate gates: *submit for indexing* only after the audit clears (the gate was never the adapter, it is routing external volume into an unaudited AMM), and only once the pools clear a depth worth routing to. **Fees follow depth, not integration** — protocol take is `fee_rate × protocol_fee_bps` ≈ 6 bps of routed volume at a 30 bps pool with a 20% protocol share, so ~$1M routed ≈ $600 to `market_vault`. Needs a quote-vs-execution parity harness (engineering, not audit budget).
- [x] **oSOLA exercise fee** — ✅ **IMPLEMENTED 2026-08-05.** See [OSOLA_EXERCISE_FEE_DESIGN.md](OSOLA_EXERCISE_FEE_DESIGN.md). Fee proportional to the gain (never flat), priced off the curve (`virtual_usdc / virtual_sola`, oracle-free and manipulation-resistant), charged **on top of** the strike and never carved out of it, routed to `market_vault`. Supersedes the 2026-06-21 "hybrid exercise" — **the locked-hiSOLA branch is dropped**, because `unstake_hi_sola` already enforces borrow-as-lock (`usdc_borrowed <= remaining`) and a time-lock only defers the dump.
  - **Rate: `DEFAULT_EXERCISE_FEE_BPS = 1_000` — 10% OF THE GAIN**, hard-capped at 50% by `MAX_EXERCISE_FEE_BPS`. ⚠️ Do **not** restate this as "2% like the borrow fee": `BORROW_FEE_BPS` is a share of the *notional borrowed*, this is a share of `(curve_price − 1) × amount`. 2% on the gain would be ~0.02 USDC/SOLA at a curve price of 2 and would leave the oBERO cannibalisation problem essentially unaddressed. At 10% the exerciser still pays 1.10 for an asset worth 2 (+82%).
  - New field `ProtocolState.exercise_fee_bps` (u16) — **carved from spare bytes, `LEN` stays 416, no realloc, no migration** (static assert verified by `cargo check`). Live singletons read **0** → today's zero-fee behaviour persists until the authority calls `set_exercise_fee`. Unlike the phase flags, **forgetting this flip breaks nothing** — it only forgoes revenue, irreversibly, for everything exercised in the gap.
  - ⚠️ **That is exactly why it is dangerous, and why the order is now written into §7 Stage 2 rather than only here.** A missing phase flag reverts every call and gets fixed within minutes; a missing fee lets the protocol run perfectly while collecting nothing, and nobody files a bug. This entry stated the fact from 2026-08-05 and the launch sequence still said "flip `exercise_enabled`" with no mention of it — a fact documented in a checklist but absent from the procedure is a fact that will be missed. Tooling: **`scripts/set_exercise_fee.ts`** (added 2026-08-13; `--check` dry-runs it and warns if the flag is already on).
  - New authority-only instruction `set_exercise_fee(bps)`. `ExerciseOSola` gained a `market_vault` account.
  - Accumulator handling: `exercise_o_sola` deliberately does **not** advance `fees_per_hi_sola` nor touch `last_market_vault_balance` — same lazy pattern as `buy_sola`. The fee is credited by the next staker interaction, from the real vault balance. Covered by a dedicated test.
  - Tests: 3 new (`35 passing` on localnet), including the load-bearing assertion that `floor_vault` receives the **full** strike and `total_purchased_sola` increments only by the financed amount.
  - IDL rebuilt + copied to `app/lib/soladrome.json`; frontend `Exercise.tsx` shows the fee and total before signing, and the balance check covers strike + fee.

## 2b. ☢️ Pre-deploy artifact verification — MANDATORY, RUN ON THE EXACT `.so` YOU SHIP

`FOUNDER_WALLET` is feature-gated (added 2026-07-17) and **`devnet` is a DEFAULT feature**. A plain
`anchor build` therefore produces a binary whose founder is `DJZFZSBGCuo3X79hEVqPjzdkKF5aVDVNCaFyW8g5QS6i`
— a throwaway key **committed at `tests/keys/founder-devnet.json`**. Deploying that to mainnet hands
the entire 12.25M founder allocation to anyone who reads the repo. `VESTING_CLIFF_SECS` rides the
same flag (5 s vs 180 days), so a wrong build gives away the wallet **and** the timelock together.

The constant is a `&str`, so it is literally readable in the binary. Verify the artifact, not your
intent — this catches a wrong flag, a stale cache, the wrong terminal, or the wrong `.so`:

```bash
# Build for mainnet — the safe build is NOT the default
cargo build-sbf --arch v3 --no-default-features

# Gate: refuse to deploy unless the binary carries the real Ledger and not the test key
strings target/deploy/soladrome.so | grep -q "DJZFZSBGCuo3X79hEVqPjzdkKF5aVDVNCaFyW8g5QS6i" \
  && { echo "☢️  STOP — devnet build: throwaway founder key"; exit 1; }
strings target/deploy/soladrome.so | grep -q "46AqfBuHfgae9s5FK9RSHFExK5mJGiaPJhA9TFXc2Nw4" \
  || { echo "☢️  STOP — mainnet Ledger absent from binary"; exit 1; }
echo "✅ artifact carries the mainnet founder wallet"
```

Verified 2026-07-17: a devnet build greps 1 hit on the test key and 0 on the Ledger — the check
discriminates correctly.

**Consider inverting the default** (`default = ["devnet"]` → `default = []` in
`programs/soladrome/Cargo.toml`) so the safe build is the reflex one and the dangerous build needs
an explicit `-- --features devnet`. Cost: every test/devnet command gains the flag, and a naive
`anchor test` fails the founder tests. The artifact check above is the stronger guard of the two
(it verifies the thing, not the intent); inverting is complementary, not a substitute.

## 2c. Test coverage — founder path (new 2026-07-17)

The 12.25M founder allocation had **zero test coverage** until 2026-07-17 — not an oversight:
`FOUNDER_WALLET` was an ungated Ledger address, and no test can sign for a Ledger. The `devnet`
gate (§2b) exists to make this path reachable at all. Four tests in `tests/soladrome.ts`:

| Test | Proves |
|---|---|
| `[founder] burn_o_sola_for_votes rejects the founder wallet` | The 5M oSOLA are not an **uncapped** vote path around the muzzle on the 7M (the oSOLA bonus bypasses the 30% per-address cap by design). |
| `[founder] claim_founder_hi_sola escrows into the ve lock, never the wallet` | hiSOLA lands in `ve_lock_vault`; **wallet stays 0** (borrow_usdc blind); **`total_hi_sola` unchanged** (no fee capture). |
| `[founder] unlock_hi_sola rejects the founder — locked for life` | The reserve can never return to a wallet. |
| `[curve] k is mainnet-scale` | `k = 1e24`, not the old `1e16` (Beradrome's doc example). |

Run with `anchor test --provider.cluster localnet` — **never plain `anchor test`, which deploys to
devnet** (`Anchor.toml` has `cluster = "devnet"`).

✅ **RESOLVED 2026-08-04 — clean clone runs green (33 passing / 0 failing, ~43 s on localnet).**
The old failure: a fresh `initialize` writes all six phase flags `false`, so `buy_sola` /
`create_pool` / `exercise_o_sola` / the vote paths revert `FeatureDisabled` and ~20 tests cascade —
the suite had only ever run against the live devnet `ProtocolState` where the authority flipped the
flags months ago, so a third party (an auditor) cloning the repo saw ~20 red. **Fixed:** init +
USDC funding + `set_phase_flags(all true)` were moved out of a leading `it()` and into a top-level
`before()` hook in `tests/soladrome.ts`. Because it is a `before()` (not an `it()`), the gates are
opened even for a **filtered / `.only` run of a single test** — the case a plain leading `it()` would
be skipped by the grep and the isolated test would fail `FeatureDisabled`. Verified end-to-end on a
clean localnet: full suite 33/33 green, and `--grep "buys SOLA via bonding curve"` (one gated test in
isolation) passes. The two former setup `it()`s remain as thin state assertions for coverage. Run
with `anchor test --provider.cluster localnet` — **never plain `anchor test`** (`Anchor.toml` has
`cluster = "devnet"`).

## 2d. Founder-flow rehearsal — DONE 2026-07-17 on devnet, with the real Ledger

Full mainnet founder flow rehearsed end-to-end on the last pre-`cfg` devnet deploy (the only window
where the Ledger was the on-chain founder). On-chain record, wallet `46Aqf…`:

| Test | Result |
|---|---|
| `claim_founder_hi_sola` | ✅ 2,825,034 hiSOLA minted **into the lifetime ve escrow** — wallet received zero |
| `vote_gauge` | ✅ rejected — `FounderVotingDisabled` ("dormant anti-capture reserve") |
| Oversized borrow | ✅ rejected — `BorrowExceedsFloorBuffer` (75% buffer live) |
| In-headroom borrow (100K) | ✅ passed, then repaid to restore tester headroom |
| Legacy pre-escrow hiSOLA | unstake + `borrow_usdc` both worked on wallet-held tokens — live demo of the exact bypass the escrow closes; impossible on mainnet (wallet never holds any) |

**☢️ TGE-day requirement found by this rehearsal: BLIND SIGNING.** With blind signing disabled in
the Ledger's Solana app, **every** transaction fails silently client-side — nothing reaches the
chain, and it presents as "the whole protocol is broken". Anchor instructions are unrecognized by
the Ledger app, so blind signing is mandatory. Before ANY mainnet founder/authority operation
(including the Squads stage-flips): Ledger Solana app up to date + **blind signing enabled**, and
verify a transaction actually lands on-chain before concluding anything is broken.

## 3. Deploy-time parameters to set

- `EPOCH_DURATION`: already correct (604800s), no change needed at deploy
- `OSOLA_EMISSION_PER_SEC` / continuous emission rate + `continuous_end_epoch`: calibrate for mainnet bootstrap (devnet ran 413360 base/s ≈ 250k oSOLA/epoch/pool over 4 epochs as a beta-test value — not a mainnet recommendation as-is)
- `transfer_authority` → Squads vault `BxYTiKyDxWpK4hPDZEiYVW9qBj8YpzhSHEBCWpaZbWQ4` immediately after `initialize`
- `NEXT_PUBLIC_RPC_URL` → mainnet RPC (MWA cluster derivation follows automatically, see [[project-soladrome]])
- IDL rebuild + copy to `app/lib/soladrome.json` after any contract change before deploy (see [[feedback-anchor-idl-rebuild]])

## 3b. Launch sequence — two-stage gated launch (decided 2026-07-08)

Mainnet opens in two stages, enforced on-chain by the phase flags (§2). Rationale:
partners seed depth and start accumulating locked hiSOLA before the public arrives;
the public lands on a protocol that already has liquidity and active incentives.

**Stage 1 — partner-only window (all flags `false` at `initialize`, then per-partner enables):**
1. `initialize` → `transfer_authority` to Squads vault.
2. `register_partner` for each signed founding partner (tier cap, bribe mint, 1:1 rate).
3. `set_phase_flags(lp_enabled = true)` — partners create/seed their pools (non-SOLA pairs only, per §4).
4. `set_phase_flags(bribes_enabled = true, voting_enabled = true)` — partner bribes start converting 1:1 into locked hiSOLA up to tier caps; partners vote their gauges.
5. **Curve stays CLOSED** (`curve_enabled = false`): the curve price is monotonically increasing, so an open curve would let snipers buy the cheapest SOLA ahead of the community airdrop. Partners don't need it (hiSOLA via partner program, LP on non-SOLA pools).
6. `exercise_enabled` stays `false` — exercise is meaningless while the floor vault is unfunded, and `flash_arbitrage` is gated with it.

**Stage 2 — public open (one event):**
1. `set_phase_flags(curve_enabled = true)` + Genesis Airdrop on-chain distribution (§2) in the same window → curve opening = TGE = airdrop.
2. ☢️ **`scripts/set_exercise_fee.ts 1000` FIRST — before the flip, never after.** `exercise_fee_bps` is written only by `initialize`, and the field was added 2026-08-05, after every live singleton was initialized. A live `ProtocolState` therefore reads it out of spare bytes as **0**, meaning NO FEE. This is the same migration artefact as the phase flags themselves (§2), with one difference that makes it worse: forgetting the flags **bricks** entry paths, which is loud and immediate. Forgetting this one is **silent** — exercise works perfectly and simply charges nothing. Every oSOLA exercised in the gap keeps 100% of its gain, and there is no retroactive charge. Verify with `--check` before and read back `exerciseFeeBps` after.
3. `set_phase_flags(exercise_enabled = true)` once the floor vault has real backing from curve buys — and only once step 2 has confirmed on-chain.

> **Why the order cannot be reversed, in one line:** the flip is what makes the fee collectable, so a fee armed after the flip is a fee that was never charged on everything exercised in between. On mainnet that gap sits next to the curve opening, the TGE and the airdrop, i.e. the busiest window of the launch and the one with the most oSOLA in circulation.

**Hard rules:**
- **Fix the stage-1 duration in advance** (recommendation: 3-4 epochs), announce it publicly, and hold it even if a partner isn't ready — the window must not depend on partner velocity (fBOMB lesson), and a dated window is negotiation leverage.
- Sanity-check the 30% vote cap behavior with only 2-3 voters before stage 1 (partners voting their own gauges is expected during the window).
- Exit paths (`sell_sola`, unstake, repay, remove_liquidity, claims, unlock) are never gated by any flag.

## 4. Liquidity / pools

**2026-07-06 — revised: no SOLA-paired pool at launch.** Superseded the earlier
"1 external SOLA/jitoSOL pool" plan below. Reasoning: the bonding curve
(System 1) has no on-chain rebase — its virtual-reserve price only ever moves
up (only `buy_sola`/`deploy_pol` touch it, `sell_sola` never does, see
[JUPITER_ADAPTER_DESIGN.md §6](JUPITER_ADAPTER_DESIGN.md)). Any AMM pool priced
in SOLA creates a second, independent market price for the protocol's core
mechanism that can permanently decorrelate from the curve, with no way to
correct it after the fact. Judged too risky to introduce at launch.

1. **Launch pools — ecosystem-only, no SOLA in any pair:**
   `jitoSOL-SOL`, `mSOL-SOL`, `bSOL-SOL`, `jupSOL-SOL` (LST/SOL),
   `USDC-USDG`, `USDMS-USDC` (stable/stable),
   `renzoETH-ETH` (LST/ETH), `fBOMB-SOL` (partner token — see [[project-mlcb-bridge]]).
   Functionally this launches the AMM + gauge/bribe system as a standalone
   LST/stable liquidity venue (ve(3,3)-style, à la Velodrome/Aerodrome core
   pools), fully decoupled from the bonding curve. hiSOLA governance still
   directs gauge emissions across these pools; external protocols/whales can
   still bribe for votes — the flywheel works without ever touching SOLA price.
2. **Gauge core floor**: once the feature exists, point it at a subset of the
   above (or split across them) rather than a single SOLA house pool — TBD
   which pools get the floor.
3. **Ecosystem allocation seeding (1.75M SOLA)**: the old plan assumed seeding
   a SOLA/jitoSOL pool directly. That's moot now — **needs a new decision** on
   what the ecosystem allocation actually funds under this pool-less-for-SOLA
   strategy (e.g. bribes/incentives on the pools above, rather than direct
   SOLA liquidity).
4b. **2026-08-04 — SOLA-paired and oSOLA-paired variants examined and REFUSED.**
   Two candidates were raised and both are rejected; recording the mechanisms so
   they are not re-litigated:
   - **fBOMB-SOLA — no.** The pairing asset is irrelevant; the danger is that *any*
     SOLA market creates the exit that makes mass-exercise-and-dump profitable.
     Without one, exercising to sell is pointless (pay 1 USDC, the only exit is the
     floor at 1:1, net zero). With one, `exercise_o_sola` becomes a mint-and-dump
     machine: it mints **outside the curve, without limit**, against a gisement of
     5M founder oSOLA + 1.75M ecosystem + emissions. fBOMB is specifically the worst
     pairing — shallowest (so most manipulable) and it imports a volatile small-cap's
     price into SOLA's own reference.
   - **fBOMB-oSOLA — no, though it is genuinely better.** Credit where due: it does
     **not** ratchet the curve, because exercise is strictly one-way (oSOLA → SOLA,
     verified: no SOLA → oSOLA path exists), so curve output cannot be fed into the
     pool. But it makes the **partner the exit liquidity for Soladrome's own
     inflation** (oSOLA sellers extract fBOMB) — a deal no sophisticated partner
     accepts, and a relationship-killer with the one that does not notice. It also
     re-liquefies unfinanced allocations (holders monetise without ever paying the
     strike, partially reopening what the 2026-07-17 redesign closed), and gives a
     thin, reflexive price signal for the very token that sets LP reward value.
   - **fBOMB-SOL — yes, at launch.** No SOLA in the pair, so no curve risk at all,
     and it is the one candidate where Soladrome can plausibly be the *deepest*
     venue and actually win Jupiter routes (unlike jitoSOL/mSOL/stable pairs, which
     are the most commoditised on Solana — Sanctum/Orca/Raydium already have depth).
   - If an oSOLA market is ever revisited, it pairs with **USDC or SOL** (deep,
     neutral, taxes no partner) — and only after the exercise fee ships, which may
     make it unnecessary.

4c. **⚠️ Open problem — ecosystem pool funding (unresolved, blocks the Jupiter upside).**
   Three funding sources are closed *simultaneously*, which is why the pools have no
   liquidity path today:
   - **Ecosystem allocation cannot do it (denomination mismatch).** The launch pools
     need jitoSOL/SOL/USDC; the 1.75M ecosystem budget is **oSOLA** (since 2026-07-17,
     to close the floor drain). oSOLA is in none of the pairs, and making it liquid
     requires *exercising* — up to 1.75M USDC the treasury does not have — and yields
     SOLA, which by decision goes into no pool. This is an impossibility, not a
     pending decision.
   - **The protocol has no mechanism.** The only protocol-funded seeding path is
     `deploy_pol`, hardcoded SOLA/USDC.
   - **The market has no reason.** An LP earns exactly two things: the LP share of
     swap fees (stays in reserves) and **oSOLA emissions** (`osola_reward_per_lp`).
     With emissions off, only swap fees remain — ≈ 0 on a shallow pool that loses
     routes. Bribes do not fill the gap: **bribes pay voters, not LPs.**
   → Bootstrap circularity: no liquidity → no volume → no fees → no reason to supply
   liquidity. The normal ve(3,3) circuit-breaker is emissions, which is exactly what
   the full-scope audit decision (§1) unlocks. Remaining lever if it is still thin:
   contractualise seeding in the partner deal (welcome bag against a dated, quantified
   liquidity commitment — the fBOMB lesson is that partner velocity cannot be relied on).

5. **Whether SOLA ever gets an AMM pool is an open question**, not scheduled:
   no anti-decorrelation mechanism is designed, so there's currently no
   condition/trigger defined for revisiting this — it's a standing default,
   not a "phase 2" on a timeline. Revisit if/when a peg-safety mechanism is
   designed, not on a fixed date.
5. **Jupiter adapter**: still relevant generically for System 2 (the design in
   [JUPITER_ADAPTER_DESIGN.md](JUPITER_ADAPTER_DESIGN.md) doesn't depend on the
   pool being SOLA-denominated) — but SOLA itself is explicitly out of scope
   for Jupiter routing per this decision. If pursued, it would apply to the
   ecosystem pools above, which already compete against much deeper incumbent
   pools on Raydium/Orca for the same LSTs — worth weighing whether that's
   worth the adapter effort before the audit/POL prerequisites even clear.

<details>
<summary>Superseded — original SOLA/jitoSOL house pool plan (kept for record)</summary>

1. Launch: one external pool SOLA/jitoSOL (Raydium/Orca), modest liquidity — visibility, USD pricing, routing, LST yield. No SOLA/USDC pool.
2. Gauge core floor pointed at that pool once the feature exists (fixed emission share independent of votes).
3. Manual seed from ecosystem allocation (1.75M SOLA) or founder allocation (250K SOLA) — no code required.
4. Phase 2, post-audit: Jupiter adapter + house pool fee capture into `market_vault`.

</details>

## 5. Launch-adjacent (not blocking, tracked here for visibility)

- Logo/icon (current PWA icons are a green "S" placeholder)
- Production domain finalization
- Mobile Wallet Adapter cluster: derived from `NEXT_PUBLIC_RPC_URL` automatically, no separate action needed at launch (see [[project-soladrome]])

## 6. Frontend — mainnet changes to prepare (added 2026-08-04, resume here)

These are **off-chain** (Next.js `app/`), so none touch the audited Solana
program — but they must land before or at mainnet go-live.

1. **Remove the USDC faucet — MANDATORY for mainnet, and keep it out of any
   frontend/API audit scope.** It is devnet-only (mints devnet USDC from a
   server keypair) and has no meaning on mainnet. Touch points to strip:
   - `app/app/api/faucet/route.ts` (the server route + `FAUCET_KEYPAIR` /
     `FAUCET_USDC_MINT` / `FAUCET_RPC_URL` env)
   - the "Get 500 Test USDC" button in `app/components/BuySell.tsx` (`claimFaucet`,
     ~L27, L157-168) and in `app/components/AmmSwap.tsx` (~L58, L394-405)
   - the `faucet` quest in `app/lib/quests.ts` + its handling in
     `app/app/api/track-quest/route.ts`
   - the "Get SOL + USDC" prompt in `app/lib/program.ts` (~L175)
   > Note: the faucet is not in the *program* audit scope regardless (off-chain);
   > this item is about (a) removing it so mainnet users are never shown a test
   > faucet, and (b) making sure it is never handed to a reviewer as in-scope.

2. **SOLA price source: LP → bonding curve.** Today the frontend derives the SOLA
   price from the **USDC-SOLA AMM pool** (devnet has one — see the `creates an AMM
   pool for SOLA/USDC` test). Mainnet has **no SOLA-paired pool by design** (§4),
   so the UI must price SOLA from the **bonding curve** instead: from
   `ProtocolState.virtual_usdc / virtual_sola` (spot), equivalently
   `price = (1 + U/N)²`. Audit for every place the UI reads a SOLA/USD price off a
   pool and repoint it at the curve; a mainnet build must not assume a SOLA pool
   exists. This is consistent with (and required by) the no-SOLA-pool decision.

---

**How to use this file:** update checkboxes as items land; do not let mainnet-readiness state live only in chat/session memory going forward. Cross-reference designs docs (`*_DESIGN.md`) for anything non-trivial rather than inlining the design here.
