import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership, requireId, requireString } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { addEvent, cancelledJobUpdate, dossierSchema, loadProduct } from "../core/dossier.utils";
import { formatReference } from "../core/dossier-reference";
import {
  assurePath,
  dossierCounterPath,
  dossierPath,
  dossiersPath,
  memberPath,
  cabinetPath,
  insurerPath,
  productPath,
} from "../core/firestore-paths";
import {
  ACTIVE_QUOTE_JOB_STATUSES,
  computeCompleteness,
  DOSSIER_STATUSES,
  SANS_SUITE_MOTIF_MAX,
  TERMINAL_DOSSIER_STATUSES,
  ANSWERS_EDITABLE_DOSSIER_STATUSES,
  buildJobQuoteData,
  isTransitionAllowed,
  questionFor,
  supportsProduct,
  validateAnswer,
  withAddedComplements,
  type CanonicalData,
  type CanonicalPath,
  type DossierStatus,
  type QuestionnaireSection,
  type QuoteJobStatus,
} from "../shared/index.js";

const MAX_PATCH_FIELDS = 100;
const MAX_INSURERS = 50;

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
 * Extranets envoyés pendant la tarification : un assureur choisi ne se retire plus (ses tarifs et son job en dépendent),
 * on ne peut qu'en ajouter. Les ajoutés doivent tarifer le produit du dossier et être activés par le cabinet (aucun
 * choix = tous), comme pour tarification-lancer. Liste identique : `added` vide, rien ne change.
 * `frozen` : le dossier a un questionnaire figé (à compléter avec les questions des nouveaux assureurs).
 */
async function addedInsurers(
  tx: admin.firestore.Transaction,
  cabinetId: string,
  dossier: admin.firestore.DocumentSnapshot,
  requested: string[],
): Promise<{ insurerIds: string[]; added: string[]; frozen: boolean }> {
  const chosen = (dossier.get("insurerIds") as string[] | undefined) ?? [];
  const next = new Set(requested);
  if (chosen.some(id => !next.has(id))) {
    throw new HttpsError("failed-precondition", "Un assureur choisi ne peut pas être retiré pendant la tarification.", {
      reason: "pricing_remove",
    });
  }
  const added = [...next].filter(id => !chosen.includes(id));
  const snapshot = dossier.get("questionnaireSnapshot") as QuestionnaireSection[] | null | undefined;
  const frozen = Array.isArray(snapshot) && snapshot.length > 0;
  if (!added.length) return { insurerIds: chosen, added, frozen };

  const db = admin.firestore();
  const [cabinet, ...insurers] = await Promise.all([
    tx.get(db.doc(cabinetPath(cabinetId))),
    ...added.map(id => tx.get(db.doc(insurerPath(id)))),
  ]);
  const enabled = (cabinet.get("enabledInsurers") as string[] | undefined) ?? [];
  const productId = dossier.get("productId") as string;
  for (const insurer of insurers) {
    const productsSupported = (insurer.get("productsSupported") as string[] | undefined) ?? [];
    if (
      !insurer.exists ||
      !supportsProduct({ productsSupported }, productId) ||
      (enabled.length > 0 && !enabled.includes(insurer.id))
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Cet assureur n'est pas disponible pour ce produit dans votre cabinet.",
        { reason: "insurer_not_available", insurerId: insurer.id },
      );
    }
  }
  return { insurerIds: [...chosen, ...added], added, frozen };
}

/**
 * Crée un dossier en « brouillon » pour un assuré et un produit. La référence est attribuée ici,
 * dans la transaction du compteur : deux créations simultanées n'obtiennent jamais le même numéro.
 */
export const creer = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const assureId = requireId(request.data?.assureId, "assuré");
  const productId = requireId(request.data?.productId, "produit");

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
    if (assure.get("deletedAt")) {
      throw new HttpsError(
        "failed-precondition",
        "Ce client est dans la corbeille : restaurez-le pour lui créer un dossier.",
        {
          reason: "assure_deleted",
        },
      );
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
    // Complétude initiale sur le questionnaire du dossier (extranets du cabinet, socle et compléments), comme à chaque
    // enregistrement : une question facultative pour ces extranets ne compte pas parmi les champs manquants.
    const { questionnaireSchema } = await loadProduct(tx, cabinetId, productId);
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
      completeness: computeCompleteness(questionnaireSchema, data),
      // Version du questionnaire du produit à la création (le questionnaire est figé à la validation de la couverture).
      questionnaireVersion:
        (product.get("questionnaireUpdatedAt") as admin.firestore.Timestamp | undefined)?.toMillis() ?? null,
      questionnaireSnapshot: null,
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
 * `sectionIndex` mémorise où le courtier s'est arrêté ; `insurerIds`, les extranets choisis ; `event` trace la
 * modification dans l'historique.
 * En tarification, `insurerIds` ne peut qu'ajouter des assureurs : le questionnaire figé reçoit leurs compléments
 * (withAddedComplements), dont les réponses obligatoires doivent arriver dans le même `patch` (événement `insurers_added`).
 */
export const sauvegarder = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const dossierId = requireId(request.data?.dossierId, "dossier");
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
  const insurerIds = request.data?.insurerIds;
  if (
    insurerIds !== undefined &&
    (!Array.isArray(insurerIds) ||
      insurerIds.length > MAX_INSURERS ||
      insurerIds.some(id => typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)))
  ) {
    throw new HttpsError("invalid-argument", "Extranets invalides.");
  }

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
    if (!ANSWERS_EDITABLE_DOSSIER_STATUSES.includes(status)) {
      throw new HttpsError("failed-precondition", "Ce dossier n'est plus modifiable.", { reason: "not_editable" });
    }
    const pricing = status === "tarification";
    // Pendant la tarification, la liste des extranets ne peut que s'allonger (assureur ajouté) : `pricingInsurers`
    // dit ce qui change, et le questionnaire figé reçoit les compléments que les nouveaux assureurs exigent.
    const pricingInsurers =
      pricing && insurerIds !== undefined ? await addedInsurers(tx, cabinetId, dossier, insurerIds) : null;
    let schema: QuestionnaireSection[];
    let addedQuestions: CanonicalPath[] = [];
    if (pricingInsurers?.added.length) {
      const current = await dossierSchema(tx, cabinetId, dossier);
      const fresh = (await loadProduct(tx, cabinetId, dossier.get("productId"), pricingInsurers.insurerIds))
        .questionnaireSchema;
      const merged = withAddedComplements(current, fresh);
      addedQuestions = merged.added;
      // Sans questionnaire figé (rien à compléter), le questionnaire de référence est celui des nouveaux extranets.
      schema = pricingInsurers.frozen ? merged.schema : fresh;
    } else {
      schema = await dossierSchema(
        tx,
        cabinetId,
        dossier,
        insurerIds !== undefined && !pricing ? { insurerIds: insurerIds as string[] } : {},
      );
    }
    // Lectures avant toute écriture (transaction) : tarifications et tarifs du dossier.
    const jobs = pricing ? await tx.get(ref.collection("ci_quoteJobs")) : null;
    const offers = pricing ? await tx.get(ref.collection("ci_offers")) : null;

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

    const previous = dossier.get("data") as CanonicalData;
    const data = { ...previous, ...(patch as CanonicalData) };
    const completeness = computeCompleteness(schema, data);

    // Un dossier « complet » qui cesse de l'être repasse en brouillon ; un dossier « besoin validé » ne peut pas perdre d'information obligatoire.
    let newStatus = status;
    // Pendant la tarification : seule compte une réponse obligatoire qu'on viderait (d'autres peuvent déjà manquer).
    const emptied = pricing
      ? completeness.missing.filter(path => !computeCompleteness(schema, previous).missing.includes(path))
      : [];
    // Assureur ajouté : ses questions obligatoires (visibles) se renseignent dans le même enregistrement, sinon rien n'est écrit.
    const unanswered = completeness.missing.filter(path => addedQuestions.includes(path));
    if (unanswered.length) {
      const labels = unanswered.map(path => questionFor(schema, path)?.label ?? path);
      throw new HttpsError("invalid-argument", `Renseignez : ${labels.join(", ")}.`, {
        reason: "incomplete",
        missing: unanswered,
      });
    }
    if (emptied.length) {
      throw new HttpsError(
        "failed-precondition",
        "Tarification en cours : une information obligatoire ne peut pas être retirée.",
        {
          reason: "validated",
        },
      );
    }
    if (!completeness.ok && status === "besoin_valide") {
      throw new HttpsError(
        "failed-precondition",
        "Ce dossier est validé : une information obligatoire ne peut pas être retirée.",
        {
          reason: "validated",
        },
      );
    }
    if (!completeness.ok && status === "complet") {
      newStatus = "brouillon";
      addEvent(tx, cabinetId, dossierId, uid, "status_changed", { from: status, to: newStatus, automatic: true });
    }
    if (request.data?.event === true && entries.length > 0) {
      addEvent(tx, cabinetId, dossierId, uid, "data_updated", { fields: entries.map(([path]) => path) });
    }

    if (pricing && jobs && offers) {
      // Première réponse à une question ajoutée avec un assureur : rien de ce qui a servi aux tarifs ne change.
      const firstAnswer = (path: string) =>
        addedQuestions.includes(path as CanonicalPath) && (previous[path as keyof CanonicalData] ?? null) === null;
      const changed = entries
        .map(([path]) => path)
        .filter(
          path =>
            !firstAnswer(path) &&
            JSON.stringify(previous[path as keyof CanonicalData] ?? null) !==
              JSON.stringify(data[path as keyof CanonicalData] ?? null),
        );
      if (changed.length) {
        // Tarifications en cours : nouvelles données (signal de reprise pour l'extension, comme tarification-completer).
        const quoteData = buildJobQuoteData(schema, data);
        for (const job of jobs.docs) {
          if (ACTIVE_QUOTE_JOB_STATUSES.includes(job.get("status") as QuoteJobStatus)) {
            tx.update(job.ref, { quoteData, updatedAt: FieldValue.serverTimestamp() });
          }
        }
        // Tarifs déjà obtenus : calculés sur les anciennes données, donc périmés.
        const stale = offers.docs.filter(offer => offer.get("stale") !== true);
        for (const offer of stale) tx.update(offer.ref, { stale: true, staleSince: FieldValue.serverTimestamp() });
        if (stale.length)
          addEvent(tx, cabinetId, dossierId, uid, "offers_stale", { insurers: stale.map(o => o.id), fields: changed });
      }
    }

    if (pricingInsurers?.added.length) {
      addEvent(tx, cabinetId, dossierId, uid, "insurers_added", {
        insurers: pricingInsurers.added,
        questions: addedQuestions.length,
      });
    }

    tx.update(ref, {
      data,
      completeness,
      status: newStatus,
      ...(sectionIndex !== undefined ? { draft: { sectionIndex } } : {}),
      ...(insurerIds !== undefined && !pricing ? { insurerIds: [...new Set(insurerIds as string[])] } : {}),
      ...(pricingInsurers?.added.length
        ? {
            insurerIds: pricingInsurers.insurerIds,
            ...(pricingInsurers.frozen ? { questionnaireSnapshot: schema } : {}),
          }
        : {}),
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
  const dossierId = requireId(request.data?.dossierId, "dossier");
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
    if (dossier.get("deletedAt")) {
      throw new HttpsError("failed-precondition", "Ce dossier est dans la corbeille : restaurez-le pour le modifier.", {
        reason: "dossier_deleted",
      });
    }
    const from = dossier.get("status") as DossierStatus;
    if (target === "besoin_valide") {
      throw new HttpsError("failed-precondition", "La couverture se valide depuis l'étape Couverture du dossier.", {
        reason: "use_validate_need",
      });
    }
    // Proposition et réponse de l'assuré : uniquement par propositions-* (email, `proposal`, `outcome`).
    if (target === "sans_suite") {
      throw new HttpsError("failed-precondition", "Un dossier se classe sans suite avec un motif.", {
        reason: "use_sans_suite",
      });
    }
    if (from === "proposition_envoyee" || ["proposition_envoyee", "souscrit", "refuse"].includes(target)) {
      throw new HttpsError(
        "failed-precondition",
        "La proposition et la réponse de l'assuré se gèrent depuis l'onglet Proposition.",
        {
          reason: "use_proposal",
        },
      );
    }
    if (!isTransitionAllowed(from, target)) {
      throw new HttpsError("failed-precondition", `Transition interdite : « ${from} » vers « ${target} ».`, {
        reason: "invalid_transition",
      });
    }
    // Quitter « couverture validée » vers l'arrière rouvre le questionnaire : celui du produit s'applique de nouveau.
    const reopened = from === "besoin_valide" && target === "complet";
    const schema = await dossierSchema(tx, cabinetId, dossier, { current: reopened });
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
      // Quitter « couverture validée » annule la validation.
      ...(from === "besoin_valide" && dossier.get("needAnalysis") ? { "needAnalysis.validatedAt": null } : {}),
      ...(reopened ? { questionnaireSnapshot: null } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    addEvent(tx, cabinetId, dossierId, uid, "status_changed", { from, to: target });
    return { status: target };
  });
});

/** Assigne ou réassigne un dossier à un membre actif : l'admin à n'importe quel dossier, un courtier à ses propres dossiers. */
export const assigner = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid, role } = await getActiveMembership(request);
  const dossierId = requireId(request.data?.dossierId, "dossier");
  const assignee = requireId(request.data?.uid, "membre");

  const db = admin.firestore();
  const ref = db.doc(dossierPath(cabinetId, dossierId));

  await db.runTransaction(async tx => {
    const [dossier, member] = await Promise.all([tx.get(ref), tx.get(db.doc(memberPath(cabinetId, assignee)))]);
    if (!dossier.exists) {
      throw new HttpsError("not-found", "Dossier introuvable.");
    }
    if (dossier.get("deletedAt")) {
      throw new HttpsError("failed-precondition", "Ce dossier est dans la corbeille : restaurez-le pour le modifier.", {
        reason: "dossier_deleted",
      });
    }
    if (role !== "admin" && dossier.get("assignedTo") !== uid) {
      throw new HttpsError(
        "permission-denied",
        "Seul un administrateur ou le courtier en charge peut réassigner ce dossier.",
      );
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

/**
 * Classe un dossier « sans suite » (statut final), à n'importe quelle étape non finale, avec un motif obligatoire.
 * Écrit `outcome` ({ result: "sans_suite", motif }) ; les tarifications encore en cours sont annulées.
 * Données : { dossierId, motif } → { status: "sans_suite", cancelledJobs }.
 */
export const classerSansSuite = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const dossierId = requireId(request.data?.dossierId, "dossier");
  const motif = requireString(request.data?.motif, "motif", SANS_SUITE_MOTIF_MAX);

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
    if (TERMINAL_DOSSIER_STATUSES.includes(from) || !isTransitionAllowed(from, "sans_suite")) {
      throw new HttpsError("failed-precondition", "Ce dossier est déjà clos.", { reason: "invalid_transition" });
    }
    const jobs = await tx.get(ref.collection("ci_quoteJobs"));
    const active = jobs.docs.filter(job => ACTIVE_QUOTE_JOB_STATUSES.includes(job.get("status") as QuoteJobStatus));
    for (const job of active) tx.update(job.ref, cancelledJobUpdate("sans_suite"));

    tx.update(ref, {
      status: "sans_suite",
      outcome: {
        result: "sans_suite",
        motif,
        contractNumber: null,
        effectiveDate: null,
        decidedBy: uid,
        decidedAt: FieldValue.serverTimestamp(),
      },
      updatedAt: FieldValue.serverTimestamp(),
    });
    addEvent(tx, cabinetId, dossierId, uid, "status_changed", { from, to: "sans_suite" });
    addEvent(tx, cabinetId, dossierId, uid, "outcome_recorded", {
      result: "sans_suite",
      motif,
      cancelledJobs: active.length,
    });
    return { status: "sans_suite" as DossierStatus, cancelledJobs: active.length };
  });
});

export { enregistrerBesoin, validerBesoin } from "./besoin.callable";
export { decider } from "./decision.callable";
