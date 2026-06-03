# Security Policy — Soladrome

## Reporting a Vulnerability

If you discover a security vulnerability in the Soladrome protocol, **please do not open a public GitHub issue.**

Report it privately by email:

**info@soladrome.finance**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

We will acknowledge receipt within **48 hours** and aim to resolve critical issues within **7 days**.

## Scope

In scope:
- Smart contract: `programs/soladrome/src/` (program ID: `4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd`)
- Frontend: `app/` (soladrome.finance)

Out of scope:
- Third-party dependencies (Anchor, SPL Token, etc.)
- Social engineering attacks
- Issues already reported or known

## Security Measures

- Emergency pause mechanism (authority-only `pause` / `unpause`)
- Squads v4 multisig (1-of-2 Ledger hardware wallets) — vault: `BxYTiKyDxWpK4hPDZEiYVW9qBj8YpzhSHEBCWpaZbWQ4`
- Code review (10 findings resolved)
- Trident fuzzing: bonding curve + flash arb invariants (~200k calls, 0 violations)
- Floor reserve buffer: 75% minimum at all times

## Disclosure Policy

We follow **responsible disclosure**. We will:
1. Confirm the vulnerability
2. Develop and test a fix
3. Deploy the fix
4. Publicly disclose the issue (with credit, if desired)

We ask that you give us reasonable time to fix the issue before public disclosure.

---

*Copyright © 2026 Soladrome Labs. BUSL-1.1 License.*
