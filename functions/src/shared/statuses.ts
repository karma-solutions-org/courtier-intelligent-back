// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
/** Rôles. Stockés dans les claims `ci_role` et dans cabinets/{t}/members/{uid}.role. */
export type UserRole = 'superadmin' | 'admin' | 'courtier';
export type CabinetRole = Exclude<UserRole, 'superadmin'>;

export type MemberStatus = 'active' | 'disabled';
export type InvitationStatus = 'pending' | 'accepted' | 'expired';

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

export const DOSSIER_STATUS_LABELS: Record<DossierStatus, string> = {
  brouillon: 'Brouillon',
  complet: 'Complet',
  besoin_valide: 'Besoin validé',
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
  | 'failed';

export const QUOTE_JOB_STATUS_LABELS: Record<QuoteJobStatus, string> = {
  requested: 'Demandé',
  analyzing: 'Analyse de l’extranet',
  needs_info: 'Informations manquantes',
  filling: 'Remplissage en cours',
  awaiting_submit: 'À valider sur l’extranet',
  captured: 'Tarif obtenu',
  failed: 'Échec',
};
