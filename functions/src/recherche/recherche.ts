import * as admin from "firebase-admin";
import { logger } from "firebase-functions/v2";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { type CallableRequest, HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership } from "../core/auth.utils";
import { CALLABLE_OPTIONS, REGION_ID } from "../core/config";
import { assurePath, dossiersPath } from "../core/firestore-paths";
import { VPC_MAX_INSTANCES } from "../vpc-functions";
import { deleteDocument, describeElasticError, ELASTIC_SECRETS, indexDocument, indexDocuments, searchHits, searchIds } from "../elastic/elastic.util";
import {
  ASSURE_SEARCH_FIELDS,
  ASSURES_INDEX,
  assureDisplayName,
  buildSearchQuery,
  cleanSearchInput,
  DOSSIER_SEARCH_FIELDS,
  DOSSIERS_INDEX,
  dossierTerms,
  pageOf,
  periodOf,
  sortOf,
  type SearchTerms,
  toAssureSearchDoc,
  toDossierSearchDoc,
} from "../elastic/search.documents";

/**
 * Recherche Elasticsearch des clients et des dossiers (même montage que CompliScan).
 *
 * L'app écrit les clients directement dans Firestore : ce sont donc des TRIGGERS qui tiennent le catalogue à jour
 * (création, modification, corbeille, suppression définitive). Une erreur Elasticsearch est journalisée et n'empêche
 * jamais l'écriture : Firestore reste la source, le script ops:reindex-elastic rattrape au besoin.
 *
 * Toutes ces functions parlent à Elasticsearch : elles sont listées dans vpc-functions.ts (IP NAT du VPC partagé).
 */

/** Fonctions sur le VPC partagé : nombre d'instances borné (le sous-réseau est partagé avec d'autres projets). */
const TRIGGER_OPTIONS = { region: REGION_ID, retry: false, maxInstances: VPC_MAX_INSTANCES, secrets: ELASTIC_SECRETS };
const SEARCH_OPTIONS = { ...CALLABLE_OPTIONS, maxInstances: VPC_MAX_INSTANCES, secrets: ELASTIC_SECRETS };

/** Client créé, modifié ou supprimé : copie dans l'index ; nom changé : ses dossiers sont réindexés (nom du client). */
export const indexerAssure = onDocumentWritten(
  { ...TRIGGER_OPTIONS, document: "ci_cabinets/{cabinetId}/ci_assures/{assureId}" },
  async event => {
    const { cabinetId, assureId } = event.params;
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    try {
      if (!after) {
        await deleteDocument(ASSURES_INDEX, assureId);
        return;
      }
      await indexDocument(ASSURES_INDEX, toAssureSearchDoc(cabinetId, assureId, after));
      const name = assureDisplayName(after);
      if (before && assureDisplayName(before) !== name) {
        const dossiers = await admin
          .firestore()
          .collection(dossiersPath(cabinetId))
          .where("assureId", "==", assureId)
          .get();
        await indexDocuments(
          DOSSIERS_INDEX,
          dossiers.docs.map(dossier => toDossierSearchDoc(cabinetId, dossier.id, dossier.data(), name)),
        );
      }
    } catch (error) {
      logger.error(`recherche-indexerAssure : indexation impossible — ${describeElasticError(error)}`, { cabinetId, assureId });
    }
  },
);

/** Dossier créé, modifié ou supprimé : copie dans l'index, avec le nom de son client. */
export const indexerDossier = onDocumentWritten(
  { ...TRIGGER_OPTIONS, document: "ci_cabinets/{cabinetId}/ci_dossiers/{dossierId}" },
  async event => {
    const { cabinetId, dossierId } = event.params;
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    try {
      if (!after) {
        await deleteDocument(DOSSIERS_INDEX, dossierId);
        return;
      }
      // Les champs cherchés changent rarement (référence, statut, client…) : on évite de réindexer à chaque frappe.
      const watched = ["reference", "status", "assureId", "productId", "assignedTo", "deletedAt", "deletedWith"];
      if (before && watched.every(key => JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null))) {
        return;
      }
      const assure = after.assureId ? await admin.firestore().doc(assurePath(cabinetId, String(after.assureId))).get() : null;
      await indexDocument(DOSSIERS_INDEX, toDossierSearchDoc(cabinetId, dossierId, after, assureDisplayName(assure?.data())));
    } catch (error) {
      logger.error(`recherche-indexerDossier : indexation impossible — ${describeElasticError(error)}`, { cabinetId, dossierId });
    }
  },
);

/** Recherche commune : le cabinet vient du jeton de l'appelant, jamais de la requête. Corbeille exclue. */
async function search(request: CallableRequest, index: string, fields: string[], terms: SearchTerms = {}): Promise<{ ids: string[] }> {
  const { cabinetId } = await getActiveMembership(request);
  const input = cleanSearchInput(request.data?.q);
  const page = pageOf({ size: request.data?.size, from: request.data?.from });
  const query = buildSearchQuery(cabinetId, input, fields, { deleted: false, terms });
  try {
    return { ids: await searchIds(index, query, { ...page, sort: sortOf(input, "createdAt") }) };
  } catch (error) {
    logger.error(`recherche : Elasticsearch indisponible — ${describeElasticError(error)}`, { index });
    throw new HttpsError("unavailable", "La recherche est momentanément indisponible. Réessayez.", { reason: "search_unavailable" });
  }
}

/**
 * Clients du cabinet (hors corbeille) correspondant au texte : identifiants dans l'ordre de pertinence (sans texte : les
 * plus récents d'abord). Données : { q, size?, from? } → { ids }.
 */
export const clients = onCall(SEARCH_OPTIONS, request => search(request, ASSURES_INDEX, ASSURE_SEARCH_FIELDS));

/**
 * Dossiers du cabinet (hors corbeille) correspondant au texte (référence, nom du client, produit), avec filtres exacts.
 * Données : { q, size?, from?, status?, productId?, assignedTo?, assureId? } (chaque filtre : valeur ou liste) → { ids }.
 */
export const dossiers = onCall(SEARCH_OPTIONS, request =>
  search(request, DOSSIERS_INDEX, DOSSIER_SEARCH_FIELDS, dossierTerms(request.data as Record<string, unknown> | undefined)),
);

/**
 * Corbeille : clients et dossiers supprimés du cabinet, les plus récemment supprimés d'abord (sans texte).
 * Données : { q?, kind?: "client" | "dossier" (sans : les deux), from?: date, to?: date (période de suppression, ms ou ISO),
 * size?, offset? } → { items: [{ kind: "client" | "dossier", id }] }.
 */
export const corbeille = onCall(SEARCH_OPTIONS, async request => {
  const { cabinetId } = await getActiveMembership(request);
  const kind = request.data?.kind;
  if (kind !== undefined && kind !== null && kind !== "client" && kind !== "dossier") {
    throw new HttpsError("invalid-argument", "Type invalide.");
  }
  const input = cleanSearchInput(request.data?.q);
  const page = pageOf({ size: request.data?.size, from: request.data?.offset });
  const indices = kind === "client" ? [ASSURES_INDEX] : kind === "dossier" ? [DOSSIERS_INDEX] : [ASSURES_INDEX, DOSSIERS_INDEX];
  const fields = kind === "client" ? ASSURE_SEARCH_FIELDS : kind === "dossier" ? DOSSIER_SEARCH_FIELDS : [...ASSURE_SEARCH_FIELDS, ...DOSSIER_SEARCH_FIELDS];
  const query = buildSearchQuery(cabinetId, input, fields, { deleted: true, period: periodOf("deletedAt", request.data) });
  try {
    const hits = await searchHits(indices, query, { ...page, sort: sortOf(input, "deletedAt") });
    return { items: hits.map(hit => ({ kind: hit.index === ASSURES_INDEX ? "client" : "dossier", id: hit.id })) };
  } catch (error) {
    logger.error(`recherche-corbeille : Elasticsearch indisponible — ${describeElasticError(error)}`);
    throw new HttpsError("unavailable", "La recherche est momentanément indisponible. Réessayez.", { reason: "search_unavailable" });
  }
});
