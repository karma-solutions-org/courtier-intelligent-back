import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership, requireString } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { addEvent, loadProduct } from "../core/dossier.utils";
import { formatReference } from "../core/dossier-reference";
import {
  assurePath,
  dossierCounterPath,
  dossierPath,
  dossiersPath,
  memberPath,
  cabinetPath,
  productPath,
} from "../core/firestore-paths";
import {
  computeCompleteness,
  DOSSIER_STATUSES,
  EDITABLE_DOSSIER_STATUSES,
  isTransitionAllowed,
  questionFor,
  validateAnswer,
  type CanonicalData,
  type DossierStatus,
  type QuestionnaireSection,
} from "../shared/index.js";

const MAX_PATCH_FIELDS = 100;

/** Champs de l'assuré repris dans le dossier (uniquement ceux que le questionnaire du produit demande). */
function prefillFromAssure(schema: QuestionnaireSection[], assure: admin.firestore.DocumentSnapshot): CanonicalData {
  const candidates: Record<string, unknown> = {
    "client.firstName": assure.get("firstName"),
    "client.lastName": assure.get("lastName"),
    "client.birthDate": assure.get("birthDate"),
    "client.email": assure.get("email"),
    "client.phone": assure.get("phone"),
    "client.address.street": assure.get("address.street"),
    "client.address.postalCode": assure.get("address.postalCode"),
    "client.address.city": assure.get("address.city"),
    "client.address.country": assure.get("address.country"),
  };
  const data: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(candidates)) {
    if (typeof value === "string" && value && questionFor(schema, path)) {
      data[path] = value;
    }
  }
  return data as CanonicalData;
}

/**
 * Crée un dossier en « brouillon » pour un assuré et un produit. La référence est attribuée ici,
 * dans la transaction du compteur : deux créations simultanées n'obtiennent jamais le même numéro.
 */
export const creer = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const assureId = requireString(request.data?.assureId, "assuré");
  const productId = requireString(request.data?.productId, "produit");

  const db = admin.firestore();
  const dossierRef = db.collection(dossiersPath(cabinetId)).doc();
  const year = new Date().getUTCFullYear();
  const counterRef = db.doc(dossierCounterPath(cabinetId, year));

  const reference = await db.runTransaction(async tx => {
    const [assure, product, cabinet, counter] = await Promise.all([
      tx.get(db.doc(assurePath(cabinetId, assureId))),
      tx.get(db.doc(productPath(productId))),
      tx.get(db.doc(cabinetPath(cabinetId))),
      tx.get(counterRef),
    ]);
    if (!assure.exists) {
      throw new HttpsError("not-found", "Assuré introuvable.");
    }
    if (!product.exists || product.get("active") !== true) {
      throw new HttpsError("not-found", "Produit introuvable ou inactif.");
    }
    const enabled = (cabinet.get("enabledProducts") as string[] | undefined) ?? [];
    if (enabled.length > 0 && !enabled.includes(productId)) {
      throw new HttpsError("failed-precondition", "Ce produit n'est pas activé pour votre cabinet.");
    }

    const schema = product.get("questionnaireSchema") as QuestionnaireSection[];
    const data = prefillFromAssure(schema, assure);
    const sequence = ((counter.get("value") as number | undefined) ?? 0) + 1;
    const reference = formatReference(year, sequence);

    tx.set(counterRef, { value: sequence });
    tx.create(dossierRef, {
      reference,
      assureId,
      productId,
      assignedTo: uid,
      createdBy: uid,
      status: "brouillon",
      data,
      completeness: computeCompleteness(schema, data),
      needAnalysis: null,
      decision: null,
      proposal: null,
      outcome: null,
      draft: { sectionIndex: 0 },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    addEvent(tx, cabinetId, dossierRef.id, uid, "created", { reference, productId, assureId });
    return reference;
  });

  return { dossierId: dossierRef.id, reference };
});

/**
 * Enregistre des réponses du questionnaire (sauvegarde automatique du brouillon) et recalcule la complétude.
 * Chaque champ est contrôlé : il doit appartenir au questionnaire du produit et avoir le bon type.
 * `sectionIndex` mémorise où le courtier s'est arrêté ; `event` trace la modification dans l'historique.
 */
export const sauvegarder = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const dossierId = requireString(request.data?.dossierId, "dossier");
  const patch = request.data?.patch;
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new HttpsError("invalid-argument", "Modifications invalides.");
  }
  const entries = Object.entries(patch as Record<string, unknown>);
  if (entries.length > MAX_PATCH_FIELDS) {
    throw new HttpsError("invalid-argument", "Trop de champs modifiés à la fois.");
  }
  const sectionIndex = request.data?.sectionIndex;
  if (sectionIndex !== undefined && (!Number.isInteger(sectionIndex) || sectionIndex < 0 || sectionIndex > 100)) {
    throw new HttpsError("invalid-argument", "Section invalide.");
  }

  const db = admin.firestore();
  const ref = db.doc(dossierPath(cabinetId, dossierId));

  return db.runTransaction(async tx => {
    const dossier = await tx.get(ref);
    if (!dossier.exists) {
      throw new HttpsError("not-found", "Dossier introuvable.");
    }
    const status = dossier.get("status") as DossierStatus;
    if (!EDITABLE_DOSSIER_STATUSES.includes(status)) {
      throw new HttpsError("failed-precondition", "Ce dossier n'est plus modifiable.", { reason: "not_editable" });
    }
    const { questionnaireSchema: schema } = await loadProduct(tx, dossier.get("productId"));

    for (const [path, value] of entries) {
      const question = questionFor(schema, path);
      if (!question) {
        throw new HttpsError("invalid-argument", `Champ inconnu : ${path}`);
      }
      const problem = validateAnswer(question, value);
      if (problem) {
        throw new HttpsError("invalid-argument", problem);
      }
    }

    const data = { ...(dossier.get("data") as CanonicalData), ...(patch as CanonicalData) };
    const completeness = computeCompleteness(schema, data);

    // Un dossier « complet » qui cesse de l'être repasse en brouillon ; un dossier « besoin validé » ne peut pas perdre d'information obligatoire.
    let newStatus = status;
    if (!completeness.ok && status === "besoin_valide") {
      throw new HttpsError("failed-precondition", "Ce dossier est validé : une information obligatoire ne peut pas être retirée.", {
        reason: "validated",
      });
    }
    if (!completeness.ok && status === "complet") {
      newStatus = "brouillon";
      addEvent(tx, cabinetId, dossierId, uid, "status_changed", { from: status, to: newStatus, automatic: true });
    }
    if (request.data?.event === true && entries.length > 0) {
      addEvent(tx, cabinetId, dossierId, uid, "data_updated", { fields: entries.map(([path]) => path) });
    }

    tx.update(ref, {
      data,
      completeness,
      status: newStatus,
      ...(sectionIndex !== undefined ? { draft: { sectionIndex } } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status: newStatus, completeness };
  });
});

/**
 * Change le statut d'un dossier. La machine à états est appliquée ici : une transition interdite est refusée,
 * et un dossier ne devient « complet » que si aucun champ obligatoire ne manque.
 */
export const changerStatut = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const dossierId = requireString(request.data?.dossierId, "dossier");
  const target = request.data?.status as DossierStatus;
  if (!DOSSIER_STATUSES.includes(target)) {
    throw new HttpsError("invalid-argument", "Statut invalide.");
  }

  const db = admin.firestore();
  const ref = db.doc(dossierPath(cabinetId, dossierId));

  return db.runTransaction(async tx => {
    const dossier = await tx.get(ref);
    if (!dossier.exists) {
      throw new HttpsError("not-found", "Dossier introuvable.");
    }
    const from = dossier.get("status") as DossierStatus;
    if (target === "besoin_valide") {
      throw new HttpsError("failed-precondition", "Le besoin se valide depuis l'onglet Besoin du dossier.", { reason: "use_validate_need" });
    }
    if (!isTransitionAllowed(from, target)) {
      throw new HttpsError("failed-precondition", `Transition interdite : « ${from} » vers « ${target} ».`, {
        reason: "invalid_transition",
      });
    }
    const { questionnaireSchema: schema } = await loadProduct(tx, dossier.get("productId"));
    const completeness = computeCompleteness(schema, dossier.get("data") as CanonicalData);
    if (target === "complet" && !completeness.ok) {
      throw new HttpsError(
        "failed-precondition",
        `Le dossier est incomplet : ${completeness.missing.length} champ(s) obligatoire(s) manquant(s).`,
        { reason: "incomplete", missing: completeness.missing },
      );
    }

    tx.update(ref, {
      status: target,
      completeness,
      // Quitter « besoin validé » annule la validation.
      ...(from === "besoin_valide" && dossier.get("needAnalysis") ? { "needAnalysis.validatedAt": null } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    addEvent(tx, cabinetId, dossierId, uid, "status_changed", { from, to: target });
    return { status: target };
  });
});

/** Assigne ou réassigne un dossier à un membre actif : l'admin à n'importe quel dossier, un courtier à ses propres dossiers. */
export const assigner = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid, role } = await getActiveMembership(request);
  const dossierId = requireString(request.data?.dossierId, "dossier");
  const assignee = requireString(request.data?.uid, "membre");

  const db = admin.firestore();
  const ref = db.doc(dossierPath(cabinetId, dossierId));

  await db.runTransaction(async tx => {
    const [dossier, member] = await Promise.all([tx.get(ref), tx.get(db.doc(memberPath(cabinetId, assignee)))]);
    if (!dossier.exists) {
      throw new HttpsError("not-found", "Dossier introuvable.");
    }
    if (role !== "admin" && dossier.get("assignedTo") !== uid) {
      throw new HttpsError("permission-denied", "Seul un administrateur ou le courtier en charge peut réassigner ce dossier.");
    }
    if (!member.exists || member.get("status") !== "active") {
      throw new HttpsError("failed-precondition", "Ce membre n'est pas actif dans le cabinet.");
    }
    const from = dossier.get("assignedTo");
    if (from === assignee) {
      return;
    }
    tx.update(ref, { assignedTo: assignee, updatedAt: FieldValue.serverTimestamp() });
    addEvent(tx, cabinetId, dossierId, uid, "assigned", { from, to: assignee });
  });
  return { success: true };
});

export { enregistrerBesoin, validerBesoin } from "./besoin.callable";
