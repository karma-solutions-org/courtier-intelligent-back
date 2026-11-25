// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
import type { ExtensionReportIssue, ExtensionReportStep } from './models.js';

/**
 * Fiabilité des extranets : bilan par assureur, calculé par la function `fiabilite-extranets` (admins du cabinet).
 * Aucune donnée client : des compteurs, des durées, des libellés de questions et des codes d'incident.
 */

/** Périodes proposées (en jours). */
export const RELIABILITY_PERIODS = [7, 30, 90] as const;
export type ReliabilityPeriod = (typeof RELIABILITY_PERIODS)[number];

/** Nombre maximal de dossiers lus pour un bilan (les plus récemment modifiés de la période). */
export const RELIABILITY_MAX_DOSSIERS = 500;

/** Un compteur nommé (question manquante, incident…), du plus fréquent au moins fréquent. */
export interface ReliabilityCount<T = string> {
  key: T;
  count: number;
}

/** Incident signalé par l'extension, toutes cabinets confondus (codes fermés, aucune donnée client). */
export interface ReliabilityIssue {
  step: ExtensionReportStep;
  issue: ExtensionReportIssue;
  count: number;
}

export interface InsurerReliability {
  insurerId: string;
  /** Tarifications de ce cabinet lancées sur la période (une par dossier et par assureur). */
  launched: number;
  /** Tarif obtenu (lu par l'extension ou saisi à la main). */
  captured: number;
  /** Tarif lu automatiquement par l'extension. */
  capturedAuto: number;
  /** Tarif saisi à la main par le courtier (l'extension n'a pas abouti, ou n'a pas été utilisée). */
  capturedManual: number;
  failed: number;
  /** En attente d'une information que le dossier ne contient pas. */
  needsInfo: number;
  /** Encore en cours (analyse, remplissage, à valider sur l'extranet). */
  inProgress: number;
  cancelled: number;
  /** Part des tarifications terminées (obtenues ou en échec) qui ont abouti : null sans tarification terminée. */
  successRate: number | null;
  /** Nombre moyen de lancements par dossier (relances comprises) : null sans tarification. */
  averageAttempts: number | null;
  /** Délai médian, en minutes, entre le lancement et le tarif lu automatiquement : null sans tarif automatique. */
  medianMinutesToPrice: number | null;
  /** Questions qui ont le plus souvent manqué (libellés du questionnaire), 5 au plus. */
  topMissingFields: ReliabilityCount[];
  /** Incidents signalés par l'extension sur cet extranet, tous cabinets confondus, 5 au plus. */
  platformIssues: ReliabilityIssue[];
  /** Total des incidents signalés sur cet extranet, tous cabinets confondus. */
  platformIssuesTotal: number;
}

export interface ExtranetReliabilityReport {
  periodDays: ReliabilityPeriod;
  /** Date du calcul (ISO 8601). */
  generatedAt: string;
  /** Dossiers lus ; `truncated` : la limite RELIABILITY_MAX_DOSSIERS a été atteinte, le bilan est partiel. */
  dossiersRead: number;
  truncated: boolean;
  /** Assureurs ayant au moins une tarification du cabinet ou un incident, du plus utilisé au moins utilisé. */
  insurers: InsurerReliability[];
}

/** Libellés français des étapes de l'extension. */
export const EXTENSION_REPORT_STEP_LABELS: Record<ExtensionReportStep, string> = {
  analyze: 'Analyse de la page',
  mapping: 'Association des champs',
  fill: 'Remplissage',
  detect: 'Détection du résultat',
  extract: 'Lecture du tarif',
  confirm: 'Vérification du tarif',
  write: 'Enregistrement',
};

/** Libellés français des incidents signalés par l'extension. */
export const EXTENSION_REPORT_ISSUE_LABELS: Record<ExtensionReportIssue, string> = {
  premium_not_found: 'Prime introuvable sur la page de résultat',
  ai_unavailable: 'IA indisponible',
  ai_unusable: "Réponse de l'IA inutilisable",
  capture_rejected: 'Tarif lu refusé par le courtier',
  offer_write_failed: "Échec d'enregistrement de l'offre",
  no_fields: 'Aucun champ reconnu',
  no_field_mapped: 'Aucun champ associé au dossier',
  memory_invalidated: 'Mémoire du formulaire invalidée',
  fill_failed: 'Champ impossible à remplir',
  job_update_failed: "Échec d'enregistrement de l'avancement",
  step_blocked: 'Étape bloquée (champ obligatoire)',
  advance_refused: "Étape refusée par l'extranet",
};

/** Médiane d'une liste de nombres ; null si elle est vide. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Les `limit` clés les plus fréquentes d'une liste (à égalité, ordre alphabétique). */
export function topCounts(keys: string[], limit = 5): ReliabilityCount[] {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}
