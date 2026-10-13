import { Client } from "@elastic/elasticsearch";
import type { QueryDslQueryContainer, SearchHit } from "@elastic/elasticsearch/lib/api/types";

/**
 * Accès à Elasticsearch, repris de compli-scan-back (même cluster Elastic Cloud, même montage) :
 * - identifiants lus dans l'environnement (`ELASTIC_CLOUD_ID`, `ELASTIC_API_KEY`), injectés par le workflow de
 *   déploiement depuis les secrets GitHub : jamais dans le code, et aucune valeur par défaut ;
 * - préfixe d'index propre à chaque projet (`ELASTIC_INDEX_PREFIX`, fichier `.env.<projet>`), obligatoire ;
 * - les functions qui l'appellent passent par le VPC partagé (voir vpc-functions.ts) : Elastic n'accepte que l'IP NAT.
 */

/** Projet de production et préfixe des index de test : la prod ne doit jamais lire ni écrire les index de test. */
const PRODUCTION_PROJECT_ID = "aibs-part";
const TEST_INDEX_PREFIX = "aibs-partenaire-testing-";

export type SearchDocument = { id: string } & Record<string, unknown>;

let clientInstance: Client | undefined;

export function elasticClient(): Client {
  if (!clientInstance) {
    const apiKey = process.env.ELASTIC_API_KEY;
    const cloudId = process.env.ELASTIC_CLOUD_ID;
    if (!apiKey || !cloudId) {
      throw new Error(
        "[ELASTIC_CONFIG_ERROR] ELASTIC_API_KEY et ELASTIC_CLOUD_ID doivent être fournis par l'environnement " +
          "(secrets GitHub injectés au déploiement). Aucune valeur par défaut.",
      );
    }
    clientInstance = new Client({ cloud: { id: cloudId }, auth: { apiKey } });
  }
  return clientInstance;
}

/** Préfixe des index de ce projet, obligatoire : un préfixe deviné pourrait faire écrire la prod dans les index de test. */
export function indexPrefix(): string {
  const prefix = process.env.ELASTIC_INDEX_PREFIX?.toLowerCase();
  if (!prefix) {
    throw new Error("[ELASTIC_CONFIG_ERROR] ELASTIC_INDEX_PREFIX n'est pas défini pour ce projet.");
  }
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  if (project === PRODUCTION_PROJECT_ID && prefix.startsWith(TEST_INDEX_PREFIX)) {
    throw new Error(
      `[ELASTIC_CONFIG_ERROR] Projet de production (${PRODUCTION_PROJECT_ID}) configuré avec le préfixe de test ` +
        `(« ${TEST_INDEX_PREFIX} ») : corrigez ELASTIC_INDEX_PREFIX avant de redéployer.`,
    );
  }
  return prefix;
}

/** Nom complet d'un index (« assures » → « aibs-partenaire-testing-ci-assures »). */
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
