import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { onCall } from "firebase-functions/v2/https";
import { assertCabinetAdmin } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { dossiersPath } from "../core/firestore-paths";
import {
  computeInsurerReliability,
  requireReliabilityPeriod,
  type ReliabilityJobInput,
  type ReliabilityOfferInput,
  type ReliabilityReportInput,
} from "../core/reliability.utils";
import {
  RELIABILITY_MAX_DOSSIERS,
  type ExtensionReportIssue,
  type ExtensionReportStep,
  type ExtranetReliabilityReport,
  type MissingField,
  type QuoteJobStatus,
} from "../shared/index.js";

/**
 * Fiabilité des extranets : bilan par assureur des tarifications du cabinet sur 7, 30 ou 90 jours, avec les incidents
 * signalés par l'extension sur chaque extranet (tous cabinets confondus : codes fermés, aucune donnée client).
 * Réservé aux admins du cabinet. Le calcul lui-même est dans core/reliability.utils.ts (testé sans Firestore).
 */

/** Incidents lus au plus sur la période (les plus récents) : un garde-fou de coût, largement au-dessus de l'usage. */
const MAX_EXTENSION_REPORTS = 5000;
/** Dossiers dont les sous-collections sont lues en même temps. */
const DOSSIER_READ_CONCURRENCY = 25;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Date Firestore (Timestamp) → millisecondes ; null si absente ou d'un autre type. */
function toMillis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

/** Applique `task` à chaque élément, `concurrency` à la fois au plus. */
async function mapBounded<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    results.push(...(await Promise.all(items.slice(i, i + concurrency).map(task))));
  }
  return results;
}

/**
 * Données : { days: 7 | 30 | 90 } → ExtranetReliabilityReport.
 *
 * Lectures (coût par appel) : au plus RELIABILITY_MAX_DOSSIERS + 1 dossiers, puis pour chacun ses jobs et ses offres
 * (une lecture par document, et au moins une par requête même vide), et au plus MAX_EXTENSION_REPORTS incidents.
 * Seuls les champs utiles sont demandés (`select`) : ni les données du dossier ni `quoteData` ne quittent Firestore.
 */
export const extranets = onCall(CALLABLE_OPTIONS, async (request): Promise<ExtranetReliabilityReport> => {
  const { cabinetId } = await assertCabinetAdmin(request);
  const days = requireReliabilityPeriod(request.data?.days);

  const db = admin.firestore();
  const nowMs = Date.now();
  const sinceMs = nowMs - days * DAY_MS;
  const since = Timestamp.fromMillis(sinceMs);

  // Dossiers modifiés sur la période, les plus récents d'abord (index mono-champ : pas d'index composite).
  // Chaque lancement de tarification (relance comprise) met `updatedAt` du dossier à jour (tarification-lancer) : un
  // dossier tarifé sur la période est donc toujours lu. Les dossiers de la corbeille sont gardés : la tarification
  // a bien eu lieu et l'extranet a bien répondu (ou non), le bilan de l'extranet doit en tenir compte.
  const [dossiers, reports] = await Promise.all([
    db
      .collection(dossiersPath(cabinetId))
      .where("updatedAt", ">=", since)
      .orderBy("updatedAt", "desc")
      .limit(RELIABILITY_MAX_DOSSIERS + 1)
      .select()
      .get(),
    // Incidents de toute la plateforme (sans cabinet ni donnée client) : index mono-champ sur `at`.
    db
      .collection("ci_extensionReports")
      .where("at", ">=", since)
      .orderBy("at", "desc")
      .limit(MAX_EXTENSION_REPORTS)
      .select("insurerId", "step", "issue", "at")
      .get(),
  ]);

  const truncated = dossiers.size > RELIABILITY_MAX_DOSSIERS;
  const dossierRefs = dossiers.docs.slice(0, RELIABILITY_MAX_DOSSIERS).map(doc => doc.ref);

  const perDossier = await mapBounded(dossierRefs, DOSSIER_READ_CONCURRENCY, async ref => {
    const [jobs, offers] = await Promise.all([
      ref.collection("ci_quoteJobs").select("status", "attempts", "requestedAt", "missingFields").get(),
      ref.collection("ci_offers").select("source", "capturedAt").get(),
    ]);
    return {
      jobs: jobs.docs.map((doc): ReliabilityJobInput => ({
        dossierId: ref.id,
        insurerId: doc.id,
        status: doc.get("status") as QuoteJobStatus,
        attempts: typeof doc.get("attempts") === "number" ? (doc.get("attempts") as number) : null,
        requestedAtMs: toMillis(doc.get("requestedAt")),
        missingFieldLabels: ((doc.get("missingFields") as MissingField[] | undefined) ?? [])
          .map(field => field?.label)
          .filter((label): label is string => typeof label === "string" && label.trim() !== ""),
      })),
      offers: offers.docs.map((doc): ReliabilityOfferInput => ({
        dossierId: ref.id,
        insurerId: doc.id,
        source: doc.get("source") === "auto" || doc.get("source") === "manual" ? doc.get("source") : null,
        capturedAtMs: toMillis(doc.get("capturedAt")),
      })),
    };
  });

  const insurers = computeInsurerReliability({
    jobs: perDossier.flatMap(d => d.jobs),
    offers: perDossier.flatMap(d => d.offers),
    reports: reports.docs
      .filter(doc => typeof doc.get("insurerId") === "string")
      .map((doc): ReliabilityReportInput => ({
        insurerId: doc.get("insurerId") as string,
        step: doc.get("step") as ExtensionReportStep,
        issue: doc.get("issue") as ExtensionReportIssue,
        atMs: toMillis(doc.get("at")),
      })),
    sinceMs,
    nowMs,
  });

  return {
    periodDays: days,
    generatedAt: new Date(nowMs).toISOString(),
    dossiersRead: dossierRefs.length,
    truncated,
    insurers,
  };
});
