// Recherche Elasticsearch : documents indexés et requêtes (fonctions pures, sans cluster).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ASSURE_SEARCH_FIELDS,
  assureDisplayName,
  buildSearchQuery,
  cleanSearchInput,
  pageOf,
  toAssureSearchDoc,
  toDossierSearchDoc,
} = require("../lib/elastic/search.documents.js");
const { indexPrefix } = require("../lib/elastic/elastic.util.js");

describe("Documents indexés", () => {
  it("un client porte son cabinet, ses champs cherchés et l'état corbeille", () => {
    const doc = toAssureSearchDoc("cab1", "a1", {
      type: "particulier",
      firstName: " Corinne ",
      lastName: "Berthier",
      email: "c@b.fr",
      address: { city: "Lyon", postalCode: "69001" },
      deletedAt: { seconds: 1 },
      createdBy: "u1",
    });
    assert.deepEqual(doc, {
      id: "a1",
      cabinetId: "cab1",
      type: "particulier",
      lastName: "Berthier",
      firstName: "Corinne",
      companyName: null,
      email: "c@b.fr",
      phone: null,
      siret: null,
      city: "Lyon",
      postalCode: "69001",
      deleted: true,
    });
  });

  it("un dossier porte le nom de son client", () => {
    const doc = toDossierSearchDoc("cab1", "d1", { assureId: "a1", reference: "2026-000001", status: "brouillon" }, "Corinne Berthier");
    assert.equal(doc.assureName, "Corinne Berthier");
    assert.equal(doc.cabinetId, "cab1");
    assert.equal(doc.deleted, false);
  });

  it("nom affiché : raison sociale, sinon prénom et nom", () => {
    assert.equal(assureDisplayName({ companyName: "ACME", firstName: "A", lastName: "B" }), "ACME");
    assert.equal(assureDisplayName({ firstName: "Corinne", lastName: "Berthier" }), "Corinne Berthier");
    assert.equal(assureDisplayName(undefined), null);
  });
});

describe("Requête de recherche", () => {
  it("filtre toujours sur le cabinet et la corbeille", () => {
    const query = buildSearchQuery("cab1", "berthier", ASSURE_SEARCH_FIELDS, { deleted: false });
    assert.deepEqual(query.bool.filter, [{ term: { "cabinetId.keyword": "cab1" } }, { term: { deleted: false } }]);
    assert.equal(query.bool.minimum_should_match, 1);
    assert.equal(query.bool.should.length, 3);
  });

  it("sans texte : tout le cabinet, sans clause de correspondance", () => {
    const query = buildSearchQuery("cab1", "", ASSURE_SEARCH_FIELDS, { deleted: true });
    assert.deepEqual(query, { bool: { filter: [{ term: { "cabinetId.keyword": "cab1" } }, { term: { deleted: true } }] } });
  });

  it("neutralise les caractères spéciaux de la syntaxe de recherche", () => {
    const query = buildSearchQuery("cab1", 'ber*th"ier OR (x)', ASSURE_SEARCH_FIELDS, { deleted: false });
    const wildcard = query.bool.should[2].query_string.query;
    assert.equal(wildcard, "*ber* AND *th* AND *ier* AND *or* AND *x*");
    assert.deepEqual(query.bool.should[2].query_string.fields, ASSURE_SEARCH_FIELDS.map(f => f.split("^")[0]));
  });

  it("borne la saisie et la pagination", () => {
    assert.equal(cleanSearchInput("  a   b  "), "a b");
    assert.equal(cleanSearchInput(42), "");
    assert.equal(cleanSearchInput("x".repeat(500)).length, 100);
    assert.deepEqual(pageOf({}), { size: 50, from: 0 });
    assert.deepEqual(pageOf({ size: 1000, from: -5 }), { size: 200, from: 0 });
  });
});

describe("Préfixe des index", () => {
  it("obligatoire, et jamais celui de test en production", () => {
    const saved = { ...process.env };
    try {
      delete process.env.ELASTIC_INDEX_PREFIX;
      assert.throws(() => indexPrefix(), /ELASTIC_INDEX_PREFIX/);
      process.env.ELASTIC_INDEX_PREFIX = "aibs-partenaire-testing-ci-";
      process.env.GCLOUD_PROJECT = "aibs-part";
      assert.throws(() => indexPrefix(), /production/);
      process.env.GCLOUD_PROJECT = "aibs-partenaire-testing";
      assert.equal(indexPrefix(), "aibs-partenaire-testing-ci-");
    } finally {
      process.env = saved;
    }
  });
});
