import * as admin from "firebase-admin";
import { FieldValue, Timestamp, Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { FALLBACK_LIMITS, GRACE_PERIOD_DAYS } from "../shared/index.js";
import { cabinetPath, invitationsPath } from "./firestore-paths";

export interface SeatUsage {
  maxUtilisateurs: number;
  activeMembers: number;
  pendingInvitations: number;
  /** Fin du délai de grâce si le cabinet dépasse sa limite (baisse d'offre). */
  graceEndsAt: Timestamp | null;
  /** Délai de grâce de l'offre du cabinet, en jours (`limits.delaiGraceJours`). */
  delaiGraceJours: number;
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
    maxUtilisateurs: (cabinet.get("limits.maxUtilisateurs") as number | undefined) ?? FALLBACK_LIMITS.maxUtilisateurs,
    activeMembers: members.size,
    pendingInvitations: invitations.size,
    graceEndsAt: (cabinet.get("graceEndsAt") as Timestamp | undefined) ?? null,
    delaiGraceJours: (cabinet.get("limits.delaiGraceJours") as number | undefined) ?? GRACE_PERIOD_DAYS,
  };
}

/**
 * Champs du cabinet à écrire pour tenir à jour le délai de grâce : ouvert quand les membres actifs
 * dépassent la limite (il n'est jamais prolongé s'il court déjà), fermé dès qu'ils rentrent dans la limite.
 * La durée est celle de l'offre du cabinet (`limits.delaiGraceJours`), GRACE_PERIOD_DAYS à défaut.
 */
export function graceUpdate(
  activeMembers: number,
  maxUtilisateurs: number,
  current: Timestamp | null,
  delaiGraceJours: number = GRACE_PERIOD_DAYS,
): { graceEndsAt: Timestamp | FieldValue } | Record<string, never> {
  if (activeMembers <= maxUtilisateurs) {
    return current ? { graceEndsAt: FieldValue.delete() } : {};
  }
  if (current) {
    return {};
  }
  return { graceEndsAt: Timestamp.fromMillis(Date.now() + delaiGraceJours * 24 * 60 * 60 * 1000) };
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
