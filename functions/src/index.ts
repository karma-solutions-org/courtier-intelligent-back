import * as admin from "firebase-admin";

admin.initializeApp();
admin.firestore().settings({ ignoreUndefinedProperties: true });

// ── Cabinets & membres (Epic E1) ────────────────────────────────────────────
export * as tenants from "./tenants/tenants";
export * as members from "./members/members.callable";

// ── Extension Chrome (Epic E6) ──────────────────────────────────────────────
export * as extension from "./extension/create-extension-token.callable";
