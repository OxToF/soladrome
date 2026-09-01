# STATUS — where Soladrome actually is

One living document. If something here disagrees with another file in this repository, this
file is the one to trust, and the other file is the one to fix.

**Last measured: 2026-09-01.** Every figure below was read from the tree or the chain on that
date, not carried forward from a previous note.

---

## The artefact

| | |
|---|---|
| Current tag | **`audit-2026-09-01`** — the tree handed to the auditor |
| Previous tag | `audit-2026-08-30b`, a verified **ancestor** of the current one |
| Branch | `main` — one trunk, and the deployed tree |
| Program id (devnet) | `DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe` |
| Instructions | 54 |
| Account parameters | 503 |
| Error variants | 58 |
| On-chain account types | 22 |
| Tests | **112 passing, 0 failing** |

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

**Should a pool on a pausable Token-2022 mint be gauge-eligible?** If it is, emissions can be
voted toward a market its issuer has frozen. Undecided.

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
