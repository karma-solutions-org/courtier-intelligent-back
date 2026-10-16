import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { FALLBACK_LIMITS } from "../shared/index.js";
import { cabinetPath, plaqueUsagePath } from "../core/firestore-paths";

/** Mois en cours (« AAAA-MM », UTC) : période du quota de recherches. */
const currentMonth = () => new Date().toISOString().substring(0, 7);

/**
 * Réserve une recherche par plaque sur le quota mensuel du cabinet (`limits.appelsPlaqueParMois`) AVANT d'appeler le
 * fournisseur payant : des recherches simultanées ne dépassent jamais la limite. Renvoie de quoi rendre la recherche
 * si le fournisseur n'a pas répondu (rien n'a été facturé).
 */
export async function reservePlaqueLookup(cabinetId: string): Promise<{ remaining: number; release: () => Promise<void> }> {
  const db = admin.firestore();
  const usageRef = db.doc(plaqueUsagePath(cabinetId, currentMonth()));
  const remaining = await db.runTransaction(async tx => {
    const [cabinet, usage] = await Promise.all([tx.get(db.doc(cabinetPath(cabinetId))), tx.get(usageRef)]);
    // Cabinet créé avant cette limite : sa copie des limites ne la porte pas encore.
    const limit = (cabinet.get("limits.appelsPlaqueParMois") as number | undefined) ?? FALLBACK_LIMITS.appelsPlaqueParMois;
    const calls = (usage.get("calls") as number | undefined) ?? 0;
    if (calls >= limit) {
      throw new HttpsError(
        "resource-exhausted",
        `Limite de ${limit} recherches par immatriculation par mois atteinte pour votre cabinet. Saisissez le véhicule à la main, ou changez d'offre.`,
        { reason: "plaque_quota", limit },
      );
    }
    tx.set(usageRef, { calls: calls + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return limit - calls - 1;
  });
  const release = () =>
    usageRef
      .set({ calls: FieldValue.increment(-1) }, { merge: true })
      .then(() => undefined)
      .catch(() => undefined);
  return { remaining, release };
}
