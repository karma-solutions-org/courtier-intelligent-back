// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
import { CanonicalData, CanonicalPath } from './canonical-paths.js';
import { DossierStatus, InvitationStatus, MemberStatus, QuoteJobStatus, CabinetRole } from './statuses.js';

/**
 * Horodatage Firestore. Côté client et côté Admin SDK les classes diffèrent :
 * on ne garde que ce qui est commun.
 */
export interface TimestampLike {
  toMillis(): number;
}

// ── Cabinet ────────────────────────────────────────────────────────────────
export interface Cabinet {
  id: string;
  name: string;
  orias: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  logoPath?: string | null;
  active: boolean;
  /** Offre souscrite (`plans/{planId}`) : écrite uniquement côté serveur. */
  planId: string;
  /** Surcharge des limites de l'offre pour ce cabinet (ex. 6 sièges au lieu de 3). Serveur uniquement. */
  overrides?: Partial<PlanLimits> | null;
  /** Limites effectives = offre + surcharge (voir `computeEffectiveLimits`), recalculées à chaque changement. */
  limits: PlanLimits;
  /**
   * Présent quand le cabinet dépasse sa limite de sièges (baisse d'offre) : fin du délai de grâce,
   * après quoi seuls les admins accèdent au cabinet.
   */
  graceEndsAt?: TimestampLike | null;
  /** Réinitialisations d'appareil consommées durant le mois `month` (« AAAA-MM »). */
  deviceResets?: { month: string; count: number } | null;
  ownerUid: string;
  enabledInsurers: string[];
  enabledProducts: string[];
  createdAt?: TimestampLike;
}

export interface Member {
  id: string; // uid
  email: string | null;
  displayName: string | null;
  role: CabinetRole;
  status: MemberStatus;
  /** Appareil lié au compte : lui seul peut se connecter, jusqu'à réinitialisation par un admin. */
  device?: BoundDevice | null;
  /** Session de l'appareil connecté : un seul appareil à la fois. */
  session?: Session | null;
  createdAt?: TimestampLike;
}

export interface BoundDevice {
  /** Identifiant généré par l'app et conservé dans IndexedDB. */
  id: string;
  /** Description lisible (ex. « Chrome · Windows »). */
  label: string | null;
  boundAt?: TimestampLike;
}

/** Session ouverte par `sessions-ouvrir`, dans `members/{uid}.session`. */
export interface Session {
  /** Identifiant de l'appareil (informatif). */
  id: string;
  /**
   * Heure de connexion (secondes) du token qui a ouvert la session : seul ce token est accepté
   * par les règles Firestore et les functions (un autre appareil a une autre valeur).
   */
  authTime: number;
  appareil: string | null;
  ouverteLe?: TimestampLike;
  /** Dernier signal de vie de l'appareil. */
  lastSeen?: TimestampLike;
  /**
   * Connexion de l'extension Chrome du même appareil : `auth_time` de SON jeton (posé par `sessions-ouvrirExtension`).
   * Il disparaît avec la session de l'app : fermée, remplacée ou membre désactivé, l'extension perd l'accès aussitôt.
   */
  extensionAuthTime?: number;
  extensionOpenedAt?: TimestampLike;
}

/** cabinets/{t}/auditLog/{id} : écrit uniquement par les Cloud Functions, lu par les admins. */
export type AuditLogType =
  | 'connexion'
  | 'connexion_refusee_appareil'
  | 'appareil_lie'
  | 'extension_connexion'
  | 'appareil_reinitialise'
  | 'reinitialisation_refusee_quota';

export interface AuditLogEntry {
  id: string;
  type: AuditLogType;
  /** Utilisateur concerné. */
  uid: string;
  /** Utilisateur à l'origine de l'action (admin pour une réinitialisation). */
  by: string;
  at?: TimestampLike;
  data?: Record<string, unknown>;
}

export interface Invitation {
  id: string;
  email: string;
  role: CabinetRole;
  status: InvitationStatus;
  invitedBy: string;
  expiresAt: TimestampLike;
}

// ── Offres ─────────────────────────────────────────────────────────────────
/** Limites d'un cabinet. */
export interface PlanLimits {
  /** Utilisateurs autorisés, admin compris. */
  maxUtilisateurs: number;
  /** Réinitialisations d'appareil autorisées par mois. */
  resetsAppareilParMois: number;
  /** Appels à l'IA (fonction `ia-proxy`, tous les utilisateurs du cabinet) autorisés par mois. */
  appelsIaParMois: number;
}

/** plans/{planId} : catalogue des offres, publié par `seed-catalog`. */
export interface Plan {
  id: string;
  name: string;
  limits: PlanLimits;
}

// ── Catalogue ──────────────────────────────────────────────────────────────
export type QuestionType = 'text' | 'number' | 'date' | 'boolean' | 'choice';

export interface QuestionChoice {
  value: string;
  label: string;
}

export interface Question {
  canonicalPath: CanonicalPath;
  label: string;
  type: QuestionType;
  required: boolean;
  choices?: QuestionChoice[];
  /** Affiché seulement si un autre champ a une valeur donnée. */
  visibleIf?: { path: CanonicalPath; equals: string | number | boolean };
  /** Demande un niveau de connaissance (connu / inconnu / déclaré inconnu). */
  withKnowledge?: boolean;
}

export interface QuestionnaireSection {
  title: string;
  questions: Question[];
}

export type GuaranteeType = 'included' | 'limit' | 'deductible';

export interface Guarantee {
  code: string; // ex. "BDG"
  label: string; // ex. "Bris de glace"
  type: GuaranteeType;
}

export interface Product {
  id: string; // ex. "auto"
  name: string;
  active: boolean;
  questionnaireSchema: QuestionnaireSection[];
  guaranteeCatalog: Guarantee[];
}

/** guaranteeSynonyms/{productId} : formulations d'un assureur → code du référentiel (ex. « vitrage » → BDG). */
export interface GuaranteeSynonyms {
  id: string; // productId
  synonyms: Record<string, string[]>; // code → formulations
}

export interface Insurer {
  id: string;
  name: string;
  logo?: string | null;
  extranetUrl: string;
  extranetDomains: string[];
  productsSupported: string[];
}

// ── Assuré & dossier ───────────────────────────────────────────────────────
export interface Assure {
  id: string;
  type: 'particulier' | 'pro';
  civilite?: 'M.' | 'Mme' | null;
  /** Prénom et nom du contact (de l'assuré lui-même pour un particulier). */
  firstName: string;
  lastName: string;
  /** Raison sociale et SIRET (14 chiffres) : assuré professionnel. */
  companyName?: string | null;
  siret?: string | null;
  birthDate?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: { street?: string | null; postalCode?: string | null; city?: string | null; country?: string | null };
  createdBy: string;
  createdAt?: TimestampLike;
  updatedAt?: TimestampLike;
}

export type CoverageLevel = 'tiers' | 'tiers_plus' | 'tous_risques';

export interface NeedAnalysis {
  coverageLevel: CoverageLevel | null;
  budgetMax: number | null;
  maxDeductible: number | null;
  mandatoryGuarantees: string[]; // codes du référentiel
  niceToHave: string[];
  notes: string | null;
  validatedAt?: TimestampLike | null;
}

export interface Dossier {
  id: string;
  reference: string | null; // ex. "2026-000123"
  assureId: string;
  productId: string;
  assignedTo: string;
  status: DossierStatus;
  data: CanonicalData;
  completeness: { ok: boolean; missing: CanonicalPath[] };
  needAnalysis: NeedAnalysis | null;
  decision: { insurerId: string; justification: string; decidedBy: string; decidedAt?: TimestampLike } | null;
  proposal: { sentAt?: TimestampLike; sentTo: string } | null;
  outcome: { result: 'souscrit' | 'refuse' | 'sans_suite'; contractNumber?: string | null; effectiveDate?: string | null } | null;
  /** Où le courtier s'est arrêté dans le questionnaire : la reprise du brouillon s'y replace exactement. */
  draft?: { sectionIndex: number } | null;
  createdBy?: string;
  createdAt?: TimestampLike;
  updatedAt?: TimestampLike;
}

/** Types d'événements de l'historique d'un dossier (cabinets/{t}/dossiers/{d}/events). */
export type DossierEventType =
  | 'created'
  | 'data_updated'
  | 'status_changed'
  | 'assigned'
  | 'need_updated'
  | 'note'
  | 'pricing_requested'
  | 'pricing_completed'
  | 'offer_entered';

export interface DossierEvent {
  id: string;
  type: DossierEventType | string;
  by: string;
  at?: TimestampLike;
  data?: Record<string, unknown>;
}

// ── Tarification ───────────────────────────────────────────────────────────
export interface MissingField {
  canonicalPath: CanonicalPath;
  label: string;
  type: QuestionType;
  choices?: QuestionChoice[];
}

/** cabinets/{t}/dossiers/{d}/quoteJobs/{insurerId} */
export interface QuoteJob {
  id: string; // insurerId
  status: QuoteJobStatus;
  ownerUid: string;
  quoteData: CanonicalData;
  missingFields: MissingField[];
  currentStep: number | null;
  totalSteps: number | null;
  error: string | null;
  attempts: number;
  /** Référence du dossier (copiée à la création du job) : affichée dans le side panel de l'extension. */
  dossierReference?: string | null;
  requestedAt?: TimestampLike;
  updatedAt?: TimestampLike;
}

export interface OfferGuarantee {
  code: string | null; // null si non reconnue dans le référentiel
  label: string;
  included: boolean;
  limit: number | null;
  deductible: number | null;
}

export type GapSeverity = 'warn' | 'ko';

export interface OfferGap {
  criterion: 'budget' | 'deductible' | 'mandatory_guarantee' | 'nice_to_have' | 'limit' | 'exclusion';
  severity: GapSeverity;
  message: string;
}

/** cabinets/{t}/dossiers/{d}/offers/{insurerId} */
export interface Offer {
  id: string; // insurerId
  quoteNumber: string | null;
  premiumAnnual: number | null;
  premiumMonthly: number | null;
  deductibles: Record<string, number>;
  guarantees: OfferGuarantee[];
  exclusions: string[];
  source: 'auto' | 'manual';
  gaps: OfferGap[];
  score: number | null;
  /** Saisie manuelle : courtier qui a saisi l'offre, et devis joint (`documents/{id}`). */
  enteredBy?: string | null;
  documentId?: string | null;
  capturedAt?: TimestampLike;
}

/** cabinets/{t}/dossiers/{d}/documents/{id} : écrit par les functions (devis joint à une offre saisie à la main). */
export interface DossierDocument {
  id: string;
  type: 'devis' | string;
  storagePath: string;
  fileName: string | null;
  insurerId?: string | null;
  ocrFields: unknown[];
  status: 'uploaded' | string;
  uploadedBy: string;
  createdAt?: TimestampLike;
}

// ── Signalements de l'extension (AUCUNE donnée client) ─────────────────────
/** Étape de la capture du tarif où le problème est survenu. */
export const EXTENSION_REPORT_STEPS = ['detect', 'extract', 'confirm', 'write'] as const;
export type ExtensionReportStep = (typeof EXTENSION_REPORT_STEPS)[number];

/** Codes fermés : un texte libre pourrait contenir une donnée client, un code jamais. */
export const EXTENSION_REPORT_ISSUES = [
  /** Page de résultat probable, mais aucune prime lue (ni dans le DOM ni par l'IA). */
  'premium_not_found',
  /** L'IA n'a pas répondu (panne, quota du cabinet). */
  'ai_unavailable',
  /** Réponse de l'IA inutilisable (pas de JSON, ou aucun montant présent sur la page). */
  'ai_unusable',
  /** Le courtier a refusé le tarif lu (montant faux, mauvaise page). */
  'capture_rejected',
  /** L'écriture de l'offre a échoué. */
  'offer_write_failed',
] as const;
export type ExtensionReportIssue = (typeof EXTENSION_REPORT_ISSUES)[number];

/** extensionReports/{id} : créé par l'extension, lu seulement par les opérateurs (console). */
export interface ExtensionReport {
  id: string;
  insurerId: string;
  /** Origine de l'extranet (« https://extranet.assureur-a.fr »), jamais l'URL complète (elle peut porter des paramètres). */
  origin: string;
  step: ExtensionReportStep;
  issue: ExtensionReportIssue;
  at?: TimestampLike;
}

// ── Mémoire partagée des formulaires (AUCUNE donnée client) ────────────────
/** Types de champs d'un extranet (analyse du DOM par l'extension). */
export const FORM_FIELD_KINDS = ['text', 'number', 'date', 'select', 'radio', 'checkbox', 'textarea', 'autocomplete'] as const;
export type FormFieldKind = (typeof FORM_FIELD_KINDS)[number];

export interface FormMemoryField {
  /** Identifiant du champ dans le formulaire (type + nom/id/libellé) : STRUCTURE, jamais une valeur saisie. */
  fieldKey: string;
  label: string | null;
  type: FormFieldKind;
  order: number;
  /** Chemin canonique associé, ou null : « ce champ n'a pas d'équivalent » est lui aussi appris. */
  canonicalPath: CanonicalPath | null;
  confidence: number;
}

/**
 * formMemories/{memoryKey} : ce que l'extension a appris d'un formulaire d'extranet, partagé par tous les cabinets.
 * `memoryKey` = sha256(`${origin}|${formFingerprint}`) en hexadécimal, tronqué à 32 caractères.
 * Écrit uniquement par les functions `memoires-*` (structure validée) ; lu par l'extension.
 */
export interface FormMemory {
  id: string;
  /** Origine de l'extranet, ex. « https://extranet.assureur-a.fr ». */
  origin: string;
  formFingerprint: string;
  version: number;
  fields: FormMemoryField[];
  /** Nombre de fois où la mémoire a servi à remplir un formulaire. */
  hits: number;
  /** Signalements d'échec (par des cabinets distincts) ; à 2, la mémoire est invalidée et réapprise. */
  failures?: number;
  invalidatedAt?: TimestampLike | null;
  lastUsedAt?: TimestampLike;
  createdAt?: TimestampLike;
}
