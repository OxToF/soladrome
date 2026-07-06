# Soladrome — Confidential Sealed-Bid Bribe Auctions
## "ve(3,3) bribe markets without the front-running"

> Confidential compute layer for the gauge/bribe system, built on **Arcium** (MPC / MXE).
> Status: **Exploratory design** — gated on (a) Arcium design-partner / grant interest and
> (b) main audit + mainnet on track. **No Arcis code is written before that conversation.**
> This document is both the internal conviction test and the Arcium approach memo.

---

## 1. Why this, and not a "confidential institutional pool"

The obvious idea — a confidential/dark pool for institutions trading SOLA — does **not** fit
Soladrome today:

- Soladrome's core value (bonding curve, **1 USDC floor**, gauge votes) is *publicly verifiable
  by construction*. Confidentiality there destroys the product, not improves it.
- Dark-pool value scales with **deep liquidity** and **large traders who fear being seen**.
  A single-token, pre-mainnet protocol has neither. Institutions don't trade SOLA in size.

The confidentiality that *does* create value lands on Soladrome's actual differentiator: the
**ve(3,3) bribe / gauge market**. That market has a real, well-known pathology that
confidential compute genuinely fixes — and it puts Arcium's **sealed-bid auction** primitive
front and center.

---

## 2. The problem (today's transparent gauge)

Current flow (see `CLAUDE.md` → Gauge/Bribe system):

- 7-day epochs (`EPOCH_DURATION = 604_800`). Bribes are deposited into `BribeVault` PDAs during
  epoch N; votes (`UserVoteReceipt`, cumulative ≤ hiSOLA balance) allocate gauge weight in
  `GaugeState`; claims open only after epoch N closes.
- **Everything is visible in real time**: every bribe amount, every vote, the running tally.

That transparency produces the classic ve(3,3) failure modes:

1. **Vote-sniping / last-mover advantage** — voters wait until the final block to see where
   bribes and votes landed, then pile onto the best $/vote. Early honest voters are penalized.
2. **Bribe wars are observable** — a briber sees a competitor's bid and tops it by 1 unit at the
   deadline. Value leaks to snipers instead of the protocol/voters.
3. **Mercenary copy-voting** — large voters' choices are public and blindly mirrored, distorting
   true preference signal.

These are not edge cases; they are *the* reason ve(3,3) bribe markets are inefficient.

---

## 3. The mechanism — sealed-bid bribes via Arcium MXE

Briber bids (and, in a later phase, votes) are submitted **encrypted** during the epoch,
computed inside an Arcium **MXE** (Multiparty eXecution Environment), and only the **result**
is revealed on-chain at epoch close via callback. No participant sees others' inputs before
resolution.

```
EPOCH N (open)                          EPOCH N close (settlement)
──────────────                          ──────────────────────────
briber → encrypt(bid)  ─┐
voter  → encrypt(votes) ─┼─► on-chain commitment PDAs (ciphertext + voter pubkey)
                         │
                         ▼
            ┌─────────────────────────────┐
            │  Arcium MXE (Arcis program)  │  triggered at epoch boundary
            │  • verify voting-power snap   │
            │  • tally votes per pool       │
            │  • allocate sealed bribes     │
            └──────────────┬──────────────┘
                           │ callback (authenticated)
                           ▼
            on-chain: write GaugeResult{pool → weight, bribe→voter splits}
                           │
                           ▼
            claims proceed exactly as today (UserBribeClaim init-PDA guard)
```

**Phasing (build only what earns the grant):**

- **Phase 1 — sealed bribes only.** Briber amounts are hidden until close; votes stay public.
  Smallest surface, kills the bribe-war sniping directly, preserves ve accountability
  (you can still see who voted). This is the MVP and the showcase.
- **Phase 2 — sealed votes.** Hide vote allocation too. Stronger anti-snipe, but trades off ve
  transparency/accountability — only if Phase 1 proves the model and the community wants it.

---

## 4. Mapping onto the existing program

Minimal new on-chain surface; reuse the current PDA + init-guard patterns:

| Existing | Change |
|---|---|
| `BribeVault [b"bribe_vault", pool_id, reward_mint, epoch]` | Tokens still escrowed here; bid **amount/allocation** moves to an encrypted commitment |
| `GaugeState [b"gauge", pool_id, epoch]` | Final weights written by MXE callback instead of incremented live |
| `UserVoteReceipt [b"vote", user, pool_id, epoch]` | Phase 2: replaced by encrypted vote commitment PDA (same `init` double-vote guard) |
| `UserBribeClaim [b"bribe_claim", ...]` | **Unchanged** — claims still gated on post-close result + `init` replay guard |
| — new — | `SealedBid [b"sealed_bid", briber, pool_id, epoch]` : ciphertext + briber pubkey |
| — new — | `GaugeResult` : MXE-signed tally, written once at close, immutable |

The MXE is an **Arcis** (Rust DSL) program; Soladrome's Anchor program calls it and receives the
result through an authenticated callback. The bonding curve, floor, AMM, staking — **all
untouched**. Confidentiality is surgically applied to the one place where opacity is an
advantage.

---

## 5. Security considerations (carry over Soladrome's existing discipline)

- **Voting-power snapshot** — power is fixed at epoch start (snapshot of hiSOLA), computed inside
  the MXE; no mid-epoch power inflation. (Same principle as the oSOLA exercise redesign guard.)
- **Founder out of gauge** — existing invariant preserved; founder allocation never votes.
- **Double-submit / replay** — reuse the `init`-PDA guard pattern (one `SealedBid` /
  vote-commitment per (user, pool, epoch); fails on replay, exactly like `UserVoteReceipt`).
- **No early decryption** — MXE design must guarantee inputs cannot be decrypted before the epoch
  boundary, even by a colluding subset below the MPC threshold. This is the core property to
  validate with Arcium.
- **Callback authentication** — only the MXE's authorized callback may write `GaugeResult`;
  treat as a privileged instruction with a fixed authority.
- **Liveness / fallback** — if the MXE fails to settle an epoch, define a safe fallback (e.g.
  bribes refundable to bribers, votes void) so funds never lock. Pre-audit requirement.
- **Reentrancy with claims** — `GaugeResult` is write-once and must be final before any
  `UserBribeClaim` opens (already the post-close ordering today).

---

## 6. Why this is fundable by Arcium (not grant-chasing)

- **Showcases their headline primitive** — sealed-bid auctions / confidential order flow, applied
  to a live ve(3,3) economy, not a toy demo.
- **Novel** — "first sealed-bid bribe market in ve(3,3) on Solana" is a defensible, specific
  claim. Generic "confidential pool" is not.
- **Native, not bolted on** — confidentiality sits on Soladrome's real differentiator (bribes),
  so the integration is credible rather than cosmetic.
- **Right phase for them** — Arcium is mainnet *alpha*, actively recruiting design partners;
  a real economic use case with a security-minded builder is exactly their target.

**The ask order matters:** approach Arcium for a **design-partnership / grant that funds the
R&D**, using this memo. Do **not** build Arcis first hoping for reimbursement.

---

## 7. Go / no-go gates

Build proceeds **only if both** hold:

1. **Arcium engages** — design-partner slot, technical support, and/or grant confirmed.
2. **Soladrome fundamentals on track** — main audit delivered + mainnet live + initial real
   liquidity. Confidential bribes are a V2 narrative, never a pre-audit distraction.

Until then: this document is the deliverable. It tests the conviction internally and opens the
door at Arcium — at zero implementation and zero audit cost.

---

## 8. Open questions for the Arcium conversation

- Threshold model + collusion assumptions: what guarantees no pre-close decryption?
- MXE settlement latency vs. the 7-day epoch boundary — comfortably within, but confirm.
- Cost per epoch settlement (MPC compute) — does it fit a small-protocol budget at mainnet?
- C-SPL relevance: are encrypted token balances needed, or only encrypted bid *values*?
- Audit surface: does the MXE/Arcis program need separate audit, and does Arcium support that?
