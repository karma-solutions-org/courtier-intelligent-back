import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership, requireString, tokenAuthTime } from "../core/auth.utils";
import { CALLABLE_OPTIONS, SESSION_TTL_MS } from "../core/config";
import { memberPath } from "../core/firestore-paths";

/** Identifiant de l'appareil généré par l'app (UUID). Informatif : la session est liée à `auth_time`. */
function requireSessionId(value: unknown): string {
  const sessionId = requireString(value, "session", 64);
  if (!/^[A-Za-z0-9-]{16,64}$/.test(sessionId)) {
    throw new HttpsError("invalid-argument", "Identifiant de session invalide.");
  }
  return sessionId;
}

interface StoredSession {
  id: string;
  authTime: number;
  ouverteLe?: Timestamp;
  lastSeen?: Timestamp;
}

/**
 * Ouvre la session de l'appareil qui se connecte. Un seul appareil par utilisateur.
 *
 * La session est liée à l'`auth_time` du token (heure de la connexion par mot de passe,
 * signée par Firebase) : impossible à falsifier ou à copier d'un appareil à l'autre.
 * - même connexion (rechargement de la page) : acceptée ;
 * - autre connexion alors que la session en cours donne signe de vie : REFUSÉE ;
 * - autre connexion après SESSION_TTL_MS sans signal (appareil éteint) : acceptée, l'ancien appareil perd l'accès.
 * Les règles Firestore et les autres functions n'acceptent que le token de cette connexion.
 */
export const ouvrir = onCall(CALLABLE_OPTIONS, async request => {
  const { uid, cabinetId } = await getActiveMembership(request, { requireSession: false });
  const authTime = tokenAuthTime(request);
  const sessionId = requireSessionId(request.data?.sessionId);
  const appareil = typeof request.data?.appareil === "string" ? request.data.appareil.substring(0, 120) : null;

  const db = admin.firestore();
  const memberRef = db.doc(memberPath(cabinetId, uid));

  await db.runTransaction(async tx => {
    const current = (await tx.get(memberRef)).get("session") as StoredSession | undefined;
    const isSameLogin = current?.authTime === authTime;
    const isStillActive = !!current?.lastSeen && Date.now() - current.lastSeen.toMillis() < SESSION_TTL_MS;
    if (current && !isSameLogin && isStillActive) {
      throw new HttpsError(
        "already-exists",
        "Ce compte est déjà connecté sur un autre appareil. Déconnectez-vous de cet appareil, " +
          "ou patientez 2 minutes s'il a été éteint sans déconnexion.",
      );
    }
    tx.update(memberRef, {
      session: {
        id: sessionId,
        authTime,
        appareil,
        // Même connexion (rechargement de la page) : on garde l'heure d'ouverture d'origine.
        ouverteLe: (isSameLogin && current?.ouverteLe) || FieldValue.serverTimestamp(),
        lastSeen: FieldValue.serverTimestamp(),
      },
    });
  });

  return { success: true };
});

/** Ferme la session à la déconnexion : l'utilisateur peut aussitôt se connecter ailleurs. */
export const fermer = onCall(CALLABLE_OPTIONS, async request => {
  const { uid, cabinetId } = await getActiveMembership(request, { requireSession: false });
  const authTime = tokenAuthTime(request);

  const db = admin.firestore();
  const memberRef = db.doc(memberPath(cabinetId, uid));
  await db.runTransaction(async tx => {
    const current = (await tx.get(memberRef)).get("session") as StoredSession | undefined;
    // Ne ferme que sa propre session, jamais celle d'un autre appareil.
    if (current?.authTime === authTime) {
      tx.update(memberRef, { session: FieldValue.delete() });
    }
  });
  return { success: true };
});
