import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { normalizeRegistration } from "../shared/index.js";
import { reservePlaqueLookup } from "./plaque-quota";
import { PLAQUE_API_TOKEN, vehicleProvider } from "./vehicle-providers";

/**
 * Recherche d'un véhicule par sa plaque (pré-remplissage du questionnaire Auto et de ses copies) :
 * membre actif du cabinet, plaque validée et normalisée (SIV ou FNI), fournisseur appelé côté serveur
 * (son token, secret PLAQUE_API_TOKEN, ne quitte jamais le serveur), dans la limite mensuelle du cabinet
 * (`limits.appelsPlaqueParMois` : chaque recherche est payante). Rien n'est enregistré : l'app remplit les champs vides du dossier.
 */
export const rechercher = onCall({ ...CALLABLE_OPTIONS, secrets: [PLAQUE_API_TOKEN] }, async request => {
  const { cabinetId } = await getActiveMembership(request);
  const normalized = normalizeRegistration(request.data?.plate);
  if (!normalized) {
    throw new HttpsError("invalid-argument", "Plaque d'immatriculation invalide (formats acceptés : AB-123-CD ou 1234 AB 75).");
  }
  // Une plaque invalide ne consomme rien ; une plaque inconnue, si (le fournisseur a été interrogé).
  const { release } = await reservePlaqueLookup(cabinetId);
  const vehicle = await vehicleProvider()
    .lookup(normalized.plate)
    .catch(async (error: unknown) => {
      // Fournisseur injoignable, token refusé ou absent : la recherche est rendue au cabinet.
      await release();
      throw error;
    });
  if (!vehicle) {
    throw new HttpsError("not-found", `Aucun véhicule trouvé pour la plaque ${normalized.plate}.`);
  }
  return { vehicle };
});
