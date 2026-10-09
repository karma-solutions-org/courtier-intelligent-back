import { createHash } from "node:crypto";
import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership, requireString } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { fieldOverlap, memoryKey, sameMapping, validateMemoryInput } from "../core/form-memory.utils";
import type { FormMemoryField } from "../shared/index.js";

const COLLECTION = "formMemories";
/** Mémoires voisines (même origine) : au-delà de ce recouvrement de champs, la nouvelle remplace l'ancienne. */
const SUPERSEDE_OVERLAP = 0.7;
/** Un signalement d'échec ne compte qu'une fois par cabinet ; à ce nombre de cabinets distincts, la mémoire est invalidée. */
const INVALIDATION_THRESHOLD = 2;
/** Le compteur d'utilisation ne s'écrit pas plus d'une fois par heure et par mémoire. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Empreinte courte d'un cabinet : sert à ne compter qu'une fois ses signalements, sans stocker son identifiant. */
const cabinetToken = (cabinetId: string) => createHash("sha256").update(`memoire|${cabinetId}`).digest("hex").substring(0, 12);

const requireKey = (value: unknown) => {
  const key = requireString(value, "mémoire", 64);
  if (!/^[0-9a-f]{32}$/.test(key)) throw new HttpsError("invalid-argument", "Identifiant de mémoire invalide.");
  return key;
};

/**
 * Enregistre ce que l'extension a appris d'un formulaire d'extranet, APRÈS un remplissage réussi et validé par le courtier.
 * La mémoire est partagée par tous les cabinets : la structure est validée à la lettre (jamais de valeur, chemins de la
 * liste fermée). Une mémoire valide n'est pas remplacée par une autre ; une mémoire invalidée est réapprise ; une
 * mémoire d'une ancienne version du formulaire (même origine, champs très proches) est supprimée.
 */
export const enregistrer = onCall(CALLABLE_OPTIONS, async request => {
  await getActiveMembership(request, { extension: true });
  const input = validateMemoryInput(request.data);
  const key = memoryKey(input.origin, input.formFingerprint);

  const db = admin.firestore();
  const ref = db.collection(COLLECTION).doc(key);

  const outcome = await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const existing = snapshot.exists
      ? (snapshot.data() as { fields: FormMemoryField[]; invalidatedAt?: Timestamp; version: number; hits: number })
      : null;

    if (existing && !existing.invalidatedAt) {
      // Même association : une confirmation de plus. Association différente : la mémoire en place est conservée.
      if (sameMapping(existing.fields, input.fields)) {
        tx.update(ref, { hits: FieldValue.increment(1), lastUsedAt: FieldValue.serverTimestamp() });
        return "confirmed" as const;
      }
      return "kept" as const;
    }
    tx.set(ref, {
      origin: input.origin,
      formFingerprint: input.formFingerprint,
      version: (existing?.version ?? 0) + 1,
      fields: input.fields,
      hits: 1,
      failures: 0,
      failureSources: [],
      lastUsedAt: FieldValue.serverTimestamp(),
      createdAt: existing ? snapshot.get("createdAt") : FieldValue.serverTimestamp(),
    });
    return existing ? ("relearned" as const) : ("created" as const);
  });

  // Le formulaire a changé (nouvelle empreinte) : les mémoires de ses anciennes versions n'ont plus lieu d'être.
  let superseded = 0;
  if (outcome === "created") {
    const neighbours = await db.collection(COLLECTION).where("origin", "==", input.origin).limit(50).get();
    for (const doc of neighbours.docs) {
      if (doc.id !== key && fieldOverlap(doc.get("fields") ?? [], input.fields) >= SUPERSEDE_OVERLAP) {
        await doc.ref.delete();
        superseded += 1;
      }
    }
  }
  return { key, outcome, superseded };
});

/** Compte une utilisation de la mémoire (au plus une écriture par heure) : sert à repérer les mémoires fiables. */
export const utiliser = onCall(CALLABLE_OPTIONS, async request => {
  await getActiveMembership(request, { extension: true });
  const ref = admin.firestore().collection(COLLECTION).doc(requireKey(request.data?.key));
  await admin.firestore().runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    const last = (snapshot.get("lastUsedAt") as Timestamp | undefined)?.toMillis() ?? 0;
    if (snapshot.exists && Date.now() - last >= TOUCH_INTERVAL_MS) {
      tx.update(ref, { hits: FieldValue.increment(1), lastUsedAt: FieldValue.serverTimestamp() });
    }
  });
  return { success: true };
});

/**
 * L'extension a utilisé cette mémoire et le remplissage a échoué (le formulaire a changé sans que son empreinte change,
 * ou la mémoire est fausse). Chaque cabinet ne compte qu'une fois ; à 2 cabinets, la mémoire est invalidée : plus
 * personne ne s'en sert, et le prochain remplissage réussi la réapprend.
 */
export const invalider = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId } = await getActiveMembership(request, { extension: true });
  const ref = admin.firestore().collection(COLLECTION).doc(requireKey(request.data?.key));
  const token = cabinetToken(cabinetId);

  const invalidated = await admin.firestore().runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists || snapshot.get("invalidatedAt")) return false;
    const sources = ((snapshot.get("failureSources") as string[] | undefined) ?? []).filter(s => s !== token);
    sources.push(token);
    const reached = sources.length >= INVALIDATION_THRESHOLD;
    tx.update(ref, {
      failureSources: sources.slice(-10),
      failures: sources.length,
      ...(reached ? { invalidatedAt: FieldValue.serverTimestamp() } : {}),
    });
    return reached;
  });
  return { invalidated };
});
