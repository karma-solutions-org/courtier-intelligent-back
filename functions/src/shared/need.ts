// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
import { CanonicalData } from './canonical-paths.js';
import type { CoverageLevel, NeedAnalysis } from './models.js';

/**
 * Analyse du besoin d'un dossier : règles communes à l'app (formulaire, suggestions) et aux Cloud Functions
 * (validation de ce qui est enregistré, trace des modifications).
 */

export const COVERAGE_LEVELS: CoverageLevel[] = ['tiers', 'tiers_plus', 'tous_risques'];

export const COVERAGE_LEVEL_LABELS: Record<CoverageLevel, string> = {
  tiers: 'Tiers (responsabilité civile)',
  tiers_plus: 'Tiers étendu',
  tous_risques: 'Tous risques',
};

/** Champs saisis du besoin (sans `validatedAt`, posé par la validation). */
export type NeedInput = Omit<NeedAnalysis, 'validatedAt'>;

export const EMPTY_NEED: NeedInput = {
  coverageLevel: null,
  budgetMax: null,
  maxDeductible: null,
  mandatoryGuarantees: [],
  niceToHave: [],
  notes: null,
};

export const NEED_FIELD_LABELS: Record<keyof NeedInput, string> = {
  coverageLevel: 'Couverture',
  budgetMax: 'Budget maximum',
  maxDeductible: 'Franchise maximum',
  mandatoryGuarantees: 'Garanties indispensables',
  niceToHave: 'Garanties souhaitées',
  notes: 'Notes',
};

const MAX_AMOUNT = 10_000_000;
const MAX_NOTES = 2000;
const MAX_GUARANTEES = 50;

const isAmount = (value: unknown): boolean =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT);

/**
 * Contrôle un besoin reçu. `guaranteeCodes` : codes du référentiel du produit.
 * Renvoie la liste des problèmes (vide si le besoin est valide).
 */
export function validateNeed(need: unknown, guaranteeCodes: string[]): string[] {
  if (typeof need !== 'object' || need === null || Array.isArray(need)) {
    return ['Besoin invalide.'];
  }
  const n = need as Record<string, unknown>;
  const problems: string[] = [];

  if (n['coverageLevel'] !== null && !COVERAGE_LEVELS.includes(n['coverageLevel'] as CoverageLevel)) {
    problems.push('Niveau de couverture invalide.');
  }
  if (!isAmount(n['budgetMax'])) problems.push('Budget maximum invalide (montant positif attendu).');
  if (!isAmount(n['maxDeductible'])) problems.push('Franchise maximum invalide (montant positif attendu).');

  const lists = (['mandatoryGuarantees', 'niceToHave'] as const).map(key => {
    const value = n[key];
    if (!Array.isArray(value) || value.length > MAX_GUARANTEES || value.some(code => typeof code !== 'string')) {
      problems.push(`${NEED_FIELD_LABELS[key]} : liste de codes de garanties attendue.`);
      return [] as string[];
    }
    const unknown = (value as string[]).filter(code => !guaranteeCodes.includes(code));
    if (unknown.length) problems.push(`${NEED_FIELD_LABELS[key]} : garantie inconnue (${unknown.join(', ')}).`);
    if (new Set(value).size !== value.length) problems.push(`${NEED_FIELD_LABELS[key]} : garantie en double.`);
    return value as string[];
  });
  const both = lists[0].filter(code => lists[1].includes(code));
  if (both.length) problems.push(`Une garantie ne peut pas être à la fois indispensable et souhaitée (${both.join(', ')}).`);

  if (n['notes'] !== null && (typeof n['notes'] !== 'string' || n['notes'].length > MAX_NOTES)) {
    problems.push(`Notes : texte de ${MAX_NOTES} caractères maximum.`);
  }
  return problems;
}

/** Remet un besoin dans sa forme canonique (ordre des listes, chaîne vide → null, champs inconnus écartés). */
export function normalizeNeed(need: NeedInput): NeedInput {
  const notes = typeof need.notes === 'string' ? need.notes.trim() : null;
  return {
    coverageLevel: need.coverageLevel ?? null,
    budgetMax: need.budgetMax ?? null,
    maxDeductible: need.maxDeductible ?? null,
    mandatoryGuarantees: [...need.mandatoryGuarantees].sort(),
    niceToHave: [...need.niceToHave].sort(),
    notes: notes || null,
  };
}

/** Champs qui diffèrent entre deux besoins (`null` = pas encore de besoin enregistré). */
export function diffNeed(before: NeedInput | null, after: NeedInput): (keyof NeedInput)[] {
  const previous = normalizeNeed(before ?? EMPTY_NEED);
  const next = normalizeNeed(after);
  return (Object.keys(EMPTY_NEED) as (keyof NeedInput)[]).filter(
    key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]),
  );
}

/** Un besoin peut être validé quand le niveau de couverture est choisi. */
export function isNeedValidatable(need: Pick<NeedAnalysis, 'coverageLevel'> | null | undefined): boolean {
  return !!need && need.coverageLevel !== null && need.coverageLevel !== undefined;
}

// ── Suggestions (E5-3) ────────────────────────────────────────────────────

export interface NeedSuggestion {
  coverageLevel: CoverageLevel | null;
  mandatoryGuarantees: string[];
  niceToHave: string[];
  /** Pourquoi chaque suggestion est faite, à afficher au courtier. */
  reasons: string[];
}

const NO_SUGGESTION: NeedSuggestion = { coverageLevel: null, mandatoryGuarantees: [], niceToHave: [], reasons: [] };

/** Ancienneté du véhicule en années entières, ou null si la date est absente ou invalide. */
function vehicleAgeYears(firstRegistration: unknown, now: Date): number | null {
  if (typeof firstRegistration !== 'string') return null;
  const date = new Date(`${firstRegistration}T00:00:00`);
  if (Number.isNaN(date.getTime()) || date > now) return null;
  let years = now.getFullYear() - date.getFullYear();
  if (now.getMonth() < date.getMonth() || (now.getMonth() === date.getMonth() && now.getDate() < date.getDate())) years -= 1;
  return years;
}

/**
 * Propose un besoin à partir des réponses du questionnaire (produit Auto). Ce ne sont que des suggestions :
 * le courtier les accepte ou les modifie. Rien n'est inventé : sans l'information nécessaire, pas de suggestion,
 * et jamais de budget ni de franchise. Seuls les codes présents au référentiel du produit sont proposés.
 */
export function suggestNeed(
  productId: string,
  data: CanonicalData,
  guaranteeCodes: string[],
  now: Date = new Date(),
): NeedSuggestion {
  if (productId !== 'auto') return NO_SUGGESTION;

  const reasons: string[] = [];
  const age = vehicleAgeYears(data['vehicle.firstRegistrationDate'], now);
  const valueRaw = data['vehicle.vehicleValue'];
  const value = typeof valueRaw === 'number' ? valueRaw : null;

  let coverageLevel: CoverageLevel | null = null;
  if (age !== null || value !== null) {
    if ((age !== null && age < 5) || (value !== null && value >= 15_000)) {
      coverageLevel = 'tous_risques';
      reasons.push(
        age !== null && age < 5
          ? `Véhicule récent (${age} an${age > 1 ? 's' : ''}) : une couverture tous risques protège sa valeur.`
          : `Véhicule de valeur élevée (${value} €) : une couverture tous risques est conseillée.`,
      );
    } else if ((age !== null && age <= 10) || (value !== null && value >= 5_000)) {
      coverageLevel = 'tiers_plus';
      reasons.push('Véhicule de moyenne ancienneté ou valeur : un tiers étendu (vol, incendie, bris de glace) est un bon compromis.');
    } else {
      coverageLevel = 'tiers';
      reasons.push('Véhicule ancien ou de faible valeur : le tiers suffit en général.');
    }
  }

  const mandatory = new Set<string>(['RC', 'DR']);
  const nice = new Set<string>(['ASS']);
  if (coverageLevel === 'tous_risques') ['DTC', 'VOL', 'INC', 'BDG'].forEach(code => mandatory.add(code));
  if (coverageLevel === 'tiers_plus') ['VOL', 'INC', 'BDG'].forEach(code => mandatory.add(code));
  if (data['vehicle.parkingType'] === 'voie_publique') {
    mandatory.add('VOL');
    reasons.push('Stationnement sur la voie publique : la garantie vol est indispensable.');
  }
  if (data['vehicle.usage'] === 'professionnel') {
    nice.add('EQP');
    nice.add('VRP');
    reasons.push('Usage professionnel : équipements transportés et véhicule de remplacement à envisager.');
  }
  nice.add('GDC');
  nice.add('VRP');

  const keep = (codes: Set<string>) => [...codes].filter(code => guaranteeCodes.includes(code));
  const mandatoryGuarantees = keep(mandatory);
  const niceToHave = keep(nice).filter(code => !mandatoryGuarantees.includes(code));

  if (coverageLevel === null && reasons.length === 0) {
    reasons.push('Responsabilité civile et défense recours sont obligatoires en base ; précisez le véhicule pour affiner.');
  }
  return { coverageLevel, mandatoryGuarantees, niceToHave, reasons };
}
