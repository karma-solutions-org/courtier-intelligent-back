import { parseArgs } from "node:util";
import { loadCatalog } from "./catalog";
import { fail } from "./ops.utils";

const USAGE = "npm run ops:preview-questionnaire -- <produit>   (ex. auto)";

/**
 * Aperçu local d'un questionnaire (sans Firebase) : sections, champs, type, obligatoire, conditions.
 * Valide d'abord le catalogue : les problèmes sont affichés avant l'aperçu.
 */
const { positionals } = parseArgs({ allowPositionals: true });
const productId = positionals[0];
if (!productId) {
  fail(`Produit manquant.\n\nUsage : ${USAGE}`);
}

const { catalog, issues } = loadCatalog();
const product = catalog.products.find(p => p.id === productId);
if (!product) {
  fail(`Produit « ${productId} » introuvable. Produits : ${catalog.products.map(p => p.id).join(", ") || "aucun"}.`);
}

console.log(`\n${product.name} (${product.id})${product.active ? "" : " — inactif"}`);
for (const section of product.questionnaireSchema) {
  console.log(`\n■ ${section.title}`);
  for (const q of section.questions) {
    const flags = [q.type, q.required ? "obligatoire" : "facultatif", q.withKnowledge ? "niveau de connaissance" : ""].filter(Boolean);
    const condition = q.visibleIf ? `   ↳ seulement si ${q.visibleIf.path} = ${String(q.visibleIf.equals)}` : "";
    console.log(`  • ${q.label}  [${flags.join(", ")}]  ${q.canonicalPath}`);
    if (q.choices) console.log(`      choix : ${q.choices.map(c => c.label).join(" / ")}`);
    if (condition) console.log(condition);
  }
}
console.log(`\n${product.guaranteeCatalog.length} garanties, ${Object.keys(product.synonyms).length} avec synonymes.`);

if (issues.length) {
  console.error(`\n${issues.length} problème(s) dans le catalogue :\n${issues.map(i => ` - ${i.file} : ${i.message}`).join("\n")}`);
  process.exit(1);
}
