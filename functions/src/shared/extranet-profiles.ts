// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
// Profil d'extranet : comment l'extension entre dans l'extranet d'un assureur pour un produit, puis (briques
// suivantes) comment elle le parcourt et où elle lit le tarif. Appris une fois par un courtier (mode apprentissage),
// rejoué ensuite pour chaque dossier. STRUCTURE seulement : libellés de boutons et pages, jamais une donnée client.

/** Un clic de navigation (lien, bouton, entrée de menu). */
export interface NavAction {
  /** Texte visible de l'élément cliqué : « Tarificateur », « Nouveau devis ». */
  label: string;
  /** Position technique de l'élément (sélecteur CSS), en secours quand plusieurs éléments ont le même texte. */
  selector: string | null;
  /** Page où le clic a lieu (chemin de l'URL, numéros remplacés par `*`) : le rejeu vérifie qu'il est au bon endroit. */
  urlPattern: string | null;
}

export type ExtranetProfileStatus = 'draft' | 'validated';

export interface ExtranetProfile {
  insurerId: string;
  productId: string;
  /** Origine de l'extranet, ex. « https://zeole.zephir.fr ». */
  origin: string;
  version: number;
  status: ExtranetProfileStatus;
  /** Chemin d'accès : les clics depuis la page d'accueil jusqu'au formulaire de devis. */
  entry: NavAction[];
}

/** Identifiant d'un profil : un par assureur et par produit (le chemin d'un devis Auto n'est pas celui d'un devis Habitation). */
export const extranetProfileId = (insurerId: string, productId: string): string => `${insurerId}_${productId}`;

export const NAV_LABEL_MAX = 80;
export const NAV_SELECTOR_MAX = 300;
export const NAV_URL_PATTERN_MAX = 200;
/** Un chemin d'accès plus long est une erreur d'enregistrement (clics parasites). */
export const ENTRY_MAX_ACTIONS = 15;

/**
 * Boutons que l'extension ne clique JAMAIS, même enregistrés : ils valident l'opération ou engagent le client
 * (validation, confirmation, envoi, souscription, signature, paiement) ou détruisent des données. L'extension ne fait
 * que récupérer le tarif : le courtier clique ces boutons lui-même. Début de mot (accents compris), toute la suite.
 */
export const FORBIDDEN_NAV_LABEL =
  /(?<!\p{L})(valid|confirm|envo[iy]|transm|[ée]mett|[ée]mission|accept|adh[ée]r|adh[ée]sion|finalis|termin|engag|contracter|souscri|sign(er|ature)|pa(yer|iement)|r[ée]gl(er|ement)|command|supprim|effac|r[ée]sili|d[ée]connex|se d[ée]connecter)/iu;

const cleanLabel = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Chemin d'une URL sans paramètres ni ancre (qui peuvent porter des données), les segments qui contiennent un chiffre
 * remplacés par `*` (numéros de dossier, de session) : « /devis/12345/etape » → « /devis/*\/etape ».
 */
export function urlPatternOf(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    return pathname
      .split('/')
      .map(segment => (/\d/.test(segment) ? '*' : segment))
      .join('/')
      .slice(0, NAV_URL_PATTERN_MAX);
  } catch {
    return null;
  }
}

/** La page `url` correspond-elle au motif enregistré ? Sans motif, toute page convient. */
export function matchesUrlPattern(url: string, pattern: string | null): boolean {
  if (!pattern) return true;
  return urlPatternOf(url) === pattern;
}

/** Un clic de navigation valide (bornes, jamais un bouton interdit), ou null. */
export function sanitizeNavAction(input: unknown): NavAction | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const label = typeof raw['label'] === 'string' ? cleanLabel(raw['label']) : '';
  if (!label || label.length > NAV_LABEL_MAX || FORBIDDEN_NAV_LABEL.test(label)) return null;
  const selector = typeof raw['selector'] === 'string' && raw['selector'].length <= NAV_SELECTOR_MAX ? raw['selector'] : null;
  const urlPattern =
    typeof raw['urlPattern'] === 'string' && raw['urlPattern'].startsWith('/') && raw['urlPattern'].length <= NAV_URL_PATTERN_MAX
      ? raw['urlPattern']
      : null;
  return { label, selector, urlPattern };
}

/** Chemin d'accès valide : clics valides, au plus ENTRY_MAX_ACTIONS ; null si l'un d'eux est invalide. */
export function sanitizeEntry(input: unknown): NavAction[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > ENTRY_MAX_ACTIONS) return null;
  const actions = input.map(sanitizeNavAction);
  return actions.every((action): action is NavAction => action !== null) ? actions : null;
}
