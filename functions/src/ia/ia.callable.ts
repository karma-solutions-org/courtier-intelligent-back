import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership } from "../core/auth.utils";
import { CALLABLE_OPTIONS, GEMINI_API_URL, GEMINI_MODELS } from "../core/config";
import { cabinetPath, iaUsagePath } from "../core/firestore-paths";
import { FALLBACK_LIMITS } from "../shared/index.js";

/** Clé de l'API Gemini : un secret des Cloud Functions, jamais dans l'extension (`firebase functions:secrets:set GEMINI_API_KEY`). */
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 30_000;
const MAX_TOTAL_CHARS = 60_000;
const MAX_SYSTEM_CHARS = 8_000;
const MAX_OUTPUT_TOKENS = 2_000;
const DEFAULT_OUTPUT_TOKENS = 1_024;
/** Durée totale accordée au service d'IA (tous modèles confondus), et à un seul modèle. */
const UPSTREAM_TIMEOUT_MS = 55_000;
const MODEL_TIMEOUT_MS = 25_000;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function parseRequest(data: unknown): { system?: string; messages: ChatMessage[]; maxTokens: number } {
  const body = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    throw new HttpsError("invalid-argument", `Entre 1 et ${MAX_MESSAGES} messages attendus.`);
  }
  let total = 0;
  for (const message of messages) {
    const m = message as Partial<ChatMessage>;
    if ((m?.role !== "user" && m?.role !== "assistant") || typeof m.content !== "string" || !m.content.trim()) {
      throw new HttpsError("invalid-argument", "Message invalide.");
    }
    if (m.content.length > MAX_MESSAGE_CHARS) {
      throw new HttpsError("invalid-argument", "Message trop long.");
    }
    total += m.content.length;
  }
  if (total > MAX_TOTAL_CHARS || (messages[0] as ChatMessage).role !== "user") {
    throw new HttpsError("invalid-argument", "Conversation invalide ou trop longue.");
  }
  const system = body.system;
  if (system !== undefined && (typeof system !== "string" || system.length > MAX_SYSTEM_CHARS)) {
    throw new HttpsError("invalid-argument", "Consigne système invalide.");
  }
  const requested = body.maxTokens;
  if (requested !== undefined && (!Number.isInteger(requested) || (requested as number) < 1)) {
    throw new HttpsError("invalid-argument", "Nombre de tokens invalide.");
  }
  return {
    ...(system !== undefined ? { system: system as string } : {}),
    messages: messages as ChatMessage[],
    maxTokens: Math.min((requested as number | undefined) ?? DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
  };
}

/** Requête Gemini (`generateContent`) construite depuis le format envoyé par l'extension (system + messages). */
function toGeminiRequest(system: string | undefined, messages: ChatMessage[], maxTokens: number): Record<string, unknown> {
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: maxTokens },
  };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

type Attempt =
  | { ok: true; text: string; usage: { inputTokens: number; outputTokens: number } }
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

/**
 * Proxy vers l'API d'IA pour l'extension : authentification (session de l'extension), cabinet actif, limite
 * d'appels par mois selon l'offre du cabinet. La clé reste côté serveur, les modèles sont imposés (`GEMINI_MODELS`, essayés dans l’ordre), les tailles bornées.
 * Le contenu des messages n'est ni journalisé ni conservé.
 */
export const proxy = onCall({ ...CALLABLE_OPTIONS, secrets: [GEMINI_API_KEY], timeoutSeconds: 60 }, async request => {
  const { cabinetId } = await getActiveMembership(request, { extension: true });
  const { system, messages, maxTokens } = parseRequest(request.data);

  const apiKey = GEMINI_API_KEY.value();
  if (!apiKey) {
    throw new HttpsError("failed-precondition", "Le service d'IA n'est pas configuré.", { reason: "ia_not_configured" });
  }

  // Un appel est réservé avant l'envoi : des appels simultanés ne dépassent jamais la limite.
  const db = admin.firestore();
  const usageRef = db.doc(iaUsagePath(cabinetId, currentMonth()));
  const remainingAfterReserve = await db.runTransaction(async tx => {
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

  const upstream = process.env.IA_UPSTREAM_URL ?? GEMINI_API_URL;
  const payload = toGeminiRequest(system, messages, maxTokens);
  const deadline = Date.now() + UPSTREAM_TIMEOUT_MS;

  // Les modèles dans l'ordre : le premier qui répond l'emporte. L'appel ne compte qu'une fois dans le quota.
  for (const model of GEMINI_MODELS) {
    const remainingTime = deadline - Date.now();
    if (remainingTime <= 1_000) break;
    const attempt = await callModel(upstream, apiKey, model, payload, Math.min(MODEL_TIMEOUT_MS, remainingTime));
    if (attempt.ok) {
      return { text: attempt.text, usage: attempt.usage, remaining: remainingAfterReserve };
    }
    if (!attempt.next) break;
  }

  // Aucun modèle n'a répondu : l'appel réservé est rendu.
  await usageRef.set({ calls: FieldValue.increment(-1) }, { merge: true }).catch(() => undefined);
  throw new HttpsError("unavailable", "Le service d'IA est momentanément indisponible. Réessayez.", { reason: "ia_upstream" });
});
