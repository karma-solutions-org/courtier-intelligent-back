import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership, requireString } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { insurerPath, productPath } from "../core/firestore-paths";
import { looksLikePersonalData, memoryKey } from "../core/form-memory.utils";
import {
  DISCOVERED_MAX_FIELDS_PER_REPORT,
  FORM_FIELD_KINDS,
  mergeDiscoveredFields,
  type DiscoveredFieldInput,
  type FormMemoryField,
  type QuestionnaireSection,
} from "../shared/index.js";

const ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9.-]{0,198}[a-z0-9])?(:\d{1,5})?$|^http:\/\/localhost(:\d{1,5})?$/;
const FINGERPRINT = /^v\d{1,3}:[0-9a-f]{14}$/;
const FIELD_KEY = /^[a-z]{3,12}:[a-z0-9-]{1,100}(#\d{1,3})?$/;
const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() && value.length <= max && !looksLikePersonalData(value) ? value.trim() : null;

/** Champs reçus : structure seulement (libellé, type, options), rien de personnel ; un champ douteux est écarté. */
function validateFields(raw: unknown): DiscoveredFieldInput[] {
  if (!Array.isArray(raw)) throw new HttpsError("invalid-argument", "Liste de champs attendue.");
  const fields: DiscoveredFieldInput[] = [];
  for (const item of raw.slice(0, DISCOVERED_MAX_FIELDS_PER_REPORT)) {
    const f = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const label = text(f.label, 120);
    if (typeof f.fieldKey !== "string" || !FIELD_KEY.test(f.fieldKey) || !label) continue;
    if (!FORM_FIELD_KINDS.includes(f.kind as never) || typeof f.inputType !== "string" || f.inputType.length > 20) continue;
    const options = Array.isArray(f.options)
      ? f.options
          .slice(0, 60)
          .map(o => (typeof o === "object" && o !== null ? (o as Record<string, unknown>) : {}))
          .map(o => ({ value: text(o.value, 100), label: text(o.label, 100) }))
          .filter((o): o is { value: string; label: string } => !!o.value && !!o.label)
      : [];
    fields.push({
      fieldKey: f.fieldKey,
      label,
      kind: f.kind as DiscoveredFieldInput["kind"],
      inputType: f.inputType,
      name: text(f.name, 100),
      section: text(f.section, 120),
      options,
    });
  }
  return fields;
}

/**
 * Champs découverts sur un extranet (signalés par l'extension après un remplissage validé) : ceux qui n'ont pas
 * d'équivalent sont AJOUTÉS AUTOMATIQUEMENT au questionnaire des produits de l'assureur, dans la section
 * « Questions des assureurs » (questions facultatives, communes à tous les cabinets ; doublons fusionnés).
 * La mémoire du formulaire apprend ensuite que ce champ correspond à la nouvelle question : l'extension le remplira.
 */
export const signaler = onCall(CALLABLE_OPTIONS, async request => {
  await getActiveMembership(request);
  const insurerId = requireString(request.data?.insurerId, "assureur", 100);
  const origin = request.data?.origin;
  const fingerprint = request.data?.formFingerprint;
  if (typeof origin !== "string" || !ORIGIN.test(origin)) throw new HttpsError("invalid-argument", "Origine invalide.");
  if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) throw new HttpsError("invalid-argument", "Empreinte invalide.");
  const fields = validateFields(request.data?.fields);
  if (!fields.length) return { added: 0 };

  const db = admin.firestore();
  const insurer = await db.doc(insurerPath(insurerId)).get();
  if (!insurer.exists) throw new HttpsError("not-found", "Assureur introuvable.");
  // Un extranet ne fait évoluer que les produits de son assureur, et seulement depuis l'un de ses domaines.
  const domains = (insurer.get("extranetDomains") as string[] | undefined) ?? [];
  const host = new URL(origin).hostname;
  if (!host.startsWith("localhost") && !domains.some(domain => host === domain || host.endsWith(`.${domain}`))) {
    throw new HttpsError("permission-denied", "Cette page n'est pas un extranet de l'assureur.");
  }
  const productIds = ((insurer.get("productsSupported") as string[] | undefined) ?? []).slice(0, 10);

  let added = 0;
  const mapping: Record<string, string> = {};
  for (const productId of productIds) {
    const result = await db.runTransaction(async tx => {
      const product = await tx.get(db.doc(productPath(productId)));
      const schema = product.get("questionnaireSchema") as QuestionnaireSection[] | undefined;
      if (!product.exists || !Array.isArray(schema)) return null;
      const merged = mergeDiscoveredFields(schema, fields, { insurerId, origin });
      if (merged.added.length || JSON.stringify(merged.schema) !== JSON.stringify(schema)) {
        tx.update(product.ref, { questionnaireSchema: merged.schema, questionnaireUpdatedAt: FieldValue.serverTimestamp() });
      }
      return merged;
    });
    if (!result) continue;
    added += result.added.length;
    Object.assign(mapping, result.mapping);
  }

  // La mémoire du formulaire apprend les nouvelles correspondances (seulement les champs encore sans équivalent).
  if (Object.keys(mapping).length) {
    const memoryRef = db.collection("formMemories").doc(memoryKey(origin, fingerprint));
    await db.runTransaction(async tx => {
      const memory = await tx.get(memoryRef);
      const memoryFields = memory.get("fields") as FormMemoryField[] | undefined;
      if (!memory.exists || !Array.isArray(memoryFields)) return;
      let changed = false;
      const next = memoryFields.map(field => {
        const path = mapping[field.fieldKey];
        if (!path || field.canonicalPath !== null) return field;
        changed = true;
        return { ...field, canonicalPath: path as FormMemoryField["canonicalPath"], confidence: 0.9 };
      });
      if (changed) tx.update(memoryRef, { fields: next, updatedAt: FieldValue.serverTimestamp() });
    });
  }
  return { added };
});
