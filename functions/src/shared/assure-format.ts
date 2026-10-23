// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
import { foldText } from './text.js';

// Formats d'un assuré, partagés par l'app (validateurs du formulaire) et les règles Firestore
// (firestore.rules, bloc « assures » du repo back) : modifier les deux ensemble.

/** Email : « x@y.zz » sans espace. Les règles appliquent l'équivalent `[^ @]+@[^ @]+[.][^ @]{2,}`. */
export const ASSURE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** SIRET : 14 chiffres (espaces retirés avant l'enregistrement), réservé aux assurés professionnels. */
export const ASSURE_SIRET_PATTERN = /^\d{14}$/;
/** Code postal français : 5 chiffres. */
export const ASSURE_POSTAL_CODE_PATTERN = /^\d{5}$/;
/** Date de naissance : AAAA-MM-JJ. */
export const ASSURE_BIRTH_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Longueurs maximales contrôlées par les règles Firestore. */
export const ASSURE_MAX_LENGTHS = {
  firstName: 100,
  lastName: 100,
  companyName: 200,
  email: 254,
  phone: 30,
  street: 200,
  city: 100,
} as const;

/** Champs d'un assuré comparés pour repérer un doublon. */
export interface AssureIdentity {
  firstName?: string | null;
  lastName?: string | null;
  birthDate?: string | null;
  email?: string | null;
  siret?: string | null;
  companyName?: string | null;
}

export type AssureDuplicateReason = 'siret' | 'email' | 'nom_naissance' | 'raison_sociale';

/** Texte comparable : minuscules, sans accents ni espaces superflus. */
export function normalizeIdentityText(value: string | null | undefined): string {
  return foldText(value)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pourquoi `candidate` ressemble à `existing` (vide : pas un doublon). Même SIRET, même email, même nom + date de
 * naissance, ou même raison sociale. Utilisé par l'app (avertissement) et par la function `assures-verifierDoublon`.
 */
export function duplicateReasons(candidate: AssureIdentity, existing: AssureIdentity): AssureDuplicateReason[] {
  const reasons: AssureDuplicateReason[] = [];
  const siret = (candidate.siret ?? '').replace(/\s/g, '');
  if (siret && siret === (existing.siret ?? '').replace(/\s/g, '')) reasons.push('siret');
  const email = normalizeIdentityText(candidate.email);
  if (email && email === normalizeIdentityText(existing.email)) reasons.push('email');
  const name = normalizeIdentityText(`${candidate.firstName ?? ''} ${candidate.lastName ?? ''}`);
  if (
    name &&
    candidate.birthDate &&
    candidate.birthDate === existing.birthDate &&
    name === normalizeIdentityText(`${existing.firstName ?? ''} ${existing.lastName ?? ''}`)
  ) {
    reasons.push('nom_naissance');
  }
  const company = normalizeIdentityText(candidate.companyName);
  if (company && company === normalizeIdentityText(existing.companyName)) reasons.push('raison_sociale');
  return reasons;
}
