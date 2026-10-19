import { createHash } from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";
import { FORM_FIELD_KINDS, isCanonicalPath, type FormMemoryField } from "../shared/index.js";

const MAX_FIELDS = 300;
const MAX_LABEL = 120;
const ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9.-]{0,198}[a-z0-9])?(:\d{1,5})?$|^http:\/\/localhost(:\d{1,5})?$/;
const FINGERPRINT = /^v\d{1,3}:[0-9a-f]{14}$/;
/** `type:identifiant` (+ `#n` si le même identifiant revient) : de la structure, jamais une valeur. */
const FIELD_KEY = /^[a-z]{3,12}:[a-z0-9-]{1,100}(#\d{1,3})?$/;

/** Identifiant du document : sha256(`origin|empreinte`), 32 premiers caractères hexadécimaux. L'extension calcule la même chose. */
export function memoryKey(origin: string, fingerprint: string): string {
  return createHash("sha256").update(`${origin}|${fingerprint}`).digest("hex").substring(0, 32);
}

/** Un libellé est un texte de formulaire (« Date de naissance ») : jamais un e-mail, un numéro ou une donnée saisie. */
export function looksLikePersonalData(text: string): boolean {
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text) || /\d{6,}/.test(text.replace(/[\s.\-/]/g, "")) || /\b[A-Z]{2}\d{2}[A-Z0-9]{10,}\b/.test(text);
}

export interface MemoryInput {
  origin: string;
  formFingerprint: string;
  fields: FormMemoryField[];
}

function invalid(message: string): never {
  throw new HttpsError("invalid-argument", message);
}

/**
 * Valide ce que l'extension veut apprendre. La mémoire est partagée entre tous les cabinets : seule de la STRUCTURE
 * est acceptée (champs et chemins canoniques de la liste fermée), jamais de valeur, et rien d'inattendu.
 */
export function validateMemoryInput(data: unknown): MemoryInput {
  const body = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  if (typeof body.origin !== "string" || !ORIGIN.test(body.origin)) invalid("Origine invalide.");
  if (typeof body.formFingerprint !== "string" || !FINGERPRINT.test(body.formFingerprint)) invalid("Empreinte invalide.");
  const rawFields = body.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0 || rawFields.length > MAX_FIELDS) invalid(`Entre 1 et ${MAX_FIELDS} champs attendus.`);

  const keys = new Set<string>();
  const fields = (rawFields as Record<string, unknown>[]).map((raw, index): FormMemoryField => {
    const field = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const unexpected = Object.keys(field).filter(key => !["fieldKey", "label", "type", "order", "canonicalPath", "confidence"].includes(key));
    if (unexpected.length) invalid(`Champ ${index + 1} : propriété inattendue (${unexpected.join(", ")}).`);

    const { fieldKey, label, type, order, canonicalPath, confidence } = field;
    if (typeof fieldKey !== "string" || !FIELD_KEY.test(fieldKey) || keys.has(fieldKey)) invalid(`Champ ${index + 1} : clé invalide ou en double.`);
    keys.add(fieldKey as string);
    if (!FORM_FIELD_KINDS.includes(type as never) || (fieldKey as string).split(":")[0] !== type) invalid(`Champ ${index + 1} : type invalide.`);
    if (label !== null && (typeof label !== "string" || label.length > MAX_LABEL || looksLikePersonalData(label))) {
      invalid(`Champ ${index + 1} : libellé invalide.`);
    }
    if (!Number.isInteger(order) || (order as number) < 0 || (order as number) > 999) invalid(`Champ ${index + 1} : ordre invalide.`);
    if (canonicalPath !== null && (typeof canonicalPath !== "string" || !isCanonicalPath(canonicalPath))) {
      invalid(`Champ ${index + 1} : chemin hors du modèle canonique.`);
    }
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) invalid(`Champ ${index + 1} : confiance invalide.`);
    return {
      fieldKey: fieldKey as string,
      label: (label as string | null) ?? null,
      type: type as FormMemoryField["type"],
      order: order as number,
      canonicalPath: canonicalPath as FormMemoryField["canonicalPath"],
      confidence: Math.round((confidence as number) * 100) / 100,
    };
  });
  return { origin: body.origin as string, formFingerprint: body.formFingerprint as string, fields };
}

/** Deux mémoires décrivent-elles les mêmes associations champ → chemin ? */
export function sameMapping(a: FormMemoryField[], b: FormMemoryField[]): boolean {
  const signature = (fields: FormMemoryField[]) => fields.map(f => `${f.fieldKey}=${f.canonicalPath ?? ""}`).sort().join("|");
  return signature(a) === signature(b);
}

/** Part des champs de `previous` qui se retrouvent dans `next` : un formulaire modifié ressemble encore à l'ancien. */
export function fieldOverlap(previous: { fieldKey: string }[], next: { fieldKey: string }[]): number {
  if (previous.length === 0) return 0;
  const nextKeys = new Set(next.map(f => f.fieldKey));
  return previous.filter(f => nextKeys.has(f.fieldKey)).length / previous.length;
}
