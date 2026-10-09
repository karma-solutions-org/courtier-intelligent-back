import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { GEMINI_API_KEY, geminiApiKey, generateWithGemini, reserveIaCall } from "../core/gemini.utils";

const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 30_000;
const MAX_TOTAL_CHARS = 60_000;
const MAX_SYSTEM_CHARS = 8_000;
const MAX_OUTPUT_TOKENS = 2_000;
const DEFAULT_OUTPUT_TOKENS = 1_024;

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

/**
 * Proxy vers l'API d'IA pour l'extension : authentification (session de l'extension), cabinet actif, limite
 * d'appels par mois selon l'offre du cabinet. La clé reste côté serveur, les modèles sont imposés (`GEMINI_MODELS`, essayés dans l’ordre), les tailles bornées.
 * Le contenu des messages n'est ni journalisé ni conservé.
 */
export const proxy = onCall({ ...CALLABLE_OPTIONS, secrets: [GEMINI_API_KEY], timeoutSeconds: 60 }, async request => {
  const { cabinetId } = await getActiveMembership(request, { extension: true });
  const { system, messages, maxTokens } = parseRequest(request.data);

  const apiKey = geminiApiKey();

  // Un appel est réservé avant l'envoi (quota mensuel du cabinet) ; il ne compte qu'une fois, quel que soit le modèle.
  const { remaining, release } = await reserveIaCall(cabinetId);
  const result = await generateWithGemini(apiKey, toGeminiRequest(system, messages, maxTokens));
  if (result) {
    return { text: result.text, usage: result.usage, remaining };
  }

  // Aucun modèle n'a répondu : l'appel réservé est rendu.
  await release();
  throw new HttpsError("unavailable", "Le service d'IA est momentanément indisponible. Réessayez.", { reason: "ia_upstream" });
});
