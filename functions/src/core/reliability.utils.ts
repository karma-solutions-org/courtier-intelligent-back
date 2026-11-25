import { HttpsError } from "firebase-functions/v2/https";
import {
  median,
  RELIABILITY_PERIODS,
  topCounts,
  type ExtensionReportIssue,
  type ExtensionReportStep,
  type InsurerReliability,
  type QuoteJobStatus,
  type ReliabilityIssue,
  type ReliabilityPeriod,
} from "../shared/index.js";

/**
 * Fiabilité des extranets : calcul pur (aucun accès à Firestore) du bilan par assureur, à partir de listes simples.
 * La callable `fiabilite-extranets` lit les données et convertit les dates en millisecondes avant d'appeler ce module.
 */

/** Une tarification du cabinet : un job par dossier et par assureur (`ci_quoteJobs/{insurerId}`). */
export interface ReliabilityJobInput {
  dossierId: string;
  insurerId: string;
  status: QuoteJobStatus;
  /** Lancements du job (relances comprises) ; null s'il est absent. */
  attempts: number | null;
  /** Date du dernier lancement (ms) ; null s'il est absent (job jamais compté). */
  requestedAtMs: number | null;
  /** Libellés des questions qui manquaient au dossier. */
  missingFieldLabels: string[];
}

/** L'offre d'un dossier pour un assureur (`ci_offers/{insurerId}`). */
export interface ReliabilityOfferInput {
  dossierId: string;
  insurerId: string;
  source: "auto" | "manual" | null;
  capturedAtMs: number | null;
}

/** Un incident signalé par l'extension (`ci_extensionReports`), tous cabinets confondus. */
export interface ReliabilityReportInput {
  insurerId: string;
  step: ExtensionReportStep;
  issue: ExtensionReportIssue;
  atMs: number | null;
}

export interface ReliabilityInput {
  jobs: ReliabilityJobInput[];
  offers: ReliabilityOfferInput[];
  reports: ReliabilityReportInput[];
  /** Début de la période (ms, inclus). */
  sinceMs: number;
  /** Fin de la période (ms, inclus) : l'heure du calcul. */
  nowMs: number;
}

const IN_PROGRESS_STATUSES: QuoteJobStatus[] = ["requested", "analyzing", "filling", "awaiting_submit"];
const MAX_PLATFORM_ISSUES = 5;
const MAX_MISSING_FIELDS = 5;

/** Durée exprimée en dixièmes de minute (arrondi à 1 décimale). */
const roundTenth = (value: number) => Math.round(value * 10) / 10;

/** Période demandée : 7, 30 ou 90 jours (RELIABILITY_PERIODS). */
export function requireReliabilityPeriod(value: unknown): ReliabilityPeriod {
  if (!(RELIABILITY_PERIODS as readonly unknown[]).includes(value)) {
    throw new HttpsError(
      "invalid-argument",
      `Période invalide : choisissez ${RELIABILITY_PERIODS.join(", ").replace(/, (\d+)$/, " ou $1")} jours.`,
    );
  }
  return value as ReliabilityPeriod;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function emptyInsurer(insurerId: string): InsurerReliability {
  return {
    insurerId,
    launched: 0,
    captured: 0,
    capturedAuto: 0,
    capturedManual: 0,
    failed: 0,
    needsInfo: 0,
    inProgress: 0,
    cancelled: 0,
    successRate: null,
    averageAttempts: null,
    medianMinutesToPrice: null,
    topMissingFields: [],
    platformIssues: [],
    platformIssuesTotal: 0,
  };
}

/** Incidents d'un assureur regroupés par étape et code, du plus fréquent au moins fréquent (5 au plus). */
function groupIssues(reports: ReliabilityReportInput[]): ReliabilityIssue[] {
  const counts = new Map<string, ReliabilityIssue>();
  for (const { step, issue } of reports) {
    const key = `${step}|${issue}`;
    const entry = counts.get(key) ?? { step, issue, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.step.localeCompare(b.step) || a.issue.localeCompare(b.issue))
    .slice(0, MAX_PLATFORM_ISSUES);
}

/**
 * Bilan par assureur : tarifications du cabinet lancées sur la période (`requestedAt` entre `sinceMs` et `nowMs`)
 * et incidents de la plateforme sur la même période. Assureurs triés du plus utilisé au moins utilisé, puis par
 * nombre d'incidents, puis par identifiant.
 */
export function computeInsurerReliability({
  jobs,
  offers,
  reports,
  sinceMs,
  nowMs,
}: ReliabilityInput): InsurerReliability[] {
  const inPeriod = (ms: number | null): ms is number => ms !== null && ms >= sinceMs && ms <= nowMs;
  const offerByJob = new Map(offers.map(offer => [`${offer.dossierId}/${offer.insurerId}`, offer]));

  const jobsByInsurer = groupBy(
    jobs.filter(job => inPeriod(job.requestedAtMs)),
    job => job.insurerId,
  );
  const reportsByInsurer = groupBy(
    reports.filter(report => inPeriod(report.atMs)),
    report => report.insurerId,
  );

  const insurerIds = new Set([...jobsByInsurer.keys(), ...reportsByInsurer.keys()]);
  const result = [...insurerIds].map(insurerId => {
    const stats = emptyInsurer(insurerId);
    const insurerJobs = jobsByInsurer.get(insurerId) ?? [];
    const attempts: number[] = [];
    const minutesToPrice: number[] = [];
    const missingLabels: string[] = [];

    for (const job of insurerJobs) {
      stats.launched++;
      if (typeof job.attempts === "number" && Number.isFinite(job.attempts)) attempts.push(job.attempts);
      missingLabels.push(...job.missingFieldLabels);
      switch (job.status) {
        case "captured": {
          stats.captured++;
          const offer = offerByJob.get(`${job.dossierId}/${insurerId}`);
          if (offer?.source === "manual") stats.capturedManual++;
          if (offer?.source === "auto") {
            stats.capturedAuto++;
            // Délai lancement → tarif lu ; une offre antérieure au lancement (reprise d'une ancienne capture) est ignorée.
            if (offer.capturedAtMs !== null && job.requestedAtMs !== null) {
              const minutes = (offer.capturedAtMs - job.requestedAtMs) / 60_000;
              if (minutes >= 0) minutesToPrice.push(minutes);
            }
          }
          break;
        }
        case "failed":
          stats.failed++;
          break;
        case "needs_info":
          stats.needsInfo++;
          break;
        case "cancelled":
          stats.cancelled++;
          break;
        default:
          if (IN_PROGRESS_STATUSES.includes(job.status)) stats.inProgress++;
      }
    }

    const finished = stats.captured + stats.failed;
    stats.successRate = finished ? stats.captured / finished : null;
    stats.averageAttempts = attempts.length ? attempts.reduce((sum, n) => sum + n, 0) / attempts.length : null;
    const medianMinutes = median(minutesToPrice);
    stats.medianMinutesToPrice = medianMinutes === null ? null : roundTenth(medianMinutes);
    stats.topMissingFields = topCounts(missingLabels, MAX_MISSING_FIELDS);

    const insurerReports = reportsByInsurer.get(insurerId) ?? [];
    stats.platformIssues = groupIssues(insurerReports);
    stats.platformIssuesTotal = insurerReports.length;
    return stats;
  });

  return result.sort(
    (a, b) =>
      b.launched - a.launched ||
      b.platformIssuesTotal - a.platformIssuesTotal ||
      a.insurerId.localeCompare(b.insurerId),
  );
}
