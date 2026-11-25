// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
import { CanonicalData, CanonicalPath } from './canonical-paths.js';
import { QuestionnaireSection } from './models.js';
import { questionFor, validateAnswer } from './questionnaire.js';

/**
 * Reprise du dernier dossier du client (phase 2, lot C) : un nouveau dossier repart des réponses déjà données pour le
 * même produit. Le client (`client.*`) vient de sa fiche ; véhicule, conducteur et antécédents viennent du dossier
 * précédent. Les antécédents changent avec le temps (bonus-malus, sinistres, assureur actuel) : ils sont repris mais
 * marqués « à vérifier » jusqu'à ce que le courtier les confirme ou les corrige.
 */
export const REUSED_PATH_PREFIXES = ['vehicle.', 'driver.', 'insuranceHistory.'] as const;
export const TO_VERIFY_PATH_PREFIXES = ['insuranceHistory.'] as const;

/** Dossier dont les réponses ont été reprises. */
export interface ReusedFrom {
  dossierId: string;
  reference: string | null;
}

/**
 * Réponses reprises d'un dossier précédent : seulement celles que le questionnaire du nouveau dossier pose et qui y
 * restent valides (un choix retiré, une valeur hors des bornes actuelles n'est pas reprise). Vides ignorées.
 */
export function reusableAnswers(
  schema: QuestionnaireSection[],
  previous: CanonicalData,
): { data: CanonicalData; toVerify: CanonicalPath[] } {
  const data: Record<string, unknown> = {};
  const toVerify: CanonicalPath[] = [];
  for (const [path, value] of Object.entries(previous ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    if (!REUSED_PATH_PREFIXES.some(prefix => path.startsWith(prefix))) continue;
    const question = questionFor(schema, path);
    if (!question || validateAnswer(question, value) !== null) continue;
    data[path] = value;
    if (TO_VERIFY_PATH_PREFIXES.some(prefix => path.startsWith(prefix))) toVerify.push(path as CanonicalPath);
  }
  return { data: data as CanonicalData, toVerify };
}
