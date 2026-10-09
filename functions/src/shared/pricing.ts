// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
import { CanonicalData, CanonicalPath, isCanonicalPath } from './canonical-paths.js';
import type { Guarantee, Insurer, MissingField, Offer, OfferGuarantee, Question, QuestionnaireSection, QuoteJob } from './models.js';
import { buildQuoteData, isAnswered, questionsOf } from './questionnaire.js';
import type { DossierStatus, QuoteJobStatus } from './statuses.js';

/**
 * Tarification d'un dossier : règles communes à l'app (onglet Tarification) et aux Cloud Functions `tarification-*`
 * (l'app n'est jamais crue sur parole).
 */

/** Statuts du dossier où l'on peut tarifer : le besoin doit être validé. */
export const PRICING_DOSSIER_STATUSES: DossierStatus[] = ['besoin_valide', 'tarification', 'comparaison'];

/** Jobs pris en charge par l'extension : on ne les relance pas, on rouvre l'extranet. */
export const ACTIVE_QUOTE_JOB_STATUSES: QuoteJobStatus[] = ['requested', 'analyzing', 'needs_info', 'filling', 'awaiting_submit'];

/** Un job se lance quand il n'existe pas encore, et se relance quand il a échoué. */
export function canLaunchQuoteJob(job: Pick<QuoteJob, 'status'> | null | undefined): boolean {
  return !job || job.status === 'failed';
}

/** Assureurs proposés pour un produit : ceux qui le tarifent, parmi ceux activés par le cabinet (aucun choix = tous). */
export function insurersForProduct(insurers: Insurer[], productId: string, enabledInsurers: string[]): Insurer[] {
  return insurers.filter(
    insurer => insurer.productsSupported.includes(productId) && (enabledInsurers.length === 0 || enabledInsurers.includes(insurer.id)),
  );
}

/**
 * `quoteData` d'un job : les réponses du questionnaire (voir `buildQuoteData`), plus les informations demandées
 * par un extranet hors questionnaire (champs manquants complétés par le courtier, gardées dans le dossier).
 */
export function buildJobQuoteData(schema: QuestionnaireSection[], data: CanonicalData): CanonicalData {
  const quoteData = buildQuoteData(schema, data);
  const inSchema = new Set<string>(questionsOf(schema).map(q => q.canonicalPath));
  for (const [path, value] of Object.entries(data)) {
    if (!inSchema.has(path) && isCanonicalPath(path) && isAnswered(value)) {
      quoteData[path] = value;
    }
  }
  return quoteData;
}

/** Question posée au courtier pour un champ manquant signalé par l'extension (toujours obligatoire). */
export function missingFieldQuestion(field: MissingField): Question {
  return {
    canonicalPath: field.canonicalPath,
    label: field.label,
    type: field.type,
    required: true,
    ...(field.choices?.length ? { choices: field.choices } : {}),
  };
}

/** Les chemins demandés par l'extension, sans doublon et uniquement dans le modèle canonique. */
export function missingPaths(fields: MissingField[]): CanonicalPath[] {
  return [...new Set(fields.map(f => f.canonicalPath).filter(isCanonicalPath))];
}

// ── Saisie manuelle d'une offre ────────────────────────────────────────────

/** Ce que le courtier saisit (le reste de l'offre est posé par le serveur). */
export type ManualOfferInput = Pick<Offer, 'quoteNumber' | 'premiumAnnual' | 'premiumMonthly' | 'deductibles' | 'guarantees' | 'exclusions'>;

/** Clé de la franchise générale dans `Offer.deductibles` (les autres clés sont des codes de garantie). */
export const GENERAL_DEDUCTIBLE = 'general';

const MAX_AMOUNT = 10_000_000;
const MAX_EXCLUSIONS = 30;
const MAX_TEXT = 300;

const isAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT;
const isOptionalAmount = (value: unknown): boolean => value === null || isAmount(value);

/** Contrôle une offre saisie à la main. `guaranteeCodes` : référentiel du produit. Renvoie la liste des problèmes. */
export function validateManualOffer(offer: unknown, guaranteeCodes: string[]): string[] {
  if (typeof offer !== 'object' || offer === null || Array.isArray(offer)) {
    return ['Offre invalide.'];
  }
  const o = offer as Record<string, unknown>;
  const problems: string[] = [];

  if (o['quoteNumber'] !== null && (typeof o['quoteNumber'] !== 'string' || o['quoteNumber'].length > 100)) {
    problems.push('Numéro de devis invalide (100 caractères maximum).');
  }
  if (!isOptionalAmount(o['premiumAnnual'])) problems.push('Prime annuelle invalide (montant positif attendu).');
  if (!isOptionalAmount(o['premiumMonthly'])) problems.push('Prime mensuelle invalide (montant positif attendu).');
  if (!isAmount(o['premiumAnnual']) && !isAmount(o['premiumMonthly'])) {
    problems.push('Renseignez la prime annuelle ou la prime mensuelle.');
  }

  const deductibles = o['deductibles'];
  if (typeof deductibles !== 'object' || deductibles === null || Array.isArray(deductibles)) {
    problems.push('Franchises invalides.');
  } else {
    for (const [key, value] of Object.entries(deductibles)) {
      if (key !== GENERAL_DEDUCTIBLE && !guaranteeCodes.includes(key)) problems.push(`Franchise : garantie inconnue (${key}).`);
      else if (!isAmount(value)) problems.push(`Franchise « ${key} » : montant positif attendu.`);
    }
  }

  const guarantees = o['guarantees'];
  if (!Array.isArray(guarantees) || guarantees.length > guaranteeCodes.length) {
    problems.push('Garanties : liste attendue.');
  } else {
    const codes = guarantees.map(g => (g as Partial<OfferGuarantee> | null)?.code);
    for (const g of guarantees as Partial<OfferGuarantee>[]) {
      if (typeof g !== 'object' || g === null || typeof g.code !== 'string' || !guaranteeCodes.includes(g.code)) {
        problems.push('Garanties : garantie inconnue.');
        break;
      }
      if (typeof g.included !== 'boolean' || !isOptionalAmount(g.limit) || !isOptionalAmount(g.deductible)) {
        problems.push(`Garantie ${g.code} : incluse (oui/non), plafond et franchise (montants) attendus.`);
      }
    }
    if (new Set(codes).size !== codes.length) problems.push('Garanties : garantie en double.');
  }

  const exclusions = o['exclusions'];
  if (
    !Array.isArray(exclusions) ||
    exclusions.length > MAX_EXCLUSIONS ||
    exclusions.some(e => typeof e !== 'string' || e.trim() === '' || e.length > MAX_TEXT)
  ) {
    problems.push(`Exclusions : ${MAX_EXCLUSIONS} textes de ${MAX_TEXT} caractères maximum.`);
  }
  return problems;
}

/** Offre saisie, nettoyée : libellés des garanties repris du référentiel, numéro de devis vide → null. */
export function normalizeManualOffer(offer: ManualOfferInput, catalog: Guarantee[]): ManualOfferInput {
  const labels = new Map(catalog.map(g => [g.code, g.label]));
  const quoteNumber = offer.quoteNumber?.trim() ?? '';
  return {
    quoteNumber: quoteNumber === '' ? null : quoteNumber,
    premiumAnnual: offer.premiumAnnual,
    premiumMonthly: offer.premiumMonthly,
    deductibles: { ...offer.deductibles },
    guarantees: offer.guarantees.map(g => ({
      code: g.code,
      label: labels.get(g.code ?? '') ?? g.label,
      included: g.included,
      limit: g.limit,
      deductible: g.deductible,
    })),
    exclusions: offer.exclusions.map(e => e.trim()),
  };
}

// ── Devis joint ─────────────────────────────────────────────────────────────

export const QUOTE_DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export const QUOTE_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Dossier Storage des devis d'un dossier. */
export const quoteDocumentsFolder = (cabinetId: string, dossierId: string) => `cabinets/${cabinetId}/dossiers/${dossierId}/devis`;

/** Le chemin d'un devis envoyé est-il bien dans le dossier des devis de CE dossier (aucun « .. », aucun sous-dossier) ? */
export function isQuoteDocumentPath(path: unknown, cabinetId: string, dossierId: string): path is string {
  const prefix = `${quoteDocumentsFolder(cabinetId, dossierId)}/`;
  if (typeof path !== 'string' || !path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  return /^[A-Za-z0-9._-]{1,200}$/.test(name) && !name.startsWith('.');
}
