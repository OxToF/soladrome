# Security Policy — Soladrome

☢️ **Soladrome has never been audited and has never been deployed to mainnet.** Everything below
describes a devnet deployment run by a small team. Read the *Key control* section before treating
any of it as a guarantee.

## Reporting a Vulnerability

If you discover a security vulnerability in the Soladrome protocol, **please do not open a public
GitHub issue.**

Report it privately by email:

**info@soladrome.finance**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

We read every report and reply as soon as we reasonably can. We deliberately do **not** promise a
fixed acknowledgement window or a fixed time to fix, and you should be suspicious of any unaudited
project that does: this is a small team, and a deadline on a security fix is an argument for
shipping an unreviewed patch under time pressure, which is how protocols get bricked. What we
commit to instead is that a fix is deployed when it is understood and tested, and that you are
told where it stands.

> This section promised a 48-hour acknowledgement and a 7-day critical fix until 2026-09-14. Both
> were removed as unkeepable rather than quietly missed.

## Scope

In scope:
- Smart contract: `programs/soladrome/src/` (program ID: `DgD37Vjs8ozzBwZnfsNEDQNw1SEsgBTr2TXfBdsrgXpe`, **devnet**)
- Frontend: `app/` (soladrome.finance)

Out of scope:
- Third-party dependencies (Anchor, SPL Token, etc.)
- Social engineering attacks
- Issues already reported or known

## Key control — read this before the list below

**The deployed devnet program is controlled by a single key, not by a multisig.** Verified
on-chain on 2026-09-14:

| What | Who holds it |
|---|---|
| Program upgrade authority | `2BhwbPGjRcoYv98jLJpkk6khjZX1oW97kSixUge2xTfB` |
| `ProtocolState.authority` (pause, phase flags, emissions config) | `2BhwbPGjRcoYv98jLJpkk6khjZX1oW97kSixUge2xTfB` |

A Squads v4 vault exists at `BxYTiKyDxWpK4hPDZEiYVW9qBj8YpzhSHEBCWpaZbWQ4`, on **mainnet only**. It
holds neither of the authorities above, because nothing of Soladrome is deployed to mainnet yet.

☢️ **That vault is configured 1-of-2, which is not a security threshold.** A threshold of 1 means
a single signature suffices, so either key can act alone. What that buys is redundancy against
*losing* a device; what it does not buy is any requirement that two people, or two devices, agree.
Calling it a "multisig" under Security Measures implied a consensus requirement that a threshold
of 1 does not provide.

To be precise about what the exposure is and is not: both keys are Ledger hardware wallets, so
neither is reachable by the class of attack that takes key files, keychains or browser extensions
off a host — a private key never leaves the secure element. What a threshold of 1 changes is the
count of devices whose physical control is individually sufficient: two rather than one. That is a
real difference from a 2-of-2, and a much smaller one than the word "multisig" suggested. Raising
the threshold before mainnet is worth doing; it is not an emergency.

> This file listed "Squads v4 multisig (1-of-2 Ledger hardware wallets)" under *Security Measures*
> until 2026-09-14, next to the vault address. The correction is to the claim, not to the setup:
> the hardware wallets are what they say they are, and the 2026-08-05 host compromise never
> reached them for the reason given above. What was wrong was presenting a threshold of 1 as a
> consensus control, and listing it as protecting a deployment it holds no authority over.

## Security Measures

What is actually true of the code as deployed:

- **Emergency pause** — authority-only `pause` / `unpause`, which stops the user-facing paths.
  Note that this shares the single key described above.
- **Floor reserve buffer** — borrowing is refused if it would leave `floor_vault` below 75% of
  `total_purchased_sola` (`FLOOR_RESERVE_MIN_BPS = 7_500`).
- **Token-2022 admission control** — `token_ext::require_supported_mint` refuses a transfer fee, an
  armed transfer hook and a default-frozen mint at the door, because the seeds that would hold such
  a mint are `init` and cannot be cleared afterwards. It deliberately **admits** a permanent
  delegate, a pausable config and an unarmed hook; the residual risk that an unarmed hook is armed
  later is real and is not closable from inside the program.
- **Test suites, run in CI on every push** — 63 native Rust unit tests (`cargo test`) covering the
  AMM math, the curve and fee math, and the whole Token-2022 admission policy, plus 124
  bankrun/mocha cases exercising the compiled SBF binary against a validator. Measured with
  `cargo llvm-cov`: 93.93% region for `amm_math.rs`, 95.09% for `math.rs`, 98.15% for
  `token_ext.rs`. Across the whole program it is 16.32%, because the instruction handlers are
  covered by the bankrun suite, which that tool cannot instrument — a limitation of the
  measurement, not a statement that the handlers are untested.
- **Past security reviews** — several rounds, findings resolved and each proven by mutation rather
  than by assertion. These were internal reviews. **They are not an audit.**

### Not currently a guarantee

- **Trident fuzzing.** `trident-tests/` was last updated 2026-08-12 and has not run since. The
  program changed substantially afterwards — hiSOLA became a non-transferable position on
  2026-08-21, the instruction tree was restructured on 2026-08-30, and Token-2022 support landed on
  2026-09-01 — so those targets describe an architecture that no longer exists, and they do not run
  in CI. This file previously claimed "~200k calls, 0 violations" with no date attached. A fuzzer
  finding nothing means either the code is sound or the harness covers little, and without saying
  which invariants were exercised the number cannot be interpreted. Treat the fuzzing as stale
  until the targets are rewritten against the current instruction set.

## Disclosure Policy

We follow **responsible disclosure**. We will:
1. Confirm the vulnerability
2. Develop and test a fix
3. Deploy the fix
4. Publicly disclose the issue (with credit, if desired)

We ask that you give us reasonable time to fix the issue before public disclosure. If you need a
date to plan around, 90 days from your report is the usual industry window and we will not ask you
to wait longer without telling you why.

---

*Copyright © 2026 Soladrome Labs. BUSL-1.1 License.*
