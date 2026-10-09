import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { writeAudit } from "../core/audit.utils";
import { getActiveMembership, requireString, tokenAuthTime } from "../core/auth.utils";
import { CALLABLE_OPTIONS, EXTENSION_APP_SESSION_MAX_AGE_MS } from "../core/config";
import { cabinetPath, memberPath } from "../core/firestore-paths";
import { FALLBACK_LIMITS, type BoundDevice, type Session } from "../shared/index.js";

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
 * Un compte est lié à UN appareil (ou jusqu'à `limits.maxAppareilsParUtilisateur` selon l'offre) : les premiers
 * avec lesquels il se connecte, jusqu'à ce qu'un admin les réinitialise (`equipe-reinitialiserAppareil`).
 * Le premier reste dans `device`, les suivants dans `extraDevices`.
 * - autre appareil, toutes les places prises : REFUSÉ (et tracé dans le journal d'audit du cabinet), même avec le bon mot de passe ;
 * - appareil lié : accepté. Une nouvelle connexion remplace aussitôt la précédente (autre onglet, autre
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
    const [member, cabinet] = await Promise.all([tx.get(memberRef), tx.get(db.doc(cabinetPath(cabinetId)))]);
    const device = member.get("device") as BoundDevice | undefined;
    const extraDevices = (member.get("extraDevices") as BoundDevice[] | undefined) ?? [];
    const bound = device ? [device, ...extraDevices] : [];
    const maxDevices =
      (cabinet.get("limits.maxAppareilsParUtilisateur") as number | undefined) ?? FALLBACK_LIMITS.maxAppareilsParUtilisateur;
    const isBound = bound.some(entry => entry.id === deviceId);
    if (!isBound && bound.length >= maxDevices) {
      return { refused: true as const, boundLabel: bound.map(entry => entry.label).filter(Boolean).join(", ") || null };
    }
    const newDevice = { id: deviceId, label, boundAt: Timestamp.now() };
    const current = member.get("session") as Session | undefined;
    const isSameLogin = current?.authTime === authTime;
    tx.update(memberRef, {
      // Premier appareil : `device` (forme historique) ; les suivants s'ajoutent à `extraDevices`.
      ...(isBound ? {} : device ? { extraDevices: [...extraDevices, newDevice] } : { device: { ...newDevice, boundAt: FieldValue.serverTimestamp() } }),
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
    return { refused: false as const, newlyBound: !isBound, isNewLogin: !isSameLogin };
  });

  if (outcome.refused) {
    await writeAudit(cabinetId, {
      type: "connexion_refusee_appareil",
      uid,
      data: { appareil: label, appareilLie: outcome.boundLabel },
    });
    throw new HttpsError(
      "permission-denied",
      "Cet appareil n'est pas autorisé : votre compte est lié à un autre appareil" +
        `${outcome.boundLabel ? ` (${outcome.boundLabel})` : ""}. ` +
        "Demandez à l'administrateur de votre cabinet de le réinitialiser.",
      { reason: "device_not_authorized" },
    );
  }
  if (outcome.newlyBound) {
    await writeAudit(cabinetId, { type: "appareil_lie", uid, data: { appareil: label } });
  }
  if (outcome.isNewLogin) {
    await writeAudit(cabinetId, { type: "connexion", uid, data: { appareil: label } });
  }

  return { success: true };
});

/** Ferme la session à la déconnexion. L'appareil reste lié au compte. */
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
 */
export const ouvrirExtension = onCall(CALLABLE_OPTIONS, async request => {
  const { uid, cabinetId } = await getActiveMembership(request, { requireSession: false });
  const authTime = tokenAuthTime(request);

  const db = admin.firestore();
  const memberRef = db.doc(memberPath(cabinetId, uid));

  const isNewLogin = await db.runTransaction(async tx => {
    const current = (await tx.get(memberRef)).get("session") as Session | undefined;
    const lastSeen = current?.lastSeen?.toMillis();
    if (!current || lastSeen === undefined || Date.now() - lastSeen > EXTENSION_APP_SESSION_MAX_AGE_MS) {
      throw new HttpsError(
        "failed-precondition",
        "Ouvrez Courtier Intelligent dans votre navigateur et connectez-vous avant d'utiliser l'extension.",
        { reason: "no_app_session" },
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
