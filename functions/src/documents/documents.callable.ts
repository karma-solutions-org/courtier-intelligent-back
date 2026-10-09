import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership, requireString } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { documentsPath, dossierPath, productPath } from "../core/firestore-paths";
import { GEMINI_API_KEY, geminiApiKey, generateWithGemini, reserveIaCall } from "../core/gemini.utils";
import {
  buildOcrPrompt,
  DOSSIER_DOCUMENT_MAX_BYTES,
  DOSSIER_DOCUMENT_MIME_TYPES,
  isAnalyzableDocumentType,
  isDossierDocumentPath,
  isDossierDocumentType,
  ocrQuestions,
  parseOcrResponse,
  type DossierDocumentType,
  type QuestionnaireSection,
} from "../shared/index.js";

const MAX_OCR_OUTPUT_TOKENS = 2_000;

/**
 * Enregistre un document envoyé dans Storage par l'app (E12-1) : carte grise, permis, relevé d'information ou autre.
 * Le fichier est relu côté serveur (emplacement, type, taille) : l'app ne peut pas forger l'entrée `documents/{id}`.
 */
export const enregistrer = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const dossierId = requireString(request.data?.dossierId, "dossier");
  const type = request.data?.type;
  const storagePath = request.data?.storagePath;
  if (!isDossierDocumentType(type)) {
    throw new HttpsError("invalid-argument", "Type de document invalide.");
  }
  if (!isDossierDocumentPath(storagePath, cabinetId, dossierId)) {
    throw new HttpsError("invalid-argument", "Emplacement du document invalide.");
  }
  const fileName = typeof request.data?.fileName === "string" ? request.data.fileName.slice(0, 200) : null;

  const db = admin.firestore();
  const dossier = await db.doc(dossierPath(cabinetId, dossierId)).get();
  if (!dossier.exists) {
    throw new HttpsError("not-found", "Dossier introuvable.");
  }

  const [exists] = await admin.storage().bucket().file(storagePath).exists();
  if (!exists) {
    throw new HttpsError("failed-precondition", "Le fichier n'a pas été reçu. Réessayez l'envoi.", { reason: "file_missing" });
  }
  const [metadata] = await admin.storage().bucket().file(storagePath).getMetadata();
  const size = Number(metadata.size ?? 0);
  const contentType = metadata.contentType ?? "";
  if (!DOSSIER_DOCUMENT_MIME_TYPES.includes(contentType) || size <= 0 || size > DOSSIER_DOCUMENT_MAX_BYTES) {
    throw new HttpsError("invalid-argument", "Document refusé : PDF, JPG ou PNG de 10 Mo maximum.");
  }

  // Un même fichier n'est enregistré qu'une fois.
  const already = await db.collection(documentsPath(cabinetId, dossierId)).where("storagePath", "==", storagePath).limit(1).get();
  if (!already.empty) {
    return { documentId: already.docs[0].id };
  }

  const documentRef = db.collection(documentsPath(cabinetId, dossierId)).doc();
  await documentRef.create({
    type,
    storagePath,
    fileName,
    contentType,
    size,
    ocrFields: [],
    status: "uploaded",
    error: null,
    uploadedBy: uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { documentId: documentRef.id };
});

/**
 * Lecture automatique d'un document (E12-2) : le fichier est lu dans Storage et envoyé à l'IA, qui ne peut proposer que
 * des champs du questionnaire du produit lisibles sur ce type de document (véhicule pour une carte grise, conducteur pour
 * un permis, historique pour un relevé). La réponse est contrôlée (`parseOcrResponse`) puis rangée dans `ocrFields` :
 * rien n'est écrit dans le dossier, le courtier choisit ce qu'il applique. Compte dans le quota d'appels d'IA du cabinet.
 */
export const analyser = onCall({ ...CALLABLE_OPTIONS, secrets: [GEMINI_API_KEY], timeoutSeconds: 90, memory: "512MiB" }, async request => {
  const { cabinetId } = await getActiveMembership(request);
  const dossierId = requireString(request.data?.dossierId, "dossier");
  const documentId = requireString(request.data?.documentId, "document");

  const db = admin.firestore();
  const documentRef = db.doc(`${documentsPath(cabinetId, dossierId)}/${documentId}`);
  const [document, dossier] = await Promise.all([documentRef.get(), db.doc(dossierPath(cabinetId, dossierId)).get()]);
  if (!document.exists || !dossier.exists) {
    throw new HttpsError("not-found", "Document introuvable.");
  }
  const type = document.get("type") as DossierDocumentType;
  if (!isAnalyzableDocumentType(type)) {
    throw new HttpsError("failed-precondition", "Ce type de document n'est pas lu automatiquement.", { reason: "not_analyzable" });
  }
  const storagePath = document.get("storagePath") as string;
  if (!isDossierDocumentPath(storagePath, cabinetId, dossierId)) {
    throw new HttpsError("failed-precondition", "Emplacement du document invalide.");
  }

  const product = await db.doc(productPath(dossier.get("productId") as string)).get();
  const schema = (product.get("questionnaireSchema") as QuestionnaireSection[] | undefined) ?? [];
  const questions = ocrQuestions(schema, type);
  if (!questions.length) {
    throw new HttpsError("failed-precondition", "Le questionnaire de ce produit n'a aucun champ lisible sur ce document.", { reason: "no_fields" });
  }

  const apiKey = geminiApiKey();
  const file = admin.storage().bucket().file(storagePath);
  const [metadata] = await file.getMetadata();
  const mimeType = metadata.contentType ?? "";
  if (!DOSSIER_DOCUMENT_MIME_TYPES.includes(mimeType) || Number(metadata.size ?? 0) > DOSSIER_DOCUMENT_MAX_BYTES) {
    throw new HttpsError("failed-precondition", "Document illisible : PDF, JPG ou PNG de 10 Mo maximum.");
  }
  const [bytes] = await file.download();

  const fail = async (reason: string) => {
    await documentRef.update({ status: "failed", error: reason, analyzedAt: FieldValue.serverTimestamp() });
  };

  const { remaining, release } = await reserveIaCall(cabinetId).catch(async (error: unknown) => {
    if (error instanceof HttpsError && error.code === "resource-exhausted") await fail("ia_quota");
    throw error;
  });
  const result = await generateWithGemini(apiKey, {
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType, data: bytes.toString("base64") } }, { text: buildOcrPrompt(type, questions) }],
      },
    ],
    generationConfig: { maxOutputTokens: MAX_OCR_OUTPUT_TOKENS, responseMimeType: "application/json", temperature: 0 },
  });
  if (!result) {
    // Aucun modèle n'a répondu : l'appel réservé est rendu.
    await release();
    await fail("ia_upstream");
    throw new HttpsError("unavailable", "Le service d'IA est momentanément indisponible. Réessayez.", { reason: "ia_upstream" });
  }

  const fields = parseOcrResponse(result.text, type, schema);
  if (fields === null) {
    await fail("ia_unusable");
    return { status: "failed", ocrFields: [], remaining };
  }
  await documentRef.update({ status: "analyzed", ocrFields: fields, error: null, analyzedAt: FieldValue.serverTimestamp() });
  return { status: "analyzed", ocrFields: fields, remaining };
});
