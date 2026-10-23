// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
// Champs découverts sur les extranets : quand l'extension rencontre un champ sans équivalent dans l'application,
// il est signalé au serveur (function champs-signaler) qui l'ajoute automatiquement au questionnaire du produit,
// dans la section « Questions des assureurs ». Règles communes à l'extension (ce qui est signalé) et au serveur
// (filtre, fusion des doublons, construction de la question).
import { ExtraCanonicalPath } from './canonical-paths.js';
import { FormFieldKind, Question, QuestionChoice, QuestionnaireSection, QuestionType } from './models.js';
import { findMatchingQuestion, shapeOf } from './question-matching.js';
import { foldText } from './text.js';

export const DISCOVERED_SECTION_TITLE = 'Questions des assureurs';
/** Plafonds : au-delà, le signalement est tronqué (un extranet ne doit pas pouvoir gonfler le questionnaire). */
export const DISCOVERED_MAX_FIELDS_PER_REPORT = 30;
export const DISCOVERED_MAX_QUESTIONS = 150;
export const DISCOVERED_MAX_CHOICES = 40;
/** Libellé le plus long d'une question découverte (déclarations de Zephir : « Le véhicule est-il utilisé pour le transport… »). */
export const DISCOVERED_LABEL_MAX = 250;

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
  /** Obligatoire sur l'extranet (astérisque, attribut required…) : la question le sera aussi. */
  required?: boolean;
}

/** Texte comparable : minuscules, sans accents ni ponctuation, espaces simples. */
export function normalizeLabel(label: string): string {
  return foldText(label)
    .replace(/[*:?()[\]«»"'’.,;!/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Mots qui ne distinguent pas deux questions (« le nombre de km » = « nombre km »). */
const STOPWORDS = new Set(['le', 'la', 'les', 'l', 'de', 'du', 'des', 'd', 'un', 'une', 'votre', 'vos', 'en', 'au', 'aux', 'a', 'et', 'ou', 'par', 'pour', 'sur']);

const tokens = (label: string) => normalizeLabel(label).split(' ').filter(word => word && !STOPWORDS.has(word));

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
  if (label.length < 3 || label.length > DISCOVERED_LABEL_MAX) return false;
  const text = `${label} ${normalizeLabel(field.name ?? '')}`;
  return !NOISE.some(pattern => pattern.test(text));
}

/** Type de la question d'après le champ : une liste devient un choix (si ses options sont exploitables). */
export function questionTypeOf(field: Pick<DiscoveredFieldInput, 'kind' | 'inputType' | 'options'>): QuestionType {
  const choices = usableChoices(field.options);
  // Oui / Non (boutons de Zephir, radios) : une question oui / non, pas une liste à deux choix.
  if ((field.kind === 'select' || field.kind === 'radio') && isYesNoChoices(choices)) return 'boolean';
  if ((field.kind === 'select' || field.kind === 'radio') && choices.length >= 2) return 'choice';
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
  const cleaned = label.replace(/[*:]+\s*$/g, '').replace(/\s+/g, ' ').trim().slice(0, DISCOVERED_LABEL_MAX);
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

const isYesNoChoices = (choices: QuestionChoice[]) =>
  choices.length === 2 && choices.every(choice => /^(oui|non|yes|no)$/i.test(choice.label.trim()));

/**
 * La question existe-t-elle déjà (même sens, même forme de réponse, voir question-matching.ts) ? Compare à tout le
 * questionnaire, y compris les questions ajoutées depuis d'autres extranets : c'est ce qui fusionne les doublons entre
 * assureurs, même quand chacun la pose avec ses mots.
 */
export function findSameQuestion(
  schema: QuestionnaireSection[],
  field: Pick<DiscoveredFieldInput, 'label' | 'kind' | 'inputType' | 'options'>,
): Question | null {
  const questions = schema.flatMap(section => section.questions).map(question => ({
    question,
    label: question.label,
    shape: shapeOf(question.type, question.choices),
  }));
  const type = questionTypeOf(field);
  const wanted = { label: field.label, shape: shapeOf(type, type === 'choice' ? usableChoices(field.options) : undefined) };
  return findMatchingQuestion(questions, wanted)?.question.question ?? null;
}

/** Question créée pour un champ découvert : obligatoire si l'extranet l'exige, facultative sinon. */
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
    required: field.required === true,
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
 *   (et, pour une question déjà découverte ailleurs, l'extranet est ajouté à ses sources) ; si l'extranet l'exige,
 *   elle devient obligatoire, et elle le reste même si un autre extranet la propose en facultatif ;
 * - sinon une question (obligatoire ou facultative comme sur l'extranet) est créée dans la section « Questions des assureurs », dans la limite de
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
    const same = findSameQuestion(sections, field);
    if (same) {
      mapping[field.fieldKey] = same.canonicalPath;
      // L'extranet l'exige : la question existante devient obligatoire. Un champ facultatif ne retire jamais l'exigence.
      if (field.required) {
        same.required = true;
        if (same.withKnowledge) same.mustBeKnown = true;
      }
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

/** Plafond des chemins exigés dans un signalement. */
export const REQUIRED_PATHS_MAX = 60;

/**
 * Exigences d'un extranet : chaque question dont le champ est obligatoire sur l'extranet le devient dans l'application,
 * et une question à niveau de connaissance n'accepte plus « le client ne sait pas » (un chiffre est attendu).
 * Pure ; `changed` dit s'il y a quelque chose à enregistrer. Jamais l'inverse : une exigence ne se retire pas ici.
 */
export function applyInsurerRequirements(
  schema: QuestionnaireSection[],
  requiredPaths: readonly string[],
): { schema: QuestionnaireSection[]; changed: boolean } {
  const wanted = new Set(requiredPaths);
  let changed = false;
  const next = schema.map(section => ({
    ...section,
    questions: section.questions.map(question => {
      if (!wanted.has(question.canonicalPath)) return question;
      const updated = { ...question, required: true, ...(question.withKnowledge ? { mustBeKnown: true } : {}) };
      if (updated.required !== question.required || updated.mustBeKnown !== question.mustBeKnown) changed = true;
      return updated;
    }),
  }));
  return { schema: next, changed };
}

/**
 * Questionnaire vu par un cabinet : une question découverte sur un extranet n'est gardée que si l'un de ses assureurs
 * est activé par le cabinet (les questions des autres assureurs ne le concernent pas et ne bloquent pas ses dossiers).
 * Aucun assureur choisi = tous les assureurs, comme pour `enabledInsurers` ailleurs.
 */
export function schemaForCabinet(schema: QuestionnaireSection[], enabledInsurers: string[]): QuestionnaireSection[] {
  if (!enabledInsurers.length) return schema;
  const enabled = new Set(enabledInsurers);
  const visible = (question: Question): boolean =>
    !question.discoveredOn?.length || question.discoveredOn.some(source => source.insurerId === null || enabled.has(source.insurerId));
  return schema
    .map(section => ({ ...section, questions: section.questions.filter(visible) }))
    .filter(section => !section.discovered || section.questions.length > 0);
}

/**
 * Questionnaire d'un dossier : seulement les questions connues des extranets choisis (`Insurer.questions`), plus celles
 * découvertes sur ces extranets. Si l'un d'eux n'a pas encore de liste pour le produit, on ne peut pas savoir ce qu'il
 * demande : rien n'est retiré. Les questions qui conditionnent une question gardée (`visibleIf`) sont gardées aussi.
 */
export function schemaForInsurers(
  schema: QuestionnaireSection[],
  insurers: { id: string; questions?: Record<string, string[]> }[],
  productId: string,
): QuestionnaireSection[] {
  const ids = insurers.map(insurer => insurer.id);
  const byDiscovery = schemaForCabinet(schema, ids);
  const lists = insurers.map(insurer => insurer.questions?.[productId]);
  if (!lists.length || lists.some(list => !list)) return byDiscovery;
  const known = new Set(lists.flat() as string[]);
  const all = byDiscovery.flatMap(section => section.questions);
  for (const question of all) {
    if (known.has(question.canonicalPath) && question.visibleIf) known.add(question.visibleIf.path);
  }
  return byDiscovery
    .map(section => ({
      ...section,
      questions: section.questions.filter(question => section.discovered || known.has(question.canonicalPath)),
    }))
    .filter(section => section.questions.length > 0);
}
