// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
import { CanonicalData, CanonicalPath, CanonicalValue, KnownValue, isCanonicalPath } from './canonical-paths.js';
import type { Question, QuestionnaireSection } from './models.js';

/**
 * Règles du questionnaire d'un produit, communes à l'app (formulaire dynamique), aux Cloud Functions
 * (complétude, validation des réponses) et à l'extension (`quoteData`).
 */

/** Toutes les questions d'un questionnaire, dans l'ordre. */
export function questionsOf(schema: QuestionnaireSection[]): Question[] {
  return schema.flatMap(section => section.questions);
}

/** Valeur brute d'un champ dans les données d'un dossier. */
const valueAt = (data: CanonicalData, path: CanonicalPath): CanonicalValue | undefined => data[path];

export function isKnownValue(value: unknown): value is KnownValue<number> {
  return typeof value === 'object' && value !== null && 'knowledge' in value && 'value' in value;
}

/** Une question conditionnelle n'est posée que si le champ dont elle dépend a la valeur attendue. */
export function isQuestionVisible(question: Question, data: CanonicalData): boolean {
  return !question.visibleIf || valueAt(data, question.visibleIf.path) === question.visibleIf.equals;
}

/**
 * Le champ est-il renseigné ? Rien n'est inventé : `null`, absent et chaîne vide = non renseigné,
 * mais `0` et `false` sont des réponses. « L'assuré ne sait pas » est une réponse ; « inconnu » (pas encore su) n'en est pas une.
 */
export function isAnswered(value: CanonicalValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (isKnownValue(value)) {
    return value.knowledge === 'DECLARED_UNKNOWN' || (value.knowledge === 'KNOWN' && value.value !== null);
  }
  return true;
}

/** Champs obligatoires et visibles qui ne sont pas renseignés. */
export function computeMissing(schema: QuestionnaireSection[], data: CanonicalData): CanonicalPath[] {
  return questionsOf(schema)
    .filter(q => q.required && isQuestionVisible(q, data) && !isAnswered(valueAt(data, q.canonicalPath)))
    .map(q => q.canonicalPath);
}

export function computeCompleteness(
  schema: QuestionnaireSection[],
  data: CanonicalData,
): { ok: boolean; missing: CanonicalPath[] } {
  const missing = computeMissing(schema, data);
  return { ok: missing.length === 0, missing };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Contrôle une réponse reçue (côté serveur : l'app n'est jamais crue sur parole).
 * Renvoie le message d'erreur, ou null si la valeur est acceptable. `null` (effacer) est toujours accepté.
 */
export function validateAnswer(question: Question, value: unknown): string | null {
  if (value === null) return null;
  const label = question.label;

  if (question.withKnowledge) {
    if (!isKnownValue(value)) return `« ${label} » : réponse avec niveau de connaissance attendue.`;
    if (!['KNOWN', 'UNKNOWN', 'DECLARED_UNKNOWN'].includes(value.knowledge)) return `« ${label} » : niveau de connaissance invalide.`;
    if (value.value !== null && (typeof value.value !== 'number' || !Number.isFinite(value.value))) {
      return `« ${label} » : nombre attendu.`;
    }
    if (value.knowledge === 'KNOWN' && value.value === null) return `« ${label} » : valeur manquante.`;
    return null;
  }

  switch (question.type) {
    case 'text':
      return typeof value === 'string' && value.length <= 500 ? null : `« ${label} » : texte attendu (500 caractères maximum).`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `« ${label} » : nombre attendu.`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `« ${label} » : oui ou non attendu.`;
    case 'date':
      return typeof value === 'string' && (value === '' || (ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))))
        ? null
        : `« ${label} » : date attendue (AAAA-MM-JJ).`;
    case 'choice':
      return typeof value === 'string' && (value === '' || (question.choices ?? []).some(c => c.value === value))
        ? null
        : `« ${label} » : choix invalide.`;
  }
}

/** Chemins du dossier acceptés pour un produit : uniquement ceux de son questionnaire, jamais hors modèle canonique. */
export function questionFor(schema: QuestionnaireSection[], path: string): Question | null {
  return isCanonicalPath(path) ? (questionsOf(schema).find(q => q.canonicalPath === path) ?? null) : null;
}

/**
 * Données envoyées à l'extension pour tarifer (`QuoteJob.quoteData`), construites depuis le dossier.
 * - seules les questions visibles du produit sont incluses (un champ masqué par une condition est écarté) ;
 * - `null` reste `null` (non renseigné ≠ 0 ≠ faux), jamais de valeur par défaut inventée ;
 * - un champ avec niveau de connaissance reste `{ value, knowledge }` : « inconnu » et « l'assuré ne sait pas » sont conservés.
 */
export function buildQuoteData(schema: QuestionnaireSection[], data: CanonicalData): CanonicalData {
  const quoteData: CanonicalData = {};
  for (const question of questionsOf(schema)) {
    if (!isQuestionVisible(question, data)) continue;
    const raw = valueAt(data, question.canonicalPath);

    if (question.withKnowledge) {
      quoteData[question.canonicalPath] = isKnownValue(raw)
        ? { value: raw.value, knowledge: raw.knowledge }
        : typeof raw === 'number'
          ? { value: raw, knowledge: 'KNOWN' }
          : { value: null, knowledge: 'UNKNOWN' };
      continue;
    }
    const plain = isKnownValue(raw) ? raw.value : raw;
    quoteData[question.canonicalPath] = plain === undefined || plain === '' ? null : plain;
  }
  return quoteData;
}
