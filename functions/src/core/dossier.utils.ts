import * as admin from "firebase-admin";
import { FieldValue, Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { cabinetPath, dossierPath, productPath } from "./firestore-paths";
import { schemaForCabinet, type DossierEventType, type Product, type QuestionnaireSection } from "../shared/index.js";

/**
 * Produit d'un dossier (questionnaire et référentiel des garanties) : la référence pour valider ce qui est enregistré.
 * Le questionnaire est celui vu par le cabinet (sans les questions des assureurs qu'il n'utilise pas).
 */
export async function loadProduct(
  tx: Transaction,
  cabinetId: string,
  productId: string,
): Promise<Pick<Product, "questionnaireSchema" | "guaranteeCatalog">> {
  const [product, cabinet] = await Promise.all([
    tx.get(admin.firestore().doc(productPath(productId))),
    tx.get(admin.firestore().doc(cabinetPath(cabinetId))),
  ]);
  if (!product.exists || !product.get("questionnaireSchema")) {
    throw new HttpsError("failed-precondition", "Produit introuvable : le catalogue n'est pas publié.");
  }
  return {
    questionnaireSchema: schemaForCabinet(product.get("questionnaireSchema"), cabinet.get("enabledInsurers") ?? []),
    guaranteeCatalog: product.get("guaranteeCatalog") ?? [],
  };
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
  const ref = admin.firestore().collection(`${dossierPath(cabinetId, dossierId)}/ci_events`).doc();
  tx.create(ref, { type, by: uid, at: FieldValue.serverTimestamp(), data: data ?? {} });
}

/**
 * Questionnaire de référence d'un dossier : celui figé à la validation de la couverture (`questionnaireSnapshot`)
 * s'il existe, sinon celui du produit. Une modification du produit ne bloque donc pas un dossier déjà validé.
 */
export async function dossierSchema(
  tx: Transaction,
  cabinetId: string,
  dossier: admin.firestore.DocumentSnapshot,
  { current = false }: { current?: boolean } = {},
): Promise<QuestionnaireSection[]> {
  const snapshot = dossier.get("questionnaireSnapshot") as QuestionnaireSection[] | null | undefined;
  if (!current && Array.isArray(snapshot) && snapshot.length) return snapshot;
  return (await loadProduct(tx, cabinetId, dossier.get("productId"))).questionnaireSchema;
}

/** Champs d'un job annulé : l'extension s'arrête (statut terminal), la relance reste possible. */
export const cancelledJobUpdate = (reason: string) => ({
  status: "cancelled",
  error: reason,
  missingFields: [],
  updatedAt: FieldValue.serverTimestamp(),
});
