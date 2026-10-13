import * as admin from "firebase-admin";
import { parseArgs } from "node:util";
import type { QuestionnaireSection } from "../shared/index.js";
import { loadCatalog } from "./catalog";
import { fail, initOps, run } from "./ops.utils";

const USAGE = "npm run ops:seed-catalog -- (--emulator | --project <id>) [--dry-run]";

/**
 * Publie le catalogue global (offres, assureurs, produits et leurs garanties/synonymes) depuis les JSON
 * du dépôt. Sans risque à relancer : chaque document a un identifiant fixe et est remplacé en entier.
 * Un JSON invalide bloque la publication : rien n'est écrit.
 */
run(async () => {
  const dryRun = parseArgs({ options: { "dry-run": { type: "boolean" } }, strict: false }).values["dry-run"] === true;
  const { catalog, issues } = loadCatalog();
  if (issues.length) {
    fail(`Catalogue invalide, publication annulée :\n${issues.map(i => ` - ${i.file} : ${i.message}`).join("\n")}`);
  }

  const documents = [
    ...catalog.plans.map(({ id, ...plan }) => ({ path: `plans/${id}`, data: plan })),
    ...catalog.insurers.map(({ id, ...insurer }) => ({ path: `insurers/${id}`, data: insurer })),
    ...catalog.products.flatMap(({ id, synonyms, ...product }) => [
      { path: `products/${id}`, data: product },
      { path: `guaranteeSynonyms/${id}`, data: { synonyms } },
    ]),
  ];

  if (dryRun) {
    console.log(`Catalogue valide (${documents.length} documents) : rien n'a été écrit (--dry-run).`);
    return;
  }

  initOps({ "dry-run": { type: "boolean" } }, USAGE);
  const db = admin.firestore();
  // Les questions ajoutées automatiquement depuis les extranets (section `discovered`) ne sont pas dans les JSON :
  // on les reprend du produit publié, sinon chaque publication les effacerait.
  for (const document of documents) {
    if (!document.path.startsWith("products/")) continue;
    const published = await db.doc(document.path).get();
    const discovered = ((published.get("questionnaireSchema") as QuestionnaireSection[] | undefined) ?? []).filter(s => s.discovered);
    const data = document.data as { questionnaireSchema?: QuestionnaireSection[] };
    if (discovered.length && data.questionnaireSchema) {
      data.questionnaireSchema = [...data.questionnaireSchema.filter(s => !s.discovered), ...discovered];
      console.log(`${document.path} : ${discovered[0].questions.length} question(s) découverte(s) conservée(s).`);
    }
  }
  const batch = db.batch();
  for (const { path, data } of documents) {
    batch.set(db.doc(path), data);
  }
  await batch.commit();
  console.log(`Catalogue publié : ${documents.length} documents (${documents.map(d => d.path).join(", ")}).`);
});
