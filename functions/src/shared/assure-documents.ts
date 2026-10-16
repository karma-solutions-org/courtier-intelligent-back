// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
// Pièces d'un client : CIN et Kbis sont lues à la création du client pour pré-remplir sa fiche ; toutes (carte grise,
// permis… compris) sont rangées avec elle, puis reprises dans ses dossiers (documents-reprendrePiecesClient).
// Règles communes à l'app (pré-remplissage) et aux functions assures-* (contrôle de la réponse de l'IA).
import { ASSURE_BIRTH_DATE_PATTERN, ASSURE_MAX_LENGTHS, ASSURE_POSTAL_CODE_PATTERN, ASSURE_SIRET_PATTERN } from './assure-format.js';
import { DOSSIER_DOCUMENT_MAX_BYTES, DOSSIER_DOCUMENT_MIME_TYPES, DossierDocumentType } from './documents.js';

export const ASSURE_DOCUMENT_TYPES = ['cin', 'kbis', 'carte_grise', 'permis', 'releve_information', 'autre'] as const;
export type AssureDocumentType = (typeof ASSURE_DOCUMENT_TYPES)[number];

/** Pièces lues pour pré-remplir la fiche du client (les autres sont seulement rangées, puis lues dans le dossier). */
export const ASSURE_READABLE_TYPES = ['cin', 'kbis'] as const;
export type AssureReadableType = (typeof ASSURE_READABLE_TYPES)[number];

export const isAssureReadableType = (type: unknown): type is AssureReadableType =>
  typeof type === 'string' && (ASSURE_READABLE_TYPES as readonly string[]).includes(type);

/** Type du document créé dans un dossier à partir d'une pièce du client ; `null` : pièce non reprise (Kbis). */
export function dossierTypeForAssureDocument(type: AssureDocumentType): DossierDocumentType | null {
  return type === 'kbis' ? null : type;
}

export const ASSURE_DOCUMENT_MIME_TYPES = DOSSIER_DOCUMENT_MIME_TYPES;
export const ASSURE_DOCUMENT_MAX_BYTES = DOSSIER_DOCUMENT_MAX_BYTES;

export const isAssureDocumentType = (type: unknown): type is AssureDocumentType =>
  typeof type === 'string' && (ASSURE_DOCUMENT_TYPES as readonly string[]).includes(type);

/** Valeurs lues sur une pièce : uniquement des champs de la fiche client, jamais inventés (absent = non lu). */
export interface AssureOcrValues {
  civilite?: 'M.' | 'Mme';
  firstName?: string;
  lastName?: string;
  birthDate?: string;
  companyName?: string;
  siret?: string;
  street?: string;
  postalCode?: string;
  city?: string;
}

/** Pièce rangée avec le client : cabinets/{c}/assures/{a}/documents/{id}. */
export interface AssureDocument {
  id: string;
  type: AssureDocumentType;
  storagePath: string;
  fileName: string | null;
  contentType: string;
  size: number;
  values: AssureOcrValues;
  uploadedBy: string;
  createdAt?: { toMillis(): number };
}

/** Dépôt provisoire d'une pièce, avant que le client n'existe : propre au courtier qui l'envoie. */
export const assureImportsFolder = (cabinetId: string, uid: string) => `cabinets/${cabinetId}/imports/${uid}`;
/** Pièces rangées avec un client. */
export const assureDocumentsFolder = (cabinetId: string, assureId: string) => `cabinets/${cabinetId}/assures/${assureId}/documents`;

const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;

/** Le chemin est-il un fichier du dépôt provisoire de CE courtier (aucun « .. », aucun sous-dossier) ? */
export function isAssureImportPath(path: unknown, cabinetId: string, uid: string): path is string {
  const prefix = `${assureImportsFolder(cabinetId, uid)}/`;
  return typeof path === 'string' && path.startsWith(prefix) && FILE_NAME.test(path.slice(prefix.length));
}

const FIELDS: Record<AssureReadableType, string[]> = {
  cin: [
    '- civilite : "M." ou "Mme" (sexe M ou F)',
    '- lastName : nom de naissance (le nom d\'usage seulement s\'il est seul)',
    '- firstName : premier prénom uniquement',
    '- birthDate : date de naissance, format AAAA-MM-JJ',
    '- street, postalCode (5 chiffres), city : adresse, seulement si elle est imprimée (verso de l\'ancien modèle)',
  ],
  kbis: [
    '- companyName : dénomination ou raison sociale',
    '- siret : SIRET du siège (14 chiffres) ; s\'il n\'y a que le SIREN (9 chiffres), omettre',
    '- lastName, firstName : nom et premier prénom du représentant légal (gérant, président)',
    '- street, postalCode (5 chiffres), city : adresse du siège',
  ],
};

const LABELS: Record<AssureReadableType, string> = {
  cin: "carte nationale d'identité française",
  kbis: 'extrait Kbis',
};

/** Consigne envoyée à l'IA pour une pièce de client. */
export function buildAssureOcrPrompt(type: AssureReadableType): string {
  return [
    `Tu lis un(e) ${LABELS[type]} joint(e). Extrais uniquement les champs suivants :`,
    ...FIELDS[type],
    '',
    'Réponds UNIQUEMENT avec un JSON de la forme {"civilite":"...","firstName":"...",...}.',
    "N'invente jamais : un champ absent, illisible ou incertain est omis. N'ajoute aucun autre champ.",
    'Écris les noms et la ville avec une majuscule initiale (Dupont, et non DUPONT).',
  ].join('\n');
}

/** Le premier objet JSON d'un texte (l'IA l'entoure parfois de ```json … ```). */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed && trimmed.length <= max ? trimmed : undefined;
};

/** Date AAAA-MM-JJ qui existe et n'est pas dans le futur. */
function pastDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ASSURE_BIRTH_DATE_PATTERN.test(value)) return undefined;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const exists = date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
  return exists && y >= 1900 && date <= new Date() ? value : undefined;
}

/**
 * Contrôle la réponse de l'IA : seuls les champs prévus pour ce type de pièce sont gardés, chacun au bon format.
 * Un champ vide ou invalide est écarté (jamais de valeur inventée). `null` si la réponse n'est pas un JSON exploitable.
 */
export function parseAssureOcrResponse(response: string, type: AssureReadableType): AssureOcrValues | null {
  const raw = extractJson(response);
  if (!raw) return null;
  const values: AssureOcrValues = {
    firstName: text(raw['firstName'], ASSURE_MAX_LENGTHS.firstName),
    lastName: text(raw['lastName'], ASSURE_MAX_LENGTHS.lastName),
    street: text(raw['street'], ASSURE_MAX_LENGTHS.street),
    city: text(raw['city'], ASSURE_MAX_LENGTHS.city),
  };
  const postalCode = text(raw['postalCode'], 5);
  if (postalCode && ASSURE_POSTAL_CODE_PATTERN.test(postalCode)) values.postalCode = postalCode;
  if (type === 'cin') {
    if (raw['civilite'] === 'M.' || raw['civilite'] === 'Mme') values.civilite = raw['civilite'];
    values.birthDate = pastDate(raw['birthDate']);
  } else {
    values.companyName = text(raw['companyName'], ASSURE_MAX_LENGTHS.companyName);
    const siret = typeof raw['siret'] === 'string' ? raw['siret'].replace(/\s/g, '') : '';
    if (ASSURE_SIRET_PATTERN.test(siret)) values.siret = siret;
  }
  // Champs non lus retirés : « absent » et « vide » se confondent pour l'app.
  for (const key of Object.keys(values) as (keyof AssureOcrValues)[]) {
    if (values[key] === undefined) delete values[key];
  }
  return values;
}

const CLASSIFY_LABELS: Record<AssureDocumentType, string> = {
  cin: "carte nationale d'identité ou passeport (recto ou verso)",
  kbis: 'extrait Kbis',
  carte_grise: "certificat d'immatriculation (carte grise), recto ou verso",
  permis: 'permis de conduire, recto ou verso',
  releve_information: "relevé d'information d'un assureur auto",
  autre: 'autre document',
};

/** Consigne envoyée à l'IA pour reconnaître le type d'une pièce de client. */
export function buildAssureClassifyPrompt(): string {
  return [
    'Tu reçois un document joint. Indique de quel type il s’agit, parmi :',
    ...ASSURE_DOCUMENT_TYPES.map(type => `- ${type} : ${CLASSIFY_LABELS[type]}`),
    '',
    'Réponds UNIQUEMENT avec un JSON de la forme {"type":"..."}. En cas de doute, réponds {"type":"autre"}.',
  ].join('\n');
}

/** Type reconnu par l'IA, ou `null` si la réponse n'est pas exploitable. */
export function parseAssureClassifyResponse(response: string): AssureDocumentType | null {
  const type = extractJson(response)?.['type'];
  return (ASSURE_DOCUMENT_TYPES as readonly unknown[]).includes(type) ? (type as AssureDocumentType) : null;
}
