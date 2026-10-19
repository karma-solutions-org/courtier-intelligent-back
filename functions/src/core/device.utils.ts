import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { writeAudit } from "./audit.utils";

/**
 * Champs du membre à écrire pour réinitialiser ses appareils : tous ses appareils liés et sa session sont
 * supprimés, l'ancien appareil perd l'accès immédiatement. Le prochain appareil avec lequel il se connecte
 * devient le sien.
 */
export function deviceResetUpdate() {
  return {
    device: FieldValue.delete(),
    extraDevices: FieldValue.delete(),
    session: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/**
 * Termine une réinitialisation d'appareil une fois le membre mis à jour : révoque les jetons du membre
 * (déconnexion partout) et trace l'opération dans le journal d'audit du cabinet.
 * `by` : uid de l'admin, ou « ops » pour un script d'exploitation.
 */
export async function completeDeviceReset(
  cabinetId: string,
  memberUid: string,
  by: string,
  data: Record<string, unknown>,
): Promise<void> {
  await admin.auth().revokeRefreshTokens(memberUid);
  await writeAudit(cabinetId, { type: "appareil_reinitialise", uid: memberUid, by, data });
}
