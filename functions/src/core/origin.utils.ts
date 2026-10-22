import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

/** Emulators : seul cas où une page servie en local (extranet de test) est acceptée. */
export const isEmulator = () => process.env.FUNCTIONS_EMULATOR === "true";

/** Le domaine (ou un sous-domaine) fait-il partie de la liste ? */
export function hostMatches(host: string, domains: string[]): boolean {
  return domains.some(domain => !!domain && (host === domain || host.endsWith(`.${domain}`)));
}

/** Hôte d'une origine, ou null si elle n'est pas acceptable (http seulement pour localhost, et seulement en emulator). */
export function originHost(origin: string, emulator = isEmulator()): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.hostname === "localhost") return emulator ? "localhost" : null;
  return url.protocol === "https:" ? url.hostname : null;
}

/**
 * La page est-elle un extranet de cet assureur (signalement de champs) ? Domaine du catalogue (https), ou localhost
 * dans les emulators seulement : le questionnaire commun ne change jamais depuis une page locale en production.
 */
export function isInsurerExtranetOrigin(origin: string, domains: string[], emulator = isEmulator()): boolean {
  const host = originHost(origin, emulator);
  if (host === "localhost") return true;
  return !!host && hostMatches(host, domains);
}

/** Domaines d'extranet du catalogue global (relus au plus toutes les 5 minutes). */
let cache: { at: number; domains: string[] } | null = null;
async function globalInsurerDomains(): Promise<string[]> {
  // Emulators : pas de cache (les tests ajoutent des assureurs à la volée).
  if (cache && !isEmulator() && Date.now() - cache.at < 5 * 60 * 1000) return cache.domains;
  const snapshot = await admin.firestore().collection("ci_insurers").get();
  const domains = snapshot.docs.flatMap(doc => ((doc.get("extranetDomains") as string[] | undefined) ?? []).filter(d => typeof d === "string"));
  cache = { at: Date.now(), domains };
  return domains;
}

/**
 * La mémoire partagée n'apprend que des extranets d'assureurs du catalogue global : un domaine saisi par un cabinet
 * (assureur du cabinet) ou une page quelconque ne l'alimentent jamais.
 */
export async function assertKnownInsurerOrigin(origin: string): Promise<void> {
  const host = originHost(origin);
  if (host === "localhost") return;
  if (!host || !hostMatches(host, await globalInsurerDomains())) {
    throw new HttpsError("permission-denied", "Cette page n'est pas un extranet d'assureur connu.", { reason: "unknown_origin" });
  }
}
