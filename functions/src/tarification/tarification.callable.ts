import * as admin from "firebase-admin";
import { DocumentSnapshot, FieldValue, Transaction } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership, requireString } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { addEvent, loadProduct } from "../core/dossier.utils";
import { cabinetPath, documentsPath, dossierPath, insurerPath, offerPath, quoteJobPath } from "../core/firestore-paths";
import {
  buildJobQuoteData,
  canLaunchQuoteJob,
  computeCompleteness,
  isAnswered,
  isQuoteDocumentPath,
  missingFieldQuestion,
  normalizeManualOffer,
  PRICING_DOSSIER_STATUSES,
  questionFor,
  validateAnswer,
  validateManualOffer,
  type CanonicalData,
  type CanonicalValue,
  type DossierStatus,
  type ManualOfferInput,
  type MissingField,
  type QuoteJobStatus,
} from "../shared/index.js";

const MAX_ANSWERS = 100;

/**
 * Le dossier peut-il être tarifé ? Il faut un besoin validé (statut « besoin validé » ou au-delà, jusqu'à la comparaison).
 * Renvoie le dossier lu dans la transaction.
 */
async function loadPricingDossier(tx: Transaction, cabinetId: string, dossierId: string): Promise<DocumentSnapshot> {
  const dossier = await tx.get(admin.firestore().doc(dossierPath(cabinetId, dossierId)));
  if (!dossier.exists) {
    throw new HttpsError("not-found", "Dossier introuvable.");
  }
  const status = dossier.get("status") as DossierStatus;
  if (!PRICING_DOSSIER_STATUSES.includes(status) || !dossier.get("needAnalysis.validatedAt")) {
    throw new HttpsError("failed-precondition", "Validez le besoin du client avant de lancer une tarification.", {
      reason: "need_not_validated",
    });
  }
  return dossier;
}

/** L'assureur doit tarifer le produit du dossier et être activé par le cabinet (aucun choix = tous). */
async function loadPricingInsurer(tx: Transaction, cabinetId: string, insurerId: string, productId: string): Promise<DocumentSnapshot> {
  const db = admin.firestore();
  const [insurer, cabinet] = await Promise.all([tx.get(db.doc(insurerPath(insurerId))), tx.get(db.doc(cabinetPath(cabinetId)))]);
  if (!insurer.exists) {
    throw new HttpsError("not-found", "Assureur introuvable.");
  }
  const supported = (insurer.get("productsSupported") as string[] | undefined) ?? [];
  const enabled = (cabinet.get("enabledInsurers") as string[] | undefined) ?? [];
  if (!supported.includes(productId) || (enabled.length > 0 && !enabled.includes(insurerId))) {
    throw new HttpsError("failed-precondition", "Cet assureur n'est pas disponible pour ce produit dans votre cabinet.", {
      reason: "insurer_not_available",
    });
  }
  return insurer;
}

/** Premier passage en tarification : le dossier quitte « besoin validé ». */
function enterPricing(tx: Transaction, cabinetId: string, dossier: DocumentSnapshot, uid: string): DossierStatus {
  const from = dossier.get("status") as DossierStatus;
  if (from !== "besoin_valide") {
    return from;
  }
  tx.update(dossier.ref, { status: "tarification", updatedAt: FieldValue.serverTimestamp() });
  addEvent(tx, cabinetId, dossier.id, uid, "status_changed", { from, to: "tarification", automatic: true });
  return "tarification";
}

/**
 * « Tarifer chez un assureur » : écrit le job `requested` avec les données du dossier (`quoteData`) ; l'extension du
 * courtier le prend en charge sur l'extranet. Relance aussi un job en échec (nouvelle tentative, données à jour).
 * Bloqué tant que le besoin n'est pas validé.
 */
export const lancer = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const dossierId = requireString(request.data?.dossierId, "dossier");
  const insurerId = requireString(request.data?.insurerId, "assureur");

  const db = admin.firestore();
  const jobRef = db.doc(quoteJobPath(cabinetId, dossierId, insurerId));

  return db.runTransaction(async tx => {
    const dossier = await loadPricingDossier(tx, cabinetId, dossierId);
    const insurer = await loadPricingInsurer(tx, cabinetId, insurerId, dossier.get("productId"));
    const job = await tx.get(jobRef);
    const { questionnaireSchema } = await loadProduct(tx, dossier.get("productId"));

    if (!canLaunchQuoteJob(job.exists ? { status: job.get("status") as QuoteJobStatus } : null)) {
      throw new HttpsError(
        "failed-precondition",
        job.get("status") === "captured" ? "Le tarif de cet assureur est déjà obtenu." : "Une tarification est déjà en cours chez cet assureur.",
        { reason: job.get("status") === "captured" ? "already_captured" : "job_in_progress" },
      );
    }

    const attempts = ((job.get("attempts") as number | undefined) ?? 0) + 1;
    const status = enterPricing(tx, cabinetId, dossier, uid);
    tx.set(jobRef, {
      status: "requested",
      ownerUid: uid,
      quoteData: buildJobQuoteData(questionnaireSchema, dossier.get("data") as CanonicalData),
      missingFields: [],
      currentStep: null,
      totalSteps: null,
      error: null,
      attempts,
      dossierReference: dossier.get("reference") ?? null,
      requestedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    addEvent(tx, cabinetId, dossierId, uid, "pricing_requested", { insurerId, attempt: attempts });
    return { dossierStatus: status, attempts, extranetUrl: (insurer.get("extranetUrl") as string | undefined) ?? null };
  });
});

/**
 * Réponses du courtier aux champs que l'extranet demande et que le dossier ne renseigne pas (`needs_info`).
 * Elles sont enregistrées dans le dossier, puis `quoteData` est mis à jour : l'extension reprend le remplissage.
 */
export const completer = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const dossierId = requireString(request.data?.dossierId, "dossier");
  const insurerId = requireString(request.data?.insurerId, "assureur");
  const answers = request.data?.answers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers) || Object.keys(answers).length > MAX_ANSWERS) {
    throw new HttpsError("invalid-argument", "Réponses invalides.");
  }

  const db = admin.firestore();
  const jobRef = db.doc(quoteJobPath(cabinetId, dossierId, insurerId));

  return db.runTransaction(async tx => {
    const dossier = await loadPricingDossier(tx, cabinetId, dossierId);
    const job = await tx.get(jobRef);
    if (!job.exists || job.get("status") !== "needs_info") {
      throw new HttpsError("failed-precondition", "Cette tarification n'attend pas d'informations.", { reason: "not_waiting_info" });
    }
    const { questionnaireSchema: schema } = await loadProduct(tx, dossier.get("productId"));

    // Seuls les champs demandés par l'extension sont acceptés, et tous doivent être renseignés.
    const fields = new Map(((job.get("missingFields") as MissingField[] | undefined) ?? []).map(f => [f.canonicalPath as string, f]));
    for (const [path, value] of Object.entries(answers as Record<string, unknown>)) {
      const field = fields.get(path);
      if (!field) {
        throw new HttpsError("invalid-argument", `Champ non demandé : ${path}`);
      }
      const problem = validateAnswer(questionFor(schema, path) ?? missingFieldQuestion(field), value);
      if (problem) {
        throw new HttpsError("invalid-argument", problem);
      }
    }
    const unanswered = [...fields.values()].filter(f => !isAnswered((answers as Record<string, CanonicalValue>)[f.canonicalPath]));
    if (unanswered.length) {
      throw new HttpsError("invalid-argument", `Renseignez : ${unanswered.map(f => f.label).join(", ")}.`, { reason: "incomplete" });
    }

    const data = { ...(dossier.get("data") as CanonicalData), ...(answers as CanonicalData) };
    tx.update(dossier.ref, { data, completeness: computeCompleteness(schema, data), updatedAt: FieldValue.serverTimestamp() });
    // Un nouveau `quoteData` est le signal de reprise pour l'extension ; elle repose elle-même le statut du job.
    tx.update(jobRef, { quoteData: buildJobQuoteData(schema, data), missingFields: [], updatedAt: FieldValue.serverTimestamp() });
    addEvent(tx, cabinetId, dossierId, uid, "pricing_completed", { insurerId, fields: Object.keys(answers) });
    return { success: true };
  });
});

/**
 * Saisie manuelle d'une offre (extension en échec, devis reçu autrement…), avec le devis joint s'il y en a un.
 * L'offre est marquée `source: manual` ; le job de l'assureur, s'il existe, passe en « tarif obtenu ».
 */
export const saisirOffre = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const dossierId = requireString(request.data?.dossierId, "dossier");
  const insurerId = requireString(request.data?.insurerId, "assureur");
  const received = request.data?.offer;
  const document = request.data?.document as { storagePath?: unknown; fileName?: unknown } | null | undefined;
  if (document != null && !isQuoteDocumentPath(document.storagePath, cabinetId, dossierId)) {
    throw new HttpsError("invalid-argument", "Devis joint invalide.");
  }
  const fileName = typeof document?.fileName === "string" ? document.fileName.slice(0, 200) : null;

  const db = admin.firestore();
  const jobRef = db.doc(quoteJobPath(cabinetId, dossierId, insurerId));
  const offerRef = db.doc(offerPath(cabinetId, dossierId, insurerId));

  return db.runTransaction(async tx => {
    const dossier = await loadPricingDossier(tx, cabinetId, dossierId);
    await loadPricingInsurer(tx, cabinetId, insurerId, dossier.get("productId"));
    const [job, previous] = await Promise.all([tx.get(jobRef), tx.get(offerRef)]);
    const { guaranteeCatalog } = await loadProduct(tx, dossier.get("productId"));

    const problems = validateManualOffer(received, guaranteeCatalog.map(g => g.code));
    if (problems.length) {
      throw new HttpsError("invalid-argument", problems.join(" "));
    }

    let documentId: string | null = null;
    if (document != null) {
      const documentRef = db.collection(documentsPath(cabinetId, dossierId)).doc();
      documentId = documentRef.id;
      tx.create(documentRef, {
        type: "devis",
        storagePath: document.storagePath,
        fileName,
        insurerId,
        ocrFields: [],
        status: "uploaded",
        uploadedBy: uid,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    const status = enterPricing(tx, cabinetId, dossier, uid);
    // Une nouvelle saisie remplace l'offre précédente ; le devis déjà joint est gardé si aucun nouveau n'est envoyé.
    tx.set(offerRef, {
      ...normalizeManualOffer(received as ManualOfferInput, guaranteeCatalog),
      source: "manual",
      gaps: [],
      score: null,
      enteredBy: uid,
      documentId: documentId ?? (previous.get("documentId") as string | undefined) ?? null,
      capturedAt: FieldValue.serverTimestamp(),
    });
    if (job.exists && job.get("status") !== "captured") {
      tx.update(jobRef, { status: "captured", missingFields: [], error: null, updatedAt: FieldValue.serverTimestamp() });
    }
    addEvent(tx, cabinetId, dossierId, uid, "offer_entered", { insurerId, replaced: previous.exists, withDocument: documentId !== null });
    return { dossierStatus: status, documentId };
  });
});
