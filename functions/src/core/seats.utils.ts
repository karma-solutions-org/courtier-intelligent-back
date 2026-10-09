import * as admin from "firebase-admin";
import { FieldValue, Timestamp, Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { DEFAULT_MAX_UTILISATEURS } from "./config";
import { cabinetPath, invitationsPath } from "./firestore-paths";

export interface SeatUsage {
  maxUtilisateurs: number;
  activeMembers: number;
  pendingInvitations: number;
}

/**
 * Places utilisées d'un cabinet : membres actifs + invitations encore valables
 * (une invitation en attente réserve une place, sinon on pourrait inviter au-delà de la limite).
 */
export async function getSeatUsage(cabinetId: string, tx?: Transaction): Promise<SeatUsage> {
  const db = admin.firestore();
  const cabinetRef = db.doc(cabinetPath(cabinetId));
  const activeMembersQuery = cabinetRef.collection("members").where("status", "==", "active");
  const pendingInvitationsQuery = db
    .collection(invitationsPath(cabinetId))
    .where("status", "==", "pending")
    .where("expiresAt", ">", Timestamp.now());

  const [cabinet, members, invitations] = tx
    ? await Promise.all([tx.get(cabinetRef), tx.get(activeMembersQuery), tx.get(pendingInvitationsQuery)])
    : await Promise.all([cabinetRef.get(), activeMembersQuery.get(), pendingInvitationsQuery.get()]);

  return {
    maxUtilisateurs: (cabinet.get("maxUtilisateurs") as number | undefined) ?? DEFAULT_MAX_UTILISATEURS,
    activeMembers: members.size,
    pendingInvitations: invitations.size,
  };
}

/**
 * Sérialise les opérations sur les sièges d'un cabinet : chaque transaction qui compte les sièges
 * écrit aussi le document du cabinet. Deux invitations envoyées au même instant ne peuvent donc pas
 * compter toutes les deux la même place libre : la seconde est rejouée et voit la première.
 */
export function lockSeats(tx: Transaction, cabinetId: string): void {
  tx.update(admin.firestore().doc(cabinetPath(cabinetId)), { seatsCheckedAt: FieldValue.serverTimestamp() });
}

/** Refuse l'action si elle ferait dépasser la limite d'utilisateurs du cabinet. */
export function assertSeatAvailable(usage: SeatUsage, seatsNeeded: number): void {
  if (seatsNeeded > usage.maxUtilisateurs) {
    throw new HttpsError(
      "resource-exhausted",
      `Votre cabinet est limité à ${usage.maxUtilisateurs} utilisateurs. ` +
        "Libérez une place (désactivez un membre ou annulez une invitation) ou passez à une offre supérieure.",
    );
  }
}
