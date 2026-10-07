import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertSuperAdmin, requireString } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { tenantPath } from "../core/firestore-paths";

/**
 * Le super-admin active ou désactive un cabinet.
 * Désactivé : les règles Firestore bloquent toutes ses données et ses membres sont déconnectés.
 */
export const setTenantActive = onCall(CALLABLE_OPTIONS, async request => {
  const callerUid = assertSuperAdmin(request);
  const tenantId = requireString(request.data?.tenantId, "cabinet");
  const active = request.data?.active;
  if (typeof active !== "boolean") {
    throw new HttpsError("invalid-argument", "Le champ « active » doit être vrai ou faux.");
  }

  const db = admin.firestore();
  const tenantRef = db.doc(tenantPath(tenantId));
  if (!(await tenantRef.get()).exists) {
    throw new HttpsError("not-found", "Cabinet introuvable.");
  }
  await tenantRef.update({ active, activeChangedBy: callerUid, activeChangedAt: FieldValue.serverTimestamp() });

  if (!active) {
    const members = await tenantRef.collection("members").get();
    await Promise.all(members.docs.map(member => admin.auth().revokeRefreshTokens(member.id)));
  }
  return { success: true };
});
