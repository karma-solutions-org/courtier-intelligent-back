import { escapeHtml } from "../core/html.utils";
import { EMAIL_COLORS, emailButton, emailLayout, emailParagraph } from "../core/email-layout";

/**
 * Email d'invitation d'un membre dans un cabinet. Logique pure (testable, prévisualisable).
 * `cabinetName` est déjà échappé par l'appelant (il sert aussi au sujet, comme auparavant).
 */
export function buildInvitationEmail(input: { cabinetName: string; email: string; link: string; ttlDays: number }): {
  subject: string;
  html: string;
} {
  const { cabinetName } = input;
  return {
    subject: `Invitation à rejoindre ${cabinetName} sur Courtier Intelligent`,
    html: emailLayout({
      headerTitle: cabinetName,
      headerSubtitle: "Invitation sur Courtier Intelligent",
      body:
        emailParagraph(`Vous êtes invité à rejoindre le cabinet <strong>${cabinetName}</strong> sur Courtier Intelligent.`) +
        emailButton(escapeHtml(input.link), "Accepter l'invitation") +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr>` +
        `<td style="padding:12px 16px;background:#fff6e0;border-left:4px solid ${EMAIL_COLORS.amber};border-radius:0 8px 8px 0;font-size:14px;line-height:22px;color:${EMAIL_COLORS.text}">` +
        `<p style="margin:0"><strong>Important :</strong> connectez-vous ou créez votre compte avec cette adresse email, ` +
        `<strong>${escapeHtml(input.email)}</strong>. L'invitation ne peut pas être acceptée depuis un autre compte.</p></td></tr></table>`,
      footer: `Ce lien expire dans ${input.ttlDays} jours.`,
    }),
  };
}
