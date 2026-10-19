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
/** Nombre maximal de sinistres détaillés dans un dossier (lignes d'un tableau « Sinistres » d'extranet). */
export const MAX_CLAIMS = 6;
export const CLAIM_FIELDS = ['type', 'responsibility', 'date'] as const;
export type ClaimField = (typeof CLAIM_FIELDS)[number];
export type ClaimIndex = 1 | 2 | 3 | 4 | 5 | 6;
/**
 * Un sinistre = trois chemins plats indexés : `insuranceHistory.claims.<n>.type | responsibility | date` (n de 1 à 6).
 * Rester « à plat » garde le modèle tel quel : une question par chemin, même validation, même `CanonicalData`.
 */
export type ClaimPath = `insuranceHistory.claims.${ClaimIndex}.${ClaimField}`;

export const claimPath = (index: ClaimIndex, field: ClaimField): ClaimPath => `insuranceHistory.claims.${index}.${field}`;

const CLAIM_PATHS: readonly ClaimPath[] = Array.from({ length: MAX_CLAIMS }, (_, i) =>
  CLAIM_FIELDS.map(field => claimPath((i + 1) as ClaimIndex, field)),
).flat();

/** Rang (1 à 6) et rubrique d'un chemin de sinistre, ou null. */
export function parseClaimPath(path: string): { index: ClaimIndex; field: ClaimField } | null {
  const match = /^insuranceHistory\.claims\.([1-6])\.(type|responsibility|date)$/.exec(path);
  return match ? { index: Number(match[1]) as ClaimIndex, field: match[2] as ClaimField } : null;
}

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

  // ─── Détail des sinistres (une ligne par sinistre, voir CLAIM_PATHS) ───
  ...CLAIM_PATHS,
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
