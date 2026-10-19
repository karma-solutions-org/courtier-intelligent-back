import { loadCatalog } from "./catalog";

/** Valide les JSON du catalogue sans rien publier. Code de sortie 1 si un fichier est invalide (CI). */
const { catalog, issues } = loadCatalog();
if (issues.length) {
  console.error(`Catalogue invalide (${issues.length} problème(s)) :\n${issues.map(i => ` - ${i.file} : ${i.message}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `Catalogue valide : ${catalog.plans.length} offre(s), ${catalog.insurers.length} assureur(s), ` +
    `${catalog.products.length} produit(s).`,
);
