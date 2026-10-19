// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
/**
 * Modèle canonique : le langage commun entre l'app, l'extension et l'IA.
 *
 * RÈGLE ABSOLUE : liste fermée. L'extension ne mappe jamais vers un chemin absent
 * de cette liste ; sans correspondance fiable, le champ reste `null`.
 *
 * Seule ouverture : les chemins `extra.<code>` des questions ajoutées au questionnaire à partir des champs
 * découverts sur les extranets (voir discovered-fields.ts). Ils n'existent que si une question les porte.
 */
export const CANONICAL_PATHS = [
  // ─── Client ───────────────────────────────────────────────
  'client.firstName',
  'client.lastName',
  'client.nationalId',
  'client.birthDate',
  'client.phone',
  'client.email',
  'client.address.street',
  'client.address.postalCode',
  'client.address.city',
  'client.address.country',

  // ─── Véhicule ─────────────────────────────────────────────
  'vehicle.registration',
  'vehicle.brand',
  'vehicle.model',
  'vehicle.version',
  'vehicle.firstRegistrationDate',
  'vehicle.fiscalPower',
  'vehicle.vehicleValue',
  'vehicle.vehicleType',
  'vehicle.usage',
  'vehicle.parkingType',
  'vehicle.energyType',
  'vehicle.parkingPostalCode',
  'vehicle.parkingCity',
  'vehicle.purchaseDate',

  // ─── Conducteur ───────────────────────────────────────────
  'driver.firstName',
  'driver.lastName',
  'driver.birthDate',
  'driver.birthCountry',
  'driver.licenseDate',
  'driver.licenseCountry',
  'driver.licenseType',
  'driver.profession',
  'driver.socioProfessionalCategory',
  'driver.phone',

  // ─── Historique d'assurance ───────────────────────────────
  'insuranceHistory.currentlyInsured',
  'insuranceHistory.previousInsurer',
  'insuranceHistory.previousContractStartDate',
  'insuranceHistory.previousContractEndDate',
  'insuranceHistory.seniority',
  'insuranceHistory.bonusMalus',
  'insuranceHistory.claimsCount',
  'insuranceHistory.responsibleClaimsCount',
  'insuranceHistory.nonResponsibleClaimsCount',
  'insuranceHistory.wasTerminated',
  'insuranceHistory.terminatedByInsurer',
  'insuranceHistory.terminationReason',
  'insuranceHistory.terminationDate',
] as const;

/** Chemin de la liste fermée (identité, véhicule, conducteur, historique). */
export type FixedCanonicalPath = (typeof CANONICAL_PATHS)[number];
/** Chemin d'une question ajoutée depuis un champ découvert sur un extranet. */
export type ExtraCanonicalPath = `extra.${string}`;
export type CanonicalPath = FixedCanonicalPath | ExtraCanonicalPath;

const EXTRA_PATH = /^extra\.[a-z0-9_]{1,60}$/;

export function isFixedCanonicalPath(path: string): path is FixedCanonicalPath {
  return (CANONICAL_PATHS as readonly string[]).includes(path);
}

export function isExtraPath(path: string): path is ExtraCanonicalPath {
  return EXTRA_PATH.test(path);
}

export function isCanonicalPath(path: string): path is CanonicalPath {
  return isFixedCanonicalPath(path) || isExtraPath(path);
}

/**
 * Niveau de connaissance d'une valeur sensible : ne jamais inventer de donnée.
 * `null` (non renseigné) ≠ `0` ; « l'assuré ne sait pas » ≠ « pas encore demandé ».
 */
export type Knowledge = 'KNOWN' | 'UNKNOWN' | 'DECLARED_UNKNOWN';

export interface KnownValue<T> {
  value: T | null;
  knowledge: Knowledge;
}

/** Valeur d'un champ canonique dans un dossier. */
export type CanonicalValue = string | number | boolean | KnownValue<number> | null;

/** Données d'un dossier, indexées par chemin canonique. */
export type CanonicalData = Partial<Record<CanonicalPath, CanonicalValue>>;
