import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { setCabinetClaims } from "./auth.utils";
import { cabinetPath, memberPath } from "./firestore-paths";
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
  const cabinetId = db.collection("cabinets").doc().id;
  await db.runTransaction(async tx => {
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
