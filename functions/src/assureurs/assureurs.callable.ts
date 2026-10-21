import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertCabinetAdmin, requireId } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { cabinetPath } from "../core/firestore-paths";
import {
  CABINET_INSURER_NAME_MAX,
  CABINET_INSURER_PREFIX,
  CABINET_INSURERS_MAX,
  insurerDocPath,
  isCabinetInsurerId,
  parseExtranetUrl,
  productDocPath,
} from "../shared/index.js";

/**
 * Assureurs propres à un cabinet (admin) : ajoutés en plus du catalogue global, visibles de ce cabinet seulement.
 * Écrits uniquement ici : nom, adresse de l'extranet (son domaine sert à l'extension) et produits tarifés,
 * parmi les produits actifs du catalogue. Un assureur retiré est archivé, pas effacé : l'historique des dossiers le garde.
 * Un assureur du catalogue global modifié ou retiré est remplacé pour ce cabinet par une fiche du cabinet (`replaces`).
 */

const insurersCollection = (cabinetId: string) => admin.firestore().collection(`${cabinetPath(cabinetId)}/ci_insurers`);

function requireName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > CABINET_INSURER_NAME_MAX) {
    throw new HttpsError("invalid-argument", `Le nom de l'assureur doit faire entre 2 et ${CABINET_INSURER_NAME_MAX} caractères.`);
  }
  return name;
}

function requireExtranet(value: unknown): { url: string; domain: string } {
  const parsed = typeof value === "string" ? parseExtranetUrl(value) : null;
  if (!parsed) {
    throw new HttpsError("invalid-argument", "Adresse de l'extranet invalide : une adresse https:// est attendue.");
  }
  return parsed;
}

/** Produits tarifés : au moins un, parmi les produits actifs du catalogue et ceux du cabinet. */
async function requireProducts(cabinetId: string, value: unknown): Promise<string[]> {
  const ids = Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))].slice(0, 20) : [];
  if (!ids.length) {
    throw new HttpsError("invalid-argument", "Choisissez au moins un produit tarifé par cet assureur.");
  }
  const products = await Promise.all(ids.map(id => admin.firestore().doc(productDocPath(cabinetId, id)).get()));
  if (products.some(product => !product.exists || product.get("active") === false || product.get("archived") === true)) {
    throw new HttpsError("invalid-argument", "Produit inconnu.");
  }
  return ids;
}

/** Identifiant lisible et unique dans le cabinet : cab-<nom>, suffixé si besoin. */
async function newInsurerId(cabinetId: string, name: string): Promise<string> {
  const slug =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "assureur";
  const base = `${CABINET_INSURER_PREFIX}${slug}`;
  for (let i = 1; i < 100; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    if (!(await insurersCollection(cabinetId).doc(id).get()).exists) return id;
  }
  throw new HttpsError("resource-exhausted", "Impossible de créer cet assureur : choisissez un autre nom.");
}

async function existingCabinetInsurer(cabinetId: string, insurerId: string) {
  if (!isCabinetInsurerId(insurerId)) {
    throw new HttpsError("permission-denied", "Seuls les assureurs ajoutés par le cabinet sont modifiables.");
  }
  const ref = admin.firestore().doc(insurerDocPath(cabinetId, insurerId));
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Assureur introuvable.");
  }
  if (snapshot.get("archived") === true) {
    throw new HttpsError("failed-precondition", "Assureur retiré : il ne peut plus être modifié.");
  }
  return { ref, snapshot };
}

/** Ajoute un assureur au cabinet et l'active (les assureurs activés du cabinet le reçoivent). */
export const ajouter = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await assertCabinetAdmin(request);
  const name = requireName(request.data?.name);
  const extranet = requireExtranet(request.data?.extranetUrl);
  const productsSupported = await requireProducts(cabinetId, request.data?.productsSupported);

  const active = await insurersCollection(cabinetId).where("archived", "==", false).count().get();
  if (active.data().count >= CABINET_INSURERS_MAX) {
    throw new HttpsError("resource-exhausted", `Un cabinet peut ajouter jusqu'à ${CABINET_INSURERS_MAX} assureurs.`);
  }

  const id = await newInsurerId(cabinetId, name);
  const db = admin.firestore();
  await db.runTransaction(async tx => {
    const cabinet = await tx.get(db.doc(cabinetPath(cabinetId)));
    const enabled = (cabinet.get("enabledInsurers") as string[] | undefined) ?? [];
    tx.create(insurersCollection(cabinetId).doc(id), {
      name,
      logo: null,
      extranetUrl: extranet.url,
      extranetDomains: [extranet.domain],
      productsSupported,
      custom: true,
      archived: false,
      createdBy: uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    // Aucun choix = tous les assureurs : la liste vide reste vide (le nouveau est déjà inclus).
    if (enabled.length) {
      tx.update(cabinet.ref, { enabledInsurers: FieldValue.arrayUnion(id) });
    }
  });
  return { id };
});

/** Assureur du catalogue global que le cabinet n'a encore ni modifié ni retiré. */
async function existingGlobalInsurer(cabinetId: string, insurerId: string) {
  const snapshot = await admin.firestore().doc(insurerDocPath(cabinetId, insurerId)).get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Assureur introuvable.");
  }
  const replaced = await insurersCollection(cabinetId).where("replaces", "==", insurerId).limit(1).get();
  if (!replaced.empty) {
    throw new HttpsError("failed-precondition", "Cet assureur a déjà été modifié ou retiré par le cabinet.");
  }
  return snapshot;
}

/**
 * Remplace, pour ce cabinet seulement, un assureur du catalogue global par une fiche du cabinet (les autres cabinets
 * gardent l'original). Activé à sa place s'il l'était.
 */
async function replaceGlobalInsurer(cabinetId: string, uid: string, globalId: string, data: Record<string, unknown>): Promise<string> {
  const id = await newInsurerId(cabinetId, data.name as string);
  const db = admin.firestore();
  await db.runTransaction(async tx => {
    const cabinet = await tx.get(db.doc(cabinetPath(cabinetId)));
    const enabled = (cabinet.get("enabledInsurers") as string[] | undefined) ?? [];
    tx.create(insurersCollection(cabinetId).doc(id), {
      logo: null,
      ...data,
      custom: true,
      replaces: globalId,
      createdBy: uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    if (enabled.includes(globalId)) {
      const next = enabled.filter(x => x !== globalId);
      tx.update(cabinet.ref, { enabledInsurers: data.archived === true ? next : [...next, id] });
    }
  });
  return id;
}

/**
 * Modifie le nom, l'extranet ou les produits d'un assureur. Un assureur du catalogue global est copié dans le cabinet
 * (voir replaceGlobalInsurer) : le nouvel identifiant est renvoyé.
 */
export const modifier = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await assertCabinetAdmin(request);
  const insurerId = requireId(request.data?.id, "assureur", 100);
  const global = !isCabinetInsurerId(insurerId);
  const existing = global ? await existingGlobalInsurer(cabinetId, insurerId) : (await existingCabinetInsurer(cabinetId, insurerId)).snapshot;
  const name = requireName(request.data?.name);
  const extranet = requireExtranet(request.data?.extranetUrl);
  const productsSupported = await requireProducts(cabinetId, request.data?.productsSupported);
  const fields = { name, extranetUrl: extranet.url, extranetDomains: [extranet.domain], productsSupported };

  if (global) {
    const active = await insurersCollection(cabinetId).where("archived", "==", false).count().get();
    if (active.data().count >= CABINET_INSURERS_MAX) {
      throw new HttpsError("resource-exhausted", `Un cabinet peut ajouter jusqu'à ${CABINET_INSURERS_MAX} assureurs.`);
    }
    const id = await replaceGlobalInsurer(cabinetId, uid, insurerId, { logo: existing.get("logo") ?? null, ...fields, archived: false });
    return { ok: true, id };
  }
  await existing.ref.update({ ...fields, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true, id: insurerId };
});

/**
 * Retire un assureur du cabinet : archivé (caché des listes, désactivé), son historique reste lisible.
 * Un assureur du catalogue global est masqué pour ce cabinet seulement (fiche archivée qui le remplace).
 */
export const archiver = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await assertCabinetAdmin(request);
  const insurerId = requireId(request.data?.id, "assureur", 100);
  if (!isCabinetInsurerId(insurerId)) {
    const global = await existingGlobalInsurer(cabinetId, insurerId);
    await replaceGlobalInsurer(cabinetId, uid, insurerId, {
      name: global.get("name"),
      logo: global.get("logo") ?? null,
      extranetUrl: global.get("extranetUrl"),
      extranetDomains: global.get("extranetDomains") ?? [],
      productsSupported: global.get("productsSupported") ?? [],
      archived: true,
    });
    return { ok: true };
  }
  const { ref } = await existingCabinetInsurer(cabinetId, insurerId);
  const db = admin.firestore();
  const batch = db.batch();
  batch.update(ref, { archived: true, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() });
  batch.update(db.doc(cabinetPath(cabinetId)), { enabledInsurers: FieldValue.arrayRemove(insurerId) });
  await batch.commit();
  return { ok: true };
});
