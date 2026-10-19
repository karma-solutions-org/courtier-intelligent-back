/** Une mémoire telle que la lit le script `memories` (formMemories/{key}). */
export interface MemoryRow {
  key: string;
  origin: string;
  formFingerprint: string;
  version: number;
  fieldCount: number;
  hits: number;
  failures: number;
  invalidated: boolean;
  lastUsedAt: Date | null;
  createdAt: Date | null;
}

export interface PurgeCriteria {
  key?: string;
  origin?: string;
  invalidated?: boolean;
  /** Mémoires sans utilisation depuis plus de N jours (celles sans date d'utilisation comptent comme anciennes). */
  olderThanDays?: number;
}

/** Au moins un critère est obligatoire : sans lui, « purger » viderait toute la mémoire partagée. */
export function hasCriteria(criteria: PurgeCriteria): boolean {
  return criteria.key !== undefined || criteria.origin !== undefined || criteria.invalidated === true || criteria.olderThanDays !== undefined;
}

/** Mémoires qui correspondent à TOUS les critères donnés. */
export function selectMemories(rows: MemoryRow[], criteria: PurgeCriteria, now: Date = new Date()): MemoryRow[] {
  if (!hasCriteria(criteria)) return [];
  return rows.filter(row => {
    if (criteria.key !== undefined && row.key !== criteria.key) return false;
    if (criteria.origin !== undefined && row.origin !== criteria.origin) return false;
    if (criteria.invalidated === true && !row.invalidated) return false;
    if (criteria.olderThanDays !== undefined) {
      const last = row.lastUsedAt ?? row.createdAt;
      if (last && now.getTime() - last.getTime() <= criteria.olderThanDays * 24 * 60 * 60 * 1000) return false;
    }
    return true;
  });
}

const day = (date: Date | null) => (date ? date.toISOString().substring(0, 10) : "—");

/** Une ligne lisible par mémoire. */
export function formatRow(row: MemoryRow): string {
  return (
    `${row.key}  ${row.origin}  ${row.formFingerprint}  v${row.version}  ${row.fieldCount} champs  ` +
    `${row.hits} utilisation(s)  ${row.failures} échec(s)${row.invalidated ? "  INVALIDÉE" : ""}  ` +
    `dernière utilisation ${day(row.lastUsedAt)}`
  );
}
