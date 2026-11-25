// Questionnaire en deux niveaux (phase 2) sur le vrai catalogue Auto : socle (`core`) toujours posé, compléments des
// extranets choisis, autres compléments dans la section facultative (jamais obligatoires, toujours acceptés).
// Lancer avec : npm run test:unit
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  computeCompleteness,
  DISCOVERED_SECTION_TITLE,
  OPTIONAL_SECTION_TITLE,
  questionFor,
  questionsOf,
  schemaWithComplements,
  validateAnswer,
} = require("../lib/shared/index.js");
const { loadCatalog } = require("../lib/ops/catalog.js");
const { withLateDiscoveredQuestions } = require("../lib/core/dossier.utils.js");

const { catalog } = loadCatalog();
const schema = catalog.products.find(p => p.id === "auto").questionnaireSchema;
const insurer = id => catalog.insurers.find(i => i.id === id);
const paths = sections => questionsOf(sections).map(q => q.canonicalPath);
const optionalOf = sections => sections.find(s => s.optional);
const mainOf = sections => sections.filter(s => !s.optional);

/** Questions du socle obligatoires et visibles sans condition : ce qu'un dossier vide doit fournir au minimum. */
const coreRequired = questionsOf(schema)
  .filter(q => q.core && q.required && !q.visibleIf)
  .map(q => q.canonicalPath);

describe("Extranet sans liste de questions (Allianz) : le socle seulement", () => {
  const tiered = schemaWithComplements(schema, [insurer("allianz")], "auto");

  it("pose les 29 questions du socle, le reste en section facultative à la fin", () => {
    assert.deepEqual(
      paths(mainOf(tiered)).sort(),
      questionsOf(schema)
        .filter(q => q.core)
        .map(q => q.canonicalPath)
        .sort(),
    );
    assert.equal(tiered.at(-1).title, OPTIONAL_SECTION_TITLE);
    assert.equal(tiered.at(-1).optional, true);
    // Rien n'est perdu : socle + facultatif = tout le questionnaire du catalogue.
    assert.equal(paths(tiered).length, questionsOf(schema).length);
  });

  it("un dossier vide n'exige que les questions obligatoires du socle", () => {
    const { ok, missing } = computeCompleteness(tiered, {});
    assert.equal(ok, false);
    assert.deepEqual([...missing].sort(), [...coreRequired].sort());
    // Obligatoires dans le catalogue, mais compléments qu'aucun extranet choisi ne demande.
    for (const path of ["vehicle.version", "vehicle.fiscalPower", "driver.socioProfessionalCategory"]) {
      assert.ok(!missing.includes(path), path);
      assert.equal(questionFor(tiered, path).required, false, path);
    }
  });
});

describe("Oyat (liste du catalogue) : le socle plus ses compléments", () => {
  const tiered = schemaWithComplements(schema, [insurer("oyat")], "auto");

  it("ajoute au socle les compléments de sa liste, hors section facultative", () => {
    const main = paths(mainOf(tiered));
    for (const path of [
      "driver.birthCountry",
      "driver.profession",
      "insuranceHistory.seniority",
      "insuranceHistory.claims.1.type",
    ]) {
      assert.ok(main.includes(path), path);
    }
    const optional = paths([optionalOf(tiered)]);
    assert.ok(optional.includes("vehicle.version"));
    assert.ok(optional.includes("driver.socioProfessionalCategory"));
    assert.ok(!optional.includes("driver.profession"));
  });

  it("Oyat + un extranet sans liste : le socle et les compléments d'Oyat, pas tout le questionnaire", () => {
    const both = schemaWithComplements(schema, [insurer("oyat"), insurer("allianz")], "auto");
    assert.deepEqual(paths(mainOf(both)), paths(mainOf(tiered)));
    assert.ok(optionalOf(both));
  });
});

describe("Section facultative : réponses acceptées, sans effet sur la complétude", () => {
  const tiered = schemaWithComplements(schema, [insurer("allianz")], "auto");
  const complete = Object.fromEntries(
    coreRequired.map(path => {
      const q = questionFor(schema, path);
      if (q.withKnowledge) return [path, { value: 0, knowledge: "KNOWN" }];
      if (q.type === "boolean") return [path, false];
      if (q.type === "date") return [path, "2000-01-01"];
      if (q.type === "choice") return [path, q.choices[0].value];
      return [path, "x"];
    }),
  );

  it("le socle rempli suffit à rendre le dossier complet", () => {
    assert.deepEqual(computeCompleteness(tiered, complete), { ok: true, missing: [] });
  });

  it("une réponse facultative est acceptée (questionFor + validateAnswer) et ne change pas la complétude", () => {
    const q = questionFor(tiered, "vehicle.fiscalPower");
    assert.ok(q, "la question facultative fait partie du questionnaire du dossier");
    assert.equal(validateAnswer(q, 5), null);
    assert.match(validateAnswer(q, "cinq"), /nombre/);
    assert.deepEqual(computeCompleteness(tiered, { ...complete, "vehicle.fiscalPower": 5 }), { ok: true, missing: [] });
    assert.deepEqual(computeCompleteness(tiered, { ...complete, "vehicle.fiscalPower": null }), {
      ok: true,
      missing: [],
    });
  });

  it("les chemins facultatifs restent envoyés à l'extension (productPaths)", () => {
    // Même calcul que tarification-lancer : toutes les questions du questionnaire du dossier.
    const productPaths = [...new Set(paths(tiered))];
    assert.ok(productPaths.includes("vehicle.fiscalPower"));
    assert.ok(productPaths.includes("vehicle.registration"));
  });
});

describe("withLateDiscoveredQuestions avec une section facultative", () => {
  const late = {
    canonicalPath: "extra.nombre_enfants",
    label: "Nombre d'enfants",
    type: "number",
    required: true,
    discoveredOn: [{ insurerId: "allianz", origin: "https://x.fr", fieldKey: "k", required: true }],
  };
  const current = [...schema, { title: DISCOVERED_SECTION_TITLE, questions: [late], discovered: true }];

  it("ajoute la question découverte avant la section facultative, jamais dedans, et facultative", () => {
    const snapshot = schemaWithComplements(schema, [insurer("allianz")], "auto");
    const result = withLateDiscoveredQuestions(snapshot, current, ["allianz"]);
    assert.equal(result.at(-1).optional, true);
    assert.deepEqual(result.at(-1), snapshot.at(-1), "la section facultative est inchangée");
    const discovered = result.at(-2);
    assert.equal(discovered.discovered, true);
    assert.deepEqual(paths([discovered]), ["extra.nombre_enfants"]);
    assert.equal(discovered.questions[0].required, false);
  });

  it("un instantané ancien (sans section facultative) reçoit la section à la fin, comme avant", () => {
    const result = withLateDiscoveredQuestions(schema, current, ["allianz"]);
    assert.equal(result.length, schema.length + 1);
    assert.equal(result.at(-1).discovered, true);
  });
});
