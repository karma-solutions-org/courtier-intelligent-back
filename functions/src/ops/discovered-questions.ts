import * as admin from "firebase-admin";
import { productPath } from "../core/firestore-paths";
import type { QuestionnaireSection } from "../shared/index.js";
import { fail, initOps, required, run } from "./ops.utils";

const USAGE =
  "npm run ops:discovered-questions -- (--emulator | --project <id>) --product <id> [--remove <extra.code>]";

/**
 * Questions ajoutées automatiquement depuis les extranets (section « Questions des assureurs ») : liste, ou retrait
 * d'une question parasite. Les réponses déjà saisies dans les dossiers restent dans leurs données (rien n'est effacé).
 */
run(async () => {
  const args = initOps({ product: { type: "string" }, remove: { type: "string" } }, USAGE);
  const productId = required(args.product, "product", USAGE);
  const db = admin.firestore();
  const ref = db.doc(productPath(productId));

  const remove = typeof args.remove === "string" ? args.remove : null;
  const removed = await db.runTransaction(async tx => {
    const product = await tx.get(ref);
    if (!product.exists) fail(`Produit « ${productId} » introuvable.`);
    const schema = (product.get("questionnaireSchema") as QuestionnaireSection[] | undefined) ?? [];
    const section = schema.find(s => s.discovered);
    if (!remove) {
      const questions = section?.questions ?? [];
      console.log(questions.length ? `${questions.length} question(s) découverte(s) :` : "Aucune question découverte.");
      for (const q of questions) {
        const sources = (q.discoveredOn ?? []).map(s => s.insurerId ?? s.origin).join(", ");
        console.log(` - ${q.canonicalPath} · ${q.label} (${q.type}) · vue chez : ${sources}`);
      }
      return null;
    }
    if (!section?.questions.some(q => q.canonicalPath === remove)) {
      fail(`« ${remove} » n'est pas une question découverte du produit ${productId}.`);
    }
    const next = schema
      .map(s => (s.discovered ? { ...s, questions: s.questions.filter(q => q.canonicalPath !== remove) } : s))
      .filter(s => !s.discovered || s.questions.length > 0);
    tx.update(ref, { questionnaireSchema: next });
    return remove;
  });
  if (removed) console.log(`Question ${removed} retirée du produit ${productId}.`);
});
