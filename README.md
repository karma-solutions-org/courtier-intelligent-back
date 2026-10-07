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
        ├── cabinets/                        creerMonCabinet, creer, activer
        └── equipe/equipe.callable.ts        inviter, accepterInvitation, changerRole, activerMembre
```

## Functions

Exportées par groupe dans `index.ts` (`export * as members from ...`) : le nom déployé est `<groupe>-<function>`.

| Function | Appelée par | Rôle |
|---|---|---|
| `cabinets-creerMonCabinet` | Utilisateur juste inscrit | Crée le cabinet, l'ajoute comme `admin`, pose ses claims |
| `cabinets-creer` | Super-admin | Crée un cabinet et son admin (compte créé si besoin, email avec lien pour choisir le mot de passe) |
| `cabinets-activer` | Super-admin | Active / désactive un cabinet (désactivé : données bloquées, membres déconnectés) |
| `equipe-inviter` | Admin du cabinet | Crée une invitation (7 jours) et envoie l'email |
| `equipe-accepterInvitation` | Invité connecté | Le rattache au cabinet avec le rôle prévu |
| `equipe-changerRole` | Admin du cabinet | Change le rôle d'un membre (garde au moins un admin) |
| `equipe-activerMembre` | Admin du cabinet | Désactive / réactive un membre (révoque ses sessions) |

Région : **europe-west3** (le front appelle la même).

## Claims

Claims **préfixés `ci_`** : `ci_cabinet_id`, `ci_role` (`admin` | `courtier` | `superadmin`).
Le projet de test est partagé avec d'autres applications dont les règles donnent des droits sur des claims génériques (`admin`, `role`) : ne pas les renommer. Les claims existants des autres applications sont conservés.

## ⚠️ Projet Firebase partagé

`aibs-partenaire-testing` est aussi utilisé par **aibs-partenaire** et **compli-scan**.

- Déployer **uniquement les functions** : `npm --prefix functions run deploy` (codebase `courtier-intelligent`).
- **Ne jamais lancer `firebase deploy` sans `--only`** : les règles Firestore/Storage de ce repo remplaceraient celles des autres applications. Elles servent aux emulators.
- Les emails partent via la collection `MailCourtierIntelligent` : une instance de l'extension Firebase *Trigger Email* doit écouter cette collection.

## Super-admin

Le rôle super-admin se donne à un compte existant, dédié (sans cabinet) :

```bash
cd functions
node scripts/set-superadmin.mjs prenom.nom@exemple.fr          # --remove pour le retirer
```

Pré-requis : `gcloud auth application-default login` (ou `GOOGLE_APPLICATION_CREDENTIALS`).

## Tests des règles Firestore

```bash
cd functions
npm run test:rules   # lance l'emulator Firestore et vérifie l'isolation des cabinets et les droits par rôle
```

## Développement local

```bash
cd functions
npm install
npm run serve        # build + emulators (functions, auth, firestore)
```

UI des emulators : http://127.0.0.1:4000
