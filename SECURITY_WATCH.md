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
