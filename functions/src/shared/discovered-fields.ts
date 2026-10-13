// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
// Champs découverts sur les extranets : quand l'extension rencontre un champ sans équivalent dans l'application,
// il est signalé au serveur (function champs-signaler) qui l'ajoute automatiquement au questionnaire du produit,
// dans la section « Questions des assureurs ». Règles communes à l'extension (ce qui est signalé) et au serveur
// (filtre, fusion des doublons, construction de la question).
import { ExtraCanonicalPath } from './canonical-paths.js';
import { FormFieldKind, Question, QuestionChoice, QuestionnaireSection, QuestionType } from './models.js';

export const DISCOVERED_SECTION_TITLE = 'Questions des assureurs';
/** Plafonds : au-delà, le signalement est tronqué (un extranet ne doit pas pouvoir gonfler le questionnaire). */
export const DISCOVERED_MAX_FIELDS_PER_REPORT = 30;
export const DISCOVERED_MAX_QUESTIONS = 150;
export const DISCOVERED_MAX_CHOICES = 40;

/** Champ sans équivalent, tel que l'extension le décrit : structure seulement, jamais la valeur saisie. */
export interface DiscoveredFieldInput {
  fieldKey: string;
  label: string;
  kind: FormFieldKind;
  /** Type HTML de l'input (text, email, password, hidden…), `select` ou `textarea`. */
  inputType: string;
  name: string | null;
  section: string | null;
  options: QuestionChoice[];
}

/** Texte comparable : minuscules, sans accents ni ponctuation, espaces simples. */
export function normalizeLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[*:?()[\]«»"'’.,;!/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Mots qui ne distinguent pas deux questions (« le nombre de km » = « nombre km »). */
const STOPWORDS = new Set(['le', 'la', 'les', 'l', 'de', 'du', 'des', 'd', 'un', 'une', 'votre', 'vos', 'en', 'au', 'aux', 'a', 'et', 'ou', 'par', 'pour', 'sur']);

const tokens = (label: string) => normalizeLabel(label).split(' ').filter(word => word && !STOPWORDS.has(word));

/** Clé de comparaison : mots significatifs, triés (l'ordre des mots ne fait pas un nouveau champ). */
export function labelSignature(label: string): string {
  return [...new Set(tokens(label))].sort().join(' ');
}

/** Code du chemin `extra.<code>` : dérivé du libellé, stable, 60 caractères au plus. */
export function discoveredPath(label: string): ExtraCanonicalPath {
  const code = tokens(label).join('_').replace(/[^a-z0-9_]/g, '').slice(0, 60).replace(/_+$/, '');
  return `extra.${code || 'champ'}`;
}

/** Libellés et noms techniques qui ne sont jamais des questions pour le client. */
const NOISE = [
  /captcha/, /mot de passe|password|passwd/, /\bcgu\b|\bcgv\b|conditions generales|j accepte|consentement|rgpd/,
  /newsletter|offres? commerciales?|partenaires|publicite/, /code promo|parrain|coupon/,
  /identifiant|login|\btoken\b|\bcsrf\b|\bsession\b/, /rechercher|recherche\b/, /^\s*$/,
];
const NOISE_INPUT_TYPES = new Set(['hidden', 'password', 'submit', 'button', 'reset', 'file', 'image', 'search']);

/** Le champ est-il une vraie question sur le client, le véhicule ou son historique ? */
export function isRelevantField(field: Pick<DiscoveredFieldInput, 'label' | 'inputType' | 'name'>): boolean {
  if (NOISE_INPUT_TYPES.has(field.inputType)) return false;
  const label = normalizeLabel(field.label ?? '');
  if (label.length < 3 || label.length > 120) return false;
  const text = `${label} ${normalizeLabel(field.name ?? '')}`;
  return !NOISE.some(pattern => pattern.test(text));
}

/** Type de la question d'après le champ : une liste devient un choix (si ses options sont exploitables). */
export function questionTypeOf(field: Pick<DiscoveredFieldInput, 'kind' | 'inputType' | 'options'>): QuestionType {
  if ((field.kind === 'select' || field.kind === 'radio') && usableChoices(field.options).length >= 2) return 'choice';
  if (field.kind === 'checkbox') return 'boolean';
  if (field.kind === 'date' || field.inputType === 'date') return 'date';
  if (field.kind === 'number' || field.inputType === 'number') return 'number';
  return 'text';
}

/** Options d'une liste, sans l'option vide (« Choisir… ») ni les doublons. */
export function usableChoices(options: QuestionChoice[]): QuestionChoice[] {
  const seen = new Set<string>();
  return options
    .filter(option => typeof option?.value === 'string' && typeof option?.label === 'string')
    .map(option => ({ value: option.value.trim().slice(0, 100), label: option.label.trim().slice(0, 100) }))
    .filter(option => option.value && option.label && !/^(choisir|selectionner|select|--)/.test(normalizeLabel(option.label)))
    .filter(option => !seen.has(option.value) && seen.add(option.value))
    .slice(0, DISCOVERED_MAX_CHOICES);
}

/** Libellé affiché : celui de l'extranet, nettoyé (astérisque d'obligation, deux-points, espaces). */
export function cleanLabel(label: string): string {
  const cleaned = label.replace(/[*:]+\s*$/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * La question existe-t-elle déjà (même sens, à l'ordre des mots près) ? Compare aux libellés de tout le questionnaire,
 * y compris les questions déjà ajoutées depuis d'autres extranets : c'est ce qui fusionne les doublons entre assureurs.
 */
export function findSameQuestion(schema: QuestionnaireSection[], label: string): Question | null {
  const signature = labelSignature(label);
  if (!signature) return null;
  for (const question of schema.flatMap(section => section.questions)) {
    if (labelSignature(question.label) === signature) return question;
  }
  return null;
}

/** Question créée pour un champ découvert : toujours facultative, elle ne bloque jamais un dossier. */
export function questionFromField(
  field: DiscoveredFieldInput,
  source: { insurerId: string | null; origin: string },
  takenPaths: ReadonlySet<string>,
): Question {
  let path = discoveredPath(field.label);
  for (let i = 2; takenPaths.has(path); i++) path = `${discoveredPath(field.label).slice(0, 63)}_${i}` as ExtraCanonicalPath;
  const type = questionTypeOf(field);
  return {
    canonicalPath: path,
    label: cleanLabel(field.label),
    type,
    required: false,
    ...(type === 'choice' ? { choices: usableChoices(field.options) } : {}),
    discoveredOn: [{ insurerId: source.insurerId, origin: source.origin, fieldKey: field.fieldKey.slice(0, 200) }],
  };
}

export interface MergeResult {
  schema: QuestionnaireSection[];
  /** Questions créées. */
  added: Question[];
  /** Champ de l'extranet → chemin de la question (créée ou existante) : appris dans la mémoire de ce formulaire. */
  mapping: Record<string, string>;
}

/**
 * Ajoute au questionnaire les champs découverts sur un extranet. Pure (testée sans Firestore) :
 * - un champ technique ou marketing est ignoré ;
 * - un champ dont le libellé correspond à une question existante n'en crée pas d'autre : il est rattaché à celle-ci
 *   (et, pour une question déjà découverte ailleurs, l'extranet est ajouté à ses sources) ;
 * - sinon une question facultative est créée dans la section « Questions des assureurs », dans la limite de
 *   DISCOVERED_MAX_QUESTIONS.
 */
export function mergeDiscoveredFields(
  schema: QuestionnaireSection[],
  fields: DiscoveredFieldInput[],
  source: { insurerId: string | null; origin: string },
): MergeResult {
  const sections = schema.map(section => ({ ...section, questions: section.questions.map(question => ({ ...question })) }));
  let discovered = sections.find(section => section.discovered);
  const added: Question[] = [];
  const mapping: Record<string, string> = {};
  const taken = new Set(sections.flatMap(section => section.questions.map(question => question.canonicalPath as string)));

  for (const field of fields.slice(0, DISCOVERED_MAX_FIELDS_PER_REPORT)) {
    if (!isRelevantField(field)) continue;
    const same = findSameQuestion(sections, field.label);
    if (same) {
      mapping[field.fieldKey] = same.canonicalPath;
      if (same.discoveredOn && !same.discoveredOn.some(s => s.origin === source.origin && s.fieldKey === field.fieldKey)) {
        same.discoveredOn = [...same.discoveredOn, { ...source, fieldKey: field.fieldKey }].slice(-20);
      }
      continue;
    }
    if (!discovered) {
      discovered = { title: DISCOVERED_SECTION_TITLE, questions: [], discovered: true };
      sections.push(discovered);
    }
    if (discovered.questions.length >= DISCOVERED_MAX_QUESTIONS) break;
    const question = questionFromField(field, source, taken);
    taken.add(question.canonicalPath);
    discovered.questions.push(question);
    added.push(question);
    mapping[field.fieldKey] = question.canonicalPath;
  }
  return { schema: sections, added, mapping };
}
