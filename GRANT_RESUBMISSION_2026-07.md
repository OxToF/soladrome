# Solana Foundation Grant — Resubmission (July 2026)
## Soladrome — what changed since June 13

> **INTERNAL NOTES — remove this block before sending.**
> - Original application: [GRANT_APPLICATION.md](GRANT_APPLICATION.md) ($35,000, submitted ~June 13, declined June 14 for maturity/traction: *"the idea is a good one, it's not quite far enough along"*, with an explicit invitation: *"happy to review any future applications... including for this project if things change down the line"*).
> - This invitation is spendable ONCE. Recommended send trigger: after the Marinade call, if it produces any positive signal (even informal interest). A named LST conversation plus everything below is a categorically stronger file than June's.
> - Every claim below is dated and verifiable on-chain, on GitHub, or in production. Keep it that way when editing — no "committed" language for partners who haven't signed (lesson from our own whitepaper cleanup).

---

Dear Solana Foundation grants team,

In June you reviewed our application for Soladrome and encouraged us to come back if things changed. Six weeks later, they have — concretely and verifiably. This is not the same application resubmitted: it is a summary of what shipped since June 13, and a proposal to structure the grant so that funds are only released against delivered milestones.

**Requested amount:** $35,000 USD (unchanged)
**Everything referenced below is live, public, and verifiable.**

---

## 1. What changed since June 13

### Live beta with real, sybil-filtered traction
- **Genesis beta campaign live on devnet** (soladrome.finance) since June 18: 8 on-chain missions (swap, LP, stake, borrow, repay, vote), public leaderboard, 200k SOLA genesis airdrop announced with on-chain distribution at TGE (no manual claim).
- **Over 2,300 wallets participated. We built an anti-sybil system and publish the honest number: ~700 human-like testers** after on-chain proof gating (stake/borrow/vote completions verified against chain state before credit), temporal fingerprinting, and funder clustering. We detected a 97%-bot wave in week one, shipped on-chain verification within 24 hours, and filtered the leaderboard publicly. We would rather report 700 real testers than 2,300 inflated ones — airdrop eligibility reads on-chain footprints, not our own database.
- **Quest verification hardened**: Discord verification moved from honor-system to OAuth2 + bot verification (July 7) after a publicly reported exploit — found, disclosed, fixed.

### Security posture: self-audit in public, plus an ecosystem public good
- **Continuous security watch** running against our own codebase, journaled publicly in the repo (`SECURITY_WATCH.md`). It found a HIGH-severity founder-vesting bypass in our own code; we fixed it and published the finding ourselves.
- **The methodology is now packaged as an open-source agent skill** — `solana-security-watch` (github.com/OxToF/solana-security-watch, MIT) — and submitted to the community Solana AI Kit (solanabr/solana-ai-kit PR #18). This is a contribution to securing the Solana ecosystem generally, independent of Soladrome's own success.
- Trident fuzzing (bonding curve + flash arb): ~200k calls, zero invariant violations.

### Partner traction: EVM capital building its way in
- **MLCB DAO (fBOMB, ~$35M treasury, major veAERO/veVELO positions) is building an SPL OFT version of fBOMB** — the technical prerequisite to bribe in fBOMB on Solana and LP fBOMB-SOL. An EVM-native treasury is doing engineering work to enter Solana, with Soladrome as the venue. Terms finalize around mainnet.
- **Active conversation with Marinade** (introduced by Accretion.xyz) on an mSOL-SOL launch pool and bribe program.
- **The partner program itself is deployed and tested on devnet**: bribe-indexed 1:1 hiSOLA streaming with per-tier caps and 4-year locks (`register_partner` / `partner_deposit_bribe` / `claim_partner_allocation`). What Aerodrome's Flight School does discretionarily, we enforce on-chain.

### A concrete, de-risked launch plan
- **Two-stage gated mainnet, enforced on-chain** (implemented July 8): five phase flags on protocol state. Stage 1 is a partner-only window — founding partners seed pools and accumulate locked hiSOLA while the bonding curve stays closed (preventing snipers from front-running the community airdrop on a monotonic curve). Stage 2 opens the curve, TGE, and the sybil-filtered airdrop as one event.
- **Mainnet runbook** consolidated in-repo (deploy parameters, Squads multisig authority transfer, launch sequence, hard rules).
- Mobile: PWA + Solana Mobile Wallet Adapter integrated, Seeker dApp Store publication runbook written.

### Audit: quotes in hand — this is the one item capital unblocks
- Formal quotes obtained (Sec3: ~$37K full scope) and a second firm (Accretion.xyz) in active discussion.
- We deliberately structured auditor relationships to protect report independence: fixed cash payment only, no token allocation, no governance power to auditors.

---

## 2. Addressing June's feedback directly

The June response was, fairly, "not quite far enough along." Two points:

1. **Everything above was shipped with zero external funding.** Beta, anti-sybil system, partner program, security tooling, launch design — none of it required a grant. We think it demonstrates exactly the execution capacity a grant is meant to lever.
2. **The one remaining blocker is the audit, and it is precisely what the grant funds.** Partners (Marinade, MLCB), listings, and real TVL are all gated on an independent audit; the audit is gated on capital. This resubmission exists to break that cycle — and we propose to structure it so the Foundation carries no delivery risk.

---

## 3. Proposed milestone-gated disbursement

We propose the grant be released against delivered milestones rather than up front:

| Milestone | Deliverable (verifiable) | Amount |
|---|---|---|
| M1 — Independent audit | Scoped audit of money-critical paths (bonding curve, floor vault, vesting, flash arbitrage) by a named firm; report published | $20,000 |
| M2 — Gated mainnet, stage 1 | Program live on mainnet-beta, authority under Squads multisig, partner window open with at least one registered partner | $10,000 |
| M3 — Public open | Curve opened, TGE executed, on-chain sybil-filtered Genesis airdrop distributed | $5,000 |

Total: **$35,000**. M1 is payable directly to the audit firm if the Foundation prefers.

---

## 4. Updated key links

- Live beta: https://soladrome.finance (devnet)
- Protocol repo: https://github.com/OxToF/soladrome (BUSL-1.1, self-audit journal in-repo)
- Security public good: https://github.com/OxToF/solana-security-watch + solanabr/solana-ai-kit PR #18
- Bridge repo: https://github.com/OxToF/soladrome-bridge (LayerZero V2, testnet)
- Original application: on file with your team (June 2026)
- Contact: info@soladrome.finance

Thank you for the earlier review and for leaving the door open. We believe this is what "things changing down the line" looks like.

— Soladrome Labs
