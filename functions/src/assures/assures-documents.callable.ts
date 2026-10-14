import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership, requireString } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { assurePath } from "../core/firestore-paths";
import { GEMINI_API_KEY, geminiApiKey, generateWithGemini, reserveIaCall } from "../core/gemini.utils";
import {
  ASSURE_DOCUMENT_MAX_BYTES,
  ASSURE_DOCUMENT_MIME_TYPES,
  assureDocumentsFolder,
  buildAssureOcrPrompt,
  isAssureDocumentType,
  isAssureImportPath,
  parseAssureOcrResponse,
  type AssureOcrValues,
} from "../shared/index.js";

const MAX_OCR_OUTPUT_TOKENS = 800;

/** Relit le fichier déposé (existence, type, taille) : l'app ne peut pas faire passer autre chose. */
async function checkedImport(storagePath: string) {
  const file = admin.storage().bucket().file(storagePath);
  const [exists] = await file.exists();
  if (!exists) {
    throw new HttpsError("failed-precondition", "Le fichier n'a pas été reçu. Réessayez l'envoi.", { reason: "file_missing" });
  }
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size ?? 0);
  const contentType = metadata.contentType ?? "";
  if (!ASSURE_DOCUMENT_MIME_TYPES.includes(contentType) || size <= 0 || size > ASSURE_DOCUMENT_MAX_BYTES) {
    throw new HttpsError("invalid-argument", "Document refusé : PDF, JPG ou PNG de 10 Mo maximum.");
  }
  return { file, size, contentType };
}

/**
 * Lecture d'une pièce (CIN, Kbis) déposée avant la création du client : renvoie les valeurs lues pour pré-remplir
 * le formulaire. Rien n'est écrit : le courtier vérifie, puis la pièce est rangée avec le client par `rattacherPiece`.
 * Compte dans le quota d'appels d'IA du cabinet.
 */
export const lirePiece = onCall({ ...CALLABLE_OPTIONS, secrets: [GEMINI_API_KEY], timeoutSeconds: 90, memory: "512MiB" }, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const type = request.data?.type;
  const storagePath = request.data?.storagePath;
  if (!isAssureDocumentType(type)) {
    throw new HttpsError("invalid-argument", "Type de pièce invalide.");
  }
  if (!isAssureImportPath(storagePath, cabinetId, uid)) {
    throw new HttpsError("invalid-argument", "Emplacement du document invalide.");
  }
  const { file, contentType } = await checkedImport(storagePath);
  const apiKey = geminiApiKey();
  const [bytes] = await file.download();

  const { remaining, release } = await reserveIaCall(cabinetId);
  const result = await generateWithGemini(apiKey, {
    contents: [
      { role: "user", parts: [{ inlineData: { mimeType: contentType, data: bytes.toString("base64") } }, { text: buildAssureOcrPrompt(type) }] },
    ],
    generationConfig: { maxOutputTokens: MAX_OCR_OUTPUT_TOKENS, responseMimeType: "application/json", temperature: 0 },
  });
  if (!result) {
    await release();
    throw new HttpsError("unavailable", "Le service d'IA est momentanément indisponible. Réessayez.", { reason: "ia_upstream" });
  }
  const values = parseAssureOcrResponse(result.text, type);
  return { values: values ?? {}, readable: values !== null, remaining };
});

/**
 * Range une pièce déposée avec le client qui vient d'être créé : le fichier quitte le dépôt provisoire du courtier
 * pour cabinets/{c}/assures/{a}/documents/, et l'entrée `assures/{a}/documents/{id}` est écrite (valeurs lues comprises).
 */
export const rattacherPiece = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await getActiveMembership(request);
  const assureId = requireString(request.data?.assureId, "client");
  const type = request.data?.type;
  const storagePath = request.data?.storagePath;
  if (!isAssureDocumentType(type)) {
    throw new HttpsError("invalid-argument", "Type de pièce invalide.");
  }
  if (!isAssureImportPath(storagePath, cabinetId, uid)) {
    throw new HttpsError("invalid-argument", "Emplacement du document invalide.");
  }
  const fileName = typeof request.data?.fileName === "string" ? request.data.fileName.slice(0, 200) : null;
  const values = sanitizeValues(request.data?.values);

  const db = admin.firestore();
  const assureRef = db.doc(assurePath(cabinetId, assureId));
  if (!(await assureRef.get()).exists) {
    throw new HttpsError("not-found", "Client introuvable.");
  }
  const { file, size, contentType } = await checkedImport(storagePath);

  const documentRef = assureRef.collection("ci_documents").doc();
  const name = storagePath.slice(storagePath.lastIndexOf("/") + 1);
  const target = `${assureDocumentsFolder(cabinetId, assureId)}/${documentRef.id}-${name}`.slice(0, 900);
  await file.move(target);
  await documentRef.create({
    type,
    storagePath: target,
    fileName,
    contentType,
    size,
    values,
    uploadedBy: uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { documentId: documentRef.id };
});

/** Les valeurs reçues de l'app ne gardent que des champs texte connus, bornés (simple trace, la fiche fait foi). */
function sanitizeValues(raw: unknown): AssureOcrValues {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const keys: (keyof AssureOcrValues)[] = ["civilite", "firstName", "lastName", "birthDate", "companyName", "siret", "street", "postalCode", "city"];
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) values[key] = value.trim().slice(0, 200);
  }
  return values as AssureOcrValues;
}

