import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertSignedIn, requireString, setTenantClaims } from "../core/auth.utils";
import { CLAIM_TENANT_ID, REGION_ID } from "../core/config";
import { memberPath, tenantPath } from "../core/firestore-paths";

/**
 * Inscription d'un nouveau cabinet : appelée juste après la création du compte.
 * Crée le cabinet, y ajoute l'appelant comme admin et pose ses claims.
 * Ne peut s'exécuter qu'une fois par compte : un utilisateur déjà rattaché
 * (ou invité dans un autre cabinet) ne peut pas s'en créer un nouveau.
 */
export const createCabinet = onCall({ region: REGION_ID }, async request => {
  const uid = assertSignedIn(request);
  if (request.auth?.token[CLAIM_TENANT_ID]) {
    throw new HttpsError("failed-precondition", "Ce compte est déjà rattaché à un cabinet.");
  }

  const name = requireString(request.data?.name, "nom du cabinet", 120);
  const orias = typeof request.data?.orias === "string" ? request.data.orias.trim().substring(0, 20) : null;
  const user = await admin.auth().getUser(uid);

  const db = admin.firestore();
  const tenantRef = db.collection("tenants").doc();
  const tenantId = tenantRef.id;

  await db.runTransaction(async tx => {
    tx.set(db.doc(tenantPath(tenantId)), {
      name,
      orias,
      active: true,
      ownerUid: uid,
      enabledInsurers: [],
      enabledProducts: [],
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.doc(memberPath(tenantId, uid)), {
      email: user.email ?? null,
      displayName: user.displayName ?? null,
      role: "admin",
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  await setTenantClaims(uid, tenantId, "admin");
  return { tenantId };
});
