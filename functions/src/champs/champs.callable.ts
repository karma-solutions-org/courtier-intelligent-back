import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership, requireId } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { looksLikePersonalData, memoryKey } from "../core/form-memory.utils";
import { isInsurerExtranetOrigin } from "../core/origin.utils";
import { cabinetMemoryPath } from "../core/firestore-paths";
import {
  applyInsurerRequirements,
  DISCOVERED_MAX_FIELDS_PER_REPORT,
  isCanonicalPath,
  REQUIRED_PATHS_MAX,
  FORM_FIELD_KINDS,
  mergeDiscoveredFields,
  type DiscoveredFieldInput,
  type FormMemoryField,
  type QuestionnaireSection,
  isCabinetInsurerId,
  insurerDocPath,
  isCabinetProductId,
  productDocPath,
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
      required: f.required === true,
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
  // Appelée par l'extension : c'est sa session (extensionAuthTime) qui est vérifiée, pas celle de l'app.
  const { cabinetId } = await getActiveMembership(request, { extension: true });
  const insurerId = requireId(request.data?.insurerId, "assureur", 100);
  const origin = request.data?.origin;
  const fingerprint = request.data?.formFingerprint;
  if (typeof origin !== "string" || !ORIGIN.test(origin)) throw new HttpsError("invalid-argument", "Origine invalide.");
  if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) throw new HttpsError("invalid-argument", "Empreinte invalide.");
  const fields = validateFields(request.data?.fields ?? []);
  const requiredPaths = Array.isArray(request.data?.requiredPaths)
    ? [...new Set((request.data.requiredPaths as unknown[]).filter((p): p is string => typeof p === "string" && isCanonicalPath(p)))].slice(0, REQUIRED_PATHS_MAX)
    : [];
  if (!fields.length && !requiredPaths.length) return { added: 0 };

  const db = admin.firestore();
  const cabinetInsurer = isCabinetInsurerId(insurerId);
  const insurer = await db.doc(insurerDocPath(cabinetId, insurerId)).get();
  if (!insurer.exists) throw new HttpsError("not-found", "Assureur introuvable.");
  // Un extranet ne fait évoluer que les produits de son assureur, et seulement depuis l'un de ses domaines.
  // Page locale (extranet de démo) : dans les emulators, ou pour un assureur du cabinet qui déclare ce domaine:port.
  const domains = (insurer.get("extranetDomains") as string[] | undefined) ?? [];
  if (!isInsurerExtranetOrigin(origin, domains, { cabinetInsurer })) {
    throw new HttpsError("permission-denied", "Cette page n'est pas un extranet de l'assureur.");
  }
  // Un assureur ajouté par un cabinet (domaine saisi par le cabinet) ne complète que les produits de ce cabinet :
  // jamais le questionnaire commun à tous les cabinets.
  const productIds = ((insurer.get("productsSupported") as string[] | undefined) ?? [])
    .filter(productId => !cabinetInsurer || isCabinetProductId(productId))
    .slice(0, 10);

  let added = 0;
  const mapping: Record<string, string> = {};
  for (const productId of productIds) {
    const result = await db.runTransaction(async tx => {
      const product = await tx.get(db.doc(productDocPath(cabinetId, productId)));
      const schema = product.get("questionnaireSchema") as QuestionnaireSection[] | undefined;
      if (!product.exists || !Array.isArray(schema)) return null;
      const merged = mergeDiscoveredFields(schema, fields, { insurerId, origin });
      // Exigences de l'extranet : questions obligatoires (et chiffre exigé), retenues aussi pour les republications du catalogue.
      const required = applyInsurerRequirements(merged.schema, requiredPaths);
      merged.schema = required.schema;
      if (merged.added.length || JSON.stringify(merged.schema) !== JSON.stringify(schema)) {
        tx.update(product.ref, {
          questionnaireSchema: merged.schema,
          questionnaireUpdatedAt: FieldValue.serverTimestamp(),
          ...(requiredPaths.length ? { insurerRequiredPaths: FieldValue.arrayUnion(...requiredPaths) } : {}),
        });
      }
      return merged;
    });
    if (!result) continue;
    added += result.added.length;
    Object.assign(mapping, result.mapping);
  }

  // La mémoire du formulaire DU CABINET apprend les nouvelles correspondances (seulement les champs encore sans
  // équivalent) : la mémoire commune ne change que par memoires-enregistrer (plusieurs cabinets d'accord).
  if (Object.keys(mapping).length) {
    const memoryRef = db.doc(cabinetMemoryPath(cabinetId, memoryKey(origin, fingerprint)));
    await db.runTransaction(async tx => {
      const memory = await tx.get(memoryRef);
      const memoryFields = memory.get("fields") as FormMemoryField[] | undefined;
      if (!memory.exists || !Array.isArray(memoryFields)) return;
      // La mémoire ne garde que des champs associés (jamais de chemin vide) : les nouveaux champs s'y ajoutent.
      const known = new Set(memoryFields.map(field => field.fieldKey));
      const order = memoryFields.reduce((max, field) => Math.max(max, field.order), -1);
      const appended: FormMemoryField[] = fields
        .filter(field => mapping[field.fieldKey] && !known.has(field.fieldKey) && field.fieldKey.split(":")[0] === field.kind)
        .map((field, index) => ({
          fieldKey: field.fieldKey,
          label: field.label,
          type: field.kind,
          order: Math.min(order + 1 + index, 999),
          canonicalPath: mapping[field.fieldKey] as FormMemoryField["canonicalPath"],
          confidence: 0.9,
        }));
      const changed = appended.length > 0;
      const next = [...memoryFields, ...appended];
      if (changed) tx.update(memoryRef, { fields: next, updatedAt: FieldValue.serverTimestamp() });
    });
  }
  return { added };
});
