// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
/** Texte sans accents et en minuscules (« Élève » → « eleve ») : base commune des comparaisons de textes. */
export function foldText(text: string | null | undefined): string {
  return (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}
