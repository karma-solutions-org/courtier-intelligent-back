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
| `equipe-inviter` | Admin du cabinet | Crée une invitation (7 jours) et envoie l'email |
| `equipe-accepterInvitation` | Invité connecté | Le rattache au cabinet avec le rôle prévu |
| `equipe-changerRole` | Admin du cabinet | Change le rôle d'un membre (garde au moins un admin) |
| `equipe-annulerInvitation` | Admin du cabinet | Annule une invitation en attente (libère la place) |
| `sessions-ouvrir` | App, à la connexion | Ouvre la session de l'appareil ; refusée si un autre appareil est connecté |
| `sessions-fermer` | App, à la déconnexion | Libère la session : l'utilisateur peut se connecter ailleurs |
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

## Offre : limite d'utilisateurs et appareil unique

- `maxUtilisateurs` (3 par défaut, admin compris) est stocké sur le cabinet et **écrit uniquement côté serveur**. Une invitation en attente réserve une place.
- Un seul appareil par utilisateur : `sessions-ouvrir` refuse un 2e appareil tant que le 1er envoie son signal de vie (expiration après 2 minutes sans signal). Les règles refusent tout accès d'une autre session.

## Tests des règles Firestore

```bash
cd functions
npm run test         # lance l'emulator Firestore et vérifie l'isolation des cabinets et les droits par rôle
```

## Développement local

```bash
cd functions
npm install
npm run serve        # build + emulators (functions, auth, firestore)
```

UI des emulators : http://127.0.0.1:4000
