import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertSignedIn, requireString, setCabinetClaims } from "../core/auth.utils";
import { CLAIM_CABINET_ID, CALLABLE_OPTIONS } from "../core/config";
import { memberPath, cabinetPath } from "../core/firestore-paths";

/**
 * Inscription d'un nouveau cabinet : appelée juste après la création du compte.
 * Crée le cabinet, y ajoute l'appelant comme admin et pose ses claims.
 * Ne peut s'exécuter qu'une fois par compte : un utilisateur déjà rattaché
 * (ou invité dans un autre cabinet) ne peut pas s'en créer un nouveau.
 */
export const creerMonCabinet = onCall(CALLABLE_OPTIONS, async request => {
  const uid = assertSignedIn(request);
  if (request.auth?.token[CLAIM_CABINET_ID]) {
    throw new HttpsError("failed-precondition", "Ce compte est déjà rattaché à un cabinet.");
  }

  const name = requireString(request.data?.name, "nom du cabinet", 120);
  const orias = typeof request.data?.orias === "string" ? request.data.orias.trim().substring(0, 20) : null;
  const user = await admin.auth().getUser(uid);

  const db = admin.firestore();
  const cabinetRef = db.collection("cabinets").doc();
  const cabinetId = cabinetRef.id;

  await db.runTransaction(async tx => {
    tx.set(db.doc(cabinetPath(cabinetId)), {
      name,
      orias,
      active: true,
      ownerUid: uid,
      enabledInsurers: [],
      enabledProducts: [],
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.doc(memberPath(cabinetId, uid)), {
      email: user.email ?? null,
      displayName: user.displayName ?? null,
      role: "admin",
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  await setCabinetClaims(uid, cabinetId, "admin");
  return { cabinetId };
});
