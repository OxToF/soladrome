# Soladrome — Veille de sécurité quotidienne

> Playbook destiné à l'agent Claude (Opus 4.8) exécuté chaque jour.
> Objectif : confronter le protocole Soladrome aux nouvelles techniques d'exploit
> et failles divulguées dans l'écosystème Solana / Anchor / DeFi, et signaler
> tout point qui pourrait l'affecter.

## ⚠️ Cadrage honnête

Il n'existe pas de « flux officiel de failles détectées par Opus 4.8 ». Cette veille
fonctionne ainsi : chaque jour, un agent Claude **recherche** les divulgations
récentes (audits, post-mortems, advisories, CVE, threads de chercheurs) puis
**ré-audite** le code de Soladrome à la lumière de ces nouvelles techniques.
La qualité dépend du modèle utilisé — Opus 4.8 pour la détection la plus fine.

## Procédure quotidienne

1. **Collecte (WebSearch)** — chercher les éléments des dernières 24–48 h sur :
   - Exploits / post-mortems DeFi récents (toutes chaînes — les classes de bugs
     se transposent : oracle, reentrancy logique, rounding, donation attack…).
   - Advisories Solana spécifiques : Anchor, SPL Token / Token-2022, account
     validation, CPI, PDA, `realloc`, `init_if_needed`, sysvar, compute budget.
   - Publications de Anchor (releases / RUSTSEC), `solana-security-txt`, Sec3,
     OtterSec, Neodyme, Zellic, Trail of Bits, Ottersec blog, Helius.
   - Mots-clés : "Solana exploit", "Anchor vulnerability", "SPL token drain",
     "PDA confusion", "account substitution", "rounding bug AMM",
     "bonding curve exploit", "ve-token governance attack", "bribe gauge exploit".

2. **Confrontation au code** — pour chaque technique trouvée, vérifier dans
   `programs/soladrome/src/` si Soladrome est exposé. Surfaces prioritaires :
   - **Validation de comptes** : tout `UncheckedAccount` / `try_deserialize`
     manuel doit vérifier `owner == crate::ID` ET le PDA attendu.
     (cf. `try_load_ve_power` dans `ve.rs` = le bon pattern de référence).
   - **Bonding curve** (`math.rs`, `buy_sola`/`sell_sola`) : invariant `k`,
     backing floor, `total_purchased_sola`.
   - **AMM** (`amm.rs`, `amm_math.rs`) : donation/first-deposit attack,
     rounding, `MINIMUM_LIQUIDITY`, slippage.
   - **Gauge / bribe / vote** : double-vote, double-claim, snapshot de pouvoir,
     cap 30 %, carry-over (`replay_vote`), rollover.
   - **Vesting / allocations** : founder, contributor, partner — lock bypass,
     ré-entrée de claim, désérialisation non validée.
   - **Fee accumulator** : ordre advance/`total_hi_sola`, `fees_debt`.
   - **Pause** : couverture des entrées, sorties toujours ouvertes.

3. **Rapport** — ajouter une entrée datée dans le journal ci-dessous :
   - `RAS` si rien de pertinent (avec la liste des sources balayées).
   - Sinon : technique, surface concernée, fichier:ligne, sévérité estimée,
     et correctif proposé. Ne PAS pousser de fix automatiquement sur du code
     de production sans validation humaine — proposer, ne pas appliquer.

## Référence — classes de bugs Solana/Anchor à toujours re-vérifier

- Account substitution / manque de contrainte `seeds`/`address`/`owner`.
- `init_if_needed` ré-initialisation / reinit attack.
- Désérialisation manuelle sans check d'owner (← faille trouvée le 2026-06-11).
- Arbitrage d'arrondi (toujours arrondir en faveur du protocole).
- Donation / inflation attack sur premier dépôt LP.
- Manque de check de `total_votes > 0` / division par zéro.
- Signer manquant sur instructions permissionless sensibles.
- Confusion d'epoch / `to_le_bytes` seeds.
- Token-2022 transfer hooks / fee extensions (si jamais adopté).

---

## Journal de veille

### 2026-06-11 — Audit initial (manuel, Opus 4.8)

**HIGH — Founder vesting lock contournable (CORRIGÉ).**
`unstake_hi_sola` (`lib.rs`) lisait `founder_hi_vesting` comme `UncheckedAccount`
puis `FounderHiSolaVesting::try_deserialize` sans vérifier ni le PDA canonique ni
l'owner. Le founder pouvait passer un compte forgé avec `claimed = 0` →
`locked = 0` → lock de vesting entièrement contourné → unstake anticipé → vente de
SOLA non financé → drainage du floor_vault au détriment des acheteurs réels.
**Fix** : épinglage au PDA `[b"founder_hi_vesting"]` + `owner == crate::ID` avant
toute confiance dans `claimed`. Aucun `#[derive(Accounts)]` modifié → pas de
rebuild d'IDL requis. Vérifié : `cargo check --no-default-features` ✅.

**RAS sur le reste du code récent audité** : `claim_partner_allocation`,
`register_partner`, `replay_vote`, `set_vote_config`, `rollover_bribe`,
`vote_gauge`, `claim_bribe` — toutes les surfaces `UncheckedAccount` y sont soit
contraintes par seeds, soit validées en corps d'instruction (`try_load_ve_power`
vérifie owner + `lock.owner == user` ; `rollover_bribe` re-dérive le PDA gauge).

### 2026-06-11 — Audit approfondi (AMM / flash arb / POL / cœur monétaire)

**MEDIUM — `stake_sola` confisquait les fees non réclamées lors d'un ajout (CORRIGÉ — auto-harvest).**
`stake_sola` (`lib.rs:414`) exécute `position.fees_debt = acc` de façon
INCONDITIONNELLE, y compris pour une position existante — SANS auto-harvest
préalable. Or `unstake_hi_sola`, `lock_hi_sola` et `claim_fees` paient d'abord les
fees pending avant de réinitialiser `fees_debt`. Conséquence : un staker qui
rajoute du SOLA sans avoir réclamé voit ses fees accumulées `(acc - old_debt) ×
old_balance` redistribuées aux autres stakers. Pas un drain protocole ni
exploitable par un tiers (perte auto-infligée), mais incohérent avec le propre
pattern du protocole → perte de fonds utilisateur en usage normal.
**Fix appliqué (auto-harvest, choix utilisateur)** : `stake_sola` paie désormais
les fees pending en USDC (`pending_fees(acc, old_debt, old_balance)`) AVANT de
réinitialiser `fees_debt`, et soustrait le montant payé de `last_market_vault_balance`
— exactement comme `unstake_hi_sola`. Contexte `StakeSola` étendu : `market_vault`
passé en `mut` + ajout de `usdc_mint` et `user_usdc` (ATA `init_if_needed`).
Vérifié `cargo check` (devnet + mainnet) ✅, `anchor build` ✅, IDL régénéré +
copié dans `app/lib/soladrome.json` ✅, frontend `Stake.tsx` (branche stake) mis à
jour pour passer `usdcMint` + `userUsdc`. **`anchor deploy` FAIT (devnet, via RPC
Helius)** ✅ — bytecode + IDL on-chain upgradés (slot 467807157→468695860).

**RAS — surfaces auditées en profondeur, aucune autre faille :**
- **AMM** (`amm.rs`/`amm_math.rs`) : réserves suivies en INTERNE (`pool.reserve_a/b`)
  et non via le solde du vault → donation/inflation attack neutralisée nativement ;
  `MINIMUM_LIQUIDITY` verrouillé ; dépôt arrondi à 0 → revert (pas de perte victime) ;
  `swap_out` borné `< reserve_out` (pas de drainage) ; `AmmPool::LEN` inclut bien le
  discriminateur (donc `space = AmmPool::LEN` correct).
- **flash_arbitrage** : floor sur-collatéralisé (reçoit `amount_osola` USDC pour
  `amount_net` SOLA backé) ; `require!(usdc_out > amount_osola)` avant tout transfert ;
  contexte contraint le pool à SOLA/USDC + épingle floor/market vaults ; fee SOLA brûlée.
- **POL** (`pol.rs`) : `has_one = authority` partout ; `collect_to_pol` avance
  l'accumulateur avant de bouger l'USDC ; fix M-03 force le pool cible à contenir SOLA ;
  Phase 1 reproduit le split floor/market de `buy_sola`.
- **buy/sell/borrow/repay/exercise/claim_fees** : invariant `total_purchased_sola`
  + buffer floor 75 % + flash-borrow guard (slot) + fee origination 2 % corrects ;
  `borrow_usdc` ne clobbe pas `fees_debt` d'une position existante (seul `stake_sola` le fait).

### 2026-06-11 — Veille (suivi) : contributor_borrow_usdc

**MEDIUM — `contributor_borrow_usdc` : check de collatéral hiSOLA absent (CORRIGÉ).**
Contrairement à `founder_borrow_usdc` (qui vérifie `new_borrowed ≤ founder_hi_sola.amount`)
et à `borrow_usdc`, le contexte `ContributorBorrowUsdc` ne déclarait aucun compte
`contributor_hi_sola` et ne vérifiait donc pas le solde réel. Un contributeur pouvait
réclamer son hiSOLA, le vendre/transférer entièrement, puis emprunter quand même
jusqu'à 10 % de son allocation revendiquée → **dette sans collatéral** (bris
d'invariant DeFi). Atténuants : contributeurs enregistrés par l'authority (confiance),
cap 10 %, buffer floor 75 % → pas de drain massif, mais invariant cassé.
**Fix** : ajout de `hi_sola_mint` + `contributor_hi_sola` dans le contexte +
`require!(new_borrowed <= hi_sola_balance, BorrowLimitExceeded)` dans le handler,
en miroir exact de `founder_borrow_usdc`. Frontend `ContributorPanel.tsx` (appel
borrow) mis à jour pour passer `hiSolaMint` + `contributorHiSola`. Vérifié
`cargo check` (devnet + mainnet) ✅. **Détection : veille quotidienne Opus 4.8.**

---

### 2026-06-11 — Veille automatique (Sonnet 4.6, session planifiée)

#### Sources balayées
- [Drift Protocol $285M exploit (Chainalysis)](https://www.chainalysis.com/blog/lessons-from-the-drift-hack/) — social engineering + durable nonces, 2026-04-01
- [Drift exploit — Coindesk (durable nonces)](https://www.coindesk.com/tech/2026/04/02/how-a-solana-feature-designed-for-convenience-let-an-attacker-drain-usd270-million-from-drift)
- [CVE-2026-45137 — Anchor `Program<System>` validation bypass (CVSS 8.2)](https://advisories.gitlab.com/cargo/anchor-lang/CVE-2026-45137/) — affecte Anchor 1.0.0–1.0.1, corrigé dans 1.0.2
- [Solana Foundation STRIDE + SIRN security overhaul](https://www.coindesk.com/tech/2026/04/07/solana-foundation-unveils-security-overhaul-days-after-usd270-million-drift-exploit) — OtterSec/Neodyme membres fondateurs
- [CISA Vulnerability Bulletin SB26-159](https://www.cisa.gov/news-events/bulletins/sb26-159)
- RustSec Advisory Database (aucun advisory spécifique anchor-lang 0.32.x trouvé)

---

#### CVE-2026-45137 — `Program<'_, System>` validation bypass (Anchor 1.x)

**Non affecté.** Soladrome utilise `anchor-lang = "0.32.1"`. La CVE cible les versions
1.0.0 à 1.0.1 exclusivement (la comparaison `T::id() == Pubkey::default()` a été
introduite dans la refonte 1.x de `TryFrom` ; en 0.32.x le chemin de validation est
différent). Les usages de `Program<'info, System>` dans `Initialize`, `StakeSola`, etc.
sont correctement contraints par la dérivation PDA. **Aucune action requise.**

---

#### Drift $285M — leçon opsec : risque single-wallet authority

**Info / Opsec.** L'attaque Drift repose sur la compromission de signataires multisig
via ingénierie sociale (conférences, faux fonds quant, nonces durables pré-signés sur
6 mois). Pour Soladrome, le vecteur équivalent est la compromission du wallet
`ProtocolState.authority` (actuellement un seul Ledger Nano S).
`transfer_authority` (`lib.rs:175`) requiert la signature du détenteur actuel — un
attaquant doit d'abord compromettre la clé physique.
**Recommandation avant mainnet (connue, dans TODO)** : transférer `authority` à un
Squads multisig M-of-N avec fenêtre de timelock. Le risque de durable-nonce ne
s'applique pas tant que les transactions admin passent par Squads (validation
multi-signataire au moment de la diffusion).

---

#### MEDIUM — `contributor_borrow_usdc` : absence du check de solde hiSOLA réel

**Surface** : `lib.rs:1447–1560` (instruction) + `lib.rs:4195–4243` (contexte
`ContributorBorrowUsdc`).

**Technique** : divergence silencieuse par rapport au pattern de référence
`founder_borrow_usdc` et `borrow_usdc`.

| Instruction | Check `new_borrowed ≤ hiSOLA_balance` |
|---|---|
| `borrow_usdc` (`BorrowUsdc`) | ✅ `lib.rs:639–642` |
| `founder_borrow_usdc` (`FounderBorrowUsdc`) | ✅ `lib.rs:1166–1170` + compte `founder_hi_sola` en contexte |
| **`contributor_borrow_usdc` (`ContributorBorrowUsdc`)** | ❌ **absent** — ni le compte `contributor_hi_sola` n'est déclaré, ni le check `new_borrowed ≤ balance` n'existe |

**Scénario d'exploitation** :
1. L'authority enregistre un contributeur avec 100 000 hiSOLA d'allocation.
2. Le contributeur claim ses tokens (`claim_contributor_hi_sola`) — 100 000 hiSOLA reçus.
3. Le contributeur transfère (ou vend en AMM) la totalité de ses hiSOLA à une autre adresse.
4. Le contributeur appelle `contributor_borrow_usdc` → le protocole autorise l'emprunt
   jusqu'à `10 % × 100 000 = 10 000 USDC` depuis `floor_vault`, sans aucun collateral
   on-chain. La dette est inscrite dans `contributor_position.usdc_borrowed`
   (PDA `[b"position", contributor.key()]`).
5. Le contributeur ne rembourse jamais → `floor_vault` présente une créance irrécouvrable
   de 10 000 USDC non collatéralisée.

**Facteurs atténuants** :
- Les contributeurs sont enregistrés par l'authority (accès de confiance, non permissionless).
- Plafond CONTRIBUTOR_BORROW_CAP_BPS = 10 % de la tranche revendicée (dommage borné).
- Le buffer floor 75 % (`FLOOR_RESERVE_MIN_BPS`) protège systémiquement contre un drain massif.
- `repay_usdc` fonctionne normalement (même PDA) → le contributeur peut toujours rembourser.

**Sévérité** : Medium (bris d'invariant DeFi — collateral = dette ; impact borné ; fix trivial).

**Correctif proposé (NE PAS appliquer automatiquement)** :
1. Ajouter un compte `contributor_hi_sola` dans `ContributorBorrowUsdc` :
   ```rust
   #[account(
       address = protocol_state.hi_sola_mint,
   )]
   pub hi_sola_mint: Account<'info, Mint>,

   #[account(
       token::mint = hi_sola_mint,
       token::authority = contributor,
   )]
   pub contributor_hi_sola: Account<'info, TokenAccount>,
   ```
2. Ajouter dans le corps de `contributor_borrow_usdc` (après le check de cap, avant
   l'emprunt) :
   ```rust
   let hi_sola_balance = ctx.accounts.contributor_hi_sola.amount;
   require!(
       new_borrowed <= hi_sola_balance,
       SoladromeError::BorrowLimitExceeded
   );
   ```
   Ce miroir exact du pattern `founder_borrow_usdc` (`lib.rs:1166–1170`) garantit que
   le solde réel du contributeur couvre toujours sa dette totale.
3. Rebuild IDL + redéployer après validation humaine.

---

#### RAS — autres surfaces vérifiées ce jour

- **gauge/bribe/vote** : `vote_gauge` + `replay_vote` — cap 30 %, snapshot immutable
  `total_power_snapshot`, double-vote bloqué par `init` sur `UserVoteReceipt`. ✓
- **`rollover_bribe`** : re-dérivation PDA gauge confirmée ; grace period vérifiée. ✓
- **`claim_lp_emissions`** : double-claim bloqué par `LpEpochClaim` PDA (`init`). ✓
- **`emit_pool_rewards`** : `require!(total_votes > 0)` + `require!(pool_votes > 0)`
  prévient toute division par zéro. ✓
- **`migrate_user_position`** : `realloc::zero = true` + seeds + bump − pas d'attaque
  de ré-initialisation possible. ✓
- **CVE-2026-45137** : vérifié non applicable (Anchor 0.32.1). ✓
- **Drift opsec** : la surface durable-nonce ne s'applique pas à l'architecture actuelle ;
  le risque single-wallet authority est documenté et dans le TODO mainnet. ✓
