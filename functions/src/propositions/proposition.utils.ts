import { escapeHtml } from "../core/html.utils";
import { EMAIL_COLORS, emailButton, emailLayout, emailParagraph, sectionTitle } from "../core/email-layout";
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
    `<p style="margin:12px 0 0;font-size:11px;line-height:16px;color:#8a94a8">${parts.join(" — ")}.<br>` +
    "Activité soumise au contrôle de l'Autorité de contrôle prudentiel et de résolution (ACPR), " +
    "4 place de Budapest, CS 92459, 75436 Paris Cedex 09.<br>" +
    "Cette proposition est établie sur la base des informations que vous nous avez communiquées ; " +
    "elle ne vaut pas contrat. Les conditions définitives sont celles du contrat émis par l'assureur.</p>"
  );
}

/** Email de proposition envoyé à l'assuré : toutes les valeurs sont échappées. */
export function buildProposalEmail(input: ProposalEmailInput): { subject: string; html: string } {
  const { cabinet } = input;
  const c = EMAIL_COLORS;

  // Carte de l'offre retenue : assureur, prime annuelle en grand, prime mensuelle en dessous.
  const premiumRows: string[] = [];
  if (input.premiumAnnual !== null) {
    premiumRows.push(
      `<p style="margin:12px 0 0;font-size:12px;line-height:16px;color:${c.muted};text-transform:uppercase;letter-spacing:1px">Prime annuelle :</p>` +
        `<p style="margin:2px 0 0;font-size:32px;line-height:38px;font-weight:bold;color:${c.green}"><strong>${formatEuros(input.premiumAnnual)}</strong></p>`,
    );
  }
  if (input.premiumMonthly !== null) {
    premiumRows.push(
      `<p style="margin:6px 0 0;font-size:14px;line-height:20px;color:${c.text}">Prime mensuelle : <strong>${formatEuros(input.premiumMonthly)}</strong></p>`,
    );
  }
  const offerCard =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 6px;border-collapse:separate">` +
    `<tr><td bgcolor="${c.greenBg}" style="padding:18px 20px;background:${c.greenBg};border:1px solid #bfe5cf;border-left:5px solid ${c.green};border-radius:10px">` +
    `<p style="margin:0;font-size:12px;line-height:16px;color:${c.green};font-weight:bold;text-transform:uppercase;letter-spacing:1px">Offre retenue${premiumRows.length ? " — Tarif" : ""}</p>` +
    `<p style="margin:4px 0 0;font-size:20px;line-height:26px;font-weight:bold;color:${c.navy}">${escapeHtml(input.insurerName)}</p>` +
    (input.reference
      ? `<p style="margin:2px 0 0;font-size:13px;line-height:18px;color:${c.muted}">Dossier ${escapeHtml(input.reference)}</p>`
      : "") +
    premiumRows.join("") +
    `</td></tr></table>`;

  const cell = (html: string, extra = "") =>
    `<td style="padding:9px 12px;border-bottom:1px solid ${c.line};font-size:14px;line-height:20px;color:${c.text};${extra}">${html}</td>`;
  const table = (head: [string, string], rows: string[]) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${c.line};border-radius:8px;border-collapse:separate">` +
    `<tr><td style="padding:8px 12px;background:#f6f8fc;font-size:12px;font-weight:bold;color:${c.muted};border-bottom:1px solid ${c.line}">${head[0]}</td>` +
    `<td style="padding:8px 12px;background:#f6f8fc;font-size:12px;font-weight:bold;color:${c.muted};border-bottom:1px solid ${c.line}">${head[1]}</td></tr>` +
    rows.join("") +
    `</table>`;

  const deductibles = Object.entries(input.deductibles ?? {}).map(
    ([label, amount]) =>
      `<tr>${cell(escapeHtml(label === "general" ? "Franchise générale" : label))}${cell(formatEuros(amount), "white-space:nowrap;font-weight:bold")}</tr>`,
  );
  const guarantees = input.guarantees
    .filter(g => g.included)
    .map(g => {
      const details: string[] = [];
      if (g.limit !== null) details.push(`plafond ${formatEuros(g.limit)}`);
      if (g.deductible !== null) details.push(`franchise ${formatEuros(g.deductible)}`);
      return (
        `<tr>${cell(`<span style="color:${c.green};font-weight:bold">&#10003;</span>&nbsp; ${escapeHtml(g.label)}`)}` +
        `${cell(details.length ? details.join(", ") : "Incluse", `color:${c.muted}`)}</tr>`
      );
    });

  const contact = [
    cabinet.address ? escapeHtml(cabinet.address) : null,
    cabinet.phone ? `Tél. ${escapeHtml(cabinet.phone)}` : null,
    cabinet.email ? escapeHtml(cabinet.email) : null,
  ].filter(Boolean);

  const body =
    emailParagraph(`Bonjour ${escapeHtml(input.assureName)},`) +
    (input.message?.trim() ? emailParagraph(paragraph(input.message.trim())) : "") +
    emailParagraph(
      `Suite à l'étude de votre besoin, ${escapeHtml(cabinet.name)} vous propose l'offre de ` +
        `<strong>${escapeHtml(input.insurerName)}</strong>` +
        (input.reference ? ` (dossier ${escapeHtml(input.reference)})` : "") +
        ".",
    ) +
    offerCard +
    (deductibles.length ? sectionTitle("Franchises") + table(["Franchise", "Montant"], deductibles) : "") +
    (guarantees.length ? sectionTitle("Garanties incluses") + table(["Garantie", "Plafond / franchise"], guarantees) : "") +
    sectionTitle("Pourquoi cette offre") +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="padding:12px 16px;background:#f6f8fc;border-left:4px solid ${c.blue};border-radius:0 8px 8px 0;font-size:14px;line-height:22px;color:${c.text}">` +
    `<p style="margin:0">${paragraph(input.justification)}</p></td></tr></table>` +
    `<p style="margin:22px 0 14px;font-size:15px;line-height:23px;color:${c.text}">Pour donner suite ou pour toute question, répondez simplement à cet email ou contactez-nous.</p>`;

  const footer =
    `<p style="margin:0;font-size:13px;line-height:19px;color:${c.text}"><strong>${escapeHtml(cabinet.name)}</strong>${contact.length ? `<br>${contact.join("<br>")}` : ""}</p>` +
    cabinetLegalMentions(cabinet);

  const html = emailLayout({
    headerTitle: escapeHtml(cabinet.name),
    headerSubtitle: "Votre proposition d'assurance",
    body,
    footer,
  });

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
    html: emailLayout({
      headerTitle: "Relance : proposition sans réponse",
      headerSubtitle: `${escapeHtml(input.cabinetName)} — Courtier Intelligent`,
      body:
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr>` +
        `<td style="padding:12px 16px;background:#fff6e0;border-left:4px solid ${EMAIL_COLORS.amber};border-radius:0 8px 8px 0;font-size:15px;line-height:23px;color:${EMAIL_COLORS.text}">` +
        `<p style="margin:0">La proposition du dossier <strong>${escapeHtml(reference)}</strong> (${escapeHtml(input.assureName)}) ` +
        `a été envoyée à ${escapeHtml(input.sentTo)} il y a ${input.daysSinceSent} jours, sans réponse enregistrée.</p></td></tr></table>` +
        emailParagraph(
          "Pensez à relancer l'assuré puis à enregistrer sa réponse (souscrit, refusé ou sans suite) dans l'onglet Proposition du dossier.",
        ) +
        (input.link ? emailButton(escapeHtml(input.link), "Ouvrir le dossier") : ""),
      footer: `${escapeHtml(input.cabinetName)} — Courtier Intelligent`,
    }),
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
