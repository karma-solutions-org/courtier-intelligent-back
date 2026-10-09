import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership, requireString } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { addEvent } from "../core/dossier.utils";
import { dossierPath, offerPath } from "../core/firestore-paths";
import { isTransitionAllowed, validateDecisionJustification, type DossierStatus } from "../shared/index.js";

/** Statuts depuis lesquels on peut choisir (ou changer) l'offre retenue. */
const DECISION_STATUSES: DossierStatus[] = ["tarification", "comparaison", "decision"];

/**
 * Choix de l'offre retenue, avec une justification obligatoire (Epic E13) : écrit `decision` et passe le dossier en
 * « décision » par la machine à états. Depuis « tarification », le dossier passe d'abord par « comparaison » (transition
 * autorisée). Déjà en « décision », le choix est remplacé (historisé).
 */
export const decider = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const dossierId = requireString(request.data?.dossierId, "dossier");
  const insurerId = requireString(request.data?.insurerId, "assureur");
  const problem = validateDecisionJustification(request.data?.justification);
  if (problem) {
    throw new HttpsError("invalid-argument", problem);
  }
  const justification = (request.data.justification as string).trim();

  const db = admin.firestore();
  const ref = db.doc(dossierPath(cabinetId, dossierId));

  return db.runTransaction(async tx => {
    const [dossier, offer] = await Promise.all([
      tx.get(ref),
      tx.get(db.doc(offerPath(cabinetId, dossierId, insurerId))),
    ]);
    if (!dossier.exists) {
      throw new HttpsError("not-found", "Dossier introuvable.");
    }
    if (!offer.exists) {
      throw new HttpsError("not-found", "Offre introuvable pour cet assureur.");
    }
    const from = dossier.get("status") as DossierStatus;
    if (!DECISION_STATUSES.includes(from)) {
      throw new HttpsError(
        "failed-precondition",
        "Le choix d'une offre se fait pendant la tarification ou la comparaison.",
        {
          reason: "invalid_transition",
        },
      );
    }

    let status = from;
    if (status === "tarification" && isTransitionAllowed(status, "comparaison")) {
      addEvent(tx, cabinetId, dossierId, uid, "status_changed", { from: status, to: "comparaison", automatic: true });
      status = "comparaison";
    }
    if (status !== "decision") {
      if (!isTransitionAllowed(status, "decision")) {
        throw new HttpsError("failed-precondition", `Transition interdite : « ${status} » vers « decision ».`, {
          reason: "invalid_transition",
        });
      }
      addEvent(tx, cabinetId, dossierId, uid, "status_changed", { from: status, to: "decision" });
    }

    const previous = dossier.get("decision") as { insurerId?: string } | null;
    tx.update(ref, {
      status: "decision",
      decision: { insurerId, justification, decidedBy: uid, decidedAt: FieldValue.serverTimestamp() },
      updatedAt: FieldValue.serverTimestamp(),
    });
    addEvent(tx, cabinetId, dossierId, uid, "decision_made", {
      insurerId,
      justification,
      score: offer.get("score") ?? null,
      replaced: previous?.insurerId ?? null,
    });
    return { status: "decision" as DossierStatus };
  });
});
