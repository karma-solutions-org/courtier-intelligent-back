// Proposition (Epic E14) : email de proposition (échappement), relances, validation de la souscription.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildProposalEmail, buildReminderEmail, dossierLink, needsReminder, formatEuros } = require("../lib/propositions/proposition.utils.js");
const { validateContractNumber, validateEffectiveDate } = require("../lib/shared/index.js");

const DAY = 24 * 60 * 60 * 1000;
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

  it("relance : valeurs échappées", () => {
    const { html } = buildReminderEmail({ cabinetName: "<C>", reference: null, assureName: "<A>", sentTo: "a@b.fr", daysSinceSent: 8, link: null });
    assert.ok(!html.includes("<A>") && !html.includes("<C>"));
    assert.ok(!html.includes("<a href"));
  });

  it("relance : lien vers le dossier quand l'adresse de l'app est configurée", () => {
    const link = dossierLink("https://app.exemple.fr/", "d1");
    assert.equal(link, "https://app.exemple.fr/espace/dossiers/d1");
    const { html } = buildReminderEmail({ cabinetName: "C", reference: "D-1", assureName: "A", sentTo: "a@b.fr", daysSinceSent: 8, link });
    assert.ok(html.includes('<a href="https://app.exemple.fr/espace/dossiers/d1">Ouvrir le dossier</a>'));
  });

  it("relance : pas de lien sans adresse de l'app", () => {
    assert.equal(dossierLink("", "d1"), null);
    assert.equal(dossierLink("  ", "d1"), null);
  });
});

describe("needsReminder", () => {
  const base = { status: "proposition_envoyee", sentAtMs: NOW - 8 * DAY, lastReminderAtMs: null };
  it("relance après 7 jours sans relance", () => assert.equal(needsReminder(base, NOW), true));
  it("pas avant 7 jours", () => assert.equal(needsReminder({ ...base, sentAtMs: NOW - 6 * DAY }, NOW), false));
  it("pas si relancé il y a moins de 7 jours", () => assert.equal(needsReminder({ ...base, lastReminderAtMs: NOW - 3 * DAY }, NOW), false));
  it("de nouveau 7 jours après la dernière relance", () => assert.equal(needsReminder({ ...base, sentAtMs: NOW - 20 * DAY, lastReminderAtMs: NOW - 7 * DAY }, NOW), true));
  it("seulement en « proposition envoyée »", () => assert.equal(needsReminder({ ...base, status: "souscrit" }, NOW), false));
  it("pas sans date d'envoi", () => assert.equal(needsReminder({ ...base, sentAtMs: null }, NOW), false));
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
