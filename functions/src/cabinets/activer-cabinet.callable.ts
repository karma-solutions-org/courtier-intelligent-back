import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertSuperAdmin, requireString } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { cabinetPath } from "../core/firestore-paths";

/**
 * Le super-admin active ou désactive un cabinet.
 * Désactivé : les règles Firestore bloquent toutes ses données et ses membres sont déconnectés.
 */
export const activer = onCall(CALLABLE_OPTIONS, async request => {
  const callerUid = assertSuperAdmin(request);
  const cabinetId = requireString(request.data?.cabinetId, "cabinet");
  const active = request.data?.active;
  if (typeof active !== "boolean") {
    throw new HttpsError("invalid-argument", "Le champ « active » doit être vrai ou faux.");
  }

  const db = admin.firestore();
  const cabinetRef = db.doc(cabinetPath(cabinetId));
  if (!(await cabinetRef.get()).exists) {
    throw new HttpsError("not-found", "Cabinet introuvable.");
  }
  await cabinetRef.update({ active, activeChangedBy: callerUid, activeChangedAt: FieldValue.serverTimestamp() });

  if (!active) {
    const members = await cabinetRef.collection("members").get();
    await Promise.all(members.docs.map(member => admin.auth().revokeRefreshTokens(member.id)));
  }
  return { success: true };
});
