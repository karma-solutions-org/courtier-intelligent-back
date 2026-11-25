// Fiabilité des extranets : calcul du bilan par assureur (tarifications du cabinet, incidents de l'extension).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { computeInsurerReliability, requireReliabilityPeriod } = require("../lib/core/reliability.utils.js");

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const SINCE = NOW - 7 * 24 * 60 * MINUTE;
const AT = NOW - 60 * MINUTE; // lancé il y a une heure

let seq = 0;
const job = (insurerId, status, extra = {}) => ({
  dossierId: `d${++seq}`,
  insurerId,
  status,
  attempts: 1,
  requestedAtMs: AT,
  missingFieldLabels: [],
  ...extra,
});
const offerFor = (j, source, capturedAtMs = AT + 10 * MINUTE) => ({
  dossierId: j.dossierId,
  insurerId: j.insurerId,
  source,
  capturedAtMs,
});
const report = (insurerId, step, issue, atMs = AT) => ({ insurerId, step, issue, atMs });
const compute = ({ jobs = [], offers = [], reports = [] }) =>
  computeInsurerReliability({ jobs, offers, reports, sinceMs: SINCE, nowMs: NOW });
const one = input => {
  const result = compute(input);
  assert.equal(result.length, 1);
  return result[0];
};

describe("Fiabilité : période demandée", () => {
  it("accepte 7, 30 ou 90 jours, refuse le reste", () => {
    for (const days of [7, 30, 90]) assert.equal(requireReliabilityPeriod(days), days);
    for (const value of [undefined, null, 0, 14, "30", 30.5]) {
      assert.throws(() => requireReliabilityPeriod(value), { code: "invalid-argument" }, String(value));
    }
  });
});

describe("Fiabilité : compteurs par assureur", () => {
  it("compte chaque statut, et le taux de réussite sur les tarifications terminées", () => {
    const jobs = [
      job("allianz", "captured"),
      job("allianz", "captured"),
      job("allianz", "captured"),
      job("allianz", "failed"),
      job("allianz", "needs_info"),
      job("allianz", "requested"),
      job("allianz", "analyzing"),
      job("allianz", "filling"),
      job("allianz", "awaiting_submit"),
      job("allianz", "cancelled"),
    ];
    const stats = one({ jobs });
    assert.equal(stats.launched, 10);
    assert.equal(stats.captured, 3);
    assert.equal(stats.failed, 1);
    assert.equal(stats.needsInfo, 1);
    assert.equal(stats.inProgress, 4);
    assert.equal(stats.cancelled, 1);
    assert.equal(stats.successRate, 0.75);
  });

  it("taux de réussite null sans tarification terminée, 0 quand tout a échoué", () => {
    assert.equal(one({ jobs: [job("a", "requested"), job("a", "needs_info")] }).successRate, null);
    assert.equal(one({ jobs: [job("a", "failed")] }).successRate, 0);
  });

  it("moyenne des lancements par dossier, null sans tentative connue", () => {
    const stats = one({ jobs: [job("a", "failed", { attempts: 1 }), job("a", "captured", { attempts: 4 })] });
    assert.equal(stats.averageAttempts, 2.5);
    assert.equal(one({ jobs: [job("a", "failed", { attempts: null })] }).averageAttempts, null);
  });
});

describe("Fiabilité : tarif lu par l'extension ou saisi à la main", () => {
  it("répartit les tarifs obtenus selon la source de l'offre", () => {
    const auto1 = job("a", "captured");
    const auto2 = job("a", "captured");
    const manual = job("a", "captured");
    const withoutOffer = job("a", "captured");
    // Offre d'un job encore en cours (relance après une capture) : pas comptée comme tarif obtenu.
    const relaunched = job("a", "requested");
    const stats = one({
      jobs: [auto1, auto2, manual, withoutOffer, relaunched],
      offers: [
        offerFor(auto1, "auto"),
        offerFor(auto2, "auto"),
        offerFor(manual, "manual"),
        offerFor(relaunched, "auto"),
      ],
    });
    assert.equal(stats.captured, 4);
    assert.equal(stats.capturedAuto, 2);
    assert.equal(stats.capturedManual, 1);
  });

  it("n'associe pas l'offre d'un autre dossier ou d'un autre assureur", () => {
    const j = job("a", "captured");
    const stats = one({
      jobs: [j],
      offers: [
        { ...offerFor(j, "auto"), dossierId: "autre" },
        { ...offerFor(j, "auto"), insurerId: "b" },
      ],
    });
    assert.equal(stats.capturedAuto, 0);
  });
});

describe("Fiabilité : délai médian jusqu'au tarif", () => {
  it("médiane des tarifs lus automatiquement, arrondie au dixième de minute", () => {
    const jobs = [job("a", "captured"), job("a", "captured"), job("a", "captured"), job("a", "captured")];
    const offers = [
      offerFor(jobs[0], "auto", AT + 2 * MINUTE),
      offerFor(jobs[1], "auto", AT + 5 * MINUTE + 20_000),
      offerFor(jobs[2], "auto", AT + 30 * MINUTE),
      // Saisie à la main : pas dans le délai de l'extension.
      offerFor(jobs[3], "manual", AT + 1000 * MINUTE),
    ];
    assert.equal(one({ jobs, offers }).medianMinutesToPrice, 5.3);
  });

  it("ignore une offre antérieure au lancement ; null sans tarif automatique", () => {
    const early = job("a", "captured");
    const ok = job("a", "captured");
    const stats = one({
      jobs: [early, ok],
      offers: [offerFor(early, "auto", AT - 5 * MINUTE), offerFor(ok, "auto", AT + 3 * MINUTE)],
    });
    assert.equal(stats.medianMinutesToPrice, 3);
    assert.equal(stats.capturedAuto, 2);

    const manual = job("a", "captured");
    assert.equal(one({ jobs: [manual], offers: [offerFor(manual, "manual")] }).medianMinutesToPrice, null);
    const noDate = job("a", "captured");
    assert.equal(one({ jobs: [noDate], offers: [offerFor(noDate, "auto", null)] }).medianMinutesToPrice, null);
  });
});

describe("Fiabilité : questions manquantes", () => {
  it("les 5 libellés les plus fréquents, à égalité par ordre alphabétique", () => {
    const jobs = [
      job("a", "needs_info", { missingFieldLabels: ["Profession", "Date d'achat", "Kilométrage"] }),
      job("a", "needs_info", { missingFieldLabels: ["Profession", "Date d'achat"] }),
      job("a", "failed", { missingFieldLabels: ["Profession", "Usage", "Garage", "Bonus"] }),
    ];
    assert.deepEqual(one({ jobs }).topMissingFields, [
      { key: "Profession", count: 3 },
      { key: "Date d'achat", count: 2 },
      { key: "Bonus", count: 1 },
      { key: "Garage", count: 1 },
      { key: "Kilométrage", count: 1 },
    ]);
    assert.deepEqual(one({ jobs: [job("a", "captured")] }).topMissingFields, []);
  });
});

describe("Fiabilité : incidents de la plateforme", () => {
  it("regroupe par étape et code, garde les 5 plus fréquents, et compte le total", () => {
    const reports = [
      ...Array.from({ length: 4 }, () => report("a", "extract", "premium_not_found")),
      ...Array.from({ length: 3 }, () => report("a", "fill", "fill_failed")),
      report("a", "detect", "premium_not_found"),
      report("a", "analyze", "no_fields"),
      report("a", "mapping", "no_field_mapped"),
      report("a", "write", "offer_write_failed"),
      report("a", "confirm", "capture_rejected"),
      report("b", "fill", "step_blocked"),
    ];
    const [a, b] = compute({ reports });
    assert.equal(a.insurerId, "a");
    assert.equal(a.platformIssuesTotal, 12);
    assert.deepEqual(a.platformIssues, [
      { step: "extract", issue: "premium_not_found", count: 4 },
      { step: "fill", issue: "fill_failed", count: 3 },
      { step: "analyze", issue: "no_fields", count: 1 },
      { step: "confirm", issue: "capture_rejected", count: 1 },
      { step: "detect", issue: "premium_not_found", count: 1 },
    ]);
    // Extranet non utilisé par le cabinet : présent quand même, sans tarification.
    assert.equal(b.launched, 0);
    assert.equal(b.successRate, null);
    assert.equal(b.platformIssuesTotal, 1);
  });
});

describe("Fiabilité : période et tri", () => {
  it("ne garde que les tarifications et incidents de la période", () => {
    const jobs = [
      job("a", "captured"),
      job("a", "failed", { requestedAtMs: SINCE - 1 }),
      job("a", "failed", { requestedAtMs: null }),
      job("a", "failed", { requestedAtMs: SINCE }),
      job("old", "captured", { requestedAtMs: SINCE - MINUTE }),
    ];
    const reports = [report("a", "fill", "fill_failed", SINCE - 1), report("gone", "fill", "fill_failed", null)];
    const result = compute({ jobs, reports });
    assert.deepEqual(
      result.map(r => r.insurerId),
      ["a"],
    );
    assert.equal(result[0].launched, 2);
    assert.equal(result[0].platformIssuesTotal, 0);
  });

  it("trie par tarifications lancées, puis par incidents, puis par identifiant", () => {
    const result = compute({
      jobs: [job("peu", "captured"), job("beaucoup", "captured"), job("beaucoup", "failed")],
      reports: [
        report("z-incidents", "fill", "fill_failed"),
        report("z-incidents", "fill", "fill_failed"),
        report("b-incident", "fill", "fill_failed"),
        report("a-incident", "fill", "fill_failed"),
      ],
    });
    assert.deepEqual(
      result.map(r => r.insurerId),
      ["beaucoup", "peu", "z-incidents", "a-incident", "b-incident"],
    );
    assert.equal(compute({}).length, 0);
  });
});
