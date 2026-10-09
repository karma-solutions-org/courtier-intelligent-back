import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError } from "firebase-functions/v2/https";
import { FALLBACK_LIMITS } from "../shared/index.js";
import { GEMINI_API_URL, GEMINI_MODELS } from "./config";
import { cabinetPath, iaUsagePath } from "./firestore-paths";

/** Clé de l'API Gemini : un secret des Cloud Functions, jamais dans l'app ni l'extension (`firebase functions:secrets:set GEMINI_API_KEY`). */
export const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

/** Durée totale accordée au service d'IA (tous modèles confondus), et à un seul modèle. */
const UPSTREAM_TIMEOUT_MS = 55_000;
const MODEL_TIMEOUT_MS = 25_000;

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export interface GeminiResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

type Attempt =
  | ({ ok: true } & GeminiResult)
  /** `next` : le modèle suivant a une chance de répondre (sinon, inutile d'insister : clé refusée). */
  | { ok: false; next: boolean };

/** Un appel à un modèle Gemini. Ne lève jamais : un échec est décrit par le résultat. */
async function callModel(upstream: string, apiKey: string, model: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetch(`${upstream}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, next: true }; // réseau, délai dépassé
  }
  // Clé refusée : les autres modèles échoueraient de la même façon.
  if (response.status === 401 || response.status === 403) return { ok: false, next: false };
  // Modèle introuvable (404), surchargé (429), en panne (5xx)… : on essaie le suivant.
  if (!response.ok) return { ok: false, next: true };

  const body = (await response.json().catch(() => null)) as GeminiResponse | null;
  const text = (body?.candidates?.[0]?.content?.parts ?? []).map(part => part.text ?? "").join("");
  // Réponse vide (bloquée, ou coupée avant tout texte) : le modèle suivant peut répondre.
  if (!text) return { ok: false, next: true };
  return {
    ok: true,
    text,
    usage: { inputTokens: body?.usageMetadata?.promptTokenCount ?? 0, outputTokens: body?.usageMetadata?.candidatesTokenCount ?? 0 },
  };
}

/** Mois en cours (« AAAA-MM », UTC) : période du quota d'appels. */
const currentMonth = () => new Date().toISOString().substring(0, 7);

/** Clé de l'API, ou erreur si le secret n'est pas posé. */
export function geminiApiKey(): string {
  const apiKey = GEMINI_API_KEY.value();
  if (!apiKey) {
    throw new HttpsError("failed-precondition", "Le service d'IA n'est pas configuré.", { reason: "ia_not_configured" });
  }
  return apiKey;
}

/**
 * Réserve un appel d'IA sur le quota mensuel du cabinet (`limits.appelsIaParMois`) avant l'envoi : des appels simultanés
 * ne dépassent jamais la limite. Renvoie le nombre d'appels restants, et de quoi rendre l'appel s'il n'a pas abouti.
 */
export async function reserveIaCall(cabinetId: string): Promise<{ remaining: number; release: () => Promise<void> }> {
  const db = admin.firestore();
  const usageRef = db.doc(iaUsagePath(cabinetId, currentMonth()));
  const remaining = await db.runTransaction(async tx => {
    const [cabinet, usage] = await Promise.all([tx.get(db.doc(cabinetPath(cabinetId))), tx.get(usageRef)]);
    const limit = (cabinet.get("limits.appelsIaParMois") as number | undefined) ?? FALLBACK_LIMITS.appelsIaParMois;
    const calls = (usage.get("calls") as number | undefined) ?? 0;
    if (calls >= limit) {
      throw new HttpsError(
        "resource-exhausted",
        `Limite de ${limit} appels d'IA par mois atteinte pour votre cabinet. Réessayez le mois prochain ou changez d'offre.`,
        { reason: "ia_quota", limit },
      );
    }
    tx.set(usageRef, { calls: calls + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return limit - calls - 1;
  });
  const release = () =>
    usageRef
      .set({ calls: FieldValue.increment(-1) }, { merge: true })
      .then(() => undefined)
      .catch(() => undefined);
  return { remaining, release };
}

/**
 * Envoie une requête `generateContent` aux modèles (`GEMINI_MODELS`, dans l'ordre) : le premier qui répond l'emporte.
 * Renvoie `null` si aucun n'a répondu. Le contenu n'est ni journalisé ni conservé.
 */
export async function generateWithGemini(apiKey: string, payload: Record<string, unknown>): Promise<GeminiResult | null> {
  const upstream = process.env.IA_UPSTREAM_URL ?? GEMINI_API_URL;
  const deadline = Date.now() + UPSTREAM_TIMEOUT_MS;
  for (const model of GEMINI_MODELS) {
    const remainingTime = deadline - Date.now();
    if (remainingTime <= 1_000) break;
    const attempt = await callModel(upstream, apiKey, model, payload, Math.min(MODEL_TIMEOUT_MS, remainingTime));
    if (attempt.ok) {
      return { text: attempt.text, usage: attempt.usage };
    }
    if (!attempt.next) break;
  }
  return null;
}
