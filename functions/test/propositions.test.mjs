// Proposition (Epic E14) : email de proposition (échappement), relances, validation de la souscription.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildProposalEmail, formatEuros } = require("../lib/propositions/proposition.utils.js");
const { validateContractNumber, validateEffectiveDate } = require("../lib/shared/index.js");

const NOW = Date.UTC(2026, 9, 9, 7);

const input = {
  cabinet: { name: "Cabinet <Dupont> & Fils", orias: "12345678", address: "1 rue \"A\"", phone: "01 02", email: "c@x.fr" },
  assureName: "<script>alert(1)</script>",
  insurerName: "Assur'Plus",
  reference: "2026-000001",
  premiumAnnual: 1234.5,
  premiumMonthly: 103,
  deductibles: { general: 300 },
  guarantees: [
    { code: "BDG", label: "Bris <de> glace", included: true, limit: 1500, deductible: null },
    { code: "VOL", label: "Vol absent", included: false, limit: null, deductible: null },
  ],
  justification: "Meilleur prix\n<b>et</b> garanties",
  message: "Bonjour & merci",
};

describe("buildProposalEmail", () => {
  const { html, subject } = buildProposalEmail(input);

  it("échappe toutes les valeurs saisies", () => {
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(html.includes("Cabinet &lt;Dupont&gt; &amp; Fils"));
    assert.ok(html.includes("Assur&#39;Plus"));
    assert.ok(html.includes("1 rue &quot;A&quot;"));
    assert.ok(html.includes("Bris &lt;de&gt; glace"));
    assert.ok(html.includes("&lt;b&gt;et&lt;/b&gt;"));
    assert.ok(html.includes("Bonjour &amp; merci"));
    assert.ok(subject.includes("Cabinet <Dupont>"), "le sujet est du texte brut");
  });

  it("contient tarif, franchises, garanties incluses, justification et mentions ORIAS", () => {
    assert.ok(html.includes(formatEuros(1234.5)));
    assert.ok(html.includes("Franchise générale"));
    assert.ok(!html.includes("Vol absent"), "garantie non incluse absente");
    assert.ok(html.includes("Meilleur prix<br>"));
    assert.ok(html.includes("ORIAS sous le n° 12345678"));
  });

  it("formate les montants en euros", () => {
    assert.equal(formatEuros(1234.5), "1 234,50 €");
    assert.equal(formatEuros(300), "300 €");
  });

});

describe("validation de la souscription", () => {
  const today = new Date(NOW);
  it("numéro de contrat obligatoire", () => {
    assert.ok(validateContractNumber("  "));
    assert.equal(validateContractNumber("C-123"), null);
    assert.ok(validateContractNumber("x".repeat(51)));
  });
  it("date d'effet", () => {
    assert.equal(validateEffectiveDate("2026-11-01", today), null);
    assert.ok(validateEffectiveDate("2026-02-30", today));
    assert.ok(validateEffectiveDate("01/11/2026", today));
    assert.ok(validateEffectiveDate("2030-01-01", today));
    assert.ok(validateEffectiveDate("2024-01-01", today));
  });
});
