import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership } from "../core/auth.utils";
import { CALLABLE_OPTIONS, IA_MODEL } from "../core/config";
import { cabinetPath, iaUsagePath } from "../core/firestore-paths";
import { FALLBACK_LIMITS } from "../shared/index.js";

/** Clé de l'API d'IA : un secret des Cloud Functions, jamais dans l'extension (`firebase functions:secrets:set ANTHROPIC_API_KEY`). */
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 30_000;
const MAX_TOTAL_CHARS = 60_000;
const MAX_SYSTEM_CHARS = 8_000;
const MAX_OUTPUT_TOKENS = 2_000;
const DEFAULT_OUTPUT_TOKENS = 1_024;
const UPSTREAM_TIMEOUT_MS = 55_000;

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

/** Mois en cours (« AAAA-MM », UTC) : période du quota d'appels. */
const currentMonth = () => new Date().toISOString().substring(0, 7);

/**
 * Proxy vers l'API d'IA pour l'extension : authentification (session de l'extension), cabinet actif, limite
 * d'appels par mois selon l'offre du cabinet. La clé reste côté serveur, le modèle est imposé, les tailles bornées.
 * Le contenu des messages n'est ni journalisé ni conservé.
 */
export const proxy = onCall({ ...CALLABLE_OPTIONS, secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60 }, async request => {
  const { cabinetId } = await getActiveMembership(request, { extension: true });
  const { system, messages, maxTokens } = parseRequest(request.data);

  const apiKey = ANTHROPIC_API_KEY.value();
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

  const refund = () => usageRef.set({ calls: FieldValue.increment(-1) }, { merge: true }).catch(() => undefined);
  const unavailable = () =>
    new HttpsError("unavailable", "Le service d'IA est momentanément indisponible. Réessayez.", { reason: "ia_upstream" });
  const upstream = process.env.IA_UPSTREAM_URL ?? "https://api.anthropic.com";

  try {
    const response = await fetch(`${upstream}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: IA_MODEL, max_tokens: maxTokens, ...(system ? { system } : {}), messages }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) {
      await refund();
      throw unavailable();
    }
    const body = (await response.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (body.content ?? [])
      .filter(block => block.type === "text")
      .map(block => block.text ?? "")
      .join("");
    return {
      text,
      usage: { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 },
      remaining: remainingAfterReserve,
    };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    await refund();
    throw unavailable();
  }
});
