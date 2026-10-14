import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertCabinetAdmin, requireString } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { cabinetPath } from "../core/firestore-paths";
import {
  blankQuestionnaire,
  CABINET_PRODUCT_NAME_MAX,
  CABINET_PRODUCT_PREFIX,
  CABINET_PRODUCTS_MAX,
  cleanGuarantees,
  cleanQuestionnaire,
  isCabinetProductId,
  ProductValidationError,
  productDocPath,
  type QuestionnaireSection,
} from "../shared/index.js";

/**
 * Produits propres à un cabinet (admin) : créés à partir d'un produit existant (copie de son questionnaire et de ses
 * garanties) ou vierges (questions sur le souscripteur seulement), puis modifiés ici. Les champs découverts sur les
 * extranets des assureurs du cabinet les complètent ensuite (champs-signaler). Un produit retiré est archivé :
 * ses dossiers restent lisibles.
 */

const productsCollection = (cabinetId: string) => admin.firestore().collection(`${cabinetPath(cabinetId)}/ci_products`);

function requireName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > CABINET_PRODUCT_NAME_MAX) {
    throw new HttpsError("invalid-argument", `Le nom du produit doit faire entre 2 et ${CABINET_PRODUCT_NAME_MAX} caractères.`);
  }
  return name;
}

/** Les erreurs de saisie du questionnaire ou des garanties remontent telles quelles au courtier. */
function validated<T>(clean: () => T): T {
  try {
    return clean();
  } catch (error) {
    if (error instanceof ProductValidationError) throw new HttpsError("invalid-argument", error.message);
    throw error;
  }
}

async function newProductId(cabinetId: string, name: string): Promise<string> {
  const slug =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "produit";
  const base = `${CABINET_PRODUCT_PREFIX}${slug}`;
  for (let i = 1; i < 100; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    if (!(await productsCollection(cabinetId).doc(id).get()).exists) return id;
  }
  throw new HttpsError("resource-exhausted", "Impossible de créer ce produit : choisissez un autre nom.");
}

/** Questions sur le souscripteur reprises du premier produit actif du catalogue (base d'un produit vierge). */
async function blankStart(): Promise<QuestionnaireSection[]> {
  const products = await admin.firestore().collection("ci_products").where("active", "==", true).limit(5).get();
  for (const product of products.docs) {
    const schema = blankQuestionnaire((product.get("questionnaireSchema") as QuestionnaireSection[] | undefined) ?? []);
    if (schema.length) return schema;
  }
  return [];
}

async function existingCabinetProduct(cabinetId: string, productId: string) {
  if (!isCabinetProductId(productId)) {
    throw new HttpsError("permission-denied", "Seuls les produits créés par le cabinet sont modifiables.");
  }
  const ref = admin.firestore().doc(productDocPath(cabinetId, productId));
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Produit introuvable.");
  }
  if (snapshot.get("archived") === true) {
    throw new HttpsError("failed-precondition", "Produit retiré : il ne peut plus être modifié.");
  }
  return ref;
}

/** Crée un produit du cabinet (copie d'un produit, ou vierge) et l'active. */
export const creer = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await assertCabinetAdmin(request);
  const name = requireName(request.data?.name);
  const baseProductId = typeof request.data?.baseProductId === "string" ? request.data.baseProductId : null;

  const active = await productsCollection(cabinetId).where("archived", "==", false).count().get();
  if (active.data().count >= CABINET_PRODUCTS_MAX) {
    throw new HttpsError("resource-exhausted", `Un cabinet peut créer jusqu'à ${CABINET_PRODUCTS_MAX} produits.`);
  }

  let questionnaireSchema: QuestionnaireSection[];
  let guaranteeCatalog: unknown[] = [];
  if (baseProductId) {
    const base = await admin.firestore().doc(productDocPath(cabinetId, baseProductId)).get();
    if (!base.exists || base.get("active") === false || base.get("archived") === true) {
      throw new HttpsError("not-found", "Produit de départ introuvable.");
    }
    questionnaireSchema = (base.get("questionnaireSchema") as QuestionnaireSection[] | undefined) ?? [];
    guaranteeCatalog = (base.get("guaranteeCatalog") as unknown[] | undefined) ?? [];
  } else {
    questionnaireSchema = await blankStart();
  }

  const id = await newProductId(cabinetId, name);
  const db = admin.firestore();
  await db.runTransaction(async tx => {
    const cabinet = await tx.get(db.doc(cabinetPath(cabinetId)));
    const enabled = (cabinet.get("enabledProducts") as string[] | undefined) ?? [];
    tx.create(productsCollection(cabinetId).doc(id), {
      name,
      active: true,
      archived: false,
      custom: true,
      questionnaireSchema: validated(() => cleanQuestionnaire(questionnaireSchema)),
      guaranteeCatalog: validated(() => cleanGuarantees(guaranteeCatalog)),
      basedOn: baseProductId,
      createdBy: uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    // Aucun choix = tous les produits : la liste vide reste vide (le nouveau est déjà inclus).
    if (enabled.length) {
      tx.update(cabinet.ref, { enabledProducts: FieldValue.arrayUnion(id) });
    }
  });
  return { id };
});

/** Enregistre le nom, le questionnaire et les garanties d'un produit du cabinet. */
export const modifier = onCall({ ...CALLABLE_OPTIONS, memory: "512MiB" }, async request => {
  const { cabinetId, uid } = await assertCabinetAdmin(request);
  const productId = requireString(request.data?.id, "produit", 100);
  const ref = await existingCabinetProduct(cabinetId, productId);
  const name = requireName(request.data?.name);
  const questionnaireSchema = validated(() => cleanQuestionnaire(request.data?.questionnaireSchema));
  if (!questionnaireSchema.some(section => section.questions.length)) {
    throw new HttpsError("invalid-argument", "Le questionnaire doit contenir au moins une question.");
  }
  const guaranteeCatalog = validated(() => cleanGuarantees(request.data?.guaranteeCatalog));
  await ref.update({ name, questionnaireSchema, guaranteeCatalog, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

/** Retire un produit du cabinet : archivé (plus proposé pour un nouveau dossier), ses dossiers restent lisibles. */
export const archiver = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await assertCabinetAdmin(request);
  const productId = requireString(request.data?.id, "produit", 100);
  const ref = await existingCabinetProduct(cabinetId, productId);
  const db = admin.firestore();
  const batch = db.batch();
  batch.update(ref, { archived: true, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() });
  batch.update(db.doc(cabinetPath(cabinetId)), { enabledProducts: FieldValue.arrayRemove(productId) });
  await batch.commit();
  return { ok: true };
});
