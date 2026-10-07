import * as admin from "firebase-admin";
import { CallableRequest, HttpsError } from "firebase-functions/v2/https";
import { CLAIM_ROLE, CLAIM_CABINET_ID, UserRole } from "./config";
import { memberPath, cabinetPath } from "./firestore-paths";

export interface Membership {
  uid: string;
  cabinetId: string;
  role: UserRole;
}

export function assertSignedIn(request: CallableRequest): string {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentification requise.");
  }
  return request.auth.uid;
}

/** Réservé au super-admin de la plateforme (claim posé par scripts/set-superadmin.mjs). */
export function assertSuperAdmin(request: CallableRequest): string {
  const uid = assertSignedIn(request);
  if (request.auth?.token[CLAIM_ROLE] !== "superadmin") {
    throw new HttpsError("permission-denied", "Réservé au super-admin.");
  }
  return uid;
}

/**
 * Résout le cabinet et le rôle de l'appelant.
 * La source de vérité est Firestore, pas le token : un token reste valide ~1 h,
 * il peut donc encore porter un rôle retiré entre-temps.
 */
export async function getActiveMembership(request: CallableRequest): Promise<Membership> {
  const uid = assertSignedIn(request);
  const cabinetId = request.auth?.token[CLAIM_CABINET_ID] as string | undefined;
  if (!cabinetId) {
    throw new HttpsError("failed-precondition", "Ce compte n'est rattaché à aucun cabinet.");
  }
  const [cabinet, member] = await Promise.all([
    admin.firestore().doc(cabinetPath(cabinetId)).get(),
    admin.firestore().doc(memberPath(cabinetId, uid)).get(),
  ]);
  if (cabinet.get("active") !== true) {
    throw new HttpsError("permission-denied", "Ce cabinet est désactivé.");
  }
  if (!member.exists || member.get("status") !== "active") {
    throw new HttpsError("permission-denied", "Accès au cabinet refusé.");
  }
  return { uid, cabinetId, role: member.get("role") as UserRole };
}

export async function assertCabinetAdmin(request: CallableRequest): Promise<Membership> {
  const membership = await getActiveMembership(request);
  if (membership.role !== "admin") {
    throw new HttpsError("permission-denied", "Réservé aux administrateurs du cabinet.");
  }
  return membership;
}

/** Pose les claims Courtier Intelligent sans écraser ceux des autres applications du projet partagé. */
export async function setCabinetClaims(uid: string, cabinetId: string | null, role: UserRole | null): Promise<void> {
  const user = await admin.auth().getUser(uid);
  const claims: Record<string, unknown> = { ...(user.customClaims ?? {}) };
  if (cabinetId && role) {
    claims[CLAIM_CABINET_ID] = cabinetId;
    claims[CLAIM_ROLE] = role;
  } else {
    delete claims[CLAIM_CABINET_ID];
    delete claims[CLAIM_ROLE];
  }
  await admin.auth().setCustomUserClaims(uid, claims);
}

export function requireString(value: unknown, field: string, maxLength = 200): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new HttpsError("invalid-argument", `Le champ « ${field} » est obligatoire.`);
  }
  return text.substring(0, maxLength);
}

export function requireEmail(value: unknown): string {
  const email = requireString(value, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "Adresse email invalide.");
  }
  return email;
}
