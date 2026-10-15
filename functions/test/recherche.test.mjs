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
  dossierTerms,
  DOSSIER_SEARCH_FIELDS,
  periodOf,
  sortOf,
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
      createdAt: null,
      deleted: true,
      deletedAt: 1000,
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
    assert.deepEqual(pageOf({ size: 50, from: 1_000_000 }), { size: 50, from: 9_950 });
  });
});

describe("Préfixe des index", () => {
  it("le projet Firebase, comme les autres apps du projet partagé", () => {
    const saved = { ...process.env };
    try {
      delete process.env.GCLOUD_PROJECT;
      delete process.env.GCP_PROJECT;
      assert.throws(() => indexPrefix(), /GCLOUD_PROJECT/);
      process.env.GCLOUD_PROJECT = "aibs-partenaire-testing";
      assert.equal(indexPrefix(), "aibs-partenaire-testing-");
    } finally {
      process.env = saved;
    }
  });
});

describe("Filtres, période et tri", () => {
  it("filtres des dossiers : valeurs connues seulement, en liste", () => {
    assert.deepEqual(dossierTerms({ status: ["brouillon", "inconnu"], productId: "auto", assignedTo: ["u 1", "u1"] }), {
      status: ["brouillon"], productId: ["auto"], assignedTo: ["u1"], assureId: [],
    });
  });

  it("période de suppression (ms ou ISO) et filtres dans la requête", () => {
    const period = periodOf("deletedAt", { from: "2026-01-01T00:00:00Z", to: 5 });
    assert.deepEqual(period, { field: "deletedAt", gte: Date.parse("2026-01-01T00:00:00Z"), lte: 5 });
    assert.equal(periodOf("deletedAt", {}), null);
    const query = buildSearchQuery("cab1", "", DOSSIER_SEARCH_FIELDS, { deleted: true, terms: { status: ["refuse"] }, period });
    assert.deepEqual(query.bool.filter.slice(2), [
      { terms: { "status.keyword": ["refuse"] } },
      { range: { deletedAt: { gte: period.gte, lte: 5 } } },
    ]);
  });

  it("sans texte : les plus récents d'abord ; avec texte : pertinence", () => {
    assert.deepEqual(sortOf("", "deletedAt"), [{ deletedAt: { order: "desc", missing: "_last", unmapped_type: "long" } }]);
    assert.deepEqual(sortOf("dupont", "deletedAt"), []);
  });
});
