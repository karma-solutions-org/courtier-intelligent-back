import * as admin from "firebase-admin";

admin.initializeApp();
admin.firestore().settings({ ignoreUndefinedProperties: true });

// ── Cabinets & membres (Epic E1) ────────────────────────────────────────────
export * as cabinets from "./cabinets/cabinets";
export * as equipe from "./equipe/equipe.callable";

// ── Sessions : un seul appareil connecté par utilisateur ────────────────────
export * as sessions from "./sessions/sessions.callable";

// ── Dossiers (Epic E4) : création, sauvegarde du brouillon, statuts, assignation ──────────────
export * as dossiers from "./dossiers/dossiers.callable";

// ── Tarification (Epic E9) : lancement et relance des jobs, champs manquants, saisie manuelle d'une offre ──
export * as tarification from "./tarification/tarification.callable";

// ── IA : proxy pour l'extension (la clé reste côté serveur) ─────────────────────────────────
export * as ia from "./ia/ia.callable";

// ── Mémoire partagée des formulaires d'extranet (structure seulement) ─────────────────────────
export * as memoires from "./memoires/memoires.callable";
