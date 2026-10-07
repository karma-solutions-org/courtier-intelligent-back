import type { TenantRole } from "../shared/index.js";

/** Région des Cloud Functions : l'app Angular doit appeler la même. */
export const REGION_ID = "europe-west3";

/**
 * Noms des custom claims, préfixés « ci_ ».
 * Le projet Firebase de test est partagé avec d'autres applications dont les règles
 * accordent des droits sur des claims génériques (`admin`, `role`…) : ne pas les renommer.
 */
export const CLAIM_TENANT_ID = "ci_tenant_id";
export const CLAIM_ROLE = "ci_role";

export type { UserRole } from "../shared/index.js";
export const TENANT_ROLES: TenantRole[] = ["admin", "courtier"];

/** Collection lue par l'extension Firebase « Trigger Email » de ce projet. */
export const MAIL_COLLECTION = "MailCourtierIntelligent";

/** Durée de validité d'une invitation. */
export const INVITATION_TTL_DAYS = 7;
