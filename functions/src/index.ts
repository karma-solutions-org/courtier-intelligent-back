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

// ── Offres (Epic E13) : analyse de chaque offre écrite (garanties normalisées, écarts avec le besoin, score) ──
export * as offres from "./offres/offres.trigger";

// ── Propositions (Epic E14) : envoi de la proposition à l'assuré, réponse (souscrit, refusé, sans suite) ──
export * as propositions from "./propositions/propositions.callable";

// ── Tâches planifiées (Epic E14) : relances des propositions, invitations expirées, délai de grâce ──
export * as taches from "./taches/taches.scheduler";

// ── Documents (Epic E12) : documents du dossier et lecture automatique (OCR) par l'IA ─────────────
export * as documents from "./documents/documents.callable";

// ── IA : proxy pour l'extension (la clé reste côté serveur) ─────────────────────────────────
export * as ia from "./ia/ia.callable";

// ── Mémoire partagée des formulaires d'extranet (structure seulement) ─────────────────────────
export * as memoires from "./memoires/memoires.callable";
