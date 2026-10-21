import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership, requireString } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { assurePath, documentsPath, dossierPath } from "../core/firestore-paths";
import { GEMINI_API_KEY, geminiApiKey, generateWithGemini, runIaCall } from "../core/gemini.utils";
import {
  buildDetectOcrPrompt,
  buildOcrPrompt,
  DOSSIER_DOCUMENT_TYPES,
  parseDetectedType,
  type Question,
  dossierDocumentsFolder,
  dossierTypeForAssureDocument,
  isAssureDocumentType,
  DOSSIER_DOCUMENT_MAX_BYTES,
  DOSSIER_DOCUMENT_MIME_TYPES,
  isAnalyzableDocumentType,
  isDossierDocumentPath,
  isDossierDocumentType,
  ocrQuestions,
  parseOcrResponse,
  type DossierDocumentType,
  type QuestionnaireSection,
  productDocPath,
  safeDocumentFileName,
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
  if (dossier.get("deletedAt")) {
    throw new HttpsError("failed-precondition", "Ce dossier est dans la corbeille : restaurez-le pour le modifier.", {
      reason: "dossier_deleted",
    });
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
  // `detectType` : le courtier n'a pas choisi le type, l'IA le reconnaît puis lit les champs de ce type (même appel).
  const detectType = request.data?.detectType === true;
  const type = document.get("type") as DossierDocumentType;
  if (!detectType && !isAnalyzableDocumentType(type)) {
    throw new HttpsError("failed-precondition", "Ce type de document n'est pas lu automatiquement.", { reason: "not_analyzable" });
  }
  const storagePath = document.get("storagePath") as string;
  if (!isDossierDocumentPath(storagePath, cabinetId, dossierId)) {
    throw new HttpsError("failed-precondition", "Emplacement du document invalide.");
  }

  const product = await db.doc(productDocPath(cabinetId, dossier.get("productId") as string)).get();
  const schema = (product.get("questionnaireSchema") as QuestionnaireSection[] | undefined) ?? [];
  const questionsByType: Partial<Record<DossierDocumentType, Question[]>> = {};
  for (const candidate of DOSSIER_DOCUMENT_TYPES) {
    const list = isAnalyzableDocumentType(candidate) ? ocrQuestions(schema, candidate) : [];
    if (list.length) questionsByType[candidate] = list;
  }
  const questions = detectType ? Object.values(questionsByType).flat() : ocrQuestions(schema, type);
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
  const fail = async (reason: string) => {
    await documentRef.update({ status: "failed", error: reason, analyzedAt: FieldValue.serverTimestamp() });
  };

  // Le quota est réservé avant le téléchargement : un cabinet hors quota ne télécharge rien.
  const { result, remaining } = await runIaCall(cabinetId, async () => {
    const [bytes] = await file.download();
    return generateWithGemini(apiKey, {
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: bytes.toString("base64") } },
            { text: detectType ? buildDetectOcrPrompt(questionsByType) : buildOcrPrompt(type, questions) },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: MAX_OCR_OUTPUT_TOKENS, responseMimeType: "application/json", temperature: 0 },
    });
  }).catch(async (error: unknown) => {
    if (error instanceof HttpsError && error.code === "resource-exhausted") await fail("ia_quota");
    throw error;
  });
  if (!result) {
    // Aucun modèle n'a répondu : l'appel réservé a été rendu.
    await fail("ia_upstream");
    throw new HttpsError("unavailable", "Le service d'IA est momentanément indisponible. Réessayez.", { reason: "ia_upstream" });
  }

  const finalType = detectType ? parseDetectedType(result.text) : type;
  const fields = finalType ? parseOcrResponse(result.text, finalType, schema) : null;
  if (!finalType || fields === null) {
    await fail("ia_unusable");
    return { status: "failed", ocrFields: [], remaining };
  }
  await documentRef.update({
    type: finalType,
    status: "analyzed",
    ocrFields: fields,
    error: null,
    analyzedAt: FieldValue.serverTimestamp(),
  });
  return { status: "analyzed", ocrFields: fields, documentType: finalType, remaining };
});

/**
 * Reprend dans le dossier les pièces rangées avec son client (carte grise, permis, CIN, relevé d'information importés à
 * la création du client) : chaque fichier est copié dans les documents du dossier et une entrée `documents/{id}` est
 * écrite, prête à être lue (`analyser`). Une pièce déjà reprise ne l'est pas deux fois (`sourceAssureDocumentId`) : l'app
 * peut appeler cette fonction à chaque ouverture du dossier. Renvoie seulement les documents créés par cet appel.
 */
export const reprendrePiecesClient = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const dossierId = requireString(request.data?.dossierId, "dossier");

  const db = admin.firestore();
  const dossier = await db.doc(dossierPath(cabinetId, dossierId)).get();
  if (!dossier.exists) {
    throw new HttpsError("not-found", "Dossier introuvable.");
  }
  if (dossier.get("deletedAt")) {
    throw new HttpsError("failed-precondition", "Ce dossier est dans la corbeille : restaurez-le pour le modifier.", {
      reason: "dossier_deleted",
    });
  }
  const assureId = dossier.get("assureId") as string | undefined;
  if (!assureId) return { documents: [] };

  const [pieces, existing] = await Promise.all([
    db.collection(`${assurePath(cabinetId, assureId)}/ci_documents`).get(),
    db.collection(documentsPath(cabinetId, dossierId)).where("sourceAssureDocumentId", "!=", null).get(),
  ]);
  const alreadyTaken = new Set(existing.docs.map(doc => doc.get("sourceAssureDocumentId") as string));
  const bucket = admin.storage().bucket();
  const created: { documentId: string; type: DossierDocumentType }[] = [];

  for (const piece of pieces.docs) {
    const assureType = piece.get("type");
    if (alreadyTaken.has(piece.id) || !isAssureDocumentType(assureType)) continue;
    const type = dossierTypeForAssureDocument(assureType);
    const source = piece.get("storagePath") as string | undefined;
    if (!type || !source) continue;
    const fileName = (piece.get("fileName") as string | null) ?? null;
    const target = `${dossierDocumentsFolder(cabinetId, dossierId)}/${type}-${Date.now()}-${safeDocumentFileName(fileName ?? source.slice(source.lastIndexOf("/") + 1))}`;
    if (!isDossierDocumentPath(target, cabinetId, dossierId)) continue;
    const [exists] = await bucket.file(source).exists();
    if (!exists) continue;

    // Identifiant tiré de la pièce : si deux appels arrivent en même temps, le second `create` échoue et la pièce
    // n'est pas reprise deux fois. Le fichier n'est copié qu'une fois l'entrée réservée.
    const documentRef = db.collection(documentsPath(cabinetId, dossierId)).doc(`client-${piece.id}`);
    const reserved = await documentRef
      .create({
        type,
        storagePath: target,
        fileName,
        contentType: piece.get("contentType") ?? null,
        size: piece.get("size") ?? null,
        ocrFields: [],
        status: "uploaded",
        error: null,
        sourceAssureDocumentId: piece.id,
        uploadedBy: uid,
        createdAt: FieldValue.serverTimestamp(),
      })
      .then(() => true)
      .catch((error: { code?: number }) => {
        if (error.code === 6) return false; // ALREADY_EXISTS : déjà reprise par un appel concurrent
        throw error;
      });
    if (!reserved) continue;
    try {
      await bucket.file(source).copy(bucket.file(target));
    } catch (error) {
      await documentRef.delete();
      throw error;
    }
    created.push({ documentId: documentRef.id, type });
  }
  return { documents: created };
});
