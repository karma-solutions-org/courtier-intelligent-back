import * as admin from "firebase-admin";
import { FieldValue, Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { cabinetPath, dossierPath } from "./firestore-paths";
import { productDocPath, schemaForCabinet, type DossierEventType, type Product } from "../shared/index.js";

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
    tx.get(admin.firestore().doc(productDocPath(cabinetId, productId))),
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
