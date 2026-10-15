import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { setCabinetClaims } from "./auth.utils";
import { HttpsError } from "firebase-functions/v2/https";
import { cabinetPath, memberPath, userCabinetPath } from "./firestore-paths";
import { resolveLimits } from "./limits.utils";
import { DEFAULT_PLAN_ID, type PlanLimits } from "../shared/index.js";

export interface NewCabinet {
  name: string;
  orias: string | null;
  /** Compte Firebase de l'administrateur du cabinet. */
  ownerUid: string;
  planId?: string;
  overrides?: Partial<PlanLimits> | null;
}

/**
 * Crée un cabinet, y ajoute son propriétaire comme admin et pose ses claims.
 * Partagé par la function `cabinets-creerMonCabinet` et le script ops `create-cabinet`.
 */
export async function createCabinet(input: NewCabinet): Promise<string> {
  const planId = input.planId ?? DEFAULT_PLAN_ID;
  const [user, limits] = await Promise.all([
    admin.auth().getUser(input.ownerUid),
    resolveLimits(planId, input.overrides),
  ]);

  const db = admin.firestore();
  const cabinetId = db.collection("ci_cabinets").doc().id;
  await db.runTransaction(async tx => {
    // Un compte = un cabinet : le verrou par uid rend deux créations simultanées impossibles.
    const lock = await tx.get(db.doc(userCabinetPath(input.ownerUid)));
    if (lock.exists) {
      throw new HttpsError("already-exists", "Ce compte est déjà rattaché à un cabinet.", { reason: "already_member" });
    }
    tx.create(db.doc(userCabinetPath(input.ownerUid)), { cabinetId, role: "admin", at: FieldValue.serverTimestamp() });
    tx.set(db.doc(cabinetPath(cabinetId)), {
      name: input.name,
      orias: input.orias,
      active: true,
      // Offre, surcharge et limites effectives : modifiables uniquement côté serveur.
      planId,
      overrides: input.overrides ?? null,
      limits,
      ownerUid: input.ownerUid,
      enabledInsurers: [],
      enabledProducts: [],
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.doc(memberPath(cabinetId, input.ownerUid)), {
      email: user.email ?? null,
      displayName: user.displayName ?? null,
      role: "admin",
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  await setCabinetClaims(input.ownerUid, cabinetId, "admin");
  return cabinetId;
}
