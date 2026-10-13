// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
import { Insurer } from './models.js';

/**
 * Assureurs propres à un cabinet : ajoutés par son admin (`cabinets/{c}/insurers/{id}`), en plus du catalogue global.
 * Leur identifiant porte un préfixe : on sait sans lecture où trouver la fiche, et il ne peut pas recouvrir un assureur
 * du catalogue.
 */
export const CABINET_INSURER_PREFIX = 'cab-';

export const CABINET_INSURER_NAME_MAX = 80;
export const CABINET_INSURERS_MAX = 50;

export function isCabinetInsurerId(insurerId: string): boolean {
  return insurerId.startsWith(CABINET_INSURER_PREFIX);
}

/** Chemin Firestore de la fiche d'un assureur, qu'il vienne du catalogue ou du cabinet. */
export function insurerDocPath(cabinetId: string, insurerId: string): string {
  return isCabinetInsurerId(insurerId) ? `cabinets/${cabinetId}/insurers/${insurerId}` : `insurers/${insurerId}`;
}

/**
 * Adresse de l'extranet saisie par le courtier : https uniquement (http accepté pour localhost, démo),
 * sans identifiants dans l'URL. Renvoie l'URL normalisée et son domaine, ou null si elle est refusée.
 */
export function parseExtranetUrl(raw: string): { url: string; domain: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  if (!local && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname)) return null;
  return { url: url.toString().slice(0, 500), domain: url.hostname.toLowerCase() };
}

/** Catalogue vu par un cabinet : les assureurs globaux, puis les siens (hors archivés), triés par nom. */
export function mergeInsurers(global: Insurer[], cabinet: Insurer[]): Insurer[] {
  return [...global, ...cabinet.filter(insurer => !insurer.archived)].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}
