// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
/** Rôles. Stockés dans les claims `ci_role` et dans cabinets/{cabinetId}/members/{uid}.role. */
export type UserRole = 'admin' | 'courtier';
/** Rôle d'un membre dans son cabinet (identique à UserRole : tout utilisateur appartient à un cabinet). */
export type CabinetRole = UserRole;

export type MemberStatus = 'active' | 'disabled';
export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'cancelled';

/** Cycle de vie d'un dossier. */
export const DOSSIER_STATUSES = [
  'brouillon',
  'complet',
  'besoin_valide',
  'tarification',
  'comparaison',
  'decision',
  'proposition_envoyee',
  'souscrit',
  'refuse',
  'sans_suite',
] as const;
export type DossierStatus = (typeof DOSSIER_STATUSES)[number];

/** Transitions autorisées : toute autre transition est refusée. */
export const DOSSIER_TRANSITIONS: Record<DossierStatus, DossierStatus[]> = {
  brouillon: ['complet', 'sans_suite'],
  complet: ['brouillon', 'besoin_valide', 'sans_suite'],
  besoin_valide: ['complet', 'tarification', 'sans_suite'],
  tarification: ['comparaison', 'sans_suite'],
  comparaison: ['tarification', 'decision', 'sans_suite'],
  decision: ['comparaison', 'proposition_envoyee', 'sans_suite'],
  proposition_envoyee: ['souscrit', 'refuse', 'sans_suite'],
  souscrit: [],
  refuse: [],
  sans_suite: [],
};

/** Statuts finaux : plus aucune transition (« sans suite » : classé par `dossiers-classerSansSuite`, avec un motif). */
export const TERMINAL_DOSSIER_STATUSES: DossierStatus[] = ['souscrit', 'refuse', 'sans_suite'];

/** Dossiers jamais supprimés définitivement (trace d'une proposition faite à l'assuré). */
export const PROTECTED_DOSSIER_STATUSES: DossierStatus[] = ['proposition_envoyee', 'souscrit', 'refuse'];

/** Motif obligatoire d'un classement sans suite. */
export const SANS_SUITE_MOTIF_MAX = 500;

/**
 * Issue d'un dossier pour le taux de conversion : `won` (souscrit), `lost` (refusé, ou sans suite après une
 * proposition envoyée), `null` (pas d'issue). La corbeille n'y change rien : un dossier refusé puis supprimé compte.
 */
export function conversionOutcome(dossier: { status: DossierStatus; proposal?: unknown | null }): 'won' | 'lost' | null {
  if (dossier.status === 'souscrit') return 'won';
  if (dossier.status === 'refuse') return 'lost';
  if (dossier.status === 'sans_suite' && dossier.proposal) return 'lost';
  return null;
}

/** Une transition de statut est-elle autorisée par la machine à états ? */
export function isTransitionAllowed(from: DossierStatus, to: DossierStatus): boolean {
  return DOSSIER_TRANSITIONS[from].includes(to);
}

/** Tant que le dossier est dans l'un de ces statuts, ses informations restent modifiables. */
export const EDITABLE_DOSSIER_STATUSES: DossierStatus[] = ['brouillon', 'complet', 'besoin_valide'];

/**
 * Réponses du questionnaire modifiables : avant la tarification, et pendant (le courtier corrige ou complète ce que
 * les extranets demandent). Pendant la tarification, une information obligatoire ne peut pas être retirée, les
 * tarifications en cours reçoivent les nouvelles données et les tarifs déjà obtenus deviennent périmés.
 */
export const ANSWERS_EDITABLE_DOSSIER_STATUSES: DossierStatus[] = [...EDITABLE_DOSSIER_STATUSES, 'tarification'];

export const DOSSIER_STATUS_LABELS: Record<DossierStatus, string> = {
  brouillon: 'Brouillon',
  complet: 'Complet',
  besoin_valide: 'Couverture validée',
  tarification: 'Tarification',
  comparaison: 'Comparaison',
  decision: 'Décision',
  proposition_envoyee: 'Proposition envoyée',
  souscrit: 'Souscrit',
  refuse: 'Refusé',
  sans_suite: 'Sans suite',
};

/** Job de tarification (un par assureur et par dossier). */
export type QuoteJobStatus =
  | 'requested'
  | 'analyzing'
  | 'needs_info'
  | 'filling'
  | 'awaiting_submit'
  | 'captured'
  | 'failed'
  | 'cancelled';

export const QUOTE_JOB_STATUS_LABELS: Record<QuoteJobStatus, string> = {
  requested: 'Demandé',
  analyzing: "Analyse de l'extranet",
  needs_info: 'Informations manquantes',
  filling: 'Remplissage en cours',
  awaiting_submit: "À valider sur l'extranet",
  captured: 'Tarif obtenu',
  failed: 'Échec',
  cancelled: 'Annulé',
};
