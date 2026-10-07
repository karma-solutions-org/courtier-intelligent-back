import type { CabinetRole } from "../shared/index.js";

/** Région des Cloud Functions : l'app Angular doit appeler la même. */
export const REGION_ID = "europe-west3";

/**
 * Options communes des functions appelées par l'app.
 * `invoker: "public"` : Firebase repose l'accès Cloud Run « allUsers » à chaque déploiement
 * (sinon il ne le fait qu'à la création). Ce n'est pas une faille : chaque function vérifie
 * elle-même l'authentification et le rôle de l'appelant.
 */
export const CALLABLE_OPTIONS = { region: REGION_ID, invoker: "public" } as const;

/**
 * Noms des custom claims, préfixés « ci_ ».
 * Le projet Firebase de test est partagé avec d'autres applications dont les règles
 * accordent des droits sur des claims génériques (`admin`, `role`…) : ne pas les renommer.
 */
export const CLAIM_CABINET_ID = "ci_cabinet_id";
export const CLAIM_ROLE = "ci_role";

export type { UserRole } from "../shared/index.js";
export const CABINET_ROLES: CabinetRole[] = ["admin", "courtier"];

/** Collection lue par l'extension Firebase « Trigger Email » de ce projet. */
export const MAIL_COLLECTION = "MailCourtierIntelligent";

/** Durée de validité d'une invitation. */
export const INVITATION_TTL_DAYS = 7;
