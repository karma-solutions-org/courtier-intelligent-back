// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
// Même question, autre forme : chaque extranet pose ses questions avec ses mots (« sous l'emprise de l'alcool » chez
// l'un, « sous l'emprise d'un état alcoolique » chez l'autre). Règle UNIQUE, partagée par l'extension (cette question
// est-elle déjà dans le questionnaire ?) et le serveur (fusion des questions découvertes), pour qu'ils décident pareil.
import type { QuestionChoice, QuestionType } from './models.js';
import { foldText } from './text.js';

/** Forme de réponse d'une question : deux questions qui se répondent différemment ne sont pas la même. */
export interface AnswerShape {
  type: QuestionType;
  /** Libellés des choix (type `choice`). */
  choices?: readonly string[];
}

/** Question comparable : un libellé et sa forme de réponse. */
export interface ComparableQuestion {
  label: string;
  /** Forme de réponse ; absente (inconnue), elle n'empêche pas le rapprochement. */
  shape?: AnswerShape;
}

/** Mots qui ne font pas le sens d'une question (articles, pronoms, verbes d'appui). */
const STOPWORDS = new Set([
  'le', 'la', 'les', 'l', 'de', 'du', 'des', 'd', 'un', 'une', 'en', 'au', 'aux', 'a', 'et', 'ou', 'par', 'pour', 'sur',
  'dans', 'avec', 'sous', 'ce', 'cet', 'cette', 'ces', 'son', 'sa', 'ses', 'votre', 'vos', 'notre', 'nos', 'leur', 'leurs',
  'il', 'elle', 'ils', 'elles', 'on', 'vous', 'nous', 't', 's', 'se', 'qu', 'que', 'qui', 'quel', 'quelle', 'y',
  'est', 'sont', 'etait', 'faisait', 'fait', 'suite', 'avez', 'etes', 'ete', 'deja', 'actuellement',
]);

/**
 * Familles de mots ramenées à une racine commune (préfixe de 6 lettres inclus) : la racine seule ne rapproche pas
 * « alcoolique » d'« alcoolémie », ni « drogue » de « stupéfiant ».
 */
const SYNONYMS: Record<string, string> = {
  alcoolique: 'alcool', alcoolemie: 'alcool', alcoolise: 'alcool', ivresse: 'alcool',
  drogue: 'stupef', drogues: 'stupef', stupefiant: 'stupef', stupefiants: 'stupef', cannabis: 'stupef',
  voiture: 'vehicu', auto: 'vehicu', automobile: 'vehicu',
  resiliation: 'resili', resilie: 'resili', resiliee: 'resili',
  annulation: 'annul', annule: 'annul', annulee: 'annul',
  suspension: 'suspen', suspendu: 'suspen', suspendue: 'suspen',
  conducteurs: 'conduc', conducteur: 'conduc', conductrice: 'conduc',
};

/** Texte comparable : minuscules, sans accents ni ponctuation. */
function normalize(text: string): string {
  return foldText(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Racine d'un mot : famille connue, sinon le mot sans pluriel ni féminin (« assurées » = « assuré »), coupé à 7 lettres.
 * 7 et non moins : « assuré » et « assureur » doivent rester distincts.
 */
function stem(word: string): string {
  if (SYNONYMS[word]) return SYNONYMS[word];
  const singular = word.length > 4 ? word.replace(/[sx]$/, '') : word;
  const masculine = singular.length > 5 ? singular.replace(/ee$/, 'e') : singular;
  return SYNONYMS[masculine] ?? masculine.slice(0, 7);
}

/** Racines des mots qui font le sens de la question. */
export function questionStems(label: string): Set<string> {
  return new Set(
    normalize(label)
      .split(' ')
      .filter(word => word.length > 1 && !STOPWORDS.has(word))
      .map(stem),
  );
}

/** Seuil d'inclusion : presque tous les mots de la question la plus courte se retrouvent dans l'autre. */
const CONTAINMENT_MIN = 0.85;
/** Et les deux questions ne diffèrent pas trop en longueur (une question n'en contient pas une autre plus large). */
const OVERLAP_MIN = 0.6;
/** En deçà de OVERLAP_MIN mais au-dessus : une piste, pas la même question. */
const RELATED_OVERLAP_MIN = 0.3;

/**
 * Recouvrement de deux libellés : part des mots de la question la plus courte qu'on retrouve dans l'autre
 * (`containment`), et part des mots communs rapportée à la plus longue (`overlap`).
 */
export function compareLabels(a: string, b: string): { containment: number; overlap: number } {
  const left = questionStems(a);
  const right = questionStems(b);
  if (!left.size || !right.size) return { containment: 0, overlap: 0 };
  const common = [...left].filter(token => right.has(token)).length;
  return { containment: common / Math.min(left.size, right.size), overlap: common / Math.max(left.size, right.size) };
}

/**
 * Proximité de deux libellés (0 à 1). Mesure d'inclusion plutôt que de mots en commun : « alcool » et « état
 * alcoolique » sont la même question (tous les mots de l'une sont dans l'autre), « alcool » et « stupéfiant » non
 * (un mot de sens diffère), même si le reste de la phrase est identique. 0 sous les seuils.
 */
export function labelSimilarity(a: string, b: string): number {
  const { containment, overlap } = compareLabels(a, b);
  if (containment < CONTAINMENT_MIN || overlap < OVERLAP_MIN) return 0;
  return (containment + overlap) / 2;
}

/**
 * Question plus large ou plus précise que l'autre (« kilométrage annuel » / « kilométrage annuel parcouru estimé ») :
 * pas la même à coup sûr, mais une piste à proposer (à l'IA, au courtier).
 */
export function isRelatedLabel(a: string, b: string): boolean {
  const { containment, overlap } = compareLabels(a, b);
  return containment >= CONTAINMENT_MIN && overlap >= RELATED_OVERLAP_MIN;
}

const isYesNo = (choices: readonly string[] | undefined) =>
  !!choices && choices.length === 2 && choices.every(choice => /^(oui|non|yes|no)$/i.test(choice.trim()));

/** Forme de réponse ramenée à sa nature : un choix Oui / Non est un oui / non. */
function kindOf(shape: AnswerShape): QuestionType {
  return shape.type === 'choice' && isYesNo(shape.choices) ? 'boolean' : shape.type;
}

/** Deux questions se répondent-elles de la même façon ? Un choix doit partager au moins la moitié de ses options. */
export function sameAnswerShape(a: AnswerShape, b: AnswerShape): boolean {
  const kind = kindOf(a);
  if (kind !== kindOf(b)) return false;
  if (kind !== 'choice') return true;
  const left = new Set((a.choices ?? []).map(normalize));
  const right = (b.choices ?? []).map(normalize);
  const common = right.filter(choice => left.has(choice)).length;
  return common >= Math.min(left.size, right.length) / 2;
}

/** Forme de réponse d'une question à partir de son type et de ses choix. */
export function shapeOf(type: QuestionType, choices?: readonly QuestionChoice[]): AnswerShape {
  return { type, choices: choices?.map(choice => choice.label) };
}

/**
 * Question de `candidates` qui est la même que `wanted` (même sens, même forme de réponse), la plus proche, ou `null`.
 * Utilisée par le serveur pour fusionner, et par l'extension pour ne pas signaler une question déjà posée.
 */
export function findMatchingQuestion<T extends ComparableQuestion>(
  candidates: readonly T[],
  wanted: ComparableQuestion,
): { question: T; score: number } | null {
  let best: { question: T; score: number } | null = null;
  for (const question of candidates) {
    if (question.shape && wanted.shape && !sameAnswerShape(question.shape, wanted.shape)) continue;
    const score = labelSimilarity(question.label, wanted.label);
    if (score > 0 && (!best || score > best.score)) best = { question, score };
  }
  return best;
}
