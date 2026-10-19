// Comparaison des offres : normalisation des garanties, écarts avec le besoin et score (sur le référentiel Auto du catalogue).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  analyzeOffer,
  computeOfferGaps,
  computeOfferScore,
  EMPTY_NEED,
  guaranteeCoverage,
  matchGuaranteeCode,
  normalizeOfferGuarantees,
  validateDecisionJustification,
} = require("../lib/shared/index.js");
const { loadCatalog } = require("../lib/ops/catalog.js");

const auto = loadCatalog().catalog.products.find(p => p.id === "auto");
const catalog = auto.guaranteeCatalog;
const synonyms = auto.synonyms;

const g = (code, extra = {}) => ({ code, label: code ?? "", included: true, limit: null, deductible: null, ...extra });
const offer = overrides => ({
  premiumAnnual: 500,
  premiumMonthly: null,
  deductibles: {},
  guarantees: [],
  exclusions: [],
  ...overrides,
});
const need = overrides => ({ ...EMPTY_NEED, ...overrides });

describe("matchGuaranteeCode", () => {
  it("reconnaît un code, un libellé ou un synonyme, sans tenir compte des accents ni de la casse", () => {
    assert.equal(matchGuaranteeCode("BDG", catalog, synonyms), "BDG");
    assert.equal(matchGuaranteeCode("Bris de glace", catalog, synonyms), "BDG");
    assert.equal(matchGuaranteeCode("PARE-BRISE", catalog, synonyms), "BDG");
    assert.equal(matchGuaranteeCode("Vehicule de pret", catalog, synonyms), "VRP");
    assert.equal(matchGuaranteeCode("Garantie vitrage 100 %", catalog, synonyms), "BDG");
  });

  it("renvoie null pour une formulation inconnue", () => {
    assert.equal(matchGuaranteeCode("Option jantes alu", catalog, synonyms), null);
    assert.equal(matchGuaranteeCode("", catalog, synonyms), null);
  });
});

describe("normalizeOfferGuarantees", () => {
  it("rattache les garanties au référentiel et reprend son libellé, sans doublon", () => {
    const result = normalizeOfferGuarantees(
      [g(null, { label: "Vitrage" }), g(null, { label: "Pare-brise" }), g(null, { label: "Jantes" }), g("VOL")],
      catalog,
      synonyms,
    );
    assert.deepEqual(
      result.map(x => [x.code, x.label]),
      [
        ["BDG", "Bris de glace"],
        [null, "Pare-brise"],
        [null, "Jantes"],
        ["VOL", "Vol"],
      ],
    );
  });
});

describe("computeOfferGaps", () => {
  it("signale le dépassement de budget (bloquant au-delà de 10 %)", () => {
    assert.equal(
      computeOfferGaps(offer({ premiumAnnual: 520 }), need({ budgetMax: 500 }), catalog)[0].severity,
      "warn",
    );
    assert.equal(computeOfferGaps(offer({ premiumAnnual: 600 }), need({ budgetMax: 500 }), catalog)[0].severity, "ko");
    assert.equal(
      computeOfferGaps(offer({ premiumAnnual: null, premiumMonthly: 50 }), need({ budgetMax: 500 }), catalog)[0]
        .criterion,
      "budget",
    );
    assert.deepEqual(computeOfferGaps(offer({ premiumAnnual: 400 }), need({ budgetMax: 500 }), catalog), []);
  });

  it("signale une franchise trop élevée", () => {
    const gaps = computeOfferGaps(
      offer({ deductibles: { general: 800, VOL: 600 }, guarantees: [g("VOL")] }),
      need({ maxDeductible: 500, mandatoryGuarantees: ["VOL"] }),
      catalog,
    );
    assert.deepEqual(
      gaps.map(x => [x.criterion, x.severity]),
      [
        ["deductible", "ko"],
        ["deductible", "warn"],
      ],
    );
  });

  it("signale les garanties indispensables absentes, les plafonds et les garanties souhaitées manquantes", () => {
    const gaps = computeOfferGaps(
      offer({ guarantees: [g("RC"), g("BDG", { included: false }), g("GDC"), g("EQP", { limit: 0 })] }),
      need({ mandatoryGuarantees: ["RC", "BDG", "GDC", "EQP"], niceToHave: ["ASS"] }),
      catalog,
    );
    assert.deepEqual(
      gaps.map(x => [x.criterion, x.severity]),
      [
        ["mandatory_guarantee", "ko"],
        ["limit", "warn"],
        ["limit", "ko"],
        ["nice_to_have", "warn"],
      ],
    );
  });

  it("signale une exclusion touchant une garantie indispensable", () => {
    const gaps = computeOfferGaps(
      offer({ guarantees: [g("VOL")], exclusions: ["Vol sans effraction", "Courses automobiles"] }),
      need({ mandatoryGuarantees: ["VOL"] }),
      catalog,
      synonyms,
    );
    assert.deepEqual(
      gaps.map(x => x.criterion),
      ["exclusion"],
    );
  });
});

describe("score et analyse", () => {
  it("retire des points par écart, borné entre 0 et 100", () => {
    assert.equal(computeOfferScore([]), 100);
    assert.equal(computeOfferScore([{ severity: "ko" }, { severity: "warn" }]), 67);
    assert.equal(computeOfferScore(Array(10).fill({ severity: "ko" })), 0);
  });

  it("sans besoin : garanties normalisées, ni écart ni score", () => {
    const result = analyzeOffer(offer({ guarantees: [g(null, { label: "vitrage" })] }), null, catalog, synonyms);
    assert.deepEqual(result.gaps, []);
    assert.equal(result.score, null);
    assert.equal(result.guarantees[0].code, "BDG");
  });

  it("analyse une offre et donne un résultat stable (pas de boucle dans le trigger)", () => {
    const n = need({ budgetMax: 480, mandatoryGuarantees: ["BDG"] });
    const first = analyzeOffer(offer({ guarantees: [g(null, { label: "glaces" })] }), n, catalog, synonyms);
    assert.equal(first.score, 92);
    const second = analyzeOffer(offer({ guarantees: first.guarantees }), n, catalog, synonyms);
    assert.deepEqual(second, first);
  });

  it("état d’une garantie pour le tableau comparatif", () => {
    const o = offer({ guarantees: [g("RC"), g("GDC", { limit: 300000 }), g("VOL", { included: false })] });
    assert.equal(guaranteeCoverage(o, "RC"), "included");
    assert.equal(guaranteeCoverage(o, "GDC"), "limited");
    assert.equal(guaranteeCoverage(o, "VOL"), "absent");
    assert.equal(guaranteeCoverage(o, "ASS"), "absent");
  });
});

describe("validateDecisionJustification", () => {
  it("exige une justification de 10 à 2000 caractères", () => {
    assert.equal(validateDecisionJustification("Meilleur rapport garanties / prix."), null);
    assert.match(validateDecisionJustification("  ok  "), /minimum/);
    assert.match(validateDecisionJustification(null), /attendue/);
    assert.match(validateDecisionJustification("x".repeat(2001)), /maximum/);
  });
});
