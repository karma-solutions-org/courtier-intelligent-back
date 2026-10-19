import * as admin from "firebase-admin";
import { FieldValue, type Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { writeAudit } from "../core/audit.utils";
import { getActiveMembership, requireString, tokenAuthTime } from "../core/auth.utils";
import { APP_SESSION_ACTIVE_MS, CALLABLE_OPTIONS, EXTENSION_APP_SESSION_MAX_AGE_MS } from "../core/config";
import { memberPath } from "../core/firestore-paths";
import type { Session } from "../shared/index.js";

/** Identifiant d'appareil généré par l'app (UUID) et conservé dans son IndexedDB. */
function requireDeviceId(value: unknown): string {
  const deviceId = requireString(value, "appareil", 64);
  if (!/^[A-Za-z0-9-]{16,64}$/.test(deviceId)) {
    throw new HttpsError("invalid-argument", "Identifiant d'appareil invalide.");
  }
  return deviceId;
}

/**
 * Ouvre la session de l'appareil qui se connecte.
 *
 * Un compte peut se connecter depuis n'importe quel appareil, mais n'est ouvert qu'à UN endroit à la fois :
 * - une session encore active sur un AUTRE appareil (signe de vie depuis moins de `APP_SESSION_ACTIVE_MS`) : REFUSÉ
 *   (et tracé dans le journal d'audit du cabinet), même avec le bon mot de passe ;
 * - pas de session active ailleurs (déconnecté, ou navigateur fermé depuis plus de ce délai) : acceptée ;
 * - même appareil : acceptée. Une nouvelle connexion remplace aussitôt la précédente (autre onglet, autre
 *   fenêtre) : la session est liée à l'`auth_time` du token (heure de connexion par mot de passe, signée par
 *   Firebase), les règles Firestore et les functions n'acceptent plus que celui de la dernière connexion.
 */
export const ouvrir = onCall(CALLABLE_OPTIONS, async request => {
  const { uid, cabinetId } = await getActiveMembership(request, { requireSession: false });
  const authTime = tokenAuthTime(request);
  const deviceId = requireDeviceId(request.data?.deviceId);
  const label = typeof request.data?.appareil === "string" ? request.data.appareil.substring(0, 120) : null;

  const db = admin.firestore();
  const memberRef = db.doc(memberPath(cabinetId, uid));

  const outcome = await db.runTransaction(async tx => {
    const member = await tx.get(memberRef);
    const current = member.get("session") as Session | undefined;
    const isSameLogin = current?.authTime === authTime;
    const lastSeen = current?.lastSeen?.toMillis();
    const activeElsewhere =
      !!current && !isSameLogin && current.id !== deviceId && lastSeen !== undefined && Date.now() - lastSeen < APP_SESSION_ACTIVE_MS;
    if (activeElsewhere) {
      return { refused: true as const, activeLabel: current.appareil ?? null };
    }
    tx.update(memberRef, {
      session: {
        id: deviceId,
        authTime,
        appareil: label,
        // Même connexion (rechargement de la page) : on garde l'heure d'ouverture d'origine.
        ouverteLe: (isSameLogin && (current?.ouverteLe as Timestamp | undefined)) || FieldValue.serverTimestamp(),
        lastSeen: FieldValue.serverTimestamp(),
        // Recharger la page ne coupe pas l'extension ; une nouvelle connexion, si (elle remplace toute la session).
        ...(isSameLogin && current?.extensionAuthTime !== undefined
          ? { extensionAuthTime: current.extensionAuthTime, extensionOpenedAt: current.extensionOpenedAt }
          : {}),
      },
    });
    return { refused: false as const, isNewLogin: !isSameLogin };
  });

  if (outcome.refused) {
    await writeAudit(cabinetId, {
      type: "connexion_refusee_session_active",
      uid,
      data: { appareil: label, appareilActif: outcome.activeLabel },
    });
    throw new HttpsError(
      "permission-denied",
      "Ce compte est déjà ouvert sur un autre appareil" +
        `${outcome.activeLabel ? ` (${outcome.activeLabel})` : ""}. ` +
        "Déconnectez-vous de cet appareil, ou attendez quelques minutes s'il a été fermé, puis réessayez.",
      { reason: "session_active" },
    );
  }
  if (outcome.isNewLogin) {
    await writeAudit(cabinetId, { type: "connexion", uid, data: { appareil: label } });
  }

  return { success: true };
});

/** Ferme la session à la déconnexion : le compte peut aussitôt se connecter ailleurs. */
export const fermer = onCall(CALLABLE_OPTIONS, async request => {
  const { uid, cabinetId } = await getActiveMembership(request, { requireSession: false });
  const authTime = tokenAuthTime(request);

  const db = admin.firestore();
  const memberRef = db.doc(memberPath(cabinetId, uid));
  await db.runTransaction(async tx => {
    const current = (await tx.get(memberRef)).get("session") as Session | undefined;
    // Ne ferme que sa propre session, jamais celle d'une connexion plus récente.
    if (current?.authTime === authTime) {
      tx.update(memberRef, { session: FieldValue.delete() });
    }
  });
  return { success: true };
});

/**
 * Ouvre la session de l'extension Chrome. L'extension se connecte avec le compte de l'app, mais son jeton a
 * sa propre heure de connexion : elle n'a accès à rien tant que cette fonction ne l'a pas enregistrée, et
 * seulement si l'app est ouverte sur l'appareil (session de l'app active, avec signe de vie récent).
 * L'enregistrement vit DANS la session de l'app : fermée, remplacée, appareil réinitialisé ou membre désactivé,
 * l'extension perd l'accès aussitôt (règles Firestore et functions).
 * Liaison à l'appareil : l'extension présente l'identifiant d'appareil que l'app lui a transmis (message `PING`) ;
 * il doit être celui de la session de l'app. Sinon l'extension d'un autre poste
 * pourrait profiter d'une app ouverte ailleurs.
 */
export const ouvrirExtension = onCall(CALLABLE_OPTIONS, async request => {
  const { uid, cabinetId } = await getActiveMembership(request, { requireSession: false });
  const authTime = tokenAuthTime(request);
  const rawDeviceId = request.data?.deviceId;
  const deviceId = typeof rawDeviceId === "string" && rawDeviceId ? requireDeviceId(rawDeviceId) : null;

  const db = admin.firestore();
  const memberRef = db.doc(memberPath(cabinetId, uid));

  const isNewLogin = await db.runTransaction(async tx => {
    const member = await tx.get(memberRef);
    const current = member.get("session") as Session | undefined;
    const lastSeen = current?.lastSeen?.toMillis();
    if (!current || lastSeen === undefined || Date.now() - lastSeen > EXTENSION_APP_SESSION_MAX_AGE_MS) {
      throw new HttpsError(
        "failed-precondition",
        "Ouvrez Courtier Intelligent dans votre navigateur et connectez-vous avant d'utiliser l'extension.",
        { reason: "no_app_session" },
      );
    }
    // L'extension doit tourner sur l'appareil de la session de l'app.
    if (!deviceId || current.id !== deviceId) {
      throw new HttpsError(
        "failed-precondition",
        "L'extension doit être utilisée sur l'appareil où Courtier Intelligent est ouvert.",
        { reason: "device_mismatch" },
      );
    }
    // Garde-fou : un jeton qui aurait le même auth_time que l'app (connexions dans la même seconde) ne doit jamais
    // servir de connexion d'extension, sinon il ouvrirait aussi les données de l'app.
    if (current.authTime === authTime) {
      throw new HttpsError("failed-precondition", "Réessayez dans quelques secondes.", { reason: "retry" });
    }
    tx.update(memberRef, {
      "session.extensionAuthTime": authTime,
      "session.extensionOpenedAt": FieldValue.serverTimestamp(),
    });
    return current.extensionAuthTime !== authTime;
  });

  if (isNewLogin) {
    await writeAudit(cabinetId, { type: "extension_connexion", uid });
  }
  return { success: true };
});

/** Délai minimal entre deux jetons de connexion automatique pour un même membre. */
const EXTENSION_TOKEN_MIN_INTERVAL_MS = 5_000;

/**
 * Émet un jeton de connexion pour l'extension Chrome du même appareil (connexion automatique, sans second mot de passe).
 * Seule l'APP peut l'appeler : `getActiveMembership` compare l'`auth_time` du jeton à celui de la session de l'app,
 * donc le jeton de l'extension (autre `auth_time`) est refusé. Le jeton émis est un custom token Firebase : l'extension
 * l'échange contre sa propre connexion (nouvel `auth_time`) puis appelle `sessions-ouvrirExtension`, qui garde toutes
 * ses vérifications (session de l'app vivante, même appareil, `auth_time` distinct de celui de l'app).
 * Le jeton vit au plus une heure, la fréquence d'émission est limitée et chaque émission est tracée.
 * Production : le compte de service des functions doit avoir le rôle « Service Account Token Creator » (signature).
 */
export const emettreJetonExtension = onCall(CALLABLE_OPTIONS, async request => {
  const { uid, cabinetId } = await getActiveMembership(request);
  const deviceId = requireDeviceId(request.data?.deviceId);

  const db = admin.firestore();
  const memberRef = db.doc(memberPath(cabinetId, uid));
  await db.runTransaction(async tx => {
    const current = (await tx.get(memberRef)).get("session") as Session | undefined;
    if (!current || current.id !== deviceId) {
      throw new HttpsError(
        "failed-precondition",
        "L'extension doit être utilisée sur l'appareil où Courtier Intelligent est ouvert.",
        { reason: "device_mismatch" },
      );
    }
    const issuedAt = current.extensionTokenIssuedAt?.toMillis();
    if (issuedAt !== undefined && Date.now() - issuedAt < EXTENSION_TOKEN_MIN_INTERVAL_MS) {
      throw new HttpsError("resource-exhausted", "Trop de demandes de connexion de l'extension. Réessayez dans quelques secondes.");
    }
    tx.update(memberRef, { "session.extensionTokenIssuedAt": FieldValue.serverTimestamp() });
  });

  const token = await admin.auth().createCustomToken(uid);
  await writeAudit(cabinetId, { type: "extension_jeton_emis", uid });
  return { token };
});

/** Ferme la session de l'extension (déconnexion depuis le side panel). La session de l'app n'est pas touchée. */
export const fermerExtension = onCall(CALLABLE_OPTIONS, async request => {
  const { uid, cabinetId } = await getActiveMembership(request, { requireSession: false });
  const authTime = tokenAuthTime(request);

  const db = admin.firestore();
  const memberRef = db.doc(memberPath(cabinetId, uid));
  await db.runTransaction(async tx => {
    const current = (await tx.get(memberRef)).get("session") as Session | undefined;
    // Ne ferme que sa propre connexion.
    if (current?.extensionAuthTime === authTime) {
      tx.update(memberRef, {
        "session.extensionAuthTime": FieldValue.delete(),
        "session.extensionOpenedAt": FieldValue.delete(),
      });
    }
  });
  return { success: true };
});
