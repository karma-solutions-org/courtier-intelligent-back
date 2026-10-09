import * as admin from "firebase-admin";
import { FieldValue, Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { dossierPath, productPath } from "./firestore-paths";
import type { DossierEventType, Product } from "../shared/index.js";

/** Produit d'un dossier (questionnaire et référentiel des garanties) : la référence pour valider ce qui est enregistré. */
export async function loadProduct(tx: Transaction, productId: string): Promise<Pick<Product, "questionnaireSchema" | "guaranteeCatalog">> {
  const product = await tx.get(admin.firestore().doc(productPath(productId)));
  if (!product.exists || !product.get("questionnaireSchema")) {
    throw new HttpsError("failed-precondition", "Produit introuvable : le catalogue n'est pas publié.");
  }
  return {
    questionnaireSchema: product.get("questionnaireSchema"),
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
  const ref = admin.firestore().collection(`${dossierPath(cabinetId, dossierId)}/events`).doc();
  tx.create(ref, { type, by: uid, at: FieldValue.serverTimestamp(), data: data ?? {} });
}
