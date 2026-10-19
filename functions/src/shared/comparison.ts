// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
import type { Guarantee, NeedAnalysis, Offer, OfferGap, OfferGuarantee } from './models.js';
import { GENERAL_DEDUCTIBLE } from './pricing.js';

/**
 * Comparaison des offres : normalisation des garanties (synonymes du référentiel), écarts avec le besoin et score indicatif.
 * Règles pures, communes au trigger `offres-onWrite` (qui écrit le résultat dans l'offre) et à l'app (affichage).
 */

/** Champs d'une offre utilisés par la comparaison. */
export type ComparableOffer = Pick<Offer, 'premiumAnnual' | 'premiumMonthly' | 'deductibles' | 'guarantees' | 'exclusions'>;

/** Besoin utilisé par la comparaison. */
export type ComparisonNeed = Pick<NeedAnalysis, 'budgetMax' | 'maxDeductible' | 'mandatoryGuarantees' | 'niceToHave'>;

/** Résultat de l'analyse d'une offre, écrit dans `offers/{insurerId}`. */
export interface OfferAnalysis {
  guarantees: OfferGuarantee[];
  gaps: OfferGap[];
  score: number | null;
}

/** Au-delà de ce dépassement du budget (en proportion), l'écart est bloquant. */
export const BUDGET_TOLERANCE = 0.1;

/** Pénalités du score indicatif (sur 100) par écart. */
export const SCORE_PENALTIES: Record<OfferGap['severity'], number> = {
  ko: 25,
  warn: 8,
};

/** Justification obligatoire du choix d'une offre. */
export const DECISION_JUSTIFICATION_MIN = 10;
export const DECISION_JUSTIFICATION_MAX = 2000;

/** Texte comparable : minuscules, sans accents, ponctuation remplacée par des espaces. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Code du référentiel correspondant à une formulation d'assureur : code exact, libellé du référentiel ou synonyme,
 * puis formulation contenant un synonyme (le plus long gagne : « vol du véhicule » avant « vol »). `null` si non reconnue.
 */
export function matchGuaranteeCode(label: string, catalog: Guarantee[], synonyms: Record<string, string[]>): string | null {
  const text = normalizeText(label);
  if (!text) return null;
  const byCode = catalog.find(g => normalizeText(g.code) === text);
  if (byCode) return byCode.code;

  const candidates: { code: string; term: string }[] = [];
  for (const g of catalog) {
    candidates.push({ code: g.code, term: normalizeText(g.label) });
    for (const s of synonyms[g.code] ?? []) candidates.push({ code: g.code, term: normalizeText(s) });
  }
  const exact = candidates.find(c => c.term === text);
  if (exact) return exact.code;

  const contained = candidates
    .filter(c => c.term.length > 0 && ` ${text} `.includes(` ${c.term} `))
    .sort((a, b) => b.term.length - a.term.length);
  return contained[0]?.code ?? null;
}

/**
 * Rattache les garanties d'une offre au référentiel (codes absents ou inconnus retrouvés par les synonymes) et reprend
 * le libellé du référentiel. Une garantie déjà présente n'est pas dupliquée : la non reconnue garde `code: null`.
 */
export function normalizeOfferGuarantees(
  guarantees: OfferGuarantee[],
  catalog: Guarantee[],
  synonyms: Record<string, string[]>,
): OfferGuarantee[] {
  const labels = new Map(catalog.map(g => [g.code, g.label]));
  const seen = new Set<string>();
  return guarantees.map(g => {
    let code = g.code && labels.has(g.code) ? g.code : matchGuaranteeCode(g.label ?? g.code ?? '', catalog, synonyms);
    if (code && seen.has(code)) code = null;
    if (code) seen.add(code);
    return {
      code,
      label: code ? labels.get(code)! : g.label,
      included: g.included === true,
      limit: g.limit ?? null,
      deductible: g.deductible ?? null,
    };
  });
}

/** Prime annuelle de l'offre (à défaut, mensuelle × 12). */
export function annualPremium(offer: Pick<Offer, 'premiumAnnual' | 'premiumMonthly'>): number | null {
  if (offer.premiumAnnual != null) return offer.premiumAnnual;
  return offer.premiumMonthly != null ? Math.round(offer.premiumMonthly * 12 * 100) / 100 : null;
}

/** État d'une garantie du référentiel dans une offre (✅ incluse, ⚠️ limitée, ❌ absente). */
export type GuaranteeCoverage = 'included' | 'limited' | 'absent';

export function guaranteeCoverage(offer: Pick<Offer, 'guarantees'>, code: string): GuaranteeCoverage {
  const g = offer.guarantees.find(x => x.code === code);
  if (!g || !g.included) return 'absent';
  return g.limit != null ? 'limited' : 'included';
}

const euros = (n: number) => `${n.toLocaleString('fr-FR')} €`;

/** Écarts entre une offre (garanties déjà normalisées) et le besoin du client. */
export function computeOfferGaps(
  offer: ComparableOffer,
  need: ComparisonNeed,
  catalog: Guarantee[],
  synonyms: Record<string, string[]> = {},
): OfferGap[] {
  const gaps: OfferGap[] = [];
  const label = (code: string) => catalog.find(g => g.code === code)?.label ?? code;
  const find = (code: string) => offer.guarantees.find(g => g.code === code && g.included);

  // Budget
  const premium = annualPremium(offer);
  if (need.budgetMax != null && premium != null && premium > need.budgetMax) {
    gaps.push({
      criterion: 'budget',
      severity: premium > need.budgetMax * (1 + BUDGET_TOLERANCE) ? 'ko' : 'warn',
      message: `Prime annuelle de ${euros(premium)}, au-dessus du budget de ${euros(need.budgetMax)}.`,
    });
  }

  // Franchises : générale, puis celles des garanties indispensables
  if (need.maxDeductible != null) {
    const general = offer.deductibles?.[GENERAL_DEDUCTIBLE];
    if (general != null && general > need.maxDeductible) {
      gaps.push({
        criterion: 'deductible',
        severity: 'ko',
        message: `Franchise générale de ${euros(general)}, au-dessus du maximum de ${euros(need.maxDeductible)}.`,
      });
    }
    for (const code of need.mandatoryGuarantees) {
      const amount = offer.deductibles?.[code] ?? find(code)?.deductible ?? null;
      if (amount != null && amount > need.maxDeductible) {
        gaps.push({
          criterion: 'deductible',
          severity: 'warn',
          message: `Franchise ${label(code)} de ${euros(amount)}, au-dessus du maximum de ${euros(need.maxDeductible)}.`,
        });
      }
    }
  }

  // Garanties indispensables et plafonds
  for (const code of need.mandatoryGuarantees) {
    const g = find(code);
    if (!g) {
      gaps.push({
        criterion: 'mandatory_guarantee',
        severity: 'ko',
        message: `Garantie indispensable absente : ${label(code)}.`,
      });
    } else if (g.limit === 0) {
      gaps.push({
        criterion: 'limit',
        severity: 'ko',
        message: `${label(code)} : plafond nul.`,
      });
    } else if (g.limit == null && catalog.find(c => c.code === code)?.type === 'limit') {
      gaps.push({
        criterion: 'limit',
        severity: 'warn',
        message: `${label(code)} : plafond non précisé.`,
      });
    }
  }

  // Garanties souhaitées
  for (const code of need.niceToHave) {
    if (!find(code)) {
      gaps.push({
        criterion: 'nice_to_have',
        severity: 'warn',
        message: `Garantie souhaitée absente : ${label(code)}.`,
      });
    }
  }

  // Exclusions touchant une garantie indispensable
  for (const exclusion of offer.exclusions ?? []) {
    const code = matchGuaranteeCode(exclusion, catalog, synonyms);
    if (code && need.mandatoryGuarantees.includes(code)) {
      gaps.push({
        criterion: 'exclusion',
        severity: 'warn',
        message: `Exclusion touchant ${label(code)} : « ${exclusion} ».`,
      });
    }
  }
  return gaps;
}

/** Score indicatif d'adéquation (0 à 100) : 100 moins une pénalité par écart. */
export function computeOfferScore(gaps: OfferGap[]): number {
  const penalty = gaps.reduce((sum, gap) => sum + SCORE_PENALTIES[gap.severity], 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

/**
 * Analyse complète d'une offre : garanties normalisées, écarts et score. Sans besoin enregistré, pas d'écart ni de score.
 */
export function analyzeOffer(
  offer: ComparableOffer,
  need: ComparisonNeed | null,
  catalog: Guarantee[],
  synonyms: Record<string, string[]>,
): OfferAnalysis {
  const guarantees = normalizeOfferGuarantees(offer.guarantees ?? [], catalog, synonyms);
  if (!need) return { guarantees, gaps: [], score: null };
  const gaps = computeOfferGaps({ ...offer, guarantees }, need, catalog, synonyms);
  return { guarantees, gaps, score: computeOfferScore(gaps) };
}

/** Contrôle la justification du choix d'une offre. Renvoie le problème, ou `null`. */
export function validateDecisionJustification(justification: unknown): string | null {
  if (typeof justification !== 'string') return 'Justification attendue.';
  const length = justification.trim().length;
  if (length < DECISION_JUSTIFICATION_MIN) return `Justifiez le choix (${DECISION_JUSTIFICATION_MIN} caractères minimum).`;
  if (length > DECISION_JUSTIFICATION_MAX) return `Justification : ${DECISION_JUSTIFICATION_MAX} caractères maximum.`;
  return null;
}
