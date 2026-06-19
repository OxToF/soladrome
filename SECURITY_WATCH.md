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

---

### 2026-06-16 — Veille automatique (Sonnet 4.6, session planifiée)

#### Sources balayées
- [Raydium DEX $1.34M exploit legacy AMM V3 — CryptoTimes / CoinPaprika, 2026-06-10](https://www.cryptotimes.io/2026/06/10/old-code-new-damage-raydium-hit-by-1-34m-legacy-pool-hack/) — LP mint forgery sur pools dépréciés
- [Drift Protocol $286M exploit — Elliptic / Chainalysis, 2026-04-01](https://www.elliptic.co/blog/drift-protocol-exploited-for-286-million-in-suspected-dprk-linked-attack) — social engineering + oracle manipulation + durable nonces
- [Cetus AMM Sui $200M+ exploit — Dedaub / Elliptic, 2025-05-22](https://dedaub.com/blog/the-cetus-amm-200m-hack-how-a-flawed-overflow-check-led-to-catastrophic-loss/) — overflow dans une vérification de liquidity concentrée
- [OWASP Smart Contract Top 10 2026 — dreamworksecurity](https://dreamworksecurity.hashnode.dev/the-owasp-smart-contract-top-10-2026-every-vulnerability-explained-with-real-exploits) — classes de bugs 2026 actualisées
- [Fairyproof Weekly Blockchain Security Watch](https://fairyproof.substack.com/p/weekly-blockchain-security-watch-c7b) — résumé hebdo
- RustSec Advisory Database — aucun advisory `anchor-lang` nouveau en juin 2026
- `ve-tokenomics` capture / bribe gauge — [Mitosis University](https://university.mitosis.org/vetokenomics-bribe-markets-gauge-voting-incentives-and-curve-wars-mechanics/), [arxiv TWAP-DAO](https://arxiv.org/pdf/2505.00888)

---

#### Raydium LP Mint Forgery ($1.34M, 2026-06-10) → Non affecté ✓

**Technique** : l'AMM V3 legacy Raydium ne validait pas l'adresse du mint LP passsé par l'attaquant, permettant un retrait frauduleux des réserves avec un faux LP token.

**Soladrome** : `AddLiquidity` et `RemoveLiquidity` épinglent le mint LP via la contrainte Anchor
`#[account(mut, address = pool.lp_mint)]` (amm.rs:690, 772). Le mint LP est stocké dans l'AmmPool lors de la création (`create_pool`) et toute déviation est rejetée par l'exécution Anchor avant même d'entrer dans le handler. Non affecté.

---

#### Drift $286M (avril 2026) → Non affecté / Opsec déjà documenté ✓

**Technique** : compromission de signataires multisig par ingénierie sociale + manipulation d'oracles via wash trading d'un token fictif (CVT) → retrait de $285M en 12 min.

**Soladrome** :
- Pas d'oracle externe : le prix plancher est déterministe (1:1 USDC:SOLA, invariant `k` fixé à l'init). Aucune surface d'oracle manipulation.
- Risque `single-wallet authority` (Ledger Nano S) : déjà documenté dans le journal du 2026-06-11 et dans le TODO mainnet. `transfer_authority` requiert la signature du détenteur actuel + rejet de `Pubkey::default()` (lib.rs:180–188).
- Pas de durable nonces utilisés dans le flow admin. Non affecté.

---

#### Cetus AMM $200M+ Overflow (Sui, mai 2025) → Non affecté ✓

**Technique** : une vérification d'overflow défaillante dans la logique de liquidity concentrée (CLMM) permettait à un attaquant d'injecter des spoof tokens, fausser les réserves internes et siphonner des actifs réels.

**Soladrome** : AMM classique xy=k (pas de CLMM). Toutes les opérations critiques dans `amm_math.rs` utilisent l'arithmétique u128 avec `checked_mul` / `checked_div` / `checked_add` / `checked_sub`. Les overflows sont rattrapés et retournent `SoladromeError::Overflow`. Les réserves sont trackées en INTERNE dans `AmmPool.reserve_a/b` (pas les soldes on-chain des vaults), bloquant toute donation/inflation attack. Non affecté.

---

#### Veille ve-token / Gauge captures → Non affecté ✓

**Technique observée** : capture de gauges en accumulant des bribes pour diriger les émissions vers des pools à faible valeur (PancakeSwap/Magpie, Balancer/Humpy).

**Soladrome** : `VOTE_WEIGHT_CAP_BPS = 3 000` (30 %) prévient la domination par une seule adresse. `UserVoteReceipt` avec `init` bloque le double-vote (lib.rs:3644–3651). `total_power_snapshot` immutable par epoch empêche le gonflage post-vote de pouvoir. Non affecté par les vecteurs observés.

---

#### LOW — `rollover_bribe` : `old_gauge_state` sans check d'owner (NOUVEAU)

**Surface** : `lib.rs:2393–2412`

**Technique** : les PDAs Solana peuvent être pré-occupés par un programme tiers. Si un attaquant crée un compte à l'adresse canonique `[b"gauge", pool_id, old_epoch_le]` AVANT qu'un vrai vote `vote_gauge` ne l'initialise, le comportement diverge :

1. **Blocage du vote** : `vote_gauge` utilise `init_if_needed` sur `gauge_state`. Si le compte existe déjà avec un owner différent de `crate::ID`, l'instruction CPI de création échoue → plus aucun vote possible pour ce pool/epoch (DoS).
2. **Délai de rollover** : `rollover_bribe` lit les bytes 48–56 de `old_gauge_state` sans vérifier `owner == crate::ID`. Un compte forgé dont bytes 48–56 forment un u64 > 0 fait croire qu'il y avait des votes (`has_votes = true`) → exige le grace period de 2 epochs (~14 jours) même si personne n'avait voté.

**Impact** : DoS ciblé sur un pool/epoch. Pas de perte financière directe. Les tokens de bribe dans `old_bribe_token_vault` (PDA correctement dérivé) ne sont pas drainables ; ils sont seulement bloqués 14 jours de plus. Coût attaquant : rent d'un compte ≥ 56 octets ≈ 0.0008 SOL.

**Sévérité** : Low (DoS borné dans le temps, pas de perte de fonds, attaque peu incitative).

**Correctif proposé (NE PAS appliquer automatiquement)** : conditionner `has_votes` à ce que l'owner soit bien ce programme :
```rust
let has_votes = ctx.accounts.old_gauge_state.owner == ctx.program_id
    && gauge_data.len() >= 56
    && u64::from_le_bytes(gauge_data[48..56].try_into().unwrap()) > 0;
```
Un compte non initialisé (owner = SystemProgram) ou étranger donne `has_votes = false` → rollover immédiatement possible → supprime la surface d'attaque.

---

#### INFO — `ve_power` : cast `as u64` sans vérification de borne

**Surface** : `math.rs:106–109`

**Observation** : `((amount_locked * remaining * MAX_VE_MULTIPLIER) / MAX_LOCK_DURATION) as u64`. Le résultat u128 avant cast peut excéder `u64::MAX` si `amount_locked > u64::MAX / MAX_VE_MULTIPLIER = ~4.6e12 SOLA` avec un lock à durée maximale. Le cast `as u64` silencieusement tronque. L'impact serait une sous-estimation du pouvoir de vote pour un whale extrêmement grand.

**En pratique** : 4.6 × 10¹² SOLA avec 6 décimales = 4,6 trillion SOLA physiques. La courbe de bonding avec `k = 100e6 × 100e6` ne peut pas émettre autant de SOLA sans un achat démesuré de USDC. Non exploitable dans tout scénario réaliste.

**Recommandation** : avant mainnet, ajouter un `require!(result <= u64::MAX as u128, SoladromeError::Overflow)` ou utiliser `.min(u64::MAX as u128) as u64` dans `ve_power`. Renforce la défense-en-profondeur sans impact sur l'usage normal.

---

#### Confirmation : fix `contributor_borrow_usdc` bien présent en code ✓

Vérifié : `ContributorBorrowUsdc` (lib.rs:4206–4259) contient bien `contributor_hi_sola` avec `token::mint = hi_sola_mint, token::authority = contributor`, et le check `new_borrowed <= hi_sola_balance` est à lib.rs:1488–1491. Fix du 2026-06-11 confirmé en place.

---

#### RAS — autres surfaces ré-vérifiées ce jour

- **AMM `swap`** : fee total en u128, `amount_in_net as u64` garanti ≤ u64::MAX, réserves trackées en interne. ✓
- **`advance_accumulator`** : `saturating_mul` / `saturating_add` — pas de panic, pas de drainage silencieux. ✓
- **Flash-borrow guard** : `repay_usdc` exige `slot > last_borrow_slot` (lib.rs:731–733). ✓
- **Pause coverage** : entrées (buy, stake, borrow, lock, vote) paused ; sorties (sell, unstake, repay, claim) toujours ouvertes. ✓
- **`emit_pool_rewards`** : `require!(total_votes > 0)` en place (lib.rs:2248). ✓
- **`try_load_ve_power`** : vérifie owner + discriminateur + `lock.owner == user` (ve.rs:198–213). ✓
- **`old_gauge_state` PDA** : adresse re-dérivée canoniquement avant lecture (lib.rs:2395–2406) — seul l'owner check est absent (voir finding LOW ci-dessus).

---

### 2026-06-18 — Veille automatique (Sonnet 4.6, session planifiée)

#### Sources balayées

- Drift Protocol $286M (avril 2026) — déjà documenté les 11 et 16 juin
- [Raydium LP Mint Forgery $1.34M (2026-06-10) — GoPlus / CryptoTimes](https://www.cryptotimes.io/2026/06/11/raydium-exploit-update-goplus-reveals-how-hacker-stole-1-34m/) — déjà documenté le 16 juin
- [$127M bridge exploit (2026-06-14) — Nadcab/Cybernews](https://cybernews.com/crypto/300m-stolen-in-cross-chain-bridge-hack-largest-defi-exploit-of-2026/) — double finality check + validator compromise
- [Balancer V2 rounding exploit $128M (nov 2025) — Check Point Research](https://research.checkpoint.com/2025/how-an-attacker-drained-128m-from-balancer-through-rounding-error-exploitation/) — `mulDown` dans `_upscaleArray` ; 65 micro-swaps cumulent l'erreur
- [RUSTSEC-2026-0007 — bytes `BytesMut::reserve` integer overflow (CVE-2026-25541)](https://rustsec.org/advisories/RUSTSEC-2026-0007.html) — affecte bytes < 1.11.1 ; corrigé si `overflow-checks = true`
- Supply chain Rust : [chrono_anchor + 4 crates malveillants (mars 2026)](https://thehackernews.com/2026/03/five-malicious-rust-crates-and-ai-bot.html) — exfiltration de `.env` ; signalés par Socket
- RustSec Advisory Database — aucun advisory `anchor-lang` 0.32.x nouveau en juin 2026
- OtterSec / Neodyme / Sec3 — aucun advisory technique publié dans les 48 h précédant ce rapport

---

#### Confirmations de fixes (findings précédents)

**LOW `rollover_bribe` (signalé 2026-06-16) → CORRIGÉ ✓**
`lib.rs:2685` — `let owned_by_program = ctx.accounts.old_gauge_state.owner == ctx.program_id;` + `has_votes = owned_by_program && gauge_data.len() >= 56 && u64::from_le_bytes(...) > 0` — le check est en place et documenté par un commentaire explicatif inline. Un compte étranger ou non initialisé donne `has_votes = false` → rollover immédiat possible.

**INFO `ve_power` cast `as u64` (signalé 2026-06-16) → CORRIGÉ ✓**
`math.rs:109–113` — le calcul utilise désormais `.min(u64::MAX as u128) as u64` au lieu du cast silencieux. Sature proprement pour les whales extrêmes.

---

#### $127M bridge exploit (2026-06-14) → Non affecté ✓

**Technique** : double vecteur — compromission de validateurs de bridge + manipulation de finalité (1 confirmation acceptée au lieu de 12–15 min de finalité Ethereum). Les validateurs signaient sur inclusion en bloc, pas sur finalité → l'attaquant a diffusé une transaction valide, collecté les signatures, puis réorganisé la chaîne source pour l'invalider tandis que la chaîne destination avait déjà frappé les tokens.

**Soladrome** : aucun bridge cross-chain, aucun oracle externe. Le protocole est mono-chaîne Solana. Non affecté.

---

#### Balancer V2 rounding exploit $128M (nov 2025) → Non affecté ✓

**Technique** : `_upscaleArray` utilisait systématiquement `mulDown` (arrondi vers zéro) dans les ComposableStablePools. 65 micro-swaps accumulaient l'erreur de précision pour manipuler l'invariant et drainer les réserves.

**Soladrome** : AMM classique xy=k (pas de StablePool). Toutes les divisions dans `amm_math.rs` (`swap_out`, `lp_for_deposit`, `tokens_for_lp`) arrondissent vers le bas, ce qui est **favorable au protocole** et non à l'utilisateur — exactement l'inverse de la condition nécessaire à l'exploit Balancer. La formule `out = reserve_out * amount_in_net / (reserve_in + amount_in_net)` renvoie moins que la valeur exacte à l'utilisateur. Non affecté.

---

#### RUSTSEC-2026-0007 : bytes `BytesMut::reserve` overflow → Non affecté ✓

**Technique** : débordement entier dans `new_cap + offset` sans vérification ; si le build est configuré pour enrouler (`wrapping`), `self.cap` peut être sous-évalué → `spare_capacity_mut()` génère une slice hors-borne → comportement indéfini / corruption mémoire.

**Soladrome** :
1. Le crate `bytes` **n'apparaît pas** dans `Cargo.lock` — il n'est pas une dépendance transitive du programme.
2. Même s'il l'était : `[profile.release] overflow-checks = true` dans `Cargo.toml` force le **panic** à toute overflow entière → l'advisory dit explicitement que le problème ne s'applique pas dans cette configuration.
Non affecté.

---

#### Supply chain Rust (chrono_anchor et al.) → Non affecté ✓

**Technique** : cinq crates malveillants (`chrono_anchor`, `dnp3times`, `time_calibrator`, `time_calibrators`, `time-sync`) se faisaient passer pour des utilitaires de temps et exfiltraient les fichiers `.env` vers une infrastructure contrôlée par les attaquants.

**Soladrome** : seules trois dépendances directes — `anchor-lang = "0.32.1"`, `anchor-spl = "0.32.1"`, `solana-security-txt = "1.1.1"`. Aucune des crates malveillantes n'est présente. Non affecté.

---

#### `init_if_needed` — revue complète des surfaces → RAS ✓

Toutes les utilisations de `init_if_needed` dans `lib.rs` ont été vérifiées (ATAs et PDAs custom).

- **ATAs** (`user_sola`, `user_hi_sola`, `user_usdc`, `founder_hi_sola`, etc.) : adresses déterministes, propriétaires = Token Program — réinitialisation physiquement impossible.
- **PDAs custom** (`bribe_vault`, `gauge_state`, `user_epoch_votes`, `global_epoch_votes`, `lp_user_checkpoint`, `pool_epoch_accum`, `lock_position`) : les handlers correspondants **accumulent uniquement** (`checked_add`) sans jamais remettre à zéro l'état existant. Un appel ré-entrant ou répété ne peut qu'ajouter aux totaux, jamais les effacer → pas d'attaque de réinitialisation.

---

#### `checkpoint_lp` après `emit_pool_rewards` → RAS ✓

`checkpoint_lp` appelle `require!(!pa.finalized, SoladromeError::EpochNotFinalized)` (lib.rs:2431). Une fois `emit_pool_rewards` finalisé `pool_epoch_accum.finalized = true`, tout appel ultérieur à `checkpoint_lp` pour le même epoch/pool revert. Les totaux sont immutables après finalisation — aucune manipulation possible du dénominateur `total_weighted_supply`.

---

#### RAS — autres surfaces ré-vérifiées ce jour

- **Dépendances** : 3 dépendances directes, aucune crate suspecte, `overflow-checks = true` en release. ✓
- **`unstake_hi_sola` founder vesting** : check PDA + owner + linear unlock toujours en place (lib.rs:532–563). ✓
- **`SellSola` M-11** : `user_usdc.owner == user.key()` confirmé (lib.rs:3285). ✓
- **`try_load_ve_power`** : `owner != &crate::ID` → retour 0 sans désérialisation (ve.rs:199). ✓
- **Division par zéro `emit_pool_rewards`** : `require!(total_votes > 0) && require!(pool_votes > 0)` en place (lib.rs:2518–2519). ✓
- **`claim_bribe`** : `require!(total_votes > 0 && user_votes > 0 && total_bribed > 0)` en place (lib.rs:2600). ✓
