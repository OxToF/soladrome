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

---

### 2026-06-21 — Veille automatique (Sonnet 4.6, session planifiée)

#### Sources balayées

- [Humanity Protocol $36M private key hack (2026-06-09) — Halborn/CoinDesk](https://www.halborn.com/blog/post/explained-the-humanity-protocol-hack-june-2026) — laptop malveillant + multisig monolaptop → bridge upgradeable compromis + minting non autorisé
- [Kelp DAO $292M LayerZero DVN single-verifier (2026-04-18) — Chainalysis/CryptoTimes](https://www.chainalysis.com/blog/kelpdao-bridge-exploit-april-2026/) — DVN 1-of-1, RPC poisonné, finalité non attendue
- [Step Finance $27M private key treasury hack (2026-01-31) — CoinDesk](https://www.coindesk.com/business/2026/01/31/solana-based-defi-platform-step-finance-hit-by-usd30-million-treasury-hack-as-token-price-craters) — clé treasury compromise, projet fatal
- [Resolv Labs $25M unbacked mint exploit (2026-03-22) — Yahoo Finance](https://finance.yahoo.com/markets/crypto/articles/resolv-labs-stablecoin-depegs-plunges-110259193.html) — loophole de mintage USR sans backing
- [Bridge cross-chain $127M (2026-06-14) — Nadcab](https://www.nadcab.com/blog/defi-bridge-exploit-june-cross-chain) — double-finality flaw (déjà documenté 2026-06-18)
- [DeFi Hacks 2026 $840M+ — AltFins/CCN](https://altfins.com/blog/defi-hacks-2026/) — bilan global
- RUSTSEC Advisory Database — aucun nouvel advisory `anchor-lang` / `anchor-spl` 0.32.x en juin 2026
- OtterSec / Neodyme / Sec3 / Zellic — aucun advisory technique Solana nouveau public dans les 48h

---

#### Humanity Protocol $36M / Step Finance $27M — private key → Opsec ✓

**Technique** (commune aux deux incidents) : la clé privée contrôlant un multisig ou un treasury a été compromise (malware laptop pour Humanity, vecteur non précisé pour Step). Pour Humanity : multisig Gnosis Safe à 3-of-6 sur Ethereum, dont toutes les clés étaient sur le **même laptop** → un seul malware a suffi. Le bridge upgradeable a été pointé vers une implémentation malveillante, puis 141M H ont été drainés + 100M H non autorisés mintés.

**Soladrome** : `ProtocolState.authority` (Ledger Nano S physique dédié) est la seule surface équivalente. Différences clés :
- Il n'y a PAS de bridge upgradeable — le programme est upgradeable uniquement via `upgrade-authority` (BPF Upgradeable Loader) mais les tokens sont PDA-contrôlés par le programme, pas par un multisig externe.
- La clé authority ne peut PAS minter librement : les mints (SOLA, hiSOLA, oSOLA) sont tous authoritatés par le PDA `[b"state"]`, pas par le wallet authority directement.
- Les instructions sensibles (pause, transfer_authority, mint_founder_allocation, etc.) sont gated par `has_one = authority` sur le ProtocolState PDA.
- Le risque résiduel documenté (single-wallet authority → TODO multisig Squads avant mainnet) reste valide.

**Non affecté** — risque OPSEC documenté. ✓

---

#### Kelp DAO $292M LayerZero DVN exploit → Non affecté ✓

**Technique** : configuration 1-of-1 DVN LayerZero Labs ; RPC interne empoisonné → fausse attestation de burn sur la chaîne source → release USDC sur la destination. Déjà documenté le 2026-06-18 comme exploit de bridge cross-chain.

**Soladrome** : aucun bridge, aucun oracle externe, protocole mono-chaîne Solana. Non affecté.

---

#### Resolv Labs $25M — unbacked mint via loophole de mintage → Non affecté ✓

**Technique** : dépôt de 200 000 USDC → mintage de 80 M USR par une faille de comptabilité interne (le contrat accordait une valeur de delta-neutre sans vérifier le backing réel).

**Soladrome** — trois surfaces comparables vérifiées :

1. **`buy_sola`** : `sola_amount = vs - k/(vu + usdc_in)` (arrondi vers le bas → favorable au protocole). `floor_amount = sola_amount` → `usdc_in ≥ floor_amount` prouvé analytiquement (`f(x) = x + k/(vu+x) ≥ vs` pour tout x ≥ 0, avec égalité en 0 et croissante pour x > 0). Le `market_amount` ne peut pas être négatif. `require!(sola_amount > 0)` et `market_amount = usdc_in.checked_sub(floor_amount)` reverts si < 0. ✓

2. **`exercise_o_sola`** : coût = `o_sola_amount` USDC payé **avant** le mint de SOLA → backing toujours assuré avant création. ✓

3. **`flash_arbitrage`** : cas `fee_rate = 0` analysé en détail ce jour. Si la pool a un fee nul, `fee_total = 0`, `amount_net = amount_osola`, aucun SOLA résiduel à brûler. `total_purchased_sola += amount_osola` → le floor reçoit `amount_osola` USDC (step 5, lib.rs:3073–3082) → invariant `floor ≥ total_purchased_sola` maintenu. ✓

Non affecté.

---

#### LOW — `burn_o_sola_for_votes` avant `vote_gauge` : `total_power_snapshot` reste à zéro (CORRIGÉ)

**Surface** : `lib.rs:2360–2401` (handler `burn_o_sola_for_votes`) + `lib.rs:2074–2077` (init block de `vote_gauge`).

**Technique — footgun utilisateur, pas de risque protocolaire** : les deux instructions partagent le même PDA `UserEpochVotes` via les seeds `[b"uev", user, epoch_le8]`. `burn_o_sola_for_votes` initialise le PDA si inexistant (`if uev.epoch == 0 { uev.epoch = epoch; uev.bump = ...; }`) mais ne peuple **pas** le champ `total_power_snapshot` (qui reste à 0). Ensuite, quand l'utilisateur appelle `vote_gauge`, l'init block (`if uev.epoch == 0 { ... }`) est **sauté** car `uev.epoch != 0` — `total_power_snapshot` reste à 0.

**Conséquence** : si un utilisateur appelle `burn_o_sola_for_votes` en PREMIER dans l'epoch :
```
hi_sola_cap = total_power_snapshot = 0
effective_hi_sola = min(0, global_cap) = 0
power_cap = 0 + o_sola_bonus  ← seul le bonus oSOLA compte
```
L'utilisateur perd toute sa puissance de vote hiSOLA pour l'epoch. Seul l'oSOLA brûlé contribue, au lieu de l'addition hiSOLA + oSOLA prévue par le design.

**Ordre correct** (sans perte) : `vote_gauge` → `burn_o_sola_for_votes`. L'init block de `vote_gauge` snapshote la puissance hiSOLA en premier, puis le bonus oSOLA est ajouté additivement.

**Reproductibilité** :
1. Alice a 1 000 hiSOLA et 500 oSOLA, total_hi_sola = 5 000 (global_cap = 1 500).
2. Alice appelle `burn_o_sola_for_votes(500)` → UEV.epoch=N, UEV.o_sola_bonus=500, UEV.total_power_snapshot=0.
3. Alice appelle `vote_gauge(pool, 500)` → power_cap = 0 + 500 = 500. OK.
4. Alice appelle `vote_gauge(pool2, 1)` → new_total = 501 > 500. REVERT.
5. Ses 1 000 hiSOLA (= 1 000 votes potentiels) sont perdus pour l'epoch.

**Facteurs atténuants** :
- L'oSOLA brûlé est irréversiblement détruit — pas de perte protocolaire, seulement une perte de gouvernance utilisateur.
- Exploitable uniquement par l'utilisateur lui-même (signature requise).
- Pas de drainage de fonds possible — uniquement de l'influence de vote réduite.
- Un attaquant social engineering pourrait encourager des baleines hiSOLA à brûler l'oSOLA en premier pour leur faire perdre leur puissance de vote ce jour-là.

**Sévérité** : Low (footgun utilisateur / attaque de gouvernance sociale ; aucun risque de fonds).

**Correctif proposé (NE PAS appliquer automatiquement)** : dans le handler `burn_o_sola_for_votes`, lors de l'initialisation du UEV (`if uev.epoch == 0`), calculer et snapshoter la puissance hiSOLA + ve de l'utilisateur. Cela requiert l'ajout de `user_hi_sola` et `lock_position` dans le contexte `BurnOSolaForVotes`. Exemple :
```rust
if uev.epoch == 0 {
    uev.epoch = epoch;
    uev.bump = ctx.bumps.user_epoch_votes;
    // Snapshot hiSOLA power like vote_gauge does:
    let hi_balance = ctx.accounts.user_hi_sola.amount;
    let ve = ve::try_load_ve_power(&ctx.accounts.lock_position, &ctx.accounts.user.key(), clock.unix_timestamp);
    uev.total_power_snapshot = hi_balance.saturating_add(ve);
}
```
Alternativement, le frontend peut imposer l'ordre correct (voter d'abord, brûler ensuite) et documenter la contrainte.

**Fix appliqué (2026-06-21, option snapshot — robuste indépendamment de l'ordre d'appel)** :
Contexte `BurnOSolaForVotes` étendu avec `hi_sola_mint` (`address = protocol_state.hi_sola_mint`),
`user_hi_sola` (`constraint mint + owner == user`) et `lock_position` (`UncheckedAccount`), en
miroir exact de `VoteGauge`. Le handler calcule `total_power = user_hi_sola.amount + try_load_ve_power(...)`
AVANT le `&mut` du tracker et le snapshote dans le bloc `if uev.epoch == 0` — exactement comme
`vote_gauge`. Résultat : peu importe l'ordre (`burn` puis `vote` ou l'inverse), `total_power_snapshot`
capture la puissance hiSOLA+ve réelle au premier appel ; le bonus oSOLA reste additif et non capé.
Frontend `Stake.tsx` (`burnForVotes`) passe désormais `hiSolaMint` + `userHiSola` + `lockPosition`
(velock PDA, `try_load_ve_power` renvoie 0 s'il n'existe pas). Vérifié : `cargo check` (devnet + mainnet) ✅,
`anchor build` ✅, IDL régénéré + copié dans `app/lib/soladrome.json` ✅, `tsc --noEmit` frontend ✅.
**`anchor deploy` PAS encore fait** — en attente de validation humaine + redeploy devnet SBPFv3.

---

#### HIGH — Émission oSOLA continue non gated : farmable sans limite via pools permissionless (CORRIGÉ + DÉPLOYÉ)

**Surface** : `amm.rs` (`update_pool_rewards!` macro lib.rs-side ~30, `advance_pool_rewards` ~49,
`create_pool` ~77) + `amm_state.rs` (`AmmPool`). Découvert lors d'une revue ciblée du système
d'émission LP « maison » demandée avant deploy.

**Technique** : le stream d'émission continu (Masterchef, `osola_reward_per_lp`) accumulait
`OSOLA_EMISSION_PER_SEC` oSOLA/s pour **tout** pool AMM, sans aucun flag d'éligibilité, alors que
`create_pool` est **permissionless**. Aucune borne sur le nombre de pools ni sur le total émis
(contrairement au stream gauge budgété 800k/epoch + decay).

**Scénario** : un attaquant crée K pools avec des mints sans valeur qu'il contrôle, devient seul LP
(coût ≈ rent ~0,02–0,05 SOL/pool), et récolte `K × 86,4` oSOLA/jour (mainnet, taux 1 000) sans
plafond. Or l'oSOLA a une valeur réelle :
- `burn_o_sola_for_votes` → pouvoir de vote **non capé** (par design « burn = déflation »). Le cap
  anti-capture de 30 % (`VOTE_WEIGHT_CAP_BPS`) ne s'applique qu'au hiSOLA → de l'oSOLA farmé
  gratuitement **annule le cap de gouvernance** et permet de diriger les vraies émissions gauge.
- `exercise_o_sola` → mint SOLA au plancher (floor reste backé, mais inflation/dilution SOLA).

**Sévérité** : High (capture de gouvernance + inflation oSOLA non bornée ; l'hypothèse « oSOLA rare »
qui justifie les votes non capés était cassée). Lien direct avec le fix `burn_o_sola_for_votes` du
même jour, qui reposait sur cette hypothèse.

**Fix appliqué (2026-06-21, deploy bundle avec le fix burn)** :
- Champ `rewards_enabled: bool` ajouté à `AmmPool` (taillé dans le padding → `LEN` inchangé, pas de
  réalloc ; comptes existants lisent 0 = false). Défaut `false` à la création.
- Accrual gaté sur `rewards_enabled` dans `update_pool_rewards!` ET `advance_pool_rewards` ;
  `last_reward_ts` avance toujours → pas de back-pay quand un pool est activé après coup.
- Nouvelle instruction authority-only `set_pool_rewards(enabled)` (`SetPoolRewards`, `address =
  protocol_state.authority`) qui settle l'accrual sous l'ancien flag avant de basculer.
- L'émission est désormais bornée au set de pools « maison » approuvés par l'authority.

Vérifié : `cargo check` (devnet + mainnet) ✅, `anchor build` ✅ (IDL : `set_pool_rewards` +
champ `rewards_enabled` présents), IDL copié `app/lib/soladrome.json` ✅, `tsc --noEmit` frontend ✅,
`cargo build-sbf --arch v3` ✅, **`solana program deploy` via Helius FAIT** ✅ (slot
468695860 → 470924886, sig `8YeTTCPcr95M…`).

**⚠️ Action post-deploy requise** : tous les pools devnet existants ont désormais `rewards_enabled =
false` → l'authority doit appeler `set_pool_rewards(true)` sur les pools « maison » légitimes
(ex. SOLA/jitoSOL, oSOLA/SOLA) pour ré-activer leurs émissions. À documenter dans le runbook launch.

**Note** : deux streams d'émission oSOLA coexistent (continuous per-pool + gauge epoch) — à
clarifier/unifier dans une passe tokenomics séparée (hors scope de ce fix sécurité).

**Suivi (même jour) — le gate étendu en outil de bootstrap auto-expirant (déployé, slot 470932853).**
Le const `OSOLA_EMISSION_PER_SEC` supprimé ; rate désormais runtime `ProtocolState.continuous_rate_per_sec`
(u32, défaut 0) + sunset on-chain `continuous_end_epoch` (u16, défaut 0), via instruction authority
`configure_continuous_emissions(rate_per_sec, duration_epochs)`. Accrual gaté sur `rewards_enabled &&
current_epoch < continuous_end_epoch`. Champs taillés dans le rab de `ProtocolState` (LEN 400 inchangé,
pas de réalloc ; backward-compat vérifiée on-chain : compte existant désérialise rate=0/end=0). Décision
launch : 250k oSOLA/epoch (rate 413 360 base/s) sur le pool maison, 4 epochs, puis extinction automatique.
Le sunset on-chain élimine le risque « fondateur solo oublie de couper » du toggle manuel.

---

#### Confirmation des fixes des veilles précédentes — tous en place ✓

- **`rollover_bribe` owner check** (signalé 2026-06-16, corrigé 2026-06-18) : `owned_by_program = old_gauge_state.owner == ctx.program_id` à lib.rs:2685. ✓
- **`ve_power` cast saturant** (signalé 2026-06-16, corrigé 2026-06-18) : `.min(u64::MAX as u128) as u64` à math.rs:113. ✓
- **`contributor_borrow_usdc` check hiSOLA** (signalé + corrigé 2026-06-11) : `require!(new_borrowed <= hi_sola_balance)` à lib.rs:1509–1512. ✓
- **`unstake_hi_sola` founder vesting** : double PDA + owner check lib.rs:532–563. ✓
- **`stake_sola` auto-harvest** : auto-payout pending fees avant reset fees_debt lib.rs:437–452. ✓

---

#### RAS — surfaces ré-vérifiées ce jour

- **`borrow_against_locked`** : `lock_position` épinglé par seeds `[VELOCK_SEED, partner.key()]` (lib.rs:4608–4612) → un partenaire ne peut emprunter qu'avec son propre lock. Cap 20% sur locked, 75% floor buffer, flash guard. ✓
- **`flash_arbitrage`** : `pool` contraint à paire SOLA/USDC explicitement (lib.rs:4386–4389). Profitabilité `usdc_out > amount_osola` vérifiée avant tout transfert (lib.rs:3053). ✓
- **`vote_gauge`** : cap 30% live vs snapshot analysé — non exploitable par un whale externe ; la snapshot immutable de `total_power_snapshot` limite correctement même si `total_hi_sola` fluctue après le premier vote. ✓
- **`burn_o_sola_for_votes` post-vote** : si appelé APRÈS `vote_gauge`, le bonus s'ajoute correctement (allocated < power_cap + bonus). ✓
- **`emit_pool_rewards`** : `require!(total_votes > 0) && require!(pool_votes > 0)` lib.rs:2518–2519. ✓
- **`checkpoint_lp`** : `require!(!pa.finalized)` bloque toute manipulation post-finalisation lib.rs:2431. ✓
- **`claim_lp_emissions`** : double-claim bloqué par `LpEpochClaim` PDA `init` lib.rs:2582. ✓
- **Dépendances** : 3 dépendances directes (anchor-lang 0.32.1, anchor-spl 0.32.1, solana-security-txt 1.1.1), aucun advisory RUSTSEC nouveau. ✓

---

### 2026-06-23 — Veille automatique (Sonnet 4.6, session planifiée)

#### Sources balayées

- [DeFi Hacks 2026 — AltFins / CCN : $840M+ perdu, bridges dominants](https://altfins.com/blog/defi-hacks-2026/) — tour d'horizon, aucun vecteur Solana nouveau
- [Every Major DeFi Hack 2026 — Phemex : bridges cross-chain dominent](https://phemex.com/blogs/defi-hacks-2026-bridge-exploits-explained) — Aztec escape hatch $2.5M, MEV jaredfromsubway $15M
- [CCN DeFi Hacks & Exploits 2026 $1B+](https://www.ccn.com/education/crypto/defi-hacks-exploits-causes-crypto-stolen-2026/) — Kelp DAO, Drift, Resolv, bridge
- [Helius — A Hitchhiker's Guide to Solana Program Security](https://www.helius.dev/blog/a-hitchhikers-guide-to-solana-program-security) — patterns défensifs CPI + account reload
- [Cantina — Securing Solana: A Developer's Guide](https://cantina.xyz/blog/securing-solana-a-developers-guide) — account reload, CPI reentrancy patterns
- [Asymmetric Research — Invocation Security: Solana CPIs](https://www.asymmetric.re/blog-archived/invocation-security-navigating-vulnerabilities-in-solana-cpis) — CPI state-refresh vuln pattern
- [RUSTSEC Advisory DB](https://rustsec.org/advisories/) — aucun advisory `anchor-lang` / `anchor-spl` 0.32.x en juin 2026
- OtterSec / Neodyme / Sec3 / Zellic — aucun advisory technique Solana nouveau public dans les 48h
- [SSRN — Solana Security Ecosystem 2025 : 1 669 vulnérabilités, 163 audits](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6552478) — classes de bugs prévalentes

---

#### ⚠️ CORRECTION — infrastructure bridge présente dans le scope

Le rapport de ce jour avait initialement conclu « RAS — Soladrome mono-chaîne, aucun bridge ». **Cette conclusion était erronée.** Le projet comporte deux composants bridge distincts, tous deux absents des veilles précédentes :

1. **Wormhole Connect** — widget frontend statique (`app/public/wh/`) pour bridger des tokens généraux vers Solana avant utilisation du protocole. Pas d'interaction directe avec le programme Soladrome.
2. **soladrome-bridge** (`~/Desktop/soladrome-bridge/`) — OApp LayerZero V2 pour les bribes cross-chain EVM → Soladrome gauges. Programme Anchor `bridge-receiver` + contrat Solidity `SoladromeBribeRouter`.

Les findings ci-dessous portent sur ces deux surfaces.

---

#### CRITICAL — `DEPLOYER_PUBKEY = SystemProgram` : frontrun de `initialize()` possible

**Surface** : `soladrome-bridge/solana/programs/bridge-receiver/src/lib.rs:16`

```rust
pub const DEPLOYER_PUBKEY: Pubkey = pubkey!("11111111111111111111111111111111");
```

**Technique** : quand `DEPLOYER_PUBKEY == SYSTEM_PROGRAM_ID`, le guard F1 est entièrement bypassé :
```rust
if DEPLOYER_PUBKEY != SYSTEM_PROGRAM_ID {
    require!(ctx.accounts.owner.key() == DEPLOYER_PUBKEY, BridgeError::Unauthorized);
}
// → en dev mode, ce bloc ne s'exécute jamais
```

`initialize()` étant permissionless dans cet état, n'importe qui peut l'appeler AVANT le déploiement légitime et s'autoprocla­mer `owner` du `Store` PDA avec :
- `evm_peer` arbitraire (n'importe quel contrat EVM comme pair autorisé)
- `executor_whitelist` contenant uniquement ses propres clés
- `allowed_eids` réduisant les EIDs acceptés

Un attaquant ayant pris le contrôle du `Store` peut ensuite :
- Enregistrer des messages LZ forgés via `lz_receive` (lui-même dans la whitelist)
- Bloquer tout bribe légitime (il contrôle `paused`, `evm_peer`, `allowed_eids`)
- En V2 : drainer `bridge_fbomb_vault` → `soladrome_bribe_vault` pour n'importe quel pool/epoch

**Statut** : actuel. Le commentaire dit « UPDATE before every fresh mainnet deploy » — mais sans procédure enforced, le risque d'oubli avant un déploiement pressé est réel.

**Sévérité** : Critical (window d'attaque = gap entre `program deploy` et `initialize()`).

**Correctif proposé** : remplacer `DEPLOYER_PUBKEY` par la clé réelle AVANT de compiler pour mainnet, et ajouter un test qui échoue si la constante est encore `SYSTEM_PROGRAM_ID` :
```rust
// Dans tests ou un assert! au-dessus de declare_id!
#[cfg(feature = "mainnet")]
const _: () = {
    assert!(!DEPLOYER_PUBKEY.eq(&SYSTEM_PROGRAM_ID), "Set DEPLOYER_PUBKEY before mainnet build");
};
```
Alternativement : utiliser `upgrade-authority` pour que le déploiement et l'init soient dans la même transaction atomique.

---

#### HIGH — `lz_receive` sans validation LZ Endpoint : DVN verification entièrement bypassée

**Surface** : `soladrome-bridge/solana/programs/bridge-receiver/src/lib.rs:101–158` + `state.rs` (contexte `LzReceive`)

**Technique** : dans un OApp LayerZero V2 correct sur Solana, `lz_receive` est appelé VIA CPI par le programme LZ Endpoint (`76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6`), qui a lui-même vérifié les attestations DVN. La chaîne de confiance est :
```
DVNs attestent → LZ Endpoint vérifie on-chain → CPI → OApp::lz_receive
```

Dans ce bridge, le contexte `LzReceive` déclare :
```rust
#[account(mut)]
pub relayer: Signer<'info>,
```

`relayer` est un simple signataire — **pas** le programme LZ Endpoint. La validation se réduit à :
```rust
if !store.executor_whitelist.is_empty() {
    require!(store.executor_whitelist.contains(&relayer_key), BridgeError::UnauthorizedRelayer);
}
```
Le vrai LZ Endpoint n'est nulle part vérifié comme caller. Les paramètres `src_eid`, `sender`, `nonce`, `message` sont **tous fournis par le relayer** sans preuve cryptographique.

**Conséquence** :
- Si la whitelist est vide (dev mode) : **n'importe qui** peut appeler `lz_receive` avec une payload forgée.
- Whitelist non vide : un attaquant qui compromet une clé dans la whitelist peut injecter des messages arbitraires — aucune limite sur les champs `src_eid`, `sender`, `nonce`, `message` (sauf `sender == store.evm_peer`, mais ce champ est passé par le relayer lui-même).
- La recommandation DVN 2-of-2 dans `docs/architecture.md` est correcte mais se configure sur l'EVM LZ Endpoint — elle ne protège PAS la réception Solana si le programme n'enforce pas l'appel CPI depuis l'endpoint.

**Parallèle avec Kelp DAO $292M** : Kelp DAO utilisait le vrai LZ Endpoint mais avec un seul DVN compromis. Soladrome bridge ne valide pas du tout l'appel LZ Endpoint — une surface encore plus large.

**Impact V1 (actuel — message-only, pas de transfert réel)** :
- Faux événements `BribeReceived` émis on-chain
- Consommation de nonces pour bloquer des messages légitimes (DoS ciblé)
- Pas de perte de fonds (V2 CPI pas implémenté)

**Impact V2 (token transfer + CPI Soladrome)** :
- Drainage de `bridge_fbomb_vault` vers `soladrome_bribe_vault` pour un pool/epoch arbitraire
- Manipulation du système de gauge Soladrome depuis une fausse bribe cross-chain

**Sévérité** : High (V1 = DoS + events forgés ; V2 = drain + gauge manipulation). À corriger AVANT toute implémentation V2.

**Correctif proposé** : remplacer `relayer: Signer<'info>` par une vérification que l'instruction est appelée via CPI depuis le programme LZ Endpoint :
```rust
// Dans le contexte LzReceive :
#[account(
    constraint = lz_endpoint.key() == LZ_ENDPOINT @ BridgeError::Unauthorized,
)]
pub lz_endpoint: Signer<'info>,  // doit être le programme LZ Endpoint
```
Alternativement, si le pattern recommandé LZ V2 Solana utilise `invoke_signed` depuis l'Endpoint, s'assurer que `ctx.accounts.lz_endpoint.key() == LZ_ENDPOINT` ET que le programme est le signataire effectif du CPI. Se référer aux exemples officiels LZ V2 Solana (`layerzerolabs/oapp-solana`).

---

#### MEDIUM — `Store::LEN` : dépassement des Vecs possible à `initialize()`

**Surface** : `soladrome-bridge/solana/programs/bridge-receiver/src/state.rs:22–27`

```rust
pub const LEN: usize = 8 + 32 + 32 + 4 + (10 * 4) + 4 + (5 * 32) + 1 + 1;
// max 10 EIDs, max 5 executors
```

`allowed_eids: Vec<u32>` et `executor_whitelist: Vec<Pubkey>` sont des Vecs dynamiques. Si `initialize()` est appelé avec 11 EIDs ou 6 executors, l'espace alloué (`space = Store::LEN`) est insuffisant → `AccountDidNotSerialize` ou panic Borsh.

En V1 c'est un simple footgun. Mais si l'owner envoie une longue liste et que la transaction échoue, le Store PDA (créé avec `init`) n'existe pas — l'attaque est retentée. Pas de perte de fonds.

**Correctif** : valider les longueurs des Vecs dans `initialize()` avant la désérialisation, ou utiliser des arrays fixes `[u32; 10]` et `[Pubkey; 5]` dans la struct.

---

#### LOW — Pas de garde epoch (EVM) : bribe sur epoch passé acceptée

**Surface** : `soladrome-bridge/evm/contracts/SoladromeBribeRouter.sol:116–141` (`depositBribe`)

Aucune vérification que `epoch >= current_gauge_epoch()`. Un utilisateur peut verrouiller du fBOMB pour une epoch déjà terminée. En V2, `deposit_bribe` sur Soladrome rejetterait probablement les epochs passées (pas encore vérifié), mais le fBOMB resterait bloqué côté EVM 7 jours.

**Correctif** : comparer `epoch >= block.timestamp / EPOCH_DURATION` côté EVM (nécessite un oracle ou accept que Solana rejette et le `adminForceRefund` récupère le fBOMB).

---

#### INFO — Wormhole Connect : risque supply-chain frontend uniquement

**Surface** : `soladrome/app/public/wh/` — widget UI statique (bundle Wormhole Connect)

Ce widget permet aux utilisateurs de bridger des tokens généraux (USDC, SOL...) vers Solana avant d'utiliser Soladrome. Il n'interagit PAS avec le programme Soladrome on-chain. Risques :
- Si Wormhole est exploité, les actifs bridgés via ce widget (et non encore utilisés dans Soladrome) pourraient être à risque — précédent : $320M Wormhole hack 2022.
- Risque supply chain : le bundle `main.mjs` est un binaire pré-compilé par l'équipe Wormhole. Vérifier l'intégrité (hash) du bundle à chaque mise à jour.
- Le cœur du protocole Soladrome (floor, bonding curve, staking, gauge) n'est PAS affecté par un hack Wormhole.

**Recommandation** : épingler la version du bundle Wormhole Connect et vérifier son hash SHA256 après chaque mise à jour.

---

#### INFO — `_lzReceive` EVM : pas de valida­tion du GUID de confirmation

**Surface** : `SoladromeBribeRouter.sol:150–175` (`_lzReceive`)

En V2, BribeReceiver envoie un message de confirmation (success/refund) vers l'EVM. `_lzReceive` décote le `bool success` et efface ou rembourse. Il n'y a pas de validation que le `guid` dans les mappings est valide avant de tenter le remboursement (protégé par `if briber == address(0) || amount == 0 revert UnknownGuid`). Correct pour V1.

---

#### Exploit Aztec escape hatch $2.5M (juin 2026) → Non affecté ✓ (programme core)

**Technique** : faille dans le mécanisme d'« escape hatch » du rollup privé Aztec (ZK/privacy L2 Ethereum).

**Soladrome programme core** : aucun composant ZK, aucun rollup. Non affecté pour le programme principal.
**soladrome-bridge** : aucun composant ZK non plus. Non affecté par ce vecteur spécifique.

---

#### MEV jaredfromsubway $15M (juin 2026) → Non affecté ✓

**Technique** : attaque sur un bot MEV Ethereum — frontrun EVM, pas de mempool public Solana.

**Soladrome** : prix de bonding curve déterministe, slippage guards en place. Non affecté.
**soladrome-bridge EVM** : `depositBribe` ne dépend pas du prix → pas de sandwich possible.

---

#### Pattern CPI account-state refresh → Vérifié ✓

**Technique surveillée** : Anchor ne rechargue pas automatiquement les comptes désérialisés après un CPI. Un programme qui lit `token_account.amount` APRÈS une CPI de mint/transfer reçoit une valeur périmée — source potentielle de calculs de fees incorrects.

**Soladrome** : les développeurs sont explicitement conscients du problème. Vérification case-by-case :

| Instruction | Valeur pré-CPI sauvegardée | OK |
|---|---|---|
| `stake_sola` | `old_balance = user_hi_sola.amount` avant mint (lib.rs:404) | ✓ |
| `add_liquidity` | `user_lp_pre = user_lp.amount` avant CPI (amm.rs:198) | ✓ |
| `remove_liquidity` | `user_lp_pre = user_lp.amount` avant burn (amm.rs:297) | ✓ |
| `unstake_hi_sola` | `market_balance` capturé avant CPI, `last_market_vault_balance` mis à jour après (lib.rs:494, 589) | ✓ |
| `lock_hi_sola` | `market_balance` capturé avant CPI ; pattern identique (ve.rs:65–71) | ✓ |

Aucun cas où une valeur post-CPI périmée alimente un calcul financier. Le commentaire `// Anchor does not reload the cached token account after the mint CPI below` (lib.rs:402–403) confirme la conscience du pattern. Non affecté.

---

#### INFO — `configure_continuous_emissions` : pas de settlement préalable des pools

**Surface** : `lib.rs:2195–2224` + `amm.rs:54–68` (`advance_pool_rewards`).

**Observation** : quand l'authority appelle `configure_continuous_emissions(new_rate, duration)`, le champ `protocol_state.continuous_rate_per_sec` est mis à jour **immédiatement** sans pré-régler les accumulateurs par pool. Or chaque pool règle son accumulateur (`osola_reward_per_lp`) uniquement lors de sa prochaine interaction (`add_liquidity`, `remove_liquidity`, `swap`, `set_pool_rewards`) en utilisant `rate = protocol_state.continuous_rate_per_sec` **au moment de l'interaction**.

Conséquence : si le rate passe de R₁ à R₂ à l'instant T₀, et qu'un pool n'est touché qu'à T₁ > T₀, la période [T_last, T₁] est récompensée au taux R₂ au lieu de [T_last, T₀] × R₁ + [T₀, T₁] × R₂.
- **Hausse de rate** → back-pay partiel au taux supérieur pour la période pré-changement.
- **Baisse de rate (ou désactivation)** → sous-paiement pour la même période.

**Contraste avec `set_pool_rewards`** : cette instruction (amm.rs:78–90) appelle correctement `advance_pool_rewards(pool, now, old_rate, old_active)` AVANT de modifier `rewards_enabled` — elle règle le pool au taux en vigueur. `configure_continuous_emissions` ne peut pas faire l'équivalent (il ne passe aucun pool en contexte — il y a potentiellement N pools).

**Impact** : erreur de comptabilité de quelques centaines d'oSOLA lors d'un changement de rate (quantité liée à l'interval non réglé × delta de rate). Pas de perte de fonds utilisateurs (l'oSOLA supplémentaire est minté ex nihilo) ni drain de vault. Décision volontaire d'architecture (simplication de l'instruction admin), analogue à Masterchef v1/v2.

**Exploitabilité** : nulle — `configure_continuous_emissions` exige la signature de l'authority (Ledger Nano S). Un attaquant externe ne peut pas déclencher ce comportement.

**Sévérité** : Info (operational concern, non exploitable, authority-gated).

**Recommandation (pré-mainnet, runbook)** : avant tout appel à `configure_continuous_emissions` qui change le rate, appeler d'abord `set_pool_rewards(true)` sur chaque pool approuvé pour régler les accumulateurs au rate courant. Documenter la séquence dans le runbook de gouvernance.

---

#### Confirmation des fixes des veilles précédentes — tous en place ✓

- **`burn_o_sola_for_votes` snapshot hiSOLA** (signalé + corrigé 2026-06-21) : `total_power_snapshot` calculé dans le bloc `if uev.epoch == 0` — lib.rs:~2460–2480. ✓
- **`set_pool_rewards` gate continu** (signalé + corrigé 2026-06-21) : `rewards_enabled = false` par défaut, `advance_pool_rewards` settle avant toggle — amm.rs:78–90. ✓
- **`configure_continuous_emissions`** : authority-gated (`address = protocol_state.authority`) — lib.rs:4949–4957. ✓
- **`rollover_bribe` owner check** (corrigé 2026-06-18) : `owned_by_program = old_gauge_state.owner == ctx.program_id` — lib.rs:2685. ✓
- **`ve_power` cast saturant** (corrigé 2026-06-18) : `.min(u64::MAX as u128) as u64` — math.rs:109–113. ✓
- **`contributor_borrow_usdc` check hiSOLA** (corrigé 2026-06-11) : `require!(new_borrowed <= hi_sola_balance)` — lib.rs:1509–1512. ✓
- **`founder_hi_vesting` PDA + owner check** (corrigé 2026-06-11) — lib.rs:523–545. ✓
- **`stake_sola` auto-harvest** (corrigé 2026-06-11) — lib.rs:437–452. ✓

---

#### RAS — surfaces ré-vérifiées ce jour

- **AMM `add_liquidity` / `remove_liquidity`** : pré-CPI balances sauvegardées (`user_lp_pre`), reward accumulator settled avant harvest, CEI pattern respecté. ✓
- **`try_load_ve_power`** : `owner != &crate::ID` → retour 0 (ve.rs:199) ; `lock.owner == user` vérifié (ve.rs:210). ✓
- **`replay_vote`** : `try_load_ve_power` utilisé pour `lock_position` UncheckedAccount ; founder-guard en miroir de `vote_gauge`. ✓
- **`DistributeOSola`** : `recipient` UncheckedAccount validé implicitement par `associated_token::authority = recipient` ; instruction gated par `has_one = authority`. ✓
- **`claim_lp_emissions`** : `LpEpochClaim` PDA `init` = double-claim impossible ; `weighted_balance` remis à 0 après claim (fix M-01). ✓
- **`pending_fees` multiplication** : `delta * hi_sola_balance as u128` sans `checked_mul`, mais `overflow-checks = true` en release → panic plutôt que wrap silencieux. Pratiquement inatteignable. ✓
- **Dépendances** : anchor-lang 0.32.1, anchor-spl 0.32.1, solana-security-txt 1.1.1 — aucun advisory RUSTSEC en juin 2026. ✓

---

#### ✅ Fixes appliqués — soladrome-bridge (2026-06-23, session même jour)

Suite à l'autorisation explicite de l'utilisateur (`/goal Fix findings`), les correctifs suivants ont été appliqués dans `~/Desktop/soladrome-bridge/`. **`cargo check` : 0 erreur ✓** (warnings Anchor upstream pré-existants uniquement).

**[CRITICAL] `lib.rs` — DEPLOYER_PUBKEY → upgrade authority on-chain**
- Supprimé : `pub const DEPLOYER_PUBKEY: Pubkey = pubkey!("111...1")` (bypass permissionless).
- Ajouté : vérification du compte BPF Loader Upgradeable `program_data` (PDA `[program_id]` sous `bpf_loader_upgradeable::ID`). Le handler `initialize()` lit les octets `[0..4]` (variant=3), `[12]` (authority présente), `[13..45]` (pubkey upgrade authority) et exige `upgrade_authority == owner.key()`.
- Contexte `Initialize` : ajout de `program_data: UncheckedAccount<'info>` avec constraint seeds BPF Loader Upgradeable ; commentaire `/// CHECK:` documentant la vérification manuelle.

**[HIGH] `lib.rs` + `Cargo.toml` + `errors.rs` — executor whitelist non-contournable**
- Ajouté : `EmptyWhitelist` dans `errors.rs`.
- Ajouté : feature `dev = []` dans `Cargo.toml` (documentation explicite « NEVER mainnet »).
- Dans `initialize()`, `set_executor_whitelist()` ET `lz_receive()` : `#[cfg(not(feature = "dev"))] require!(!whitelist.is_empty(), BridgeError::EmptyWhitelist)`.
- La vérification « relayer dans whitelist » est conservée inconditionnellement quand la whitelist est non vide (dev et prod) ; en dev avec whitelist vide elle est sautée (localnet).

**[MEDIUM] `lib.rs` + `errors.rs` — bornes Vec pour Store::LEN**
- Ajouté : `pub const MAX_EIDS: usize = 10` et `pub const MAX_EXECUTORS: usize = 5`.
- Ajouté : `InvalidConfig` dans `errors.rs`.
- Dans `initialize()` : `require!(allowed_eids.len() <= MAX_EIDS)` + `require!(executor_whitelist.len() <= MAX_EXECUTORS)`.
- Dans `set_executor_whitelist()` : même check `<= MAX_EXECUTORS`.

**[LOW] `SoladromeBribeRouter.sol` — epoch guard EVM**
- Ajouté : error `EpochAlreadyEnded(uint64 epoch, uint64 currentEpoch)`.
- Dans `depositBribe()` : `uint64 currentEpoch = uint64(block.timestamp / 604_800); if (epoch < currentEpoch) revert EpochAlreadyEnded(epoch, currentEpoch)`. Durée d'epoch = 604 800 s = EPOCH_DURATION Soladrome.

**À faire avant deploy bridge** :
1. ✅ `anchor build` dans `soladrome-bridge/solana/` (IDL + .so régénérés avec les nouveaux contexts).
2. ✅ **FAIT** — Test localnet `initialize()` : validateur lancé avec `--upgradeable-program <id> <so> <provider_wallet>` (authority = provider) → `tests/bridge-receiver.ts` **2/2 passing** : (a) wallet ≠ authority revert `Unauthorized` (6005), (b) provider wallet = authority → succès + Store.owner correct. Harness `package.json`+`tsconfig.json`+`tests/` créée. Note : `anchor test` par défaut cible devnet (Anchor.toml) ; le validateur localnet vanilla charge le programme avec authority nulle → utiliser `--upgradeable-program` pour fixer l'authority.
3. ✅ **FAIT** — Test Hardhat `depositBribe()` : `evm/test/SoladromeBribeRouter.epoch.test.ts` **3/3 passing** (past epoch → revert `EpochAlreadyEnded(epoch,current)` ; current + future → `BribeQueued`). Mock `MockLZEndpoint.sol` ajouté ; plugin `hardhat-chai-matchers` ajouté à la config.
4. ✅ **FAIT** — Build mainnet SANS `dev` : `default = []` confirmé (dev opt-in), `cargo build-sbf --arch v3` produit `bridge_receiver.so` SBPFv3 (216 KB, sha256 `257d8d74…`). Diff de hash no-dev vs `--features dev` → DIFFÉRENT (l'enforcement `#[cfg(not(feature="dev"))] EmptyWhitelist` est bien dans le binaire mainnet) ; build no-dev déterministe.

**Reste avant deploy réel** : redéployer le `.so` v3 sur devnet/mainnet (le Store devnet existant — créé par un run de test sur devnet — devra être pris en compte : pas d'instruction `close`, le PDA `[b"Store"]` est singleton). Tout script d'init doit passer le nouveau compte `program_data`.

---

### 2026-06-29 — Veille automatique (Sonnet 4.6, session planifiée)

#### Sources balayées

- [Taiko Bridge Exploit $1.7M — SGX signing key leaked on GitHub (2026-06-21/22)](https://thedefiant.io/news/hacks/taiko-bridge-exploit-sgx-signing-key-github-1-7m) — clé RSA-3072 (`enclave-key.pem`) commitée publiquement → prover forgé → fausses preuves de retrait acceptées
- [Taiko Bridge Exploit — Darknavy deep-dive](https://www.darknavy.org/blog/web3/exploits/taiko-bridge-source-signal-proof-forgery/) — vecteur source-signal proof forgery
- [DeFi Hacks 2026 $840M+ — AltFins](https://altfins.com/blog/defi-hacks-2026/) — bilan global ; bridges dominent
- [Every Major DeFi Hack 2026 — Phemex](https://phemex.com/blogs/defi-hacks-2026-bridge-exploits-explained) — $127M bridge (déjà documenté), Aztec (déjà documenté), MEV jaredfromsubway
- [Blockaid — TOCTOU attacks Solana (référence, 2024)](https://www.blockaid.io/blog/dissecting-toctou-attacks-how-wallet-drainers-exploit-solanas-transaction-timing) — classe d'attaque client-side (simulation vs exécution)
- [RareSkills — `init_if_needed` reinitialization attack (référence)](https://rareskills.io/post/init-if-needed-anchor) — classe de bugs connue Anchor
- [SseRex — Symbolic execution Solana smart contracts (arxiv 2026-03)](https://arxiv.org/abs/2603.16349) — état de l'art analyse statique Solana
- RustSec Advisory Database — aucun nouvel advisory `anchor-lang` / `anchor-spl` 0.32.x trouvé en juin 2026
- OtterSec / Neodyme / Sec3 / Zellic — aucun advisory technique Solana nouveau public dans les 48–72h précédant ce rapport

---

#### Taiko Bridge SGX Key Leak $1.7M (2026-06-21/22) → Non affecté, opsec note

**Technique** : la clé RSA-3072 de l'enclave SGX (`enclave-key.pem`) de Raiko (prouveur multi-stack de Taiko) avait été commitée dans le dépôt public `taikoxyz/raiko`. L'attaquant a enregistré un faux prover via cette clé, obtenu des attestations SGX légitimes sur des états L2 fictifs, puis soumis des preuves de retrait sans dépôt correspondant → $1.7M drainé avant le freeze.

**Soladrome core** : aucun SGX, aucun prouveur externe, aucune preuve ZK. Non affecté.

**soladrome-bridge** : aucun composant SGX. La confiance repose sur les DVNs LayerZero (off-chain) + whitelist executor on-chain. Non affecté par ce vecteur spécifique.

**Leçon transposable — opsec clés bridge** : le vrai risque analogue pour soladrome-bridge est la compromission des clés privées des executors dans la whitelist. Vérification effectuée ce jour : le repo `soladrome-bridge` ne contient aucun fichier `.pem`, `.key`, `.env` ni private key commitée (seul `tests/bridge-receiver.ts` utilise `anchor.provider.wallet` = keypair local, jamais commitée). Statut : ✓ propre.

---

#### TOCTOU attacks Solana (client-side) → Non affecté ✓

**Technique** : des draineurs exploitent le delta entre simulation de transaction (client) et exécution on-chain en modifiant l'état entre les deux fenêtres (quelques secondes). Les wallets/dApps basés uniquement sur la simulation peuvent approuver une transaction qui se révèle destructrice à l'exécution.

**Soladrome** : cette classe d'attaque est principalement un risque d'interface (frontend / wallet), pas un risque de programme Anchor.

Vérification code ce jour :
- `buy_sola` : slippage guard `require!(sola_amount >= min_sola_out)` à lib.rs:227 — si un attaquant MEV insère un buy entre la simulation et l'exécution, le prix bouge mais le guard rejette la transaction. ✓
- `sell_sola` : prix déterministe 1:1 depuis `floor_vault` (invariant k ne bouge pas sur sell) — aucune surface de sandwiching. ✓
- `amm_swap` : slippage guard `require!(out >= min_out)` à amm.rs (paramètre `min_out`). ✓
- `exercise_o_sola` / `borrow_usdc` / `lock_hi_sola` : aucune dépendance à un prix oracle externe → pas de surface TOCTOU.

Non affecté.

---

#### Vérification code complète des fixes précédents — tous confirmés en place ✓

| Finding | Localisation | Statut |
|---|---|---|
| `founder_hi_vesting` PDA + owner check | lib.rs:533–545 | ✓ en place |
| `rollover_bribe` owner check | lib.rs:2736–2738 | ✓ en place |
| `ve_power` cast saturant `.min(u64::MAX as u128)` | math.rs:109–113 | ✓ en place |
| `contributor_borrow_usdc` check `new_borrowed <= hi_sola_balance` | lib.rs:1509–1512 | ✓ en place |
| `burn_o_sola_for_votes` snapshot `total_power_snapshot` | lib.rs:2444 | ✓ en place |
| `rewards_enabled` gate `advance_pool_rewards` / `update_pool_rewards!` | amm.rs:39, 61 | ✓ en place |
| `stake_sola` auto-harvest pending fees avant reset | lib.rs:437–452 | ✓ en place |

---

#### Vérification surfaces UncheckedAccount — RAS ✓

Tous les `UncheckedAccount` vérifiés ce jour :

| Compte | Validation | OK |
|---|---|---|
| `new_authority` | Pubkey uniquement utilisé ; handler vérifie ≠ default et ≠ authority actuelle | ✓ |
| `recipient` (DistributeOSola) | Dérivation ATA implicite (`associated_token::authority = recipient`) | ✓ |
| `contributor_wallet` | Seed PDA : identité enforced par `[CONTRIBUTOR_SEED, contributor_wallet.key()]` | ✓ |
| `founder_ops` | `#[account(address = FOUNDER_OPS_WALLET)]` — adresse fixe hardcodée | ✓ |
| `lock_position` | Consommé via `try_load_ve_power` (owner check + discriminateur + `lock.owner == user`) | ✓ |
| `pool_id` | Utilisé uniquement comme seed PDA ; authentifié par les PDAs dérivés | ✓ |
| `old_gauge_state` | PDA re-dérivé canoniquement avant lecture + `owned_by_program` check avant usage | ✓ |

---

#### RAS — autres surfaces ré-vérifiées ce jour

- **AMM math** : `amm_math.rs` — tout `checked_mul` / `checked_div` / `checked_add` / `checked_sub` avec erreur `Overflow`. `as u64` sur résultat u128 garanti ≤ u64::MAX par la structure des calculs (vérification ci-dessus). ✓
- **`init_if_needed` reinitialization** : revue rapide — tous les handlers d'init_if_needed accumulent (pas de reset à zéro) ; ATAs = adresses déterministes SystemProgram → réinit physiquement impossible. ✓
- **`sell_sola` sans min_usdc_out** : acceptable car prix déterministe (1:1 floor, pas d'oracle). ✓
- **Dépendances** : anchor-lang 0.32.1, anchor-spl 0.32.1, solana-security-txt 1.1.1 — aucun advisory RUSTSEC en juin 2026. ✓
- **soladrome-bridge opsec** : aucune clé privée commitée dans le repo. ✓

---

### 2026-07-03 — Veille automatique (Sonnet 5, session planifiée)

#### Contexte

Aucun commit n'a touché `programs/soladrome/src/` depuis le dernier audit du 2026-06-29 (dernier commit programme : `80ae6f0`, déjà audité). Les commits récents (`46bb16b`…`c0327b4`) sont tous frontend/PWA/wallet-mobile, hors périmètre programme on-chain. Cette veille porte donc uniquement sur les nouvelles divulgations externes.

#### Sources balayées

- WebSearch "Solana exploit hack July 2026" → [Drift Protocol $285M (avril 2026, déjà connu, hors fenêtre)](https://www.helius.dev/blog/solana-hacks)
- WebSearch "Anchor framework vulnerability advisory 2026" → bruit (résultats "Anchore" container-scanning, sans rapport)
- WebSearch "DeFi exploit post-mortem rounding bug AMM" → [Balancer V2 $116-128M — rounding error `_upscaleArray` mulDown vs mulUp sur EXACT_OUT batchSwap](https://www.theblock.co/post/377863/balancer-identifies-rounding-error-as-root-cause-of-multi-chain-defi-exploit)
- WebSearch + WebFetch RustSec package `anchor-lang` → **2 advisories HIGH trouvés** (RUSTSEC-2026-0146, RUSTSEC-2026-0144), voir ci-dessous
- WebSearch "ve(3,3) gauge bribe exploit governance attack 2026" → rien de spécifique/daté, seulement doc générale sur les risques de délégation
- WebSearch "Solana PDA account substitution exploit" → [FuzzingLabs — Revival Attacks on Solana Programs](https://fuzzinglabs.com/revival-attacks-solana-programs/) (classe de bug, pas un incident daté)
- OtterSec / Neodyme / Sec3 / Zellic — aucun nouvel advisory technique Solana publié dans les 48–72h précédant ce rapport

---

#### RUSTSEC-2026-0146 & RUSTSEC-2026-0144 (anchor-lang, mai 2026) → Non affecté, version pinned trop ancienne ✓ (mais piège pour upgrade future)

**RUSTSEC-2026-0146 — `InterfaceAccount` account substitution (CVSS 8.7 HIGH, 2026-05-19)**
Le wrapper `InterfaceAccount` ne validait plus que l'`owner` du compte (un des programs acceptés par l'interface) sans vérifier le discriminateur / type réel des données → substitution de compte d'un type inattendu si détenu par un programme accepté.
**Versions affectées** : `anchor-lang >=1.0.0-rc.1, <1.0.0-rc.2`. **Non affecté** : `<1.0.0-rc.1`.

**RUSTSEC-2026-0144 — `Program<System>` accepte des programmes exécutables arbitraires (HIGH, 2026-05-18)**
`Pubkey::default()` utilisé comme sentinelle pour distinguer `Program<T>` typé de `Program<()>` non typé ; comme l'ID du system program == `Pubkey::default()`, la validation typée dégénérait en acceptation de n'importe quel programme exécutable en lieu et place du system program → CPI/création de compte/paiement détournables.
**Versions affectées** : `anchor-lang >=1.0.0, <1.0.2`. **Non affecté** : `<1.0.0`.

**Vérification code** :
- `Cargo.lock` : `anchor-lang` / `anchor-spl` / tous les crates `anchor-*` uniformément à **0.32.1** — largement en dessous des deux plages affectées (`1.0.0-rc.1+` et `1.0.0+`). **Non exposé.**
- `grep -rn "InterfaceAccount"` sur `programs/soladrome/src/*.rs` → aucun usage (Soladrome n'utilise que `Account<T>` typé strict + validations manuelles `try_deserialize` avec owner-check pour les `UncheckedAccount`). Non exposé même hors version.
- `grep -rn "Program<'info, System>"` → ~40 occurrences (toutes les instructions qui créent/paient des comptes). C'est exactement le type visé par 0144 — **surface à re-vérifier obligatoirement avant toute montée de version anchor-lang**.

**Sévérité pour Soladrome aujourd'hui** : Info (non exploitable, version trop basse pour être dans la plage affectée).

**Recommandation (piège futur, pas un fix immédiat)** : si/quand `anchor-lang` est mis à jour vers une branche `1.x`, ne JAMAIS s'arrêter entre `1.0.0-rc.1` et `1.0.2` — sauter directement à `>=1.0.2`. Ajouter un check `cargo audit` (ou `cargo deny`) au CI pour attraper ce genre d'avisory RUSTSEC automatiquement au lieu de dépendre de la veille manuelle. Actuellement `programs/soladrome/.github` ne semble pas lancer `cargo audit` — à confirmer/ajouter en tâche séparée (non fait ce jour, hors scope veille).

---

#### Balancer V2 $116-128M rounding bug (EXACT_OUT batchSwap, mulDown/mulUp mismatch) → Non affecté ✓

**Technique** : `_upscaleArray` utilisait `mulDown` au lieu de `mulUp` dans le chemin `EXACT_OUT` du `batchSwap` v2, permettant à l'attaquant de faire chuter les balances de pool sous le seuil minimum via 65 micro-swaps successifs, chaque arrondi drainant une fraction de dust en sa faveur.

**Vérification code** (`amm_math.rs`) :
- Soladrome n'a **qu'un seul mode de swap : EXACT_IN** (`swap(amount_in, min_out, a_to_b)` — amm.rs:457 ; `buy_sola(usdc_in, min_sola_out)` — lib.rs:215 ; flash-arb interne — lib.rs:3000). Aucune instruction `EXACT_OUT` n'existe → pas de paire de fonctions de scaling forward/reverse pouvant diverger comme chez Balancer.
- `swap_out()` (amm_math.rs:24) : division entière `numerator.checked_div(denominator)` = floor — arrondi systématiquement en faveur du protocole (l'utilisateur reçoit `out` légèrement inférieur au continu). ✓
- `lp_for_deposit()` / `tokens_for_lp()` (amm_math.rs) : mêmes divisions floor sur `lp_a`/`lp_b`/`optimal_a`/`optimal_b` et sur les montants rendus au burn de LP → toujours arrondi en faveur du pool, jamais en faveur de l'utilisateur. ✓
- Une seule fonction d'arrondi utilisée de bout en bout (pas de duplication de logique de mise à l'échelle) → classe de bug structurellement absente.

Non affecté.

---

#### Revival attacks (FuzzingLabs, classe de bug — fermeture de compte non correctement marquée) → Non applicable ✓

**Technique** : un programme qui ferme un compte en mettant les lamports à zéro sans utiliser la contrainte `close` d'Anchor (qui écrit le discriminateur `CLOSED_ACCOUNT_DISCRIMINATOR` et transfère les lamports de façon atomique) laisse une fenêtre où un attaquant peut re-créditer des lamports dans la même transaction et "ressusciter" le compte avec son ancien état.

**Vérification code** : `grep -rn "close\|lamports()" programs/soladrome/src/*.rs` → **aucune occurrence**. Soladrome ne ferme jamais de compte manuellement (aucune instruction `close_account`, aucun usage de la contrainte `#[account(close = ...)]`, aucune manipulation directe de `lamports()`). Tous les comptes du protocole sont conçus pour vivre indéfiniment (accumulateurs, positions, PDAs de vote) ou sont des ATAs standard gérés par `init_if_needed`. Surface d'attaque structurellement absente — pas de fermeture de compte à sécuriser.

Non applicable.

---

#### Vérification code complète des fixes précédents — tous confirmés en place ✓

| Finding | Localisation | Statut |
|---|---|---|
| `founder_hi_vesting` PDA + owner check | lib.rs:533–545 | ✓ en place |
| `rollover_bribe` owner check | lib.rs:2736–2738 | ✓ en place |
| `ve_power` cast saturant `.min(u64::MAX as u128)` | math.rs:109–113 | ✓ en place |
| `contributor_borrow_usdc` check `new_borrowed <= hi_sola_balance` | lib.rs:1509–1512 | ✓ en place |
| `burn_o_sola_for_votes` snapshot `total_power_snapshot` | lib.rs:~2460–2480 | ✓ en place |
| `rewards_enabled` gate `advance_pool_rewards` / `update_pool_rewards!` | amm.rs:78–90 | ✓ en place |
| `stake_sola` auto-harvest pending fees avant reset | lib.rs:437–452 | ✓ en place |
| `configure_continuous_emissions` authority-gated | lib.rs:4949–4957 | ✓ en place |

---

#### RAS — autres points ré-vérifiés ce jour

- **Aucun commit programme depuis le 06-29** : surface on-chain inchangée, seul le frontend/PWA/wallet a bougé (`46bb16b`, `4b2c0fa`, `a330a98`, `c0327b4`, etc.) — hors périmètre de cette veille (programme Anchor).
- **Dépendances** : `anchor-lang`/`anchor-spl` 0.32.1 partout dans `Cargo.lock`, pas de version mixte. `solana-security-txt` 1.1.1. Aucun advisory RUSTSEC applicable à la version pinned actuelle.
- **soladrome-bridge** : pas de nouveau commit depuis le fix du 2026-06-23 ; pas re-audité en profondeur ce jour (hors scope "Soladrome" strict de ce run, cf. procédure).

**Conclusion du jour : RAS.** Aucune faille nouvellement divulguée n'affecte le code actuel de Soladrome. Seul point actionnable non-urgent : ajouter `cargo audit`/`cargo deny` au CI pour ne plus dépendre uniquement de la veille manuelle sur les advisories RUSTSEC, et se souvenir de sauter directement à `anchor-lang >=1.0.2` si une montée de version majeure a lieu un jour.

---

### 2026-07-16 — Veille automatique (Sonnet 5, session planifiée)

#### Contexte

Premier commit touchant `programs/soladrome/src/` depuis le dernier audit du 2026-07-03 : **`6ff6b62`** (2026-07-11, "ultrareview hardening + realisable Portfolio pricing"). Audité en profondeur ci-dessous. Aucun commit programme depuis (`93a70a7`…`a128f6a` sont quests/faucet/bribebridge/docs, hors `programs/soladrome/src/`).

#### Sources balayées

- WebSearch "Solana exploit hack July 2026" → **BonkDAO $20M governance attack (2026-07-07)**, cf. analyse ci-dessous — [Halborn](https://www.halborn.com/blog/post/explained-the-bonkdao-hack-july-2026), [SolanaFloor](https://solanafloor.com/news/20-m-of-treasury-funds-lost-in-bonk-dao-governance-blunder), [crypto.news](https://crypto.news/the-bonk-governance-attack-how-a-dao-lost-20-million-in-one-proposal/)
- WebSearch "Anchor framework vulnerability advisory 2026" → rien de nouveau, seul CVE-2026-45137 déjà connu (RUSTSEC-2026-0144, documenté 07-03) — [TheHackerWire](https://www.thehackerwire.com/vulnerability/CVE-2026-45137/)
- WebSearch "DeFi exploit post-mortem rounding bug bonding curve AMM 2026" → Balancer V2 $116-128M (déjà documenté 07-03) ; [Q1 2026 DeFi Exploit Pattern Analysis](https://dev.to/ohmygod/q1-2026-defi-exploit-pattern-analysis-137m-lost-5-attack-patterns-every-auditor-must-know-2mh) confirme les mêmes 5 classes déjà couvertes (donation attack, share inflation first-depositor, rounding)
- WebSearch "ve(3,3) gauge bribe governance exploit 2026" → renvoie vers BonkDAO, analysé ci-dessous
- WebSearch "RustSec anchor-lang anchor-spl advisory July 2026" → aucun nouvel advisory
- WebSearch "Solana PDA account substitution exploit OtterSec Neodyme Zellic July 2026" → rien de daté/spécifique, uniquement doc générale déjà connue
- `cargo check -p soladrome --no-default-features` (mainnet features) → ✅ compile propre

---

#### Audit du commit `6ff6b62` — Phase gating (closed-launch) : gates cohérents, aucune brèche trouvée ✓

**Contexte** : ajout de 5 flags booléens sur `ProtocolState` (`lp_enabled`, `bribes_enabled`, `voting_enabled`, `exercise_enabled`, `curve_enabled`) + instruction `set_phase_flags` pour préparer le lancement mainnet en deux temps (fenêtre partenaires-only avec curve fermée, puis ouverture publique). Objectif déclaré du commit : fermer un bypass anti-sybil sur `replay_vote` (castait de vrais votes de gauge sans aucune gate de phase).

Vérification systématique de chaque gate déclarée vs son usage réel (`grep -n "pub fn \|FeatureDisabled" lib.rs`) :

| Flag | Instructions gatées | Vérifié |
|---|---|---|
| `lp_enabled` | `create_pool` (amm.rs:112) | ✓ |
| `bribes_enabled` | `deposit_bribe` (lib.rs:1991), `partner_deposit_bribe` (lib.rs:2046) | ✓ |
| `voting_enabled` | `vote_gauge` (lib.rs:2116), `replay_vote` (lib.rs:2359 — **le bypass visé par ce commit**), `burn_o_sola_for_votes` (lib.rs:2492) | ✓ |
| `exercise_enabled` | `exercise_o_sola` (lib.rs:847), `flash_arbitrage` (lib.rs:3030 — burn oSOLA/mint SOLA, même classe que exercise, correctement aligné) | ✓ |
| `curve_enabled` | `buy_sola` (lib.rs:274) ; `sell_sola` intentionnellement NON gaté (chemin de sortie, floor redemption, doit rester ouvert comme `paused`) | ✓ |

Surfaces adjacentes vérifiées pour absence d'oubli :
- `rollover_bribe` : non gaté par `bribes_enabled`, mais ne fait que déplacer un solde de bribe déjà déposé vers l'épreuve suivante (aucun nouveau dépôt) — si `bribes_enabled` était resté `false` depuis `initialize`, tout bribe vault serait à `amount == 0` → `NothingToClaim` avant même d'atteindre cette logique. Pas de bypass.
- `add_liquidity`/`remove_liquidity` : non gatés par `lp_enabled`, mais aucun pool ne peut exister avant que `create_pool` (gaté) n'en crée un — cohérent, `remove_liquidity` reste un chemin de sortie de toute façon.
- `claim_bribe`, `claim_lp_rewards`, `unstake_hi_sola`, `repay_usdc` : chemins de sortie, non gatés — cohérent avec la politique documentée dans le code (même traitement que `paused`).
- `set_phase_flags` : contexte `SetPaused`, `has_one = authority` (lib.rs:3275) — accès admin-only confirmé, pas de bypass d'autorité.

**Vérification supplémentaire (non triviale) — compatibilité de taille de compte `ProtocolState`** : `ProtocolState::LEN` passe de 400 → 416 pour ce commit, alors que `ProtocolState` est un PDA singleton dont l'espace n'est JAMAIS réalloué après `initialize()` (`space = ProtocolState::LEN` uniquement à la création, `grep realloc` ne renvoie que `UserPosition`). Une hausse de `LEN` post-déploiement pourrait potentiellement casser une instance déjà initialisée sur devnet si la taille réellement nécessaire dépassait l'ancien espace alloué (400 octets). Calcul manuel du payload sérialisé réel (Borsh ne padde pas, contrairement à `size_of::<T>()` utilisé par le guard de compilation) : 8 pubkeys (256) + champs cœur (80) + 3 bool (3) + 2×u64 borrow (16) + `paused` (1) + émission (20) + `founder_voting_enabled` (1) + continuous (6) + 5×bool phase-gate (5) = **388 octets** + 8 octets discriminateur = **396 octets réels**. C'est ≤ 400 (ancien `LEN`) : un compte `ProtocolState` déjà initialisé sur devnet avant ce commit a donc bien assez de place pour les 5 nouveaux booléens sans réallocation — la hausse à 416 n'est qu'une marge de manœuvre pour de futurs champs, pas un besoin réel aujourd'hui. **Aucune incompatibilité.**

**Conclusion** : le gating est cohérent, complet, correctement authority-gated, et le bypass ciblé (`replay_vote` sans phase gate) est bien corrigé. `cargo check --no-default-features` ✅. IDL vérifié : `set_phase_flags` + les 5 champs présents dans `app/lib/soladrome.json`, cohérent avec le programme.

---

#### BonkDAO $20M governance attack (2026-07-07) → Non applicable à Soladrome ✓

**Technique** : un attaquant a acheté ~$4M de BONK pour dominer le vote sur une proposition Realms (SPL Governance) dissimulant une clause de transfert de 4,43T BONK ($20M) de la trésorerie DAO vers son adresse. Proposition en ligne 6 jours, seulement 7 wallets ont voté, l'attaquant contrôlait ~99,9% du vote exprimé → adoptée et exécutée on-chain automatiquement. Root cause : gouvernance token-weighted à faible participation exécutant une transaction arbitraire, pas un bug de code.

**Vérification code Soladrome** :
- `grep -rni "realms\|spl-governance\|spl_governance"` sur `programs/` → aucune occurrence. Soladrome n'utilise ni Realms ni aucun moteur de proposition on-chain à exécution automatique.
- `grep -rn "invoke(\|invoke_signed("` hors `CpiContext` → aucune occurrence : pas de CPI générique piloté par un paramètre utilisateur qui pourrait servir de "charge utile" de proposition.
- Le vote de gauge (`vote_gauge`/`replay_vote`) ne fait que router du poids de vote vers `GaugeState.total_votes` — cela influence uniquement la répartition des émissions oSOLA/LP et l'éligibilité aux bribes déjà déposés. Aucune instruction de vote ne transfère de fonds depuis `floor_vault`/`market_vault`/`sola_vault` ; tous les mouvements de trésorerie (mint founder/ecosystem, transfer_authority, pause) restent strictement `has_one = authority` (clé unique, pas de vote).
- Le marché de bribes (dépôt → vote → claim proportionnel) est structurellement le même modèle ve(3,3)/Curve-wars que celui cité par les articles ("bribe markets... treated as legitimate yield") — c'est le design voulu, pas une vulnérabilité ; il ne permet de déplacer que les bribes volontairement déposées par des tiers, jamais la trésorerie du protocole.

**Non applicable** : Soladrome n'a aucun mécanisme où un vote token-weighted autorise l'exécution d'une transaction arbitraire ou un mouvement de trésorerie protocole. Rester vigilant si un futur "treasury council on-chain" ou intégration Realms est un jour envisagé (à re-vérifier explicitement à ce moment-là).

---

#### RAS — autres points ré-vérifiés ce jour

- **Dépendances** : `anchor-lang`/`anchor-spl` toujours 0.32.1 dans `Cargo.lock`. Aucun nouvel advisory RUSTSEC applicable.
- **soladrome-bridge** : hors scope strict de cette procédure (repo séparé), non re-audité ce jour.
- Point non-urgent déjà loggé le 07-03 toujours valable : `cargo audit`/`cargo deny` en CI pas encore ajouté.

**Conclusion du jour : RAS.** Le seul changement de surface programme depuis le dernier audit (`6ff6b62`, phase gating) a été vérifié en profondeur et est sain — gating cohérent, authority-gated, compatibilité de taille de compte confirmée par calcul, IDL synchronisé. Aucune faille externe nouvellement divulguée (BonkDAO governance attack, RUSTSEC, rounding bugs) n'affecte Soladrome, pour les raisons détaillées ci-dessus.
