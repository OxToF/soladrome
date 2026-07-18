# Soladrome — Founding Contributor Whitelist (Backyard-style onboarding)

> Status: **Design phase — not started in code.** This is the reference doc
> for implementing a wallet-gated whitelist flow modeled on
> `backyard.finance/whitelist` (sign wallet → locked email/NFT rows unlock →
> completed-tasks checklist → public whitelisted-users counter → FOMO gauge).

---

## 0. Scope decision — read this before building anything

Backyard's whitelist gates **mainnet** access while the protocol is invite-only.
Soladrome's devnet is the opposite situation right now: it's open, and there
are ~1700+ active testers mid-funnel toward the TrueMRR leaderboard push
([project_soladrome_truemrr]). Two different things could be meant by
"transition the devnet to a whitelist system":

| Option | What it does | Risk |
|---|---|---|
| **A — Additive (recommended)** | Keep devnet open as-is. Add a new "Founding Contributor Whitelist" page that layers on top: connect + sign + optional email + task checklist → grants a **contributor NFT badge + guaranteed mainnet early access + boosted initial emissions**. Existing testers convert into it, new visitors see it as the marquee CTA. | None — purely additive, current funnel keeps working. |
| **B — Full gate** | Devnet itself becomes invite-only like Backyard's mainnet: nobody gets past the landing page without being whitelisted first. | Kills the open funnel that's building the ~1700-tester base and the TrueMRR vote count *right now*. Only makes sense once you're closer to mainnet and want manufactured scarcity instead of volume. |

This doc builds **Option A**. If you actually want B, say so explicitly — it's
a much bigger change (it turns the whole app into a locked room) and should be
sequenced *after* the TrueMRR push, not before.

**2026-07-07 — confirmed: Option A, local-only for now.** Nothing in this doc
ships to Vercel/prod until explicitly decided later — build and test against
`localhost:3000` + devnet only. Also confirmed: the NFT badge (§5) must be a
**real on-chain mint via an Anchor instruction**, not the off-chain
server-signed MVP originally proposed below (kept struck through for the
record of what was rejected and why).

---

## 1. What already exists — don't rebuild this

Researched directly from the codebase, not assumed:

- **Quest/points engine** — `app/lib/quests.ts` defines quest groups (Genesis
  Missions, Genesis II, Social, Ecosystem). Client calls
  `POST /api/track-quest` (`app/app/api/track-quest/route.ts`), which writes
  through the `record_quest(wallet, quest)` Postgres RPC
  (`supabase/quests.sql:27-90`). Points are decided **server-side only** —
  the client can never forge a score.
- **Anti-sybil pattern** — the `leaderboard` view
  (`supabase/quests.sql:99-107`) only surfaces wallets with ≥1
  **on-chain-verified** quest (stake/borrow/vote/borrow_again/vote_again).
  Connect/faucet-only bots never show up. Reuse this exact filter for
  whitelist eligibility.
- **Referrals** — `referrals` table + first-touch `?ref=` capture
  (`app/app/page.tsx:76-104`), reward on-verified-conversion only
  (`maybeRewardReferrer`, `track-quest/route.ts:154-171`).
- **Server-signed devnet transactions** — `app/app/api/faucet/route.ts` shows
  the established pattern: a server-held `Keypair` (env var, JSON secret key)
  builds + signs + sends a transaction on the user's behalf. This is the
  template for NFT badge minting (§5).
- **What does NOT exist yet**: wallet **message signing** for auth (only
  transaction signing exists today), any NFT/Metaplex dependency, any
  captcha/bot-protection beyond the on-chain-verified filter above.

Everything below is scoped to fill exactly those three gaps, reusing
`quest_completions` / `leaderboard` / `referrals` as-is for the tasks
checklist — **no new completions table needed.**

---

## 2. Data model — one new table

```sql
-- supabase/whitelist.sql (new file, same idempotent style as quests.sql)
create table if not exists whitelist_signups (
  wallet_address text primary key,
  email          text,
  signature      text        not null,   -- base58, proves wallet ownership
  message        text        not null,   -- the exact signed nonce message
  tier           text        not null default 'pending', -- pending|whitelisted
  created_at     timestamptz not null default now()
);
alter table whitelist_signups enable row level security;
-- no anon policy → writes only via service key (mirrors quest_completions)

create or replace function join_whitelist(p_wallet text, p_email text)
returns void language plpgsql security definer as $$
begin
  if p_wallet is null or length(p_wallet) < 32 or length(p_wallet) > 44 then
    return;
  end if;
  insert into whitelist_signups (wallet_address, email, signature, message)
  values (p_wallet, p_email, '', '')
  on conflict (wallet_address) do update set email = excluded.email;
end;
$$;
```

The "tasks completed" panel does **not** read from this table — it reads the
existing `leaderboard` view / `quest_completions` for that wallet. Whitelist
`tier` flips from `pending` → `whitelisted` once the wallet crosses a point
threshold you pick (e.g. all Genesis Missions core quests = 100 pts) — set
server-side in `/api/whitelist/status`, never trusted from the client.

---

## 3. Wallet signature verification — the genuinely new piece

This is the one auth primitive missing today. Steps:

1. **Frontend** (`Whitelist.tsx`, new component): after `wallet.connected`,
   button "Sign to verify" calls `wallet.signMessage(new TextEncoder().encode(msg))`
   where `msg = "Soladrome Whitelist — ${wallet.publicKey} — ${Date.now()}"`.
   Every adapter Soladrome already lists (Phantom, Solflare, MWA) implements
   `signMessage` — no new wallet-adapter dependency needed.
2. **Backend** (`POST /api/whitelist/join`): verify with `tweetnacl`
   (`nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes)`).
   Reject if the timestamp embedded in `msg` is >5 min old (replay window),
   matching the "stateless, no session store" pattern the rest of the app
   already uses — no new session/JWT infra required.
3. On success, call `join_whitelist(wallet, email)` via the service-key
   Supabase client (same client already instantiated in
   `track-quest/route.ts:10-12` — copy the pattern, don't add a new one).

---

## 4. New API routes (App Router, same style as existing routes)

| Route | Method | Purpose |
|---|---|---|
| `app/app/api/whitelist/join/route.ts` | POST | `{wallet, signature, message, email?}` → verify sig → `join_whitelist` RPC |
| `app/app/api/whitelist/status/route.ts` | GET `?wallet=` | Returns `{tier, points, tasksCompleted[]}` by joining `whitelist_signups` + `leaderboard` |
| `app/app/api/whitelist/count/route.ts` | GET | `select count(*) from whitelist_signups where tier='whitelisted'` — public, feeds the counter widget |

All three follow the existing fire-and-forget, no-session pattern — consistent
with `register-wallet` and `track-quest`.

---

## 5. NFT contributor badge — real on-chain mint via Anchor

~~MVP path (off-chain server-signed mint, `mint-badge` API route with a
server `Keypair`)~~ — **rejected 2026-07-07**: the user wants an actual
on-chain Anchor instruction, not a Next.js route quietly minting on the
protocol's behalf. Below is the on-chain design instead.

### 5.1 New program dependency

Nothing in `programs/soladrome/src/` touches Metaplex today (checked: no
`mpl-token-metadata` in `Cargo.toml`, no NFT code anywhere in the program).
This instruction is the first thing that needs it:

```toml
# programs/soladrome/Cargo.toml
mpl-token-metadata = { version = "...", features = ["no-entrypoint"] }
```

This is a real new attack surface (a fresh CPI dependency, bigger `.so`,
another thing to get right before mainnet) — treat it with the same caution
as the AMM/gauge code, even though the asset itself is cosmetic. Budget time
for `anchor build` to regenerate the IDL and for the SBPFv3 devnet redeploy
dance already documented in `CLAUDE.md` (`cargo build-sbf --arch v3` +
`solana program deploy`, not plain `anchor deploy`).

### 5.2 On-chain gating — what can actually be checked cheaply

The "whitelist tasks" checklist (§1) lives in Supabase, which an Anchor
instruction cannot read. Two of the three gated actions are checkable
on-chain right now, one isn't, without new state:

| Signal | On-chain today? | Usable as a mint gate? |
|---|---|---|
| Has staked (holds hiSOLA) | Yes — `user`'s hiSOLA ATA balance | Yes — cheap `TokenAccount` constraint |
| Has borrowed | Partially — `UserPosition.usdc_borrowed` is *current* debt, not history; repaying zeroes it | Weak — a wallet that borrowed then repaid reads as "never borrowed" |
| Has voted at least once | No — `UserVoteReceipt` is keyed by `(user, pool_id, epoch)`, there's no "voted at least once, ever" flag anywhere | No, not without adding new state |

**Recommendation**: gate the mint on "currently holds hiSOLA > 0" only
(genuine on-chain check, one `TokenAccount` constraint, no new state needed).
Don't try to encode the full quest checklist on-chain — that would mean
adding a global "ever borrowed / ever voted" flag to `UserPosition` just for
a cosmetic badge, which isn't worth the account-migration risk. The richer
task-completion gamification (§6) stays the Supabase-tracked layer that
decides when the frontend *shows* the mint button; the on-chain instruction
enforces the one condition it can actually prove trustlessly.

### 5.3 Instruction sketch

```rust
// New PDA — bump-only, existence = "this wallet has minted its badge".
// Same double-claim-guard pattern as UserBribeClaim / UserVoteReceipt (init fails on replay).
#[account]
pub struct ContributorBadge {
    pub bump: u8,
}
impl ContributorBadge { pub const LEN: usize = 8 + 1; }

#[derive(Accounts)]
pub struct MintContributorBadge<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    // Proves "currently staked" — the one cheap, honest on-chain gate (§5.2).
    #[account(associated_token::mint = hi_sola_mint, associated_token::authority = user)]
    pub user_hi_sola_ata: Account<'info, TokenAccount>,
    pub hi_sola_mint: Account<'info, Mint>,

    #[account(init, payer = user, space = ContributorBadge::LEN,
              seeds = [b"contributor_badge", user.key().as_ref()], bump)]
    pub contributor_badge: Account<'info, ContributorBadge>,

    #[account(init, payer = user, mint::decimals = 0, mint::authority = contributor_badge,
              seeds = [b"badge_mint", user.key().as_ref()], bump)]
    pub badge_mint: Account<'info, Mint>,

    #[account(init, payer = user, associated_token::mint = badge_mint, associated_token::authority = user)]
    pub user_badge_ata: Account<'info, TokenAccount>,

    /// CHECK: Metaplex metadata PDA — validated by the CPI itself
    #[account(mut)] pub metadata: UncheckedAccount<'info>,
    /// CHECK: Metaplex master edition PDA — validated by the CPI itself
    #[account(mut)] pub master_edition: UncheckedAccount<'info>,

    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
```

Body: `require!(user_hi_sola_ata.amount > 0, SoladromeError::NotEligibleForBadge)`,
then CPI `mint_to` (1 token, decimals 0) + `create_metadata_accounts_v3` +
`create_master_edition_v3` (fixed name/symbol/uri — a single static metadata
JSON is enough, no per-wallet customization needed).

Frontend side is the existing pattern: build with `.instruction()`, send via
`sendTx` (`app/lib/program.ts`) — never `.rpc()`, matching every other
transaction in the app since the 2026-06-25 conversion.

---

## 6. Frontend — `Whitelist.tsx`

New page/component, registered via the existing `nav` CustomEvent pattern
(`window.dispatchEvent(new CustomEvent("nav", {detail: "whitelist"}))`),
reusing `Quests.tsx`'s task-list rendering rather than duplicating it:

- **Row 1 — Sign wallet**: connect button (existing `WalletMultiButton`) → "Sign to verify" once connected.
- **Row 2 — Email** (locked until row 1 done): optional text input, POSTed with the join call.
- **Row 3 — NFT** (locked until tasks threshold met): "Mint NFT" button → calls `mint-badge`.
- **Completed tasks panel**: literally reuse `Quests.tsx`'s Genesis Missions group rendering, pointed at the same `/api/track-quest?wallet=` data — don't re-implement quest UI.
- **Whitelisted users counter**: `GET /api/whitelist/count`, poll every 30s or on mount only (this is marketing, not real-time-critical — don't add it to the RPC throttle budget).
- **FOMO gauge**: purely cosmetic — no backing data required to match Backyard's UX (their "100" gauge is decorative). If you want it to mean something instead of being decorative, tie it to `count / WHITELIST_CAP` where `WHITELIST_CAP` is a constant you pick (e.g. 500 founding spots) — gives the gauge and the CTA copy ("X spots left") a real number instead of a fake one.

---

## 7. Build order

**Local only — nothing here touches Vercel/prod (§0).**

1. `supabase/whitelist.sql` — table + RPC, run once in Supabase SQL editor (dev project).
2. `/api/whitelist/join` with signature verification (`tweetnacl` dep, likely already transitively present via `@solana/web3.js` — check `yarn why tweetnacl` before adding).
3. `/api/whitelist/count` (trivial, ship early so the frontend counter has something to hit).
4. `/api/whitelist/status`.
5. `Whitelist.tsx`, wired into nav, reusing `Quests.tsx` task rendering, hits `localhost:3000` only.
6. **Program work (bigger lift, sequence last)**:
   a. Add `mpl-token-metadata` to `programs/soladrome/Cargo.toml`.
   b. Add `ContributorBadge` state + `mint_contributor_badge` instruction (§5.3).
   c. `anchor build` (regenerates IDL) → `cp target/idl/soladrome.json app/lib/` (per `CLAUDE.md`, mandatory after any struct/instruction change).
   d. Redeploy to devnet with the SBPFv3 path (`cargo build-sbf --arch v3` + `solana program deploy`, **not** plain `anchor deploy` — devnet rejects the default arch, see `CLAUDE.md`).
   e. Wire the frontend mint button via `.instruction()` + `sendTx`, never `.rpc()`.
7. End-to-end devnet test: connect → sign → (optional email) → complete Genesis Missions (get hiSOLA balance > 0 via stake) → mint NFT badge on-chain → counter increments.
8. Only then revisit §0 — decide whether this becomes the sole entry point (Option B), and whether/when any of this goes to Vercel prod.

---

## 8. Security notes

- Signature replay: reject signed messages older than 5 minutes (embed the timestamp in the signed string itself, no server-side nonce store needed).
- Sybil: apply the same on-chain-verified-quest filter the `leaderboard` view already uses (§1) before flipping `tier` to `whitelisted` — a wallet that only connected + signed shouldn't jump the queue.
- Rate-limit `/api/whitelist/join` per wallet (Postgres `on conflict` already makes repeated joins idempotent, but add a per-IP rate limit at the route level if abuse shows up — nothing exists for this today, matching the faucet route's current lack of one).
