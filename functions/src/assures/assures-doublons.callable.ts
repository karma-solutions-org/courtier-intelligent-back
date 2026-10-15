import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { duplicateReasons, type AssureDuplicateReason, type AssureIdentity } from "../shared/index.js";

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().substring(0, max) : null);

/**
 * Doublons d'un client, cherchés côté serveur dans TOUT le cabinet (y compris la corbeille) : même SIRET, même email,
 * même nom + date de naissance ou même raison sociale. Les règles ne peuvent pas interroger la collection : l'app
 * appelle cette function avant de créer (ou de modifier) un client et avertit le courtier.
 * Données : { firstName?, lastName?, birthDate?, email?, siret?, companyName?, excludeId? }
 *   → { duplicates: [{ id, reasons, deleted }] }.
 */
export const verifierDoublon = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId } = await getActiveMembership(request);
  const candidate: AssureIdentity = {
    firstName: text(request.data?.firstName, 100),
    lastName: text(request.data?.lastName, 100),
    birthDate: text(request.data?.birthDate, 10),
    email: text(request.data?.email, 254)?.toLowerCase() ?? null,
    siret: text(request.data?.siret, 20)?.replace(/\s/g, "") ?? null,
    companyName: text(request.data?.companyName, 200),
  };
  if (!candidate.siret && !candidate.email && !candidate.lastName && !candidate.companyName) {
    throw new HttpsError("invalid-argument", "Renseignez au moins un nom, un email ou un SIRET.");
  }
  const excludeId = text(request.data?.excludeId, 100);

  const assures = admin.firestore().collection(`ci_cabinets/${cabinetId}/ci_assures`);
  const queries = [
    candidate.siret ? assures.where("siret", "==", candidate.siret).limit(20).get() : null,
    candidate.email ? assures.where("email", "==", candidate.email).limit(20).get() : null,
    candidate.email && candidate.email !== request.data?.email ? assures.where("email", "==", String(request.data.email).trim()).limit(20).get() : null,
    candidate.lastName ? assures.where("lastName", "==", candidate.lastName).limit(50).get() : null,
    candidate.companyName ? assures.where("companyName", "==", candidate.companyName).limit(20).get() : null,
  ];
  const found = new Map<string, { id: string; reasons: AssureDuplicateReason[]; deleted: boolean }>();
  for (const snapshot of await Promise.all(queries)) {
    for (const doc of snapshot?.docs ?? []) {
      if (doc.id === excludeId || found.has(doc.id)) continue;
      const reasons = duplicateReasons(candidate, doc.data() as AssureIdentity);
      if (reasons.length) found.set(doc.id, { id: doc.id, reasons, deleted: !!doc.get("deletedAt") });
    }
  }
  return { duplicates: [...found.values()].slice(0, 20) };
});
