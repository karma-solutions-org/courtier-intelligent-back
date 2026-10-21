import type { CabinetRole } from "../shared/index.js";

/** Région des Cloud Functions : l'app Angular doit appeler la même. */
export const REGION_ID = "europe-west3";

/**
 * Options communes des functions appelées par l'app.
 * `invoker: "public"` : Firebase repose l'accès Cloud Run « allUsers » à chaque déploiement
 * (sinon il ne le fait qu'à la création). Ce n'est pas une faille : chaque function vérifie
 * elle-même l'authentification, le rôle et la session de l'appelant.
 */
export const CALLABLE_OPTIONS = { region: REGION_ID, invoker: "public" } as const;

/**
 * Noms des custom claims, préfixés « ci_ ».
 * Le projet Firebase de test est partagé avec d'autres applications dont les règles
 * accordent des droits sur des claims génériques (`admin`, `role`…) : ne pas les renommer.
 */
export const CLAIM_CABINET_ID = "ci_cabinet_id";
export const CLAIM_ROLE = "ci_role";
/**
 * Ancien claim de session, remplacé par `auth_time` (propre à chaque connexion, alors qu'un
 * claim est commun à tous les appareils du compte). Conservé pour le supprimer des comptes.
 */
export const LEGACY_CLAIM_SESSION_ID = "ci_session_id";

export type { UserRole } from "../shared/index.js";
export const CABINET_ROLES: CabinetRole[] = ["admin", "courtier"];

/**
 * Adresses de l'app autorisées dans les liens envoyés par email (invitation). L'app envoie son `location.origin` :
 * une autre adresse est remplacée par la première, pour qu'un email du projet ne pointe jamais vers un site tiers.
 * Dans les emulators, localhost est accepté en plus.
 */
export const APP_ORIGINS = ["https://courtier-intelligent-test.web.app", "https://courtier-intelligent-test.firebaseapp.com"];

/** Adresse de l'app à mettre dans un lien d'email, d'après celle envoyée par l'app (voir `APP_ORIGINS`). */
export function trustedAppOrigin(requested: unknown): string {
  const origin = typeof requested === "string" ? requested.trim().replace(/\/$/, "") : "";
  if (APP_ORIGINS.includes(origin)) return origin;
  if (process.env.FUNCTIONS_EMULATOR === "true" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin)) return origin;
  return APP_ORIGINS[0];
}

/** Collection lue par l'instance « firestore-send-email » (Trigger Email) du projet, partagée avec d'autres apps. */
export const MAIL_COLLECTION = "mail";

/**
 * L'extension ne se connecte que si l'app est ouverte sur l'appareil : sa session doit avoir donné signe de vie
 * (signal toutes les 30 s) depuis moins que ce délai.
 */
export const EXTENSION_APP_SESSION_MAX_AGE_MS = 3 * 60 * 1000;

/**
 * Une session sans signe de vie depuis ce délai est considérée fermée (navigateur fermé sans se déconnecter) :
 * le compte peut alors se connecter depuis un autre appareil.
 */
export const APP_SESSION_ACTIVE_MS = 3 * 60 * 1000;

/**
 * Modèles Gemini utilisés par `ia-proxy`, dans l'ordre : si l'un échoue (introuvable, surchargé, en panne, réponse vide),
 * on essaie le suivant. Choisis côté serveur, jamais par l'extension.
 */
export const GEMINI_MODELS = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-flash-latest"];

/** API Gemini (remplacée par un faux service dans les emulators : `IA_UPSTREAM_URL`). */
export const GEMINI_API_URL = "https://generativelanguage.googleapis.com";


/** Durée de validité d'une invitation. */
export const INVITATION_TTL_DAYS = 7;

/** Journal d'audit d'un cabinet (connexions, appareils) : cabinets/{id}/auditLog. */
export const AUDIT_LOG_COLLECTION = "ci_auditLog";
