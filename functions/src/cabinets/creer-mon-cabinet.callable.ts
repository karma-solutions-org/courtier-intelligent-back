import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertSignedIn, requireString } from "../core/auth.utils";
import { createCabinet } from "../core/cabinet.utils";
import { CALLABLE_OPTIONS, CLAIM_CABINET_ID } from "../core/config";

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

  const cabinetId = await createCabinet({ name, orias, ownerUid: uid });
  return { cabinetId };
});
