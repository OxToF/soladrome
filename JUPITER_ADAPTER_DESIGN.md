# Soladrome — Jupiter Routing Adapter Design
## Getting the native AMM indexed and routable by Jupiter

> Status: **Design phase** — implementation gated on prerequisites below.
> Not started in code. This doc is the reference for when those gates clear.
>
> **2026-07-06 — scope narrowed: SOLA is explicitly out of scope.** Launch
> decision (see [MAINNET_RUNBOOK.md §4](MAINNET_RUNBOOK.md)) is that no AMM
> pool will ever be denominated in SOLA at launch — the bonding curve has no
> rebase, so an AMM-priced SOLA market risks permanent decorrelation from the
> curve, on the protocol's core mechanism. That confirms §6's original
> reasoning even more strongly. Everything below about a "house pool" now
> refers to the ecosystem pools (`jitoSOL-SOL`, `mSOL-SOL`, `bSOL-SOL`,
> `jupSOL-SOL`, `USDC-USDG`, `USDMS-USDC`, `renzoETH-ETH`, `fBOMB-SOL`) — not
> a SOLA pair. Whether Jupiter routing to *those* pools is even worth the
> adapter effort is an open question: they compete for the same liquidity
> against much deeper incumbent pools already on Raydium/Orca.

---

## 1. Why

Two separate things get confused as "Jupiter integration":

- **JUP the token** is already listed in the bribe/vote token registry
  ([tokens.ts](app/lib/tokens.ts), [Vote.tsx](app/components/Vote.tsx)). Unrelated to this doc.
- **Jupiter the aggregator routing volume into the Soladrome AMM** — not integrated.
  No `@jup-ag/*` dependency, no adapter code, no outreach. This is the actual gap.

Per [[project-soladrome-mainnet-pools]], the native permissionless AMM
(`programs/soladrome/src/amm.rs`) earns protocol fees into `market_vault` on every
swap, but is invisible to Jupiter/DexScreener/wallets because it's an unindexed
custom program. Getting Jupiter to route through it is the step that turns a
pool from decorative into a real fee source.

---

## 2. Current state — what already exists

The native AMM is architecturally close to what Jupiter already knows how to model
(a constant-product `xy=k` pool), which keeps the adapter surface small:

| Piece | Where | Jupiter-relevant property |
|---|---|---|
| Constant-product quote math | `amm_math::swap_out()` | Plain `xy=k`, no exotic curve — straightforward to mirror off-chain |
| Fee model | `amm.rs::swap()` lines 457–480 | Flat `fee_rate` bps + `protocol_fee_bps` share to `market_vault`, deducted from `amount_in` before the constant-product math |
| Reserves | `AmmPool.reserve_a` / `reserve_b` | Cached directly on the pool account — a quote needs **one** account fetch, not a vault balance read |
| Pool discovery | PDA `[b"amm_pool", mint_a, mint_b]`, mints sorted lexicographically | Deterministic; `getProgramAccounts` filtered by discriminator + mint fields enumerates all pools |
| Output routing flexibility | `Swap` context, `user_token_out` (amm.rs:969) — **intentionally unconstrained on owner** | This is exactly what Jupiter's shared-accounts multi-hop routing needs (direct output to an intermediate account, not just the signer). Already there, not a redesign. |
| Machine-readable layout | `app/lib/soladrome.json` (IDL) | Account structs already decodable without hand-written byte offsets |

Net: the on-chain program doesn't need to change shape for this. The work is
entirely a new off-chain adapter crate plus the process/prerequisites around it.

---

## 3. Gap analysis — what's missing to be routable

1. **No `Amm` trait adapter exists.** Nothing implements
   [`jupiter-amm-interface::Amm`](https://github.com/jup-ag/rust-amm-implementation)
   (`from_keyed_account`, `get_accounts_to_update`, `update`, `quote`,
   `get_swap_and_account_metas`). This has to mirror `amm.rs::swap()`'s fee math
   and `amm_math::swap_out()` exactly — any drift between the off-chain quote and
   on-chain execution shows up as failed or badly-slipped swaps for end users
   routed through Jupiter.

2. **Audit not done — hard blocker.** Per prior decision, no significant external
   volume should route through the custom AMM program pre-audit. This is the
   top-priority gate; the adapter can be designed and even written against this
   gate, but should not be submitted for indexing/listing before it clears.

3. **`protocol_state.paused` isn't modeled off-chain.** `amm.rs:459` can revert
   any swap at any time if the protocol is paused. The adapter's `quote()` must
   read `ProtocolState.paused` (add it to `get_accounts_to_update`) and return no
   route while paused — otherwise Jupiter will happily route into swaps that revert.

4. **~~POL rewrite~~ — moot for now.** `deploy_pol` is still hardcoded to
   SOLA/USDC (`pol.rs`), but this blocked the old SOLA/jitoSOL house-pool plan,
   which is superseded (see banner above and [MAINNET_RUNBOOK.md §4](MAINNET_RUNBOOK.md)).
   The launch pools (`jitoSOL-SOL`, `mSOL-SOL`, etc.) aren't SOLA-denominated,
   so they aren't funded via `deploy_pol` at all — funding source for these
   (ecosystem allocation bribes? partner-seeded LP?) is a separate open
   question, not a Jupiter-adapter blocker.

5. **Pool curation / junk pools — largely resolved by the small, fixed pool set.**
   The AMM is permissionless in general (anyone can create a pool for any pair,
   and devnet already shows wildly unbalanced reserves on some junk pools — see
   the 2026-07-04 diagnostic in [[project-soladrome-mainnet-pools]]), but the
   *launch* scope is only the 8 named ecosystem pools. That makes the practical
   answer simple: **off-chain hardcoded allow-list in the adapter crate** (a
   fixed list of 8 pool pubkeys), not a generic filtering mechanism and not an
   on-chain field. No contract change, no redeploy to adjust — just update and
   redistribute the adapter crate if the pool set changes. Revisit a more
   general curation mechanism only if the pool set grows large enough that a
   hardcoded list becomes unwieldy.

6. **License terms not re-checked against this specific use.** `LICENSE` is
   BUSL-1.1 with an Additional Use Grant permitting "interacting with deployed
   instances of the Licensed Work" and forbidding only a competing *hosted
   service*. Jupiter routing to Soladrome's own deployed program is "interacting
   with a deployed instance," not hosting a competing service — reads as
   permitted, but worth a final read against Jupiter's own submission terms
   before going public with the adapter source (Jupiter typically wants the
   adapter crate, not necessarily the on-chain program, open-sourced).

7. **No off-chain scaffolding.** The Cargo workspace (`Cargo.toml`) only has
   `programs/*` as members — no crate exists yet for an off-chain adapter. Needs
   its own workspace member (does not touch the on-chain program's build).

8. **No outreach started.** Unlike the Jito partnership (open Discord ticket,
   see [[project-soladrome]]), there's no contact with the Jupiter team and no
   listing/indexing request filed.

---

## 4. Adapter design (for when gates clear)

New workspace member, e.g. `adapters/soladrome-jupiter-amm/`, **not** part of the
on-chain program build (`programs/*`). Depends on `jupiter-amm-interface` +
`anchor-lang` (for account deserialization only, no CPI).

```rust
pub struct SoladromeAmm {
    key: Pubkey,           // pool PDA
    pool: AmmPool,         // last-synced state
    protocol_paused: bool, // last-synced ProtocolState.paused
    protocol_state: Pubkey,
    market_vault: Pubkey,
    program_id: Pubkey,
}

impl Amm for SoladromeAmm {
    fn from_keyed_account(keyed_account: &KeyedAccount, ...) -> Result<Self> { .. }

    fn get_accounts_to_update(&self) -> Vec<Pubkey> {
        // pool account (reserves) + global ProtocolState (paused flag)
        vec![self.key, self.protocol_state]
    }

    fn update(&mut self, accounts_map: &AccountMap) -> Result<()> {
        // re-deserialize AmmPool + ProtocolState.paused from the fetched accounts
    }

    fn quote(&self, params: &QuoteParams) -> Result<Quote> {
        // 1. if protocol_paused -> Err (no route)
        // 2. mirror amm.rs::swap() exactly:
        //    fee_total = amount_in * pool.fee_rate / 10_000
        //    amount_in_net = amount_in - fee_total
        //    out = amm_math::swap_out(reserve_in, reserve_out, amount_in_net)
    }

    fn get_swap_and_account_metas(&self, params: &SwapParams) -> Result<SwapAndAccountMetas> {
        // Build the exact account list from the `Swap` context in amm.rs:944 —
        // pool, token_a_vault, token_b_vault, user_token_in, user_token_out,
        // market_vault, protocol_state, token_program. user_token_out can point
        // at Jupiter's intermediate account for multi-hop (already unconstrained
        // on-chain, see §2).
    }
}
```

Key point: `quote()` and `get_swap_and_account_metas()` must be **numerically
identical** to the on-chain instruction, not just "close." Any rounding or
ordering difference between `amm_math::swap_out` and the adapter's copy of it
is a quoted-vs-executed price mismatch, which either fails the transaction
(slippage) or — worse — silently gives users a worse fill than quoted.

---

## 5. Sequencing

1. **Audit** (blocking — no code work below should be treated as "launch-ready" until this clears).
2. **Decide whether the ecosystem pools have enough real liquidity/volume to be
   worth routing at all** — they compete against deeper incumbent pools on
   Raydium/Orca for the same tokens; routing Jupiter to a shallower Soladrome
   pool may just never win a route. Worth a liquidity check before investing
   in the adapter.
3. Write the adapter crate against devnet, test quote-vs-execution parity directly
   (build both a quote and the real swap tx for the same inputs, diff the amounts).
   Hardcode the allow-list to the 8 named ecosystem pools (§3.5).
4. Open-source (or submit privately, per Jupiter's process) the adapter crate;
   file the listing/indexing request with the Jupiter team.
5. Add to [MAINNET_RUNBOOK.md](MAINNET_RUNBOOK.md) as a go-live gate.

---

## 6. Open questions

- Does Jupiter require the on-chain program itself to be open-sourced, or is
  submitting just the adapter crate sufficient? (Affects whether BUSL-1.1
  program source needs a separate disclosure decision.) — not yet verified
  against Jupiter's current integration process.
- ~~Pool curation~~ — resolved for launch scope: off-chain hardcoded allow-list
  of the 8 named pools, see §3.5. Revisit only if the pool set grows large.
- **SOLA (System 1, the bonding curve) is excluded from Jupiter routing —
  decided, not just recommended** (2026-07-06, see banner above and
  [MAINNET_RUNBOOK.md §4](MAINNET_RUNBOOK.md)): no AMM pool will be
  SOLA-denominated at launch, so there's nothing SOLA-related to route to
  regardless of the `Amm`-trait mismatch argument below. Original reasoning
  kept for record: the curve's floor/redemption mechanics don't map to a
  constant-product `Amm` trait cleanly (buy price is a monotonic-increasing
  primary-issuance curve, sell price is a fixed 1:1 floor redemption — not two
  sides of one market), and routing arbitrage volume into `buy_sola` would
  permanently move the curve price with no on-chain rebase to correct it.
- **New (2026-07-06): is a SOLA AMM pool ever coming back?** No anti-decorrelation
  mechanism is designed, so there's no trigger/date to revisit this — standing
  default, not a scheduled phase 2.
- **New (2026-07-06): funding source for the ecosystem pools** — the old plan
  (seed a SOLA/jitoSOL pool from the 1.75M SOLA ecosystem allocation) doesn't
  apply to non-SOLA pools. Unresolved whether the ecosystem allocation funds
  bribes/incentives on these pools instead, or whether liquidity comes purely
  from the partner protocols themselves.
