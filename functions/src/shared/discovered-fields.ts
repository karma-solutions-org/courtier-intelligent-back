// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
// Champs découverts sur les extranets : quand l'extension rencontre un champ sans équivalent dans l'application,
// il est signalé au serveur (function champs-signaler) qui l'ajoute automatiquement au questionnaire du produit,
// dans la section « Questions des assureurs ». Règles communes à l'extension (ce qui est signalé) et au serveur
// (filtre, fusion des doublons, construction de la question).
import { ExtraCanonicalPath } from './canonical-paths.js';
import { DiscoverySource, FormFieldKind, Question, QuestionChoice, QuestionnaireSection, QuestionType } from './models.js';
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
    discoveredOn: [{ insurerId: source.insurerId, origin: source.origin, fieldKey: field.fieldKey.slice(0, 200), required: field.required === true }],
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
  const sections = schema.map(section => ({
    ...section,
    questions: section.questions.map(question => ({ ...question, ...(question.discoveredOn ? { discoveredOn: question.discoveredOn.map(s => ({ ...s })) } : {}) })),
  }));
  let discovered = sections.find(section => section.discovered);
  const added: Question[] = [];
  const mapping: Record<string, string> = {};
  const taken = new Set(sections.flatMap(section => section.questions.map(question => question.canonicalPath as string)));

  for (const field of fields.slice(0, DISCOVERED_MAX_FIELDS_PER_REPORT)) {
    if (!isRelevantField(field)) continue;
    // Même champ du même extranet (libellé ou choix modifiés par l'assureur) : la question est mise à jour, pas doublée.
    const known = findBySource(sections, source.origin, field.fieldKey);
    if (known) {
      refreshFromField(known.question, known.entry, field);
      if (field.required) known.entry.required = true;
      mapping[field.fieldKey] = known.question.canonicalPath;
      if (field.required) {
        known.question.required = true;
        if (known.question.withKnowledge) known.question.mustBeKnown = true;
      }
      continue;
    }
    const same = findSameQuestion(sections, field);
    if (same) {
      mapping[field.fieldKey] = same.canonicalPath;
      // L'extranet l'exige : la question existante devient obligatoire. Un champ facultatif ne retire jamais l'exigence.
      if (field.required) {
        same.required = true;
        if (same.withKnowledge) same.mustBeKnown = true;
      }
      if (same.discoveredOn && !same.discoveredOn.some(s => s.origin === source.origin && s.fieldKey === field.fieldKey)) {
        same.discoveredOn = [...same.discoveredOn, { ...source, fieldKey: field.fieldKey, required: field.required === true }].slice(-20);
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

/** Parcours menés jusqu'au tarif sans le champ avant que sa question ne soit plus posée pour cet extranet. */
export const ABSENT_AFTER_RUNS = 3;
/** Plafond des champs d'un constat (tous les champs vus sur un parcours). */
export const SIGHTING_MAX_FIELDS = 300;

/** Question découverte rattachée à ce champ de cet extranet (section « Questions des assureurs » seulement). */
function findBySource(schema: QuestionnaireSection[], origin: string, fieldKey: string): { question: Question; entry: DiscoverySource } | null {
  for (const section of schema) {
    if (!section.discovered) continue;
    for (const question of section.questions) {
      const entry = question.discoveredOn?.find(s => s.origin === origin && s.fieldKey === fieldKey);
      if (entry) return { question, entry };
    }
  }
  return null;
}

/**
 * Le champ est revu sur l'extranet : il redevient présent, et si la question n'appartient qu'à cet extranet, elle
 * prend son libellé et ses choix actuels (une question partagée garde ceux de la fusion). Renvoie vrai si quelque
 * chose a changé.
 */
function refreshFromField(question: Question, entry: DiscoverySource, field: Pick<DiscoveredFieldInput, 'label' | 'options'>): boolean {
  let changed = false;
  if (entry.absent || entry.missedRuns) {
    delete entry.absent;
    delete entry.missedRuns;
    changed = true;
  }
  if (question.discoveredOn?.length !== 1) return changed;
  const label = cleanLabel(field.label);
  if (label.length >= 3 && isRelevantField({ label, inputType: 'text', name: null }) && label !== question.label) {
    question.label = label;
    changed = true;
  }
  if (question.type === 'choice') {
    const choices = usableChoices(field.options);
    if (choices.length && JSON.stringify(choices) !== JSON.stringify(question.choices ?? [])) {
      question.choices = choices;
      changed = true;
    }
  }
  return changed;
}

/**
 * Constat d'un parcours mené jusqu'au tarif sur un extranet : tous les champs vus, à toutes les étapes. Pure.
 * - champ revu : la question est mise à jour (libellé, choix) et redevient présente ;
 * - champ absent : compté ; après ABSENT_AFTER_RUNS parcours d'affilée, la question n'est plus posée pour cet extranet
 *   (`absent`). Rien n'est supprimé : les réponses déjà données restent, et la question revient si le champ réapparaît.
 * Seules les questions découvertes sont touchées, jamais celles du catalogue.
 */
export function applySighting(
  schema: QuestionnaireSection[],
  fields: Pick<DiscoveredFieldInput, 'fieldKey' | 'label' | 'options'>[],
  origin: string,
): { schema: QuestionnaireSection[]; changed: boolean } {
  const byKey = new Map(fields.slice(0, SIGHTING_MAX_FIELDS).map(field => [field.fieldKey, field]));
  let changed = false;
  const next = schema.map(section => {
    if (!section.discovered) return section;
    return {
      ...section,
      questions: section.questions.map(original => {
        if (!original.discoveredOn?.some(s => s.origin === origin)) return original;
        const question = { ...original, discoveredOn: original.discoveredOn.map(s => ({ ...s })) };
        for (const entry of question.discoveredOn) {
          if (entry.origin !== origin) continue;
          const field = byKey.get(entry.fieldKey);
          if (field) {
            if (refreshFromField(question, entry, field)) changed = true;
            continue;
          }
          entry.missedRuns = (entry.missedRuns ?? 0) + 1;
          if (entry.missedRuns >= ABSENT_AFTER_RUNS) entry.absent = true;
          changed = true;
        }
        return question;
      }),
    };
  });
  return { schema: next, changed };
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
  const enabled = enabledInsurers.length ? new Set(enabledInsurers) : null;
  // Un extranet où le champ a disparu (`absent`) ne compte plus.
  const sourcesOf = (question: Question) =>
    (question.discoveredOn ?? []).filter(source => !source.absent && (!enabled || source.insurerId === null || enabled.has(source.insurerId)));
  const visible = (question: Question): boolean => !question.discoveredOn?.length || sourcesOf(question).length > 0;
  return schema
    .map(section => ({ ...section, questions: section.questions.filter(visible).map(question => withRequirement(question, sourcesOf(question))) }))
    .filter(section => !section.discovered || section.questions.length > 0);
}

/**
 * Question découverte : obligatoire seulement si l'un des extranets visés l'exige (une question obligatoire pour Oyat ne
 * bloque pas un dossier qui ne vise que Zephir). Sources enregistrées avant cette règle (sans `required`) : on garde
 * l'exigence globale de la question.
 */
function withRequirement(question: Question, sources: DiscoverySource[]): Question {
  if (!question.discoveredOn?.length || !question.discoveredOn.some(source => source.required !== undefined)) return question;
  const required = sources.some(source => source.required ?? question.required);
  return required === question.required ? question : { ...question, required, ...(question.withKnowledge ? { mustBeKnown: required } : {}) };
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
