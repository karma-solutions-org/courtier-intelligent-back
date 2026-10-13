import type { QueryDslQueryContainer } from "@elastic/elasticsearch/lib/api/types";

/**
 * Documents envoyés à Elasticsearch et requêtes de recherche : fonctions pures (testées sans cluster).
 *
 * Elasticsearch n'est qu'un CATALOGUE : il garde de quoi retrouver un client ou un dossier, Firestore reste la source.
 * Chaque document porte `cabinetId`, et toute recherche filtre dessus : un courtier ne voit jamais un autre cabinet.
 * Pas de mapping explicite (comme CompliScan) : les textes reçoivent automatiquement un sous-champ `.keyword`,
 * utilisé pour les filtres exacts.
 */

export const ASSURES_INDEX = "assures";
export const DOSSIERS_INDEX = "dossiers";

export const SEARCH_SIZE_DEFAULT = 50;
export const SEARCH_SIZE_MAX = 200;
export const SEARCH_INPUT_MAX = 100;

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Client tel qu'indexé : identité, contact, ville, SIRET, et s'il est dans la corbeille. */
export function toAssureSearchDoc(cabinetId: string, assureId: string, data: Record<string, unknown>) {
  const address = (data.address ?? {}) as Record<string, unknown>;
  return {
    id: assureId,
    cabinetId,
    type: text(data.type),
    lastName: text(data.lastName),
    firstName: text(data.firstName),
    companyName: text(data.companyName),
    email: text(data.email),
    phone: text(data.phone),
    siret: text(data.siret),
    city: text(address.city),
    postalCode: text(address.postalCode),
    deleted: !!data.deletedAt,
  };
}

/** Nom affiché d'un client : raison sociale, sinon prénom et nom. */
export function assureDisplayName(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  return text(data.companyName) ?? text([data.firstName, data.lastName].filter(Boolean).join(" "));
}

/** Dossier tel qu'indexé : référence, statut, produit, et le nom de son client (pour le retrouver par le client). */
export function toDossierSearchDoc(
  cabinetId: string,
  dossierId: string,
  data: Record<string, unknown>,
  assureName: string | null,
) {
  return {
    id: dossierId,
    cabinetId,
    assureId: text(data.assureId),
    assureName,
    reference: text(data.reference),
    status: text(data.status),
    productId: text(data.productId),
    assignedTo: text(data.assignedTo),
    deleted: !!data.deletedAt,
  };
}

/** Taille et décalage demandés, bornés. */
export function pageOf(raw: { size?: unknown; from?: unknown }): { size: number; from: number } {
  const size = Number.isInteger(raw.size) ? Math.min(Math.max(raw.size as number, 1), SEARCH_SIZE_MAX) : SEARCH_SIZE_DEFAULT;
  const from = Number.isInteger(raw.from) ? Math.max(raw.from as number, 0) : 0;
  return { size, from };
}

/** Texte cherché : nettoyé et borné ; chaîne vide si rien d'utile. */
export function cleanSearchInput(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ").slice(0, SEARCH_INPUT_MAX) : "";
}

/**
 * Requête de recherche, même principe que CompliScan : filtre du cabinet et de la corbeille, puis trois façons de
 * correspondre (au moins une suffit) — mots exacts (poids fort), mots avec fautes de frappe, et morceaux de mots
 * (« bert » trouve « Berthier »). Sans texte : tout le cabinet.
 */
export function buildSearchQuery(
  cabinetId: string,
  input: string,
  fields: string[],
  options: { deleted: boolean },
): QueryDslQueryContainer {
  const filter: QueryDslQueryContainer[] = [
    { term: { "cabinetId.keyword": cabinetId } },
    { term: { deleted: options.deleted } },
  ];
  const tokens = input
    .replace(/[*?\\/"'()[\]{}:!^~+\-&|<>=]/g, " ")
    .split(" ")
    .map(token => token.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!tokens.length) {
    return { bool: { filter } };
  }
  const plainFields = fields.map(field => field.split("^")[0]);
  return {
    bool: {
      filter,
      minimum_should_match: 1,
      should: [
        { multi_match: { query: input, fields, operator: "or", boost: 5 } },
        {
          multi_match: {
            query: input,
            fields,
            operator: "or",
            fuzziness: "AUTO",
            prefix_length: 2,
            fuzzy_transpositions: true,
          },
        },
        {
          query_string: {
            query: tokens.map(token => `*${token.toLowerCase()}*`).join(" AND "),
            fields: plainFields,
            default_operator: "AND",
            analyze_wildcard: true,
          },
        },
      ],
    },
  };
}

/** Champs cherchés et leur poids. */
export const ASSURE_SEARCH_FIELDS = ["lastName^3", "firstName^3", "companyName^3", "email^2", "siret^2", "phone", "city", "postalCode"];
export const DOSSIER_SEARCH_FIELDS = ["reference^3", "assureName^3", "productId"];
