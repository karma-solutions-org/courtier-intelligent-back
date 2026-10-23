import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership, requireId } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { addEvent, loadProduct } from "../core/dossier.utils";
import { dossierPath } from "../core/firestore-paths";
import {
  diffNeed,
  EMPTY_NEED,
  isNeedValidatable,
  isTransitionAllowed,
  normalizeNeed,
  validateNeed,
  DOSSIER_STATUS_LABELS,
  type DossierStatus,
  type NeedInput,
} from "../shared/index.js";

/** Statuts dans lesquels le besoin s'analyse : le dossier est complet, mais pas encore tarifé. */
const NEED_STATUSES: DossierStatus[] = ["complet", "besoin_valide"];

/** Besoin enregistré d'un dossier, sans la date de validation. */
function storedNeed(raw: Record<string, unknown> | undefined): NeedInput | null {
  if (!raw) return null;
  return normalizeNeed({ ...EMPTY_NEED, ...(raw as Partial<NeedInput>) });
}

/**
 * Enregistre l'analyse du besoin d'un dossier complet (couverture, budget, franchise, garanties, notes).
 * Chaque modification est tracée dans l'historique (champs modifiés avec ancienne et nouvelle valeur). Modifier un besoin
 * déjà validé annule sa validation : le dossier repasse en « complet ».
 */
export const enregistrerBesoin = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const dossierId = requireId(request.data?.dossierId, "dossier");
  const received = request.data?.need;

  const db = admin.firestore();
  const ref = db.doc(dossierPath(cabinetId, dossierId));

  return db.runTransaction(async tx => {
    const dossier = await tx.get(ref);
    if (!dossier.exists) {
      throw new HttpsError("not-found", "Dossier introuvable.");
    }
    if (dossier.get("deletedAt")) {
      throw new HttpsError("failed-precondition", "Ce dossier est dans la corbeille : restaurez-le pour le modifier.", {
        reason: "dossier_deleted",
      });
    }
    const status = dossier.get("status") as DossierStatus;
    if (!NEED_STATUSES.includes(status)) {
      throw new HttpsError("failed-precondition", "La couverture souhaitée se renseigne une fois le dossier complet, et avant la tarification.", {
        reason: "need_not_editable",
      });
    }
    const { guaranteeCatalog } = await loadProduct(tx, cabinetId, dossier.get("productId"));
    const problems = validateNeed(received, guaranteeCatalog.map(g => g.code));
    if (problems.length) {
      throw new HttpsError("invalid-argument", problems.join(" "));
    }

    const before = storedNeed(dossier.get("needAnalysis"));
    const after = normalizeNeed(received as NeedInput);
    const changed = diffNeed(before, after);
    if (changed.length === 0) {
      return { status, changed: [] as string[] };
    }

    // Une modification invalide la validation : le dossier repasse en « complet ».
    const newStatus: DossierStatus = status === "besoin_valide" ? "complet" : status;
    tx.update(ref, {
      needAnalysis: { ...after, validatedAt: null },
      status: newStatus,
      // Couverture rouverte : le questionnaire figé à la validation n'a plus cours.
      ...(newStatus !== status ? { questionnaireSnapshot: null } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Les notes peuvent être longues : on trace qu'elles ont changé, pas leur contenu.
    const changes = Object.fromEntries(
      changed.map(key => [key, key === "notes" ? { changed: true } : { from: (before ?? EMPTY_NEED)[key], to: after[key] }]),
    );
    addEvent(tx, cabinetId, dossierId, uid, "need_updated", { changes });
    if (newStatus !== status) {
      addEvent(tx, cabinetId, dossierId, uid, "status_changed", { from: status, to: newStatus, automatic: true });
    }
    return { status: newStatus, changed };
  });
});

/** Valide le besoin : le dossier passe de « complet » à « besoin validé » (étape préalable à la tarification). */
export const validerBesoin = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const dossierId = requireId(request.data?.dossierId, "dossier");

  const db = admin.firestore();
  const ref = db.doc(dossierPath(cabinetId, dossierId));

  return db.runTransaction(async tx => {
    const dossier = await tx.get(ref);
    if (!dossier.exists) {
      throw new HttpsError("not-found", "Dossier introuvable.");
    }
    if (dossier.get("deletedAt")) {
      throw new HttpsError("failed-precondition", "Ce dossier est dans la corbeille : restaurez-le pour le modifier.", {
        reason: "dossier_deleted",
      });
    }
    const from = dossier.get("status") as DossierStatus;
    if (from === "besoin_valide") {
      return { status: "besoin_valide" };
    }
    if (!isTransitionAllowed(from, "besoin_valide")) {
      throw new HttpsError("failed-precondition", `Transition interdite : « ${DOSSIER_STATUS_LABELS[from]} » vers « ${DOSSIER_STATUS_LABELS.besoin_valide} ».`, {
        reason: "invalid_transition",
      });
    }
    const need = dossier.get("needAnalysis") as { coverageLevel?: string | null } | null;
    if (!isNeedValidatable(need as never)) {
      throw new HttpsError("failed-precondition", "Choisissez un niveau de couverture et au moins une garantie avant de valider.", {
        reason: "need_incomplete",
      });
    }
    // Questionnaire figé : la suite du dossier (complétude, tarification) s'y réfère, même si le produit change.
    const { questionnaireSchema } = await loadProduct(tx, cabinetId, dossier.get("productId"), dossier.get("insurerIds") ?? []);

    tx.update(ref, {
      status: "besoin_valide",
      questionnaireSnapshot: questionnaireSchema,
      "needAnalysis.validatedAt": FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    addEvent(tx, cabinetId, dossierId, uid, "status_changed", { from, to: "besoin_valide", need: true });
    return { status: "besoin_valide" };
  });
});
