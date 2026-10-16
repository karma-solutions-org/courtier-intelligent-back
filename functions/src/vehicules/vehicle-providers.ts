import { logger } from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import { HttpsError } from "firebase-functions/v2/https";
import type { VehicleEnergy, VehicleInfo } from "../shared/index.js";

/** Token de apiplaqueimmatriculation.com : secret des Cloud Functions (`firebase functions:secrets:set PLAQUE_API_TOKEN`). */
export const PLAQUE_API_TOKEN = defineSecret("PLAQUE_API_TOKEN");

/**
 * Fournisseur de données « plaque → véhicule ». La function ne connaît que cette interface :
 * brancher un vrai fournisseur (payant, clé dans un secret Firebase) ne change ni la function ni l'app.
 */
export interface VehicleProvider {
  readonly name: string;
  /** Plaque déjà normalisée (« AB-123-CD » ou « 1234 AB 75 ») ; `null` si le véhicule est inconnu. */
  lookup(plate: string): Promise<VehicleInfo | null>;
}

/** Plaques de test du fournisseur démo (données fictives, pour essayer le pré-remplissage de bout en bout). */
export const DEMO_VEHICLES: Record<string, Omit<VehicleInfo, "plate">> = {
  "AB-123-CD": {
    brand: "Peugeot",
    model: "208",
    version: "1.2 PureTech 100 Allure",
    firstRegistrationDate: "2021-03-15",
    fiscalPower: 5,
    energyType: "essence",
    vehicleType: "voiture",
  },
  "EF-456-GH": {
    brand: "Renault",
    model: "Clio V",
    version: "1.5 Blue dCi 100 Intens",
    firstRegistrationDate: "2020-09-02",
    fiscalPower: 5,
    energyType: "diesel",
    vehicleType: "voiture",
  },
  "KL-789-MN": {
    brand: "Tesla",
    model: "Model 3",
    version: "Propulsion",
    firstRegistrationDate: "2023-06-20",
    fiscalPower: 3,
    energyType: "electrique",
    vehicleType: "voiture",
  },
  "1234 AB 75": {
    brand: "Renault",
    model: "Clio II",
    version: "1.2 16V Expression",
    firstRegistrationDate: "2005-04-11",
    fiscalPower: 5,
    energyType: "essence",
    vehicleType: "voiture",
  },
};

/** Fournisseur démo : données fixes pour quelques plaques, aucun appel réseau, aucune clé. */
export const demoProvider: VehicleProvider = {
  name: "demo",
  async lookup(plate) {
    const vehicle = DEMO_VEHICLES[plate];
    return vehicle ? { plate, ...vehicle } : null;
  },
};

const API_PLAQUE_URL = "https://api.apiplaqueimmatriculation.com/plaque";
const API_PLAQUE_TIMEOUT_MS = 10_000;

/** Codes `energie` de apiplaqueimmatriculation.com → choix du questionnaire (gaz naturel, hydrogène : pas d'équivalent). */
const ENERGY_BY_CODE: Record<string, VehicleEnergy> = {
  "1": "ethanol",
  "2": "diesel",
  "3": "gpl",
  "4": "essence",
  "5": "hybride",
  "6": "hybride_rechargeable",
  "7": "hybride",
  "9": "hybride",
  "10": "hybride_rechargeable",
  "11": "gpl",
  "12": "electrique",
  "13": "ethanol",
  "14": "hybride",
  "15": "hybride",
  "17": "hybride",
  "18": "hybride_rechargeable",
};

/** Codes `genreVCG` (genre de la carte grise) → type de véhicule du questionnaire. */
const TYPE_BY_GENRE: Record<string, VehicleInfo["vehicleType"]> = { "1": "voiture", "2": "utilitaire", "19": "utilitaire", "5": "moto" };

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= 200 ? value.trim() : undefined;

/** AAAA-MM-JJ depuis `date1erCir_us`, sinon `date1erCir_fr` (JJ/MM/AAAA ou JJ-MM-AAAA). */
function firstRegistration(us: unknown, fr: unknown): string | undefined {
  const iso = text(us);
  if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(iso))) return iso;
  const match = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(text(fr) ?? "");
  const fromFr = match ? `${match[3]}-${match[2]}-${match[1]}` : undefined;
  return fromFr && !Number.isNaN(Date.parse(fromFr)) ? fromFr : undefined;
}

/** Réponse de apiplaqueimmatriculation.com → données du véhicule ; `null` si elle ne décrit aucun véhicule. */
export function fromApiPlaque(plate: string, body: unknown): VehicleInfo | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (text(d.erreur) || !text(d.marque)) return null;
  const power = Number.parseInt(String(d.puisFisc ?? ""), 10);
  const info: VehicleInfo = {
    plate,
    brand: text(d.marque),
    model: text(d.modele),
    version: text(d.version),
    firstRegistrationDate: firstRegistration(d.date1erCir_us, d.date1erCir_fr),
    fiscalPower: Number.isInteger(power) && power > 0 && power < 200 ? power : undefined,
    energyType: ENERGY_BY_CODE[String(d.energie ?? "")],
    vehicleType: TYPE_BY_GENRE[String(d.genreVCG ?? "")],
  };
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)) as unknown as VehicleInfo;
}

/** Fournisseur réel (payant) : la plaque part au serveur de apiplaqueimmatriculation.com avec le token du secret. */
export const apiPlaqueProvider: VehicleProvider = {
  name: "apiplaqueimmatriculation",
  async lookup(plate) {
    const token = PLAQUE_API_TOKEN.value();
    if (!token) throw new HttpsError("failed-precondition", "La recherche par immatriculation n'est pas configurée. Contactez l'administrateur.");
    const url = `${API_PLAQUE_URL}?${new URLSearchParams({ immatriculation: plate.replace(/ /g, "-"), token, pays: "FR" })}`;
    const { response, body } = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(API_PLAQUE_TIMEOUT_MS),
    })
      .then(async res => ({ response: res, body: (await res.json().catch(() => null)) as { code_erreur?: unknown; message?: unknown } | null }))
      .catch((error: unknown) => {
        logger.warn("apiplaqueimmatriculation injoignable", { error: String(error) });
        throw new HttpsError("unavailable", "Le service d'immatriculation ne répond pas. Réessayez.");
      });
    // L'API renvoie aussi son code dans le corps (`code_erreur`) ; le token n'est jamais journalisé.
    const status = typeof body?.code_erreur === "number" ? body.code_erreur : response.status;
    if (status === 401 || status === 402 || status === 403 || status === 429) {
      logger.error("apiplaqueimmatriculation refuse l'appel (token invalide ou crédits épuisés)", { status, message: body?.message });
      throw new HttpsError("unavailable", "La recherche par immatriculation est momentanément indisponible. Contactez l'administrateur si cela persiste.");
    }
    if (status === 404) return null;
    if (status >= 400 || !response.ok) {
      logger.warn("apiplaqueimmatriculation en erreur", { status, message: body?.message });
      throw new HttpsError("unavailable", "Le service d'immatriculation est en erreur. Réessayez.");
    }
    return fromApiPlaque(plate, body);
  },
};

/** Fournisseur utilisé par la function : le vrai, sauf dans les emulators sans token (données de démo). */
export function vehicleProvider(): VehicleProvider {
  return process.env.FUNCTIONS_EMULATOR === "true" && !PLAQUE_API_TOKEN.value() ? demoProvider : apiPlaqueProvider;
}
