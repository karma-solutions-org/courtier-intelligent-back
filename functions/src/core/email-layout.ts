/**
 * Mise en page commune des emails (compatible clients mail : tableaux, styles en ligne, 600 px max).
 * Les fragments reçus sont du HTML déjà échappé par l'appelant (escapeHtml) : rien n'est échappé ici.
 */

export const EMAIL_COLORS = {
  navy: "#00082b",
  navy2: "#102a6b",
  blue: "#2f5bd3",
  green: "#14894f",
  greenBg: "#e6f6ee",
  amber: "#b27700",
  text: "#1c2540",
  muted: "#6b7891",
  line: "#e3e8f1",
  bg: "#f3f6fb",
} as const;

const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Titre de section (« Garanties incluses »). */
export const sectionTitle = (title: string) =>
  `<h3 style="margin:24px 0 10px;${FONT};font-size:15px;line-height:20px;color:${EMAIL_COLORS.navy}">${title}</h3>`;

/** Paragraphe de texte courant. */
export const emailParagraph = (html: string) =>
  `<p style="margin:0 0 14px;${FONT};font-size:15px;line-height:23px;color:${EMAIL_COLORS.text}">${html}</p>`;

/** Bouton « bulletproof » (tableau + lien, avec repli VML pour Outlook). `href` doit être déjà échappé. */
export function emailButton(href: string, label: string, color: string = EMAIL_COLORS.blue): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 18px"><tr><td align="center" bgcolor="${color}" style="border-radius:8px;background:${color}">` +
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${href}" style="height:44px;v-text-anchor:middle;width:260px" arcsize="18%" stroke="f" fillcolor="${color}"><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">${label}</center></v:roundrect><![endif]-->` +
    `<!--[if !mso]><!-->` +
    `<a href="${href}" target="_blank" style="display:inline-block;padding:12px 26px;${FONT};font-size:15px;font-weight:bold;line-height:20px;color:#ffffff;text-decoration:none;border-radius:8px;background:${color}">${label}</a>` +
    `<!--<![endif]-->` +
    `</td></tr></table>`
  );
}

/**
 * Enveloppe complète : bandeau marine (titre + sous-titre), corps blanc, pied gris.
 * `headerTitle`, `headerSubtitle`, `body` et `footer` sont du HTML déjà échappé.
 */
export function emailLayout(parts: { headerTitle: string; headerSubtitle?: string; body: string; footer?: string }): string {
  const c = EMAIL_COLORS;
  return (
    `<div style="margin:0;padding:0;background:${c.bg}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${c.bg}"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;border-collapse:separate;background:#ffffff;border:1px solid ${c.line};border-radius:12px">` +
    // Bandeau marine
    `<tr><td bgcolor="${c.navy}" style="padding:22px 28px;background:${c.navy};background-image:linear-gradient(135deg,${c.navy} 0%,${c.navy2} 65%,${c.blue} 100%);border-radius:12px 12px 0 0">` +
    `<p style="margin:0;${FONT};font-size:20px;line-height:26px;font-weight:bold;color:#ffffff">${parts.headerTitle}</p>` +
    (parts.headerSubtitle
      ? `<p style="margin:4px 0 0;${FONT};font-size:13px;line-height:18px;color:#c7d3f0">${parts.headerSubtitle}</p>`
      : "") +
    `</td></tr>` +
    // Liseré d'accent
    `<tr><td height="4" style="height:4px;line-height:4px;font-size:0;background:${c.blue};background-image:linear-gradient(90deg,${c.blue},#0e9f8e)">&nbsp;</td></tr>` +
    // Corps
    `<tr><td style="padding:28px 28px 12px;${FONT};font-size:15px;line-height:23px;color:${c.text}">${parts.body}</td></tr>` +
    (parts.footer
      ? `<tr><td style="padding:16px 28px 24px;border-top:1px solid ${c.line};${FONT};font-size:12px;line-height:18px;color:${c.muted}">${parts.footer}</td></tr>`
      : "") +
    `</table>` +
    `</td></tr></table></div>`
  );
}
