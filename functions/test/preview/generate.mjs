// Génère des aperçus HTML des emails à partir des vrais builders compilés (lib/). Usage : npm run build && node test/preview/generate.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { buildProposalEmail, buildReminderEmail } = require("../../lib/propositions/proposition.utils.js");
const { buildInvitationEmail } = require("../../lib/equipe/invitation-email.js");
const { escapeHtml } = require("../../lib/core/html.utils.js");

const page = (title, html) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0">${html}</body></html>`;

const proposal = buildProposalEmail({
  cabinet: { name: "Cabinet Martin & Associés", orias: "12345678", address: "12 rue de la Paix, 75002 Paris", phone: "01 23 45 67 89", email: "contact@cabinet-martin.fr" },
  assureName: "Mme Claire Dubois",
  insurerName: "Assur'Plus",
  reference: "D-2026-0042",
  premiumAnnual: 642.5,
  premiumMonthly: 54.2,
  deductibles: { general: 300, "Bris de glace": 0 },
  guarantees: [
    { code: "RC", label: "Responsabilité civile", included: true, limit: null, deductible: null },
    { code: "BDG", label: "Bris de glace", included: true, limit: 1500, deductible: null },
    { code: "VOL", label: "Vol et incendie", included: true, limit: 20000, deductible: 300 },
    { code: "ASS", label: "Assistance 0 km", included: false, limit: null, deductible: null },
  ],
  justification: "Meilleur rapport garanties / prix parmi les 4 offres comparées.\nFranchise réduite et assistance incluse.",
  message: "Comme convenu lors de notre échange téléphonique, voici notre recommandation.",
});
writeFileSync(join(here, "proposal.html"), page(proposal.subject, proposal.html));

const reminder = buildReminderEmail({
  cabinetName: "Cabinet Martin & Associés",
  reference: "D-2026-0042",
  assureName: "Mme Claire Dubois",
  sentTo: "claire.dubois@exemple.fr",
  daysSinceSent: 8,
  link: "https://app.exemple.fr/espace/dossiers/d42",
});
writeFileSync(join(here, "reminder.html"), page(reminder.subject, reminder.html));

const invitation = buildInvitationEmail({
  cabinetName: escapeHtml("Cabinet Martin & Associés"),
  email: "nouveau.courtier@exemple.fr",
  link: "https://app.exemple.fr/invitation?cabinet=c1&invitation=i1",
  ttlDays: 7,
});
writeFileSync(join(here, "invitation.html"), page(invitation.subject, invitation.html));
console.log("Aperçus écrits dans", here);
