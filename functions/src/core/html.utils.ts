const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Échappe une valeur saisie par un utilisateur avant de l'insérer dans un email HTML. */
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => HTML_ESCAPES[c]!);
