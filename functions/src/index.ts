import * as admin from "firebase-admin";

admin.initializeApp();
admin.firestore().settings({ ignoreUndefinedProperties: true });

// ── Cabinets & membres (Epic E1) ────────────────────────────────────────────
export * as cabinets from "./cabinets/cabinets";
export * as equipe from "./equipe/equipe.callable";
