import * as admin from "firebase-admin";
import { indexDocuments, indexName } from "../elastic/elastic.util";
import {
  ASSURES_INDEX,
  assureDisplayName,
  DOSSIERS_INDEX,
  toAssureSearchDoc,
  toDossierSearchDoc,
} from "../elastic/search.documents";
import { initOps, run } from "./ops.utils";

const USAGE =
  "ELASTIC_CLOUD_ID=… ELASTIC_API_KEY=… ELASTIC_INDEX_PREFIX=… npm run ops:reindex-elastic -- --project <id> [--cabinet <id>] [--confirm]";

/**
 * (Ré)indexe dans Elasticsearch tous les clients et dossiers déjà présents dans Firestore.
 * À lancer UNE fois après le premier déploiement des triggers recherche-* (ils n'indexent que les écritures
 * suivantes), puis au besoin (index perdu, mapping changé). Sans risque à relancer : chaque document est remplacé.
 *
 * Sans --confirm : compte seulement ce qui serait indexé (aucune écriture).
 * Doit tourner depuis une machine dont l'IP est autorisée par Elastic, ou depuis le VPC partagé.
 */
run(async () => {
  const args = initOps({ cabinet: { type: "string" }, confirm: { type: "boolean" } }, USAGE);
  const db = admin.firestore();
  const cabinets = args.cabinet ? [args.cabinet] : (await db.collection("cabinets").listDocuments()).map(ref => ref.id);
  console.log(`Index : ${indexName(ASSURES_INDEX)}, ${indexName(DOSSIERS_INDEX)} — ${cabinets.length} cabinet(s).`);

  let assures = 0;
  let dossiers = 0;
  let failures = 0;
  for (const cabinetId of cabinets) {
    const assureDocs = (await db.collection(`cabinets/${cabinetId}/assures`).get()).docs;
    const names = new Map(assureDocs.map(doc => [doc.id, assureDisplayName(doc.data())]));
    const dossierDocs = (await db.collection(`cabinets/${cabinetId}/dossiers`).get()).docs;
    assures += assureDocs.length;
    dossiers += dossierDocs.length;
    if (!args.confirm) continue;

    for (let i = 0; i < assureDocs.length; i += 500) {
      failures += await indexDocuments(
        ASSURES_INDEX,
        assureDocs.slice(i, i + 500).map(doc => toAssureSearchDoc(cabinetId, doc.id, doc.data())),
      );
    }
    for (let i = 0; i < dossierDocs.length; i += 500) {
      failures += await indexDocuments(
        DOSSIERS_INDEX,
        dossierDocs
          .slice(i, i + 500)
          .map(doc => toDossierSearchDoc(cabinetId, doc.id, doc.data(), names.get(String(doc.get("assureId"))) ?? null)),
      );
    }
    console.log(`  ${cabinetId} : ${assureDocs.length} client(s), ${dossierDocs.length} dossier(s)`);
  }

  console.log(`${args.confirm ? "Indexés" : "À indexer (--confirm pour écrire)"} : ${assures} client(s), ${dossiers} dossier(s).`);
  if (failures) {
    console.error(`${failures} échec(s) : voir les détails ci-dessus.`);
    process.exitCode = 1;
  }
});
