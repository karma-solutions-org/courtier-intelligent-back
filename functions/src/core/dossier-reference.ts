/** Référence « AAAA-NNNNNN » : numéro séquentiel par cabinet et par année (ex. 2026-000123). */
export function formatReference(year: number, sequence: number): string {
  return `${year}-${String(sequence).padStart(6, "0")}`;
}
