import { escapeHtml } from "../core/html.utils";
import { PROPOSAL_REMINDER_DAYS, type OfferGuarantee } from "../shared/index.js";

/**
 * Logique pure de la proposition (Epic E14) : contenu des emails et choix des dossiers à relancer.
 * Sans accès à Firestore, pour être testée unitairement (test/propositions.test.mjs).
 */

export interface ProposalCabinet {
  name: string;
  orias: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface ProposalEmailInput {
  cabinet: ProposalCabinet;
  assureName: string;
  insurerName: string;
  reference: string | null;
  premiumAnnual: number | null;
  premiumMonthly: number | null;
  deductibles: Record<string, number>;
  guarantees: OfferGuarantee[];
  justification: string;
  message?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Montant en euros, au format français (« 1 234,50 € »). */
export function formatEuros(amount: number): string {
  const fixed = amount.toFixed(2).replace(/\.00$/, "");
  const [whole, decimals] = fixed.split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${grouped}${decimals ? `,${decimals}` : ""} €`;
}

/** Texte libre en HTML : échappé, retours à la ligne conservés. */
const paragraph = (text: string) => escapeHtml(text).replace(/\r?\n/g, "<br>");

/** Mentions légales du cabinet (intermédiaire en assurance immatriculé à l'ORIAS). */
export function cabinetLegalMentions(cabinet: ProposalCabinet): string {
  const parts = [
    `${escapeHtml(cabinet.name)}, intermédiaire en assurance immatriculé à l'ORIAS sous le n° ${escapeHtml(cabinet.orias ?? "—")} (www.orias.fr)`,
  ];
  if (cabinet.address) parts.push(escapeHtml(cabinet.address));
  return (
    `<p style="font-size:12px;color:#666">${parts.join(" — ")}.<br>` +
    "Activité soumise au contrôle de l'Autorité de contrôle prudentiel et de résolution (ACPR), " +
    "4 place de Budapest, CS 92459, 75436 Paris Cedex 09.<br>" +
    "Cette proposition est établie sur la base des informations que vous nous avez communiquées ; " +
    "elle ne vaut pas contrat. Les conditions définitives sont celles du contrat émis par l'assureur.</p>"
  );
}

/** Email de proposition envoyé à l'assuré : toutes les valeurs sont échappées. */
export function buildProposalEmail(input: ProposalEmailInput): { subject: string; html: string } {
  const { cabinet } = input;
  const premiums: string[] = [];
  if (input.premiumAnnual !== null) premiums.push(`<li>Prime annuelle : <strong>${formatEuros(input.premiumAnnual)}</strong></li>`);
  if (input.premiumMonthly !== null) premiums.push(`<li>Prime mensuelle : <strong>${formatEuros(input.premiumMonthly)}</strong></li>`);

  const deductibles = Object.entries(input.deductibles ?? {}).map(
    ([label, amount]) => `<li>${escapeHtml(label === "general" ? "Franchise générale" : label)} : ${formatEuros(amount)}</li>`,
  );
  const guarantees = input.guarantees
    .filter(g => g.included)
    .map(g => {
      const details: string[] = [];
      if (g.limit !== null) details.push(`plafond ${formatEuros(g.limit)}`);
      if (g.deductible !== null) details.push(`franchise ${formatEuros(g.deductible)}`);
      return `<li>${escapeHtml(g.label)}${details.length ? ` (${details.join(", ")})` : ""}</li>`;
    });

  const contact = [
    cabinet.address ? escapeHtml(cabinet.address) : null,
    cabinet.phone ? `Tél. ${escapeHtml(cabinet.phone)}` : null,
    cabinet.email ? escapeHtml(cabinet.email) : null,
  ].filter(Boolean);

  const html =
    `<p>Bonjour ${escapeHtml(input.assureName)},</p>` +
    (input.message?.trim() ? `<p>${paragraph(input.message.trim())}</p>` : "") +
    `<p>Suite à l'étude de votre besoin, ${escapeHtml(cabinet.name)} vous propose l'offre de ` +
    `<strong>${escapeHtml(input.insurerName)}</strong>` +
    (input.reference ? ` (dossier ${escapeHtml(input.reference)})` : "") +
    ".</p>" +
    (premiums.length ? `<h3>Tarif</h3><ul>${premiums.join("")}</ul>` : "") +
    (deductibles.length ? `<h3>Franchises</h3><ul>${deductibles.join("")}</ul>` : "") +
    (guarantees.length ? `<h3>Garanties incluses</h3><ul>${guarantees.join("")}</ul>` : "") +
    `<h3>Pourquoi cette offre</h3><p>${paragraph(input.justification)}</p>` +
    "<p>Pour donner suite ou pour toute question, répondez simplement à cet email ou contactez-nous.</p>" +
    `<p><strong>${escapeHtml(cabinet.name)}</strong>${contact.length ? `<br>${contact.join("<br>")}` : ""}</p>` +
    cabinetLegalMentions(cabinet);

  return { subject: `Votre proposition d'assurance — ${cabinet.name}`, html };
}

/** Email de relance envoyé au courtier en charge (pas à l'assuré). */
/** Lien vers la fiche d'un dossier dans l'app (`/espace/dossiers/:id`), ou null sans adresse de l'app configurée. */
export function dossierLink(appUrl: string, dossierId: string): string | null {
  const base = appUrl.trim().replace(/\/+$/, "");
  return base ? `${base}/espace/dossiers/${encodeURIComponent(dossierId)}` : null;
}

export function buildReminderEmail(input: {
  cabinetName: string;
  reference: string | null;
  assureName: string;
  sentTo: string;
  daysSinceSent: number;
  link: string | null;
}): { subject: string; html: string } {
  const reference = input.reference ?? "sans référence";
  return {
    subject: `Relance : proposition sans réponse (dossier ${reference})`,
    html:
      `<p>La proposition du dossier <strong>${escapeHtml(reference)}</strong> (${escapeHtml(input.assureName)}) ` +
      `a été envoyée à ${escapeHtml(input.sentTo)} il y a ${input.daysSinceSent} jours, sans réponse enregistrée.</p>` +
      "<p>Pensez à relancer l'assuré puis à enregistrer sa réponse (souscrit, refusé ou sans suite) dans l'onglet Proposition du dossier.</p>" +
      (input.link ? `<p><a href="${escapeHtml(input.link)}">Ouvrir le dossier</a></p>` : "") +
      `<p style="font-size:12px;color:#666">${escapeHtml(input.cabinetName)} — Courtier Intelligent</p>`,
  };
}

export interface ReminderCandidate {
  status: string;
  sentAtMs: number | null;
  lastReminderAtMs: number | null;
}

/**
 * Faut-il relancer le courtier ? Proposition envoyée depuis plus de `PROPOSAL_REMINDER_DAYS` jours,
 * et aucune relance depuis ce même délai.
 */
export function needsReminder(candidate: ReminderCandidate, nowMs: number, days = PROPOSAL_REMINDER_DAYS): boolean {
  if (candidate.status !== "proposition_envoyee" || candidate.sentAtMs === null) return false;
  const threshold = nowMs - days * DAY_MS;
  if (candidate.sentAtMs > threshold) return false;
  return candidate.lastReminderAtMs === null || candidate.lastReminderAtMs <= threshold;
}

/** Nom affiché d'un assuré (raison sociale pour un professionnel). */
export function assureDisplayName(assure: { firstName?: string; lastName?: string; companyName?: string | null } | undefined): string {
  if (!assure) return "Madame, Monsieur";
  if (assure.companyName) return assure.companyName;
  return [assure.firstName, assure.lastName].filter(Boolean).join(" ") || "Madame, Monsieur";
}
