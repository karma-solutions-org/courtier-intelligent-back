// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
import type { DossierStatus } from './statuses.js';

/** Proposition et suivi (Epic E14) : règles communes à l'app et aux functions. */

/** Statuts où l'onglet Proposition est ouvert (dès qu'une offre est retenue). */
export const PROPOSAL_DOSSIER_STATUSES: DossierStatus[] = ['decision', 'proposition_envoyee', 'souscrit', 'refuse', 'sans_suite'];

/** Délai sans réponse avant une relance du courtier, et délai minimal entre deux relances (jours). */
export const PROPOSAL_REMINDER_DAYS = 7;

export const PROPOSAL_MESSAGE_MAX = 2000;
export const CONTRACT_NUMBER_MAX = 50;

/** Numéro de contrat : obligatoire pour un dossier souscrit. Renvoie le problème, ou `null` s'il est valable. */
export function validateContractNumber(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return 'Le numéro de contrat est obligatoire.';
  if (text.length > CONTRACT_NUMBER_MAX) return `Le numéro de contrat ne doit pas dépasser ${CONTRACT_NUMBER_MAX} caractères.`;
  return null;
}

/**
 * Date d'effet « AAAA-MM-JJ » : date réelle, entre un an avant et deux ans après `today`.
 * Renvoie le problème, ou `null` si elle est valable.
 */
export function validateEffectiveDate(value: unknown, today: Date = new Date()): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return 'La date d’effet est obligatoire (AAAA-MM-JJ).';
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return 'La date d’effet n’est pas une date valide.';
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const ref = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (date.getTime() < ref - 366 * dayMs || date.getTime() > ref + 2 * 366 * dayMs) {
    return 'La date d’effet doit être comprise entre un an avant et deux ans après aujourd’hui.';
  }
  return null;
}
