import { escapeHtml } from "../core/html.utils";
import { EMAIL_COLORS, emailLayout, emailParagraph, sectionTitle } from "../core/email-layout";
import type { OfferGuarantee } from "../shared/index.js";

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


/** Montant en euros, au format français (« 1 234,50 € »). */
export function formatEuros(amount: number): string {
  const fixed = amount.toFixed(2).replace(/\.00$/, "");
  const [whole, decimals] = fixed.split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  // Espace insécable avant « € », écrite en échappement : un caractère invisible ne passe pas le lint.
  return `${grouped}${decimals ? `,${decimals}` : ""}\u00a0€`;
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
    `<p style="margin:10px 0 0;font-size:11px;line-height:16px;color:#8a94a8">${parts.join(" — ")}.<br>` +
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

  // Récapitulatif de l'offre : assureur à gauche, prime à droite, sur fond neutre.
  const premium =
    input.premiumAnnual !== null
      ? `<p style="margin:0;font-size:26px;line-height:32px;font-weight:bold;color:${c.navy}">${formatEuros(input.premiumAnnual)}</p>` +
        `<p style="margin:2px 0 0;font-size:13px;line-height:18px;color:${c.muted}">par an${
          input.premiumMonthly !== null ? `, soit ${formatEuros(input.premiumMonthly)} par mois` : ""
        }</p>`
      : input.premiumMonthly !== null
        ? `<p style="margin:0;font-size:26px;line-height:32px;font-weight:bold;color:${c.navy}">${formatEuros(input.premiumMonthly)}</p>` +
          `<p style="margin:2px 0 0;font-size:13px;line-height:18px;color:${c.muted}">par mois</p>`
        : "";
  const offerCard =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px;border:1px solid ${c.line};border-radius:6px;border-collapse:separate;background:#fafbfd">` +
    `<tr><td valign="top" style="padding:18px 20px">` +
    `<p style="margin:0;font-size:13px;line-height:18px;color:${c.muted}">Offre recommandée</p>` +
    `<p style="margin:2px 0 0;font-size:18px;line-height:24px;font-weight:bold;color:${c.navy}">${escapeHtml(input.insurerName)}</p>` +
    (input.reference
      ? `<p style="margin:2px 0 0;font-size:13px;line-height:18px;color:${c.muted}">Dossier n° ${escapeHtml(input.reference)}</p>`
      : "") +
    `</td>` +
    (premium ? `<td valign="top" align="right" style="padding:18px 20px;white-space:nowrap">${premium}</td>` : "") +
    `</tr></table>`;

  const cell = (html: string, extra = "") =>
    `<td style="padding:10px 0;border-bottom:1px solid ${c.line};font-size:14px;line-height:20px;color:${c.text};${extra}">${html}</td>`;
  const table = (head: [string, string], rows: string[]) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">` +
    `<tr><td style="padding:0 0 6px;font-size:12px;color:${c.muted};border-bottom:1px solid ${c.navy}">${head[0]}</td>` +
    `<td align="right" style="padding:0 0 6px;font-size:12px;color:${c.muted};border-bottom:1px solid ${c.navy}">${head[1]}</td></tr>` +
    rows.join("") +
    `</table>`;

  const deductibles = Object.entries(input.deductibles ?? {}).map(
    ([label, amount]) =>
      `<tr>${cell(escapeHtml(label === "general" ? "Franchise générale" : label))}${cell(formatEuros(amount), "text-align:right;white-space:nowrap")}</tr>`,
  );
  const guarantees = input.guarantees
    .filter(g => g.included)
    .map(g => {
      const details: string[] = [];
      if (g.limit !== null) details.push(`plafond ${formatEuros(g.limit)}`);
      if (g.deductible !== null) details.push(`franchise ${formatEuros(g.deductible)}`);
      return `<tr>${cell(escapeHtml(g.label))}${cell(details.length ? details.join(" · ") : "Incluse", `text-align:right;color:${c.muted}`)}</tr>`;
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
      `Suite à l'étude de votre demande, nous avons le plaisir de vous proposer l'offre de ` +
        `<strong>${escapeHtml(input.insurerName)}</strong>, que nous avons retenue pour vous.`,
    ) +
    offerCard +
    sectionTitle("Notre recommandation") +
    emailParagraph(paragraph(input.justification)) +
    (guarantees.length ? sectionTitle("Garanties incluses") + table(["Garantie", "Plafond / franchise"], guarantees) : "") +
    (deductibles.length ? sectionTitle("Franchises") + table(["Franchise", "Montant"], deductibles) : "") +
    `<p style="margin:26px 0 14px;font-size:15px;line-height:23px;color:${c.text}">Pour donner suite à cette proposition ou pour toute question, il vous suffit de répondre à cet email. Nous restons à votre disposition.</p>` +
    `<p style="margin:0 0 6px;font-size:15px;line-height:23px;color:${c.text}">Bien cordialement,<br><strong>${escapeHtml(cabinet.name)}</strong></p>`;

  const footer =
    (contact.length ? `<p style="margin:0;font-size:12px;line-height:18px;color:${c.muted}">${contact.join(" · ")}</p>` : "") +
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

/** Nom affiché d'un assuré (raison sociale pour un professionnel). */
export function assureDisplayName(assure: { firstName?: string; lastName?: string; companyName?: string | null } | undefined): string {
  if (!assure) return "Madame, Monsieur";
  if (assure.companyName) return assure.companyName;
  return [assure.firstName, assure.lastName].filter(Boolean).join(" ") || "Madame, Monsieur";
}
