import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership, requireEmail, requireString } from "../core/auth.utils";
import { CALLABLE_OPTIONS, MAIL_COLLECTION } from "../core/config";
import { addEvent } from "../core/dossier.utils";
import { assurePath, cabinetPath, dossierPath, insurerPath, offerPath } from "../core/firestore-paths";
import {
  isTransitionAllowed,
  PROPOSAL_MESSAGE_MAX,
  validateContractNumber,
  validateEffectiveDate,
  type DossierOutcomeResult,
  type DossierStatus,
} from "../shared/index.js";
import { assureDisplayName, buildProposalEmail } from "./proposition.utils";

const OUTCOME_RESULTS: DossierOutcomeResult[] = ["souscrit", "refuse", "sans_suite"];

/**
 * Envoi de la proposition à l'assuré (Epic E14) : email (offre retenue, garanties, justification, mentions du cabinet)
 * écrit dans la collection lue par Trigger Email, `proposal` renseigné et dossier passé en « Proposition envoyée ».
 * Déjà envoyée : renvoi (date d'envoi et destinataire mis à jour, nouvel événement).
 */
export const envoyer = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const dossierId = requireString(request.data?.dossierId, "dossier");
  const requestedTo = request.data?.to ? requireEmail(request.data.to) : null;
  const message =
    typeof request.data?.message === "string" ? request.data.message.trim().substring(0, PROPOSAL_MESSAGE_MAX) : "";

  const db = admin.firestore();
  const ref = db.doc(dossierPath(cabinetId, dossierId));

  return db.runTransaction(async tx => {
    const dossier = await tx.get(ref);
    if (!dossier.exists) {
      throw new HttpsError("not-found", "Dossier introuvable.");
    }
    const from = dossier.get("status") as DossierStatus;
    const decision = dossier.get("decision") as { insurerId: string; justification: string } | null;
    if (from !== "decision" && from !== "proposition_envoyee") {
      throw new HttpsError("failed-precondition", "La proposition s'envoie une fois l'offre retenue (statut « Décision »).", {
        reason: "invalid_transition",
      });
    }
    if (!decision?.insurerId) {
      throw new HttpsError("failed-precondition", "Aucune offre retenue pour ce dossier.", { reason: "no_decision" });
    }
    const [cabinet, assure, offer, insurer] = await Promise.all([
      tx.get(db.doc(cabinetPath(cabinetId))),
      tx.get(db.doc(assurePath(cabinetId, dossier.get("assureId")))),
      tx.get(db.doc(offerPath(cabinetId, dossierId, decision.insurerId))),
      tx.get(db.doc(insurerPath(decision.insurerId))),
    ]);
    if (!offer.exists) {
      throw new HttpsError("failed-precondition", "L'offre retenue est introuvable.");
    }
    const to = requestedTo ?? (assure.get("email") ? requireEmail(assure.get("email")) : null);
    if (!to) {
      throw new HttpsError("invalid-argument", "L'assuré n'a pas d'adresse email : indiquez le destinataire.", {
        reason: "no_recipient",
      });
    }
    if (from === "decision" && !isTransitionAllowed(from, "proposition_envoyee")) {
      throw new HttpsError("failed-precondition", `Transition interdite : « ${from} » vers « proposition_envoyee ».`, {
        reason: "invalid_transition",
      });
    }

    const email = buildProposalEmail({
      cabinet: {
        name: cabinet.get("name") ?? "",
        orias: cabinet.get("orias") ?? null,
        address: cabinet.get("address") ?? null,
        phone: cabinet.get("phone") ?? null,
        email: cabinet.get("email") ?? null,
      },
      assureName: assureDisplayName(assure.data() as never),
      insurerName: insurer.get("name") ?? decision.insurerId,
      reference: dossier.get("reference") ?? null,
      premiumAnnual: offer.get("premiumAnnual") ?? null,
      premiumMonthly: offer.get("premiumMonthly") ?? null,
      deductibles: offer.get("deductibles") ?? {},
      guarantees: offer.get("guarantees") ?? [],
      justification: decision.justification,
      message,
    });
    const replyTo = cabinet.get("email") as string | undefined;
    tx.create(db.collection(MAIL_COLLECTION).doc(), { to, ...(replyTo ? { replyTo } : {}), message: email });

    const resend = from === "proposition_envoyee";
    tx.update(ref, {
      status: "proposition_envoyee",
      proposal: resend
        ? {
            ...dossier.get("proposal"),
            sentAt: FieldValue.serverTimestamp(),
            sentTo: to,
            sentBy: uid,
          }
        : { sentAt: FieldValue.serverTimestamp(), sentTo: to, sentBy: uid, reminders: 0, lastReminderAt: null },
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (!resend) {
      addEvent(tx, cabinetId, dossierId, uid, "status_changed", { from, to: "proposition_envoyee" });
    }
    addEvent(tx, cabinetId, dossierId, uid, "proposal_sent", { to, insurerId: decision.insurerId, resend });
    return { status: "proposition_envoyee" as DossierStatus };
  });
});

/**
 * Réponse de l'assuré à la proposition : souscrit (numéro de contrat et date d'effet obligatoires), refusé ou sans suite.
 * Écrit `outcome` et passe le dossier dans le statut final correspondant.
 */
export const enregistrerReponse = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const dossierId = requireString(request.data?.dossierId, "dossier");
  const result = request.data?.result as DossierOutcomeResult;
  if (!OUTCOME_RESULTS.includes(result)) {
    throw new HttpsError("invalid-argument", "Réponse invalide.");
  }
  let contractNumber: string | null = null;
  let effectiveDate: string | null = null;
  if (result === "souscrit") {
    const problem = validateContractNumber(request.data?.contractNumber) ?? validateEffectiveDate(request.data?.effectiveDate);
    if (problem) {
      throw new HttpsError("invalid-argument", problem);
    }
    contractNumber = (request.data.contractNumber as string).trim();
    effectiveDate = (request.data.effectiveDate as string).trim();
  }

  const db = admin.firestore();
  const ref = db.doc(dossierPath(cabinetId, dossierId));

  return db.runTransaction(async tx => {
    const dossier = await tx.get(ref);
    if (!dossier.exists) {
      throw new HttpsError("not-found", "Dossier introuvable.");
    }
    const from = dossier.get("status") as DossierStatus;
    if (from !== "proposition_envoyee" || !isTransitionAllowed(from, result)) {
      throw new HttpsError("failed-precondition", "La réponse s'enregistre une fois la proposition envoyée.", {
        reason: "invalid_transition",
      });
    }
    tx.update(ref, {
      status: result,
      outcome: { result, contractNumber, effectiveDate, decidedBy: uid, decidedAt: FieldValue.serverTimestamp() },
      updatedAt: FieldValue.serverTimestamp(),
    });
    addEvent(tx, cabinetId, dossierId, uid, "status_changed", { from, to: result });
    addEvent(tx, cabinetId, dossierId, uid, "outcome_recorded", { result, contractNumber, effectiveDate });
    return { status: result };
  });
});
