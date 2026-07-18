# Soladrome — Mainnet Runbook

> First pass at a single source of truth for mainnet go-live. Previously this
> checklist only existed scattered across session notes; consolidated here
> 2026-07-06. Keep this file, not chat history, as the checklist going forward.

---

## 1. Blocking prerequisites (must clear before any mainnet deploy)

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | **Security audit** | ⏳ Open | Sec3 quote obtained; Accretion.xyz in the running (warmer relationship + Marinade intro). Blocks: mainnet deploy, Jupiter routing/listing, any external volume. See [[project-soladrome-funding-gtm]]. |
| 2 | **`deploy_pol` rewrite for jitoSOL leg** | ⏳ Open | Currently hardcoded to SOLA/USDC (`pol.rs`). Needed before the SOLA/jitoSOL house pool can be POL-funded. Blocks: house pool liquidity, Jupiter routing (nothing worth routing to without it). |
| 3 | **Jupiter `Amm` adapter** | ⏳ Design only | See [JUPITER_ADAPTER_DESIGN.md](JUPITER_ADAPTER_DESIGN.md). Depends on #1 and #2. Not started in code. |

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
- [x] **Phase gating flags** (`lp_enabled` / `bribes_enabled` / `voting_enabled` / `exercise_enabled` / `curve_enabled` + `set_phase_flags`) — coded 2026-07-08, local only (not built/deployed/pushed by explicit founder decision). All default `false`; `curve_enabled` gates `buy_sola`; `flash_arbitrage` honors `exercise_enabled` (it is an exercise pathway); `voting_enabled` gates `vote_gauge` **and** `replay_vote` + `burn_o_sola_for_votes` (all vote-power paths, fixed 2026-07-11 — `replay_vote`/`burn_o_sola_for_votes` were initially ungated). **IDL rebuilt + copied to `app/lib/soladrome.json` 2026-07-11** (contexts unchanged but `set_phase_flags` signature grew).
  - ⚠️ **Post-upgrade flag-flip is MANDATORY — the upgrade bricks entry paths otherwise.** The five flags are written only in `initialize` (one-time, already ran on the live devnet `ProtocolState`). After `solana program deploy` the existing account's spare bytes read `false`, so `buy_sola` / `create_pool` / `exercise_o_sola` / `deposit_bribe` / `vote_gauge` / `replay_vote` / `burn_o_sola_for_votes` / `flash_arbitrage` all revert `FeatureDisabled` until the authority calls `set_phase_flags`. There is no migration in `initialize` for the already-initialized singleton.
    - **Devnet (keep tester flow alive):** immediately after deploy run `yarn ts-node scripts/set_phase_flags.ts` (enables all five). Verify the printed `post-state` shows all `true`.
    - **Mainnet (two-stage, deliberate):** at stage-1 go-live run `scripts/set_phase_flags.ts lp bribes voting` (curve + exercise stay `false`); at stage-2 public open flip the rest as one event with TGE + airdrop (`scripts/set_phase_flags.ts curve exercise`, or the full set). Never run the enable-all form on mainnet.
- [ ] **`OSOLA_EMISSION_PER_SEC` / continuous emission rate** — calibrate at mainnet deploy time (devnet value is a high test rate, not a mainnet number)
- [x] **Founder unstake lock** — ✅ **solved structurally 2026-07-17, no vesting-aware check needed.** `claim_founder_hi_sola` now mints the 7M straight into the founder's `ve_lock_vault` (the `claim_partner_allocation` pattern), so the hiSOLA never reaches a wallet: `unstake_hi_sola` has nothing to act on and the unstake→SOLA→sell bypass is unreachable rather than merely checked. `unlock_hi_sola` additionally rejects `FOUNDER_WALLET` outright (locked for life). Two further consequences fall out for free: the 7M stay out of `total_hi_sola`, so the reserve **captures no protocol fees** (it was on track for ~89% of them), and the wallet balance stays 0, so `borrow_usdc` is blind to it and the 20% `founder_borrow_usdc` cap **stops being bypassable via the uncapped sibling instruction**. Liquidity remains available through `borrow_against_locked` (20%, open to any ve-locker). Covered by tests — see §2c.
- [ ] **`collect_to_pol` over-credits stakers — fee-accounting solvency bug (found 2026-07-17, NOT fixed)** — `pol.rs:55` advances the fee accumulator on the **full** `market_balance` (crediting stakers 100% of new fees) and only then transfers `amount` out to `pol_usdc_vault`. `fees_per_hi_sola` therefore promises more than `market_vault` holds. Consequence: `claim_fees` — and `stake_sola`, which auto-claims — **revert with a raw SPL "insufficient funds"** instead of paying, once cumulative POL collections exceed the unclaimed remainder. The comment *"Lock in stakers' share before removing from market_vault"* describes the opposite of what the code does. Likely fix: advance the accumulator on `market_balance - amount` so stakers are credited only the post-POL remainder — but that makes POL senior to stakers, which is an economic decision, not a mechanical one. **Same class as the floor drain via unfinanced allocations: an accounting promise the vault cannot honour.** Masked in tests by collecting ~10% (see the comment in `tests/soladrome.ts`); collecting 50% triggers it every time.
- [ ] **M-05 double-vote** — hiSOLA is a standard SPL token (transferable), theoretical double-vote risk. Accepted as a low-severity architectural limitation; address post-mainnet only if governance capture becomes a real concern.
- [ ] **Genesis Airdrop on-chain distribution instruction** — mint/transfer 200K SOLA (180K Genesis Tester pool split equally among sybil-filtered eligible wallets, 20K bug bounty manual) directly on-chain, no manual claim. Eligibility = `onchain_eligible.json` from the anti-sybil scripts, **not** the raw `quest_completions` table (97% bot rate found there previously). To be built **after** the devnet snapshot, not before.
- [ ] **Jupiter `Amm` adapter** — see §1 and [JUPITER_ADAPTER_DESIGN.md](JUPITER_ADAPTER_DESIGN.md)

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

⚠️ **The suite does not run green on a clean state, and never has.** A fresh `initialize` writes all
five phase flags `false` (§2, line on phase gating), so `buy_sola` / `create_pool` / `exercise_o_sola`
revert `FeatureDisabled` and ~20 tests cascade. The suite has only ever run against the live devnet
`ProtocolState`, where the authority flipped the flags months ago. **A third party cloning this repo
sees 20 red — including an auditor.** Fix: a `before()` calling `set_phase_flags` after `initialize`
(the script already exists at `scripts/set_phase_flags.ts`).

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
2. `set_phase_flags(exercise_enabled = true)` once the floor vault has real backing from curve buys.

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
4. **Whether SOLA ever gets an AMM pool is an open question**, not scheduled:
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

---

**How to use this file:** update checkboxes as items land; do not let mainnet-readiness state live only in chat/session memory going forward. Cross-reference designs docs (`*_DESIGN.md`) for anything non-trivial rather than inlining the design here.
