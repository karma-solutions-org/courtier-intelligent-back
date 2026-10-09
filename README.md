# Courtier Intelligent — Backend

Cloud Functions, règles Firestore/Storage et configuration Firebase de **Courtier Intelligent**.
Le front (Angular + extension Chrome) vit dans le repo `courtier-intelligent` — même découpage que `compli-scan-front` / `compli-scan-back`.

## Structure

```
courtier-intelligent-back/
├── firebase.json · .firebaserc
├── firestore.rules · firestore.indexes.json · storage.rules
└── functions/
    └── src/
        ├── index.ts                         Export de toutes les functions
        ├── core/                            Config (région, claims), chemins Firestore, utilitaires d'auth
        ├── cabinets/                        creerMonCabinet
        ├── equipe/equipe.callable.ts        inviter, accepterInvitation, changerRole, activerMembre, reinitialiserAppareil
        ├── sessions/sessions.callable.ts    ouvrir, fermer
        └── ops/                             scripts d'exploitation (voir « Scripts ops »)
└── catalog/                                 JSON versionnés du catalogue global (offres, assureurs, produits)
```

## Functions

Exportées par groupe dans `index.ts` (`export * as members from ...`) : le nom déployé est `<groupe>-<function>`.

| Function | Appelée par | Rôle |
|---|---|---|
| `cabinets-creerMonCabinet` | Utilisateur juste inscrit | Crée le cabinet, l'ajoute comme `admin`, pose ses claims |
| `equipe-inviter` | Admin du cabinet | Crée une invitation (7 jours) et envoie l'email |
| `equipe-accepterInvitation` | Invité connecté | Le rattache au cabinet avec le rôle prévu |
| `equipe-changerRole` | Admin du cabinet | Change le rôle d'un membre (garde au moins un admin) |
| `equipe-annulerInvitation` | Admin du cabinet | Annule une invitation en attente (libère la place) |
| `sessions-ouvrir` | App, à la connexion | Lie le compte à l'appareil (1re connexion) et ouvre la session ; refuse tout autre appareil (tracé dans `auditLog`) |
| `sessions-fermer` | App, à la déconnexion | Ferme la session (l'appareil reste lié) |
| `equipe-reinitialiserAppareil` | Admin du cabinet | Libère l'appareil lié d'un membre, dans la limite du quota mensuel de l'offre |
| `sessions-ouvrirExtension` | Extension Chrome, à la connexion | Enregistre la connexion de l'extension dans la session de l'app ; refuse si l'app n'est pas ouverte sur l'appareil |
| `sessions-fermerExtension` | Extension Chrome, à la déconnexion | Retire la connexion de l'extension (la session de l'app est intacte) |
| `memoires-enregistrer` | Extension Chrome | Apprend la structure d'un formulaire d'extranet (après un remplissage validé) : validation à la lettre, confirmation, remplacement d'une ancienne version |
| `memoires-utiliser` / `memoires-invalider` | Extension Chrome | Compte une utilisation (au plus 1 par heure) / signale un échec ; à 2 cabinets distincts, la mémoire est invalidée |
| `ia-proxy` | Extension Chrome | Appel à l'API d'IA : clé côté serveur, modèle imposé, tailles bornées, quota mensuel selon l'offre |
| `equipe-activerMembre` | Admin du cabinet | Désactive / réactive un membre (révoque ses sessions) |

Région : **europe-west3** (le front appelle la même).

## Claims

Claims **préfixés `ci_`** : `ci_cabinet_id`, `ci_role` (`admin` | `courtier`). L'appareil autorisé est identifié par `auth_time` du token, comparé à `members/{uid}.session.authTime` (l'ancien claim `ci_session_id` est supprimé).
Le projet de test est partagé avec d'autres applications dont les règles donnent des droits sur des claims génériques (`admin`, `role`) : ne pas les renommer. Les claims existants des autres applications sont conservés.

## ⚠️ Projet Firebase partagé

`aibs-partenaire-testing` est aussi utilisé par **aibs-partenaire** et **compli-scan**.

- Déployer **uniquement les functions** : `npm --prefix functions run deploy` (codebase `courtier-intelligent`).
- **Ne jamais lancer `firebase deploy` sans `--only`** : les règles Firestore/Storage de ce repo remplaceraient celles des autres applications. Elles servent aux emulators.
- Les emails partent via la collection `MailCourtierIntelligent` : une instance de l'extension Firebase *Trigger Email* doit écouter cette collection.

## Offres, limites et appareil unique

- **Offres** : `plans/{planId}` (publiées par `seed-catalog`, fichiers `catalog/plans/*.json`) portent les limites `maxUtilisateurs` (admin compris) et `resetsAppareilParMois`.
- Le cabinet stocke `planId`, une surcharge facultative `overrides` et les limites effectives `limits` (= offre + surcharge, `computeEffectiveLimits`). Tout est **écrit uniquement côté serveur** : passer un cabinet de 3 à 6 sièges se fait avec `npm run ops:set-plan`, sans redéploiement. Une invitation en attente réserve une place.
- **Baisse d'offre** : si les membres actifs dépassent la nouvelle limite, `graceEndsAt` est posé sur le cabinet (14 jours). Pendant le délai : bandeau côté app et invitations bloquées. Ensuite, les règles Firestore et les functions réservent l'accès aux admins. Le délai se referme dès que le cabinet rentre dans sa limite.
- **Un compte = un appareil** : la 1re connexion lie l'appareil (`members/{uid}.device`, identifiant conservé dans l'IndexedDB de l'app). Tout autre appareil est refusé par `sessions-ouvrir` (raison `device_not_authorized`) et le refus est tracé dans `cabinets/{id}/auditLog`. Une nouvelle connexion de l'appareil lié remplace aussitôt la précédente (la session est liée à `auth_time`). L'admin libère l'appareil avec `equipe-reinitialiserAppareil` (quota mensuel, chaque action dans `auditLog`).

## Extension Chrome

L'extension se connecte avec le compte de l'app, mais **son jeton a sa propre heure de connexion** (`auth_time`) :
- `sessions-ouvrirExtension` l'enregistre dans la session de l'app (`members/{uid}.session.extensionAuthTime`), et **seulement si l'app est ouverte sur l'appareil** (session active, signe de vie de moins de 3 min) ;
- l'extension n'a **jamais les droits de l'app** (les règles comparent `auth_time` à `session.authTime`) : elle lit ses propres jobs de tarification (`quoteJobs.ownerUid == uid`), n'écrit que le **statut et la progression** de ces jobs, des **offres automatiques** et la mémoire des formulaires (`formMemories`, `extensionReports`) ;
- l'enregistrement vit dans la session de l'app : déconnexion de l'app, nouvelle connexion, appareil réinitialisé, membre ou cabinet désactivé → **l'extension perd l'accès immédiatement** (règles et functions) ;
- recharger la page de l'app ne coupe pas l'extension.

### Mémoire partagée des formulaires (`formMemories`)

Ce que l'extension apprend d'un formulaire d'extranet est partagé par **tous les cabinets** : seule de la **structure** y entre (champs, types, libellés, chemin canonique), jamais une valeur.
- **Lecture** par l'extension connectée (règles) ; **écriture uniquement par les functions `memoires-*`**, car les règles Firestore ne savent pas contrôler le contenu d'une liste. Chaque champ est validé à la lettre : six propriétés exactement, clé `type:identifiant`, chemin de la liste fermée, libellé sans e-mail ni numéro, origine https. Un cabinet ne peut ni déposer une donnée, ni remplacer la mémoire valide des autres.
- Clé du document : `sha256(origine|empreinte)` tronqué à 32 caractères (même calcul dans l'extension, vecteur de test commun).
- **Réapprentissage** : une nouvelle empreinte très proche d'une ancienne (≥ 70 % de champs communs, même origine) la remplace ; une mémoire signalée en échec par 2 cabinets distincts est invalidée, puis réapprise au prochain remplissage réussi.
- `npm run ops:memories -- --project <id> list | show <clé> | purge (--key|--origin|--invalidated|--older-than-days n) [--yes]` : consulter et purger (sans `--yes`, la purge affiche seulement ce qui serait supprimé ; sans critère, elle refuse).

### `ia-proxy`

Aucune clé d'IA dans l'extension. La clé est un **secret des Cloud Functions** :

```bash
firebase functions:secrets:set ANTHROPIC_API_KEY --project aibs-partenaire-testing
```

Le modèle est imposé côté serveur (`IA_MODEL` dans `core/config.ts`), les messages bornés (20 messages, 30 000 caractères chacun, 2 000 tokens en sortie), le contenu n'est ni journalisé ni conservé. Limite : `limits.appelsIaParMois` de l'offre (200 / 1000 / 5000), compteur `cabinets/{id}/usage/ia-AAAA-MM`, un appel réservé avant l'envoi et remboursé si le service d'IA échoue. `npm run ops:set-plan -- … --appels-ia 500` l'ajuste par cabinet.

## Scripts ops

Toujours avec une cible explicite : `--emulator` ou `--project <id>` (le projet de test est partagé, aucune cible par défaut). Les arguments passent après `--`.

```bash
cd functions
npm run catalog:validate                                   # valide les JSON du catalogue (CI)
npm run ops:preview-questionnaire -- auto                  # aperçu local du questionnaire
npm run ops:seed-catalog -- --project aibs-partenaire-testing   # publie le catalogue ; sans risque à relancer ; --dry-run pour valider seulement
npm run ops:create-cabinet -- --emulator --name "Cabinet Dupont" --admin-email admin@dupont.fr --plan essentiel
npm run ops:set-plan -- --emulator --cabinet <id> --plan cabinet            # ou --max-utilisateurs 6
npm run ops:set-cabinet-status -- --emulator --cabinet <id> --status disabled
```

## Catalogue

Le catalogue global est maintenu en JSON dans `catalog/` et publié par `seed-catalog` (pas d'écran d'administration) :

```
catalog/
├── plans/<offre>.json                    id, name, limits
├── insurers/<assureur>.json              id, name, extranetUrl, extranetDomains, productsSupported
└── products/<produit>/
    ├── product.json                      id, name, active
    ├── questionnaire.json                sections → questions (canonicalPath, type, required, choices, visibleIf, withKnowledge)
    ├── guarantees.json                   référentiel des garanties (code, label, type)
    └── synonyms.json                     code de garantie → formulations des assureurs
```

Un JSON invalide (schéma, `canonicalPath` hors du modèle canonique, références croisées) bloque la publication. ⚠️ Les 3 assureurs fournis sont des données d'exemple (`*.example`) : remplacer l'URL et les domaines de l'extranet par ceux des vrais assureurs.

## Tests des règles Firestore

```bash
cd functions
npm run test              # emulator Firestore : isolation des cabinets, droits par rôle, journal d'audit, délai de grâce
npm run test:unit         # catalogue et limites (sans emulator)
npm run test:integration  # emulators auth + firestore + functions : appareil unique, dossiers, besoin, extension, ia-proxy, scripts ops
```

> `functions/.env.demo-courtier-intelligent` (URL du faux service d'IA et clé factice) n'est lu que par les emulators du projet `demo-courtier-intelligent`.
> ⚠️ `firestore.shared.rules` contient depuis son premier commit une ligne parasite (`database}/documents {`) avant la section Courtier Intelligent : ce fichier n'est pas chargeable tel quel, la source de vérité testée est `firestore.rules`.

## Développement local

```bash
cd functions
npm install
npm run serve        # build + emulators (functions, auth, firestore)
```

UI des emulators : http://127.0.0.1:4000
