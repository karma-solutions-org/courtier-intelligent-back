// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
import { CanonicalData, FixedCanonicalPath } from './canonical-paths.js';
import type { QuestionnaireSection } from './models.js';
import { isAnswered, isQuestionVisible, questionsOf, validateAnswer } from './questionnaire.js';

/**
 * Pré-remplissage du véhicule par sa plaque d'immatriculation (function `vehicules-rechercher`).
 * Tout se base sur les chemins canoniques du questionnaire, jamais sur l'id du produit : le produit Auto
 * et ses copies faites par un cabinet (`cab-…`, `replaces: 'auto'`) en profitent de la même façon.
 */

/** Plaque normalisée : SIV (depuis 2009, « AB-123-CD ») ou ancien format FNI (« 1234 AB 75 »). */
export interface NormalizedPlate {
  format: 'SIV' | 'FNI';
  /** Forme affichée et enregistrée dans le dossier. */
  plate: string;
}

// SIV : les lettres I, O et U ne sont jamais utilisées, « SS » non plus, et le bloc de chiffres ne vaut jamais 000.
const SIV = /^([A-HJ-NP-TV-Z]{2})(\d{3})([A-HJ-NP-TV-Z]{2})$/;
// FNI : 1 à 4 chiffres, 1 à 3 lettres, puis le département (2 chiffres, 2A/2B, ou 971 à 976 outre-mer).
const FNI = /^(\d{1,4})([A-Z]{1,3})(\d{2}|2A|2B|97[1-6])$/;

/** Accepte espaces, tirets, points et minuscules ; renvoie `null` si ce n'est pas une plaque française. */
export function normalizeRegistration(raw: unknown): NormalizedPlate | null {
  if (typeof raw !== 'string' || raw.length > 20) return null;
  const compact = raw.toUpperCase().replace(/[\s.-]/g, '');
  const siv = SIV.exec(compact);
  if (siv && siv[2] !== '000' && siv[1] !== 'SS' && siv[3] !== 'SS') {
    return { format: 'SIV', plate: `${siv[1]}-${siv[2]}-${siv[3]}` };
  }
  const fni = FNI.exec(compact);
  if (fni && Number(fni[1]) > 0) {
    return { format: 'FNI', plate: `${fni[1]} ${fni[2]} ${fni[3]}` };
  }
  return null;
}

/** Énergies du questionnaire Auto (valeurs des choix de `vehicle.energyType`). */
export type VehicleEnergy = 'essence' | 'diesel' | 'hybride' | 'hybride_rechargeable' | 'electrique' | 'gpl' | 'ethanol';

/** Données du véhicule renvoyées par la function ; un champ inconnu du fournisseur est absent, jamais inventé. */
export interface VehicleInfo {
  plate: string;
  brand?: string;
  model?: string;
  version?: string;
  /** AAAA-MM-JJ. */
  firstRegistrationDate?: string;
  fiscalPower?: number;
  energyType?: VehicleEnergy;
  vehicleType?: 'voiture' | 'utilitaire' | 'moto';
}

/** Chemins du questionnaire que la recherche peut remplir (en plus de la plaque elle-même). */
export const VEHICLE_LOOKUP_PATHS = [
  'vehicle.brand',
  'vehicle.model',
  'vehicle.version',
  'vehicle.firstRegistrationDate',
  'vehicle.fiscalPower',
  'vehicle.energyType',
  'vehicle.vehicleType',
] as const satisfies readonly FixedCanonicalPath[];

/** Les données du véhicule, rangées par chemin canonique. */
export function vehicleInfoToAnswers(info: VehicleInfo): CanonicalData {
  const answers: CanonicalData = {
    'vehicle.brand': info.brand,
    'vehicle.model': info.model,
    'vehicle.version': info.version,
    'vehicle.firstRegistrationDate': info.firstRegistrationDate,
    'vehicle.fiscalPower': info.fiscalPower,
    'vehicle.energyType': info.energyType,
    'vehicle.vehicleType': info.vehicleType,
  };
  return Object.fromEntries(Object.entries(answers).filter(([, value]) => value !== undefined && value !== '')) as CanonicalData;
}

/** Le questionnaire demande la plaque et au moins un champ que la recherche sait remplir. */
export function supportsVehicleLookup(schema: QuestionnaireSection[]): boolean {
  const paths = new Set(questionsOf(schema).map(q => q.canonicalPath));
  return paths.has('vehicle.registration') && VEHICLE_LOOKUP_PATHS.some(path => paths.has(path));
}

/**
 * Réponses à appliquer au dossier : seulement les questions du questionnaire, visibles, encore VIDES
 * (une réponse déjà saisie n'est jamais écrasée) et dont la valeur est acceptée par la question
 * (un choix absent de la copie du cabinet est ignoré).
 */
export function prefillAnswers(schema: QuestionnaireSection[], data: CanonicalData, found: CanonicalData): CanonicalData {
  const patch: CanonicalData = {};
  for (const question of questionsOf(schema)) {
    const path = question.canonicalPath;
    const value = found[path];
    if (value === undefined || value === null) continue;
    if (!isQuestionVisible(question, data) || isAnswered(data[path])) continue;
    const answer = question.withKnowledge && typeof value === 'number' ? { value, knowledge: 'KNOWN' as const } : value;
    if (validateAnswer(question, answer) === null) patch[path] = answer;
  }
  return patch;
}
