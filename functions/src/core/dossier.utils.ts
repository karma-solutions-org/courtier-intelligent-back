import * as admin from "firebase-admin";
import { FieldValue, Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { cabinetPath, dossierPath, insurerPath, insurersPath, productPath } from "./firestore-paths";
import {
  DISCOVERED_SECTION_TITLE,
  questionsOf,
  schemaForCabinet,
  schemaWithComplements,
  type DossierEventType,
  type Product,
  type QuestionnaireSection,
} from "../shared/index.js";

/**
 * Produit d'un dossier (questionnaire et référentiel des garanties) : la référence pour valider ce qui est enregistré.
 * Le questionnaire est celui des extranets choisis pour le dossier (`insurerIds`), à défaut ceux du cabinet : même
 * règle que l'app (schemaWithComplements). Les questions découvertes chez un autre assureur ne sont donc jamais exigées.
 * Avec un catalogue à socle (`core`), les compléments qu'aucun extranet choisi ne demande sont dans une dernière section
 * `optional` : jamais obligatoires (complétude), mais toujours acceptés à l'enregistrement (questionFor) et envoyés à
 * l'extension (`productPaths`, `quoteData`).
 */
export async function loadProduct(
  tx: Transaction,
  cabinetId: string,
  productId: string,
  insurerIds: readonly string[] = [],
): Promise<Pick<Product, "questionnaireSchema" | "guaranteeCatalog">> {
  const [product, cabinet] = await Promise.all([
    tx.get(admin.firestore().doc(productPath(productId))),
    tx.get(admin.firestore().doc(cabinetPath(cabinetId))),
  ]);
  if (!product.exists || !product.get("questionnaireSchema")) {
    throw new HttpsError("failed-precondition", "Produit introuvable : le catalogue n'est pas publié.");
  }
  const schema = product.get("questionnaireSchema") as QuestionnaireSection[];
  const enabled = (cabinet.get("enabledInsurers") as string[] | undefined) ?? [];
  const selected = insurerIds.length ? [...insurerIds] : enabled;
  // Comme l'app (with-dossier-derived) : à défaut d'extranets choisis ou activés, tous ceux qui proposent le produit.
  // Sinon le serveur exigerait des compléments que l'app range dans la section facultative.
  const docs = selected.length
    ? await tx.getAll(...selected.slice(0, 50).map(id => admin.firestore().doc(insurerPath(id))))
    : (
        await tx.get(
          admin.firestore().collection(insurersPath()).where("productsSupported", "array-contains", productId),
        )
      ).docs;
  const insurers = docs
    .filter(doc => doc.exists && ((doc.get("productsSupported") as string[] | undefined) ?? []).includes(productId))
    .map(doc => ({ id: doc.id, questions: doc.get("questions") as Record<string, string[]> | undefined }));
  // Questions apprises des parcours (champs-constater) : sans elles, le serveur exigerait ce que l'app ne pose pas.
  const learned = (product.get("insurerQuestions") as Record<string, string[]> | undefined) ?? {};
  // Catalogue sans socle (`core`) et aucun extranet : tout le questionnaire, comme avant.
  const questionnaireSchema = insurers.length
    ? schemaWithComplements(schema, insurers, productId, learned)
    : schema.some(section => section.questions.some(question => question.core))
      ? schemaWithComplements(schema, [], productId, learned)
      : schemaForCabinet(schema, selected);
  return { questionnaireSchema, guaranteeCatalog: product.get("guaranteeCatalog") ?? [] };
}

/** Ajoute un événement à l'historique du dossier (écrit uniquement par les functions). */
export function addEvent(
  tx: Transaction,
  cabinetId: string,
  dossierId: string,
  uid: string,
  type: DossierEventType,
  data?: Record<string, unknown>,
): void {
  const ref = admin
    .firestore()
    .collection(`${dossierPath(cabinetId, dossierId)}/ci_events`)
    .doc();
  tx.create(ref, { type, by: uid, at: FieldValue.serverTimestamp(), data: data ?? {} });
}

/**
 * Questions découvertes sur les extranets du dossier APRÈS que son questionnaire a été figé : ajoutées, facultatives
 * (elles ne bloquent aucune étape du dossier ; l'extension les demande elle-même quand l'extranet les exige), pour que
 * le courtier puisse y répondre et que la réponse parte à l'extension.
 */
export function withLateDiscoveredQuestions(
  snapshot: QuestionnaireSection[],
  current: QuestionnaireSection[],
  insurerIds: readonly string[],
): QuestionnaireSection[] {
  const known = new Set(questionsOf(snapshot).map(question => question.canonicalPath));
  const late = current
    .filter(section => section.discovered)
    .flatMap(section => section.questions)
    .filter(question => !known.has(question.canonicalPath))
    .filter(
      question =>
        !insurerIds.length ||
        !question.discoveredOn?.length ||
        question.discoveredOn.some(source => source.insurerId === null || insurerIds.includes(source.insurerId)),
    )
    .map(question => ({ ...question, required: false, mustBeKnown: false }));
  if (!late.length) return snapshot;
  const index = snapshot.findIndex(section => section.discovered);
  if (index < 0) {
    // Jamais dans la section facultative (compléments du catalogue, toujours en dernier) : la section des questions
    // découvertes se place juste avant elle. Ancien instantané sans section facultative : à la fin, comme avant.
    const section = { title: DISCOVERED_SECTION_TITLE, questions: late, discovered: true };
    const optional = snapshot.findIndex(s => s.optional);
    return optional < 0
      ? [...snapshot, section]
      : [...snapshot.slice(0, optional), section, ...snapshot.slice(optional)];
  }
  return snapshot.map((section, i) =>
    i === index ? { ...section, questions: [...section.questions, ...late] } : section,
  );
}

/**
 * Questionnaire de référence d'un dossier : celui figé à la validation de la couverture (`questionnaireSnapshot`)
 * s'il existe, sinon celui du produit. Une modification du produit ne bloque donc pas un dossier déjà validé ; seules
 * s'y ajoutent les questions découvertes depuis sur ses extranets (withLateDiscoveredQuestions).
 */
export async function dossierSchema(
  tx: Transaction,
  cabinetId: string,
  dossier: admin.firestore.DocumentSnapshot,
  { current = false, insurerIds: chosen }: { current?: boolean; insurerIds?: readonly string[] } = {},
): Promise<QuestionnaireSection[]> {
  const snapshot = dossier.get("questionnaireSnapshot") as QuestionnaireSection[] | null | undefined;
  // `insurerIds` : extranets en cours de modification (sinon ceux enregistrés sur le dossier).
  const insurerIds = chosen ?? (dossier.get("insurerIds") as string[] | undefined) ?? [];
  const product = (await loadProduct(tx, cabinetId, dossier.get("productId"), insurerIds)).questionnaireSchema;
  if (!current && Array.isArray(snapshot) && snapshot.length) {
    return withLateDiscoveredQuestions(snapshot, product, insurerIds);
  }
  return product;
}

/** Champs d'un job annulé : l'extension s'arrête (statut terminal), la relance reste possible. */
export const cancelledJobUpdate = (reason: string) => ({
  status: "cancelled",
  error: reason,
  missingFields: [],
  updatedAt: FieldValue.serverTimestamp(),
});
