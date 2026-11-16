// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
/**
 * Bornes métier des réponses du questionnaire, par chemin canonique : elles valent pour tous les produits (catalogue ou
 * produit d'un cabinet) sans republier le catalogue. Appliquées par `validateAnswer` (serveur : dossiers-sauvegarder,
 * tarification) et affichées par le champ du questionnaire dans l'app.
 */
export interface AnswerConstraint {
  /** Nombre : valeur minimale acceptée. */
  min?: number;
  /** Nombre : valeur maximale acceptée. */
  max?: number;
  /** Nombre : entier attendu (un nombre de sinistres, une puissance fiscale). */
  integer?: boolean;
  /** Date : pas après aujourd'hui (une naissance, un permis, un sinistre passé). */
  notInFuture?: boolean;
  /** Date : année minimale (une date avant n'est pas plausible). */
  minYear?: number;
}

/** Date passée et plausible. */
const PAST_DATE: AnswerConstraint = { notInFuture: true, minYear: 1900 };
/** Nombre de sinistres déclarés. */
const CLAIMS_COUNT: AnswerConstraint = { min: 0, max: 50, integer: true };

export const ANSWER_CONSTRAINTS: Readonly<Record<string, AnswerConstraint>> = {
  'client.birthDate': PAST_DATE,
  'driver.birthDate': PAST_DATE,
  'driver.licenseDate': PAST_DATE,
  'vehicle.firstRegistrationDate': PAST_DATE,
  'vehicle.purchaseDate': PAST_DATE,
  'vehicle.fiscalPower': { min: 1, max: 100, integer: true },
  'vehicle.vehicleValue': { min: 0, max: 10_000_000 },
  'insuranceHistory.previousContractStartDate': PAST_DATE,
  // Échéance du contrat en cours : elle est le plus souvent à venir.
  'insuranceHistory.previousContractEndDate': { minYear: 1900 },
  'insuranceHistory.terminationDate': PAST_DATE,
  'insuranceHistory.seniority': { min: 0, max: 1200, integer: true },
  // Coefficient de réduction-majoration (CRM) : 0,50 au mieux, 3,50 au pire (barème réglementaire).
  'insuranceHistory.bonusMalus': { min: 0.5, max: 3.5 },
  'insuranceHistory.claimsCount': CLAIMS_COUNT,
  'insuranceHistory.responsibleClaimsCount': CLAIMS_COUNT,
  'insuranceHistory.nonResponsibleClaimsCount': CLAIMS_COUNT,
};

/** Dates des sinistres détaillés (`insuranceHistory.claims.1.date`, `…2.date`…). */
const CLAIM_DATE = /^insuranceHistory\.claims\.\d+\.date$/;

/** Bornes d'un champ, ou null s'il n'en a pas. */
export function constraintFor(path: string): AnswerConstraint | null {
  return ANSWER_CONSTRAINTS[path] ?? (CLAIM_DATE.test(path) ? PAST_DATE : null);
}

/**
 * Dernière date acceptée pour « pas dans le futur », au format AAAA-MM-JJ. Une marge de 14 h couvre tous les fuseaux :
 * le serveur (UTC) ne refuse pas la date du jour saisie en France, ni le navigateur celle saisie à Nouméa.
 */
export function latestPastDate(now: number = Date.now()): string {
  return new Date(now + 14 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Nombre hors bornes : message à afficher, ou null s'il est acceptable. */
export function numberConstraintError(label: string, constraint: AnswerConstraint, value: number): string | null {
  if (constraint.integer && !Number.isInteger(value)) return `« ${label} » : nombre entier attendu.`;
  if (constraint.min !== undefined && value < constraint.min) return `« ${label} » : ${formatNumber(constraint.min)} minimum.`;
  if (constraint.max !== undefined && value > constraint.max) return `« ${label} » : ${formatNumber(constraint.max)} maximum.`;
  return null;
}

/** Date (AAAA-MM-JJ) hors bornes : message à afficher, ou null si elle est acceptable. */
export function dateConstraintError(label: string, constraint: AnswerConstraint, value: string, now: number = Date.now()): string | null {
  if (constraint.minYear !== undefined && Number(value.slice(0, 4)) < constraint.minYear) return `« ${label} » : date trop ancienne.`;
  if (constraint.notInFuture && value > latestPastDate(now)) return `« ${label} » : la date ne peut pas être dans le futur.`;
  return null;
}

/** 0.5 → « 0,5 », 10000000 → « 10 000 000 » (affichage français, sans dépendre de la locale du serveur). */
function formatNumber(value: number): string {
  const [integer, decimals] = String(value).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return decimals ? `${grouped},${decimals}` : grouped;
}
