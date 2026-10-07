// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
import { CanonicalData, CanonicalPath } from './canonical-paths.js';
import { DossierStatus, InvitationStatus, MemberStatus, QuoteJobStatus, TenantRole } from './statuses.js';

/**
 * Horodatage Firestore. Côté client et côté Admin SDK les classes diffèrent :
 * on ne garde que ce qui est commun.
 */
export interface TimestampLike {
  toMillis(): number;
}

// ── Cabinet ────────────────────────────────────────────────────────────────
export interface Tenant {
  id: string;
  name: string;
  orias: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  logoPath?: string | null;
  active: boolean;
  ownerUid: string;
  enabledInsurers: string[];
  enabledProducts: string[];
  createdAt?: TimestampLike;
}

export interface Member {
  id: string; // uid
  email: string | null;
  displayName: string | null;
  role: TenantRole;
  status: MemberStatus;
  createdAt?: TimestampLike;
}

export interface Invitation {
  id: string;
  email: string;
  role: TenantRole;
  status: InvitationStatus;
  invitedBy: string;
  expiresAt: TimestampLike;
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
  firstName: string;
  lastName: string;
  birthDate?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: { street?: string | null; postalCode?: string | null; city?: string | null; country?: string | null };
  createdBy: string;
  createdAt?: TimestampLike;
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
  createdAt?: TimestampLike;
  updatedAt?: TimestampLike;
}

export interface DossierEvent {
  id: string;
  type: string;
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

/** tenants/{t}/dossiers/{d}/quoteJobs/{insurerId} */
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

/** tenants/{t}/dossiers/{d}/offers/{insurerId} */
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
  capturedAt?: TimestampLike;
}

// ── Mémoire partagée des formulaires (AUCUNE donnée client) ────────────────
export interface FormMemoryField {
  fieldKey: string;
  label: string | null;
  type: string;
  order: number;
  canonicalPath: CanonicalPath | null;
  confidence: number;
}

/** formMemories/{memoryKey} */
export interface FormMemory {
  id: string;
  origin: string; // ex. "extranet.assureur-a.fr"
  formFingerprint: string;
  version: number;
  fields: FormMemoryField[];
  hits: number;
  lastUsedAt?: TimestampLike;
  createdAt?: TimestampLike;
}
