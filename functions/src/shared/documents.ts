// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
// Documents d'un dossier (E12) : envoi (carte grise, permis, relevé d'information…) et lecture automatique (OCR).
// Règles communes à l'app (pré-remplissage) et aux functions documents-* (contrôle de la réponse de l'IA).
import { CanonicalPath, CanonicalValue, isCanonicalPath } from './canonical-paths.js';
import { Question, QuestionnaireSection } from './models.js';
import { questionFor, validateAnswer } from './questionnaire.js';

export const DOSSIER_DOCUMENT_TYPES = ['carte_grise', 'permis', 'releve_information', 'autre'] as const;
export type DossierDocumentType = (typeof DOSSIER_DOCUMENT_TYPES)[number];

export const DOSSIER_DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export const DOSSIER_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/** En dessous de cette confiance, une valeur lue est proposée décochée, « à confirmer ». */
export const OCR_CONFIDENCE_THRESHOLD = 0.8;

/** Nombre maximal de champs gardés d'une réponse de l'IA. */
export const OCR_MAX_FIELDS = 40;

/** Champs que l'IA peut lire sur chaque type de document (« autre » : aucun, il n'est pas analysé). */
export const OCR_PATH_PREFIXES: Record<DossierDocumentType, string[]> = {
  carte_grise: ['vehicle.'],
  permis: ['driver.'],
  releve_information: ['insuranceHistory.'],
  autre: [],
};

/** Valeur lue sur un document, proposée au courtier (jamais écrite sans son accord). */
export interface OcrField {
  canonicalPath: CanonicalPath;
  value: CanonicalValue;
  /** Confiance de la lecture, entre 0 et 1. */
  confidence: number;
}

export type DossierDocumentStatus = 'uploaded' | 'analyzed' | 'failed';

export function isDossierDocumentType(type: unknown): type is DossierDocumentType {
  return typeof type === 'string' && (DOSSIER_DOCUMENT_TYPES as readonly string[]).includes(type);
}

/** Le type de document peut-il être lu automatiquement ? */
export const isAnalyzableDocumentType = (type: unknown): boolean => isDossierDocumentType(type) && OCR_PATH_PREFIXES[type].length > 0;

/** Dossier Storage des documents d'un dossier. */
export const dossierDocumentsFolder = (cabinetId: string, dossierId: string) => `cabinets/${cabinetId}/dossiers/${dossierId}/documents`;

/** Nom de fichier sûr (lettres sans accent, chiffres, « . _ - »), ne commençant pas par un point, 200 caractères au plus. */
export function safeDocumentFileName(name: string): string {
  const cleaned = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(-120);
  return cleaned || 'document';
}

/** Le chemin d'un document envoyé est-il bien dans le dossier des documents de CE dossier (aucun « .. », aucun sous-dossier) ? */
export function isDossierDocumentPath(path: unknown, cabinetId: string, dossierId: string): path is string {
  const prefix = `${dossierDocumentsFolder(cabinetId, dossierId)}/`;
  if (typeof path !== 'string' || !path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/.test(name);
}

/** Questions du produit lisibles sur ce type de document. */
export function ocrQuestions(schema: QuestionnaireSection[], type: DossierDocumentType): Question[] {
  const prefixes = OCR_PATH_PREFIXES[type] ?? [];
  return schema.flatMap(s => s.questions).filter(q => prefixes.some(p => q.canonicalPath.startsWith(p)));
}

const DOCUMENT_LABELS: Record<DossierDocumentType, string> = {
  carte_grise: "certificat d'immatriculation (carte grise)",
  permis: 'permis de conduire',
  releve_information: "relevé d'information d'assurance auto",
  autre: 'document',
};

/** Consigne envoyée à l'IA : uniquement les champs du questionnaire lisibles sur ce type de document. */
export function buildOcrPrompt(type: DossierDocumentType, questions: Question[]): string {
  const fields = questions.map(q => {
    const format =
      q.type === 'date'
        ? 'date AAAA-MM-JJ'
        : q.type === 'number' || q.withKnowledge
          ? 'nombre'
          : q.type === 'boolean'
            ? 'true ou false'
            : q.type === 'choice'
              ? `une valeur parmi ${(q.choices ?? []).map(c => JSON.stringify(c.value)).join(', ')}`
              : 'texte';
    return `- ${q.canonicalPath} (${q.label}) : ${format}`;
  });
  return [
    `Tu lis un ${DOCUMENT_LABELS[type]} joint. Extrais uniquement les champs suivants :`,
    ...fields,
    '',
    'Réponds UNIQUEMENT avec un JSON de la forme {"fields":[{"canonicalPath":"...","value":...,"confidence":0.0}]}.',
    'confidence est ta confiance entre 0 et 1. N\'invente jamais : un champ absent, illisible ou incertain est omis.',
    "N'utilise aucun autre canonicalPath que ceux listés.",
  ].join('\n');
}

/** Le premier objet JSON d'un texte (l'IA l'entoure parfois de ```json … ```). */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Contrôle la réponse de l'IA : seuls les chemins canoniques du questionnaire lisibles sur ce type de document sont gardés,
 * chaque valeur doit passer `validateAnswer`, la confiance est ramenée entre 0 et 1. Un champ vide ou invalide est écarté
 * (jamais de valeur inventée) ; un même champ n'est gardé qu'une fois. Renvoie `null` si la réponse n'est pas un JSON exploitable.
 */
export function parseOcrResponse(text: string, type: DossierDocumentType, schema: QuestionnaireSection[]): OcrField[] | null {
  const body = extractJson(text) as { fields?: unknown } | null;
  if (!body || typeof body !== 'object' || !Array.isArray(body.fields)) return null;
  const prefixes = OCR_PATH_PREFIXES[type] ?? [];
  const fields: OcrField[] = [];
  const seen = new Set<string>();

  for (const raw of body.fields) {
    if (fields.length >= OCR_MAX_FIELDS) break;
    if (typeof raw !== 'object' || raw === null) continue;
    const { canonicalPath: path, value: received, confidence } = raw as Record<string, unknown>;
    if (typeof path !== 'string' || !isCanonicalPath(path) || seen.has(path)) continue;
    if (!prefixes.some(p => path.startsWith(p))) continue;
    const question = questionFor(schema, path);
    if (!question) continue;

    const value = normalizeOcrValue(question, received);
    if (value === null || validateAnswer(question, value)) continue;

    seen.add(path);
    fields.push({ canonicalPath: path, value, confidence: clampConfidence(confidence) });
  }
  return fields;
}

const clampConfidence = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(1, Math.max(0, value)) * 100) / 100 : 0;

/** Valeur lue, mise au format du questionnaire ; `null` si elle est vide (rien n'est alors proposé). */
function normalizeOcrValue(question: Question, value: unknown): CanonicalValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    value = value.trim();
    if (value === '') return null;
  }
  if (question.withKnowledge) {
    const number = typeof value === 'string' ? Number((value as string).replace(',', '.')) : value;
    return typeof number === 'number' && Number.isFinite(number) ? { value: number, knowledge: 'KNOWN' } : (value as CanonicalValue);
  }
  if (question.type === 'number' && typeof value === 'string') {
    const number = Number(value.replace(',', '.').replace(/\s/g, ''));
    return Number.isFinite(number) ? number : (value as CanonicalValue);
  }
  return value as CanonicalValue;
}
