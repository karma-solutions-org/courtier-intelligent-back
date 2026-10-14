import { Client } from "@elastic/elasticsearch";
import { defineSecret } from "firebase-functions/params";
import type { QueryDslQueryContainer, SearchHit } from "@elastic/elasticsearch/lib/api/types";

/**
 * Accès à Elasticsearch, repris de compli-scan-back (même cluster Elastic Cloud, même montage) :
 * - identifiants dans Secret Manager (`ELASTIC_CLOUD_ID`, `ELASTIC_API_KEY`), comme GEMINI_API_KEY : déclarés ici,
 *   attachés aux functions qui en ont besoin (`secrets: ELASTIC_SECRETS`), jamais dans le code ;
 * - index nommés d'après le projet, comme les autres apps du projet partagé : `aibs-partenaire-testing-<index>` ;
 * - les functions qui l'appellent passent par le VPC partagé (voir vpc-functions.ts) : Elastic n'accepte que l'IP NAT.
 */

export type SearchDocument = { id: string } & Record<string, unknown>;

/** Secrets Secret Manager du projet (déjà créés en test). Firebase les expose aux functions comme variables d'environnement. */
export const ELASTIC_API_KEY = defineSecret("ELASTIC_API_KEY");
export const ELASTIC_CLOUD_ID = defineSecret("ELASTIC_CLOUD_ID");
export const ELASTIC_SECRETS = [ELASTIC_API_KEY, ELASTIC_CLOUD_ID];

let clientInstance: Client | undefined;

export function elasticClient(): Client {
  if (!clientInstance) {
    const apiKey = process.env.ELASTIC_API_KEY;
    const cloudId = process.env.ELASTIC_CLOUD_ID;
    if (!apiKey || !cloudId) {
      throw new Error(
        "[ELASTIC_CONFIG_ERROR] ELASTIC_API_KEY et ELASTIC_CLOUD_ID absents : secrets Secret Manager non attachés " +
          "à cette function (secrets: ELASTIC_SECRETS) ou non définis dans le projet. Aucune valeur par défaut.",
      );
    }
    clientInstance = new Client({ cloud: { id: cloudId }, auth: { apiKey } });
  }
  return clientInstance;
}

/**
 * Préfixe des index : le projet Firebase où tourne la function (« aibs-partenaire-testing- »), fourni par Cloud Functions
 * (GCLOUD_PROJECT). Même convention que les autres apps du projet partagé.
 */
export function indexPrefix(): string {
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!project) {
    throw new Error("[ELASTIC_CONFIG_ERROR] Projet inconnu (GCLOUD_PROJECT absent) : impossible de nommer les index.");
  }
  return `${project.toLowerCase()}-`;
}

/**
 * Cause lisible d'une erreur Elasticsearch, écrite dans le résumé du log (sans secret) : type d'erreur du client,
 * code HTTP et raison renvoyés par le cluster, cluster visé et index. Exemples :
 * « ConnectionError: … » (réseau / VPC), « ResponseError 401 security_exception » (clé), « 403 » (droits ou filtre IP).
 */
export function describeElasticError(error: unknown): string {
  const e = error as { name?: string; message?: string; meta?: { statusCode?: number; body?: unknown } };
  const body = e?.meta?.body as { error?: { type?: string; reason?: string } | string } | string | undefined;
  const reason =
    typeof body === "string"
      ? body.slice(0, 300)
      : typeof body?.error === "string"
        ? body.error
        : [body?.error?.type, body?.error?.reason].filter(Boolean).join(" : ");
  return [e?.name ?? "Error", e?.meta?.statusCode, reason || e?.message, `cluster=${clusterHost()}`]
    .filter(part => part !== undefined && part !== "")
    .join(" | ")
    .slice(0, 800);
}

/** Hôte du cluster déduit du Cloud ID (non secret), pour vérifier dans les logs qu'on vise le bon cluster. */
export function clusterHost(): string {
  const cloudId = process.env.ELASTIC_CLOUD_ID;
  if (!cloudId) return "ELASTIC_CLOUD_ID absent";
  try {
    const decoded = Buffer.from(cloudId.slice(cloudId.indexOf(":") + 1), "base64").toString("utf8");
    const [domain, esId] = decoded.split("$");
    return esId && domain ? `${esId.slice(0, 8)}….${domain.split(":")[0]}` : "Cloud ID illisible";
  } catch {
    return "Cloud ID illisible";
  }
}

/** Nom complet d'un index (« assures » → « aibs-partenaire-testing-assures »). */
export function indexName(index: string): string {
  return `${indexPrefix()}${index}`;
}

/** Ajoute ou remplace un document (visible tout de suite par la recherche). */
export async function indexDocument(index: string, document: SearchDocument): Promise<void> {
  await elasticClient().index({ index: indexName(index), id: document.id, document, refresh: true });
}

/** Ajoute ou remplace plusieurs documents ; renvoie le nombre d'échecs (détaillés dans les logs). */
export async function indexDocuments(index: string, documents: SearchDocument[]): Promise<number> {
  if (!documents.length) return 0;
  const name = indexName(index);
  const operations = documents.flatMap(document => [{ index: { _index: name, _id: document.id } }, document]);
  const response = await elasticClient().bulk({ operations, refresh: true });
  if (!response.errors) return 0;
  const failed = response.items.filter(item => item.index?.error);
  console.error(`[ELASTIC] ${failed.length} échec(s) d'indexation dans ${name}`, JSON.stringify(failed.slice(0, 5)));
  return failed.length;
}

/** Retire un document ; un document absent n'est pas une erreur. */
export async function deleteDocument(index: string, id: string): Promise<void> {
  await elasticClient().delete({ index: indexName(index), id, refresh: true }, { ignore: [404] });
}

/** Identifiants trouvés, dans l'ordre de pertinence. */
export async function searchIds(
  index: string,
  query: QueryDslQueryContainer,
  options: { size: number; from: number },
): Promise<string[]> {
  const response = await elasticClient().search({
    index: indexName(index),
    query,
    size: options.size,
    from: options.from,
    _source: false,
    // Index pas encore créé (aucun document indexé) : aucun résultat plutôt qu'une erreur.
    ignore_unavailable: true,
  });
  return response.hits.hits.map((hit: SearchHit<unknown>) => hit._id).filter((id): id is string => !!id);
}
