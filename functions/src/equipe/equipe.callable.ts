import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertSignedIn, assertCabinetAdmin, requireEmail, requireString, setCabinetClaims } from "../core/auth.utils";
import { CLAIM_CABINET_ID, INVITATION_TTL_DAYS, MAIL_COLLECTION, CALLABLE_OPTIONS, CABINET_ROLES, UserRole } from "../core/config";
import { escapeHtml } from "../core/html.utils";
import { assertSeatAvailable, getSeatUsage, graceUpdate, lockSeats } from "../core/seats.utils";
import { writeAudit } from "../core/audit.utils";
import { completeDeviceReset, deviceResetUpdate } from "../core/device.utils";
import { invitationPath, invitationsPath, memberPath, cabinetPath } from "../core/firestore-paths";
import { FALLBACK_LIMITS, type CabinetRole } from "../shared/index.js";

function requireCabinetRole(value: unknown): CabinetRole {
  if (!CABINET_ROLES.includes(value as CabinetRole)) {
    throw new HttpsError("invalid-argument", "Rôle invalide.");
  }
  return value as CabinetRole;
}

/** Un cabinet doit toujours garder au moins un administrateur actif. */
async function assertNotLastAdmin(cabinetId: string, uid: string): Promise<void> {
  const admins = await admin
    .firestore()
    .collection(`${cabinetPath(cabinetId)}/members`)
    .where("role", "==", "admin")
    .where("status", "==", "active")
    .get();
  if (admins.size <= 1 && admins.docs[0]?.id === uid) {
    throw new HttpsError("failed-precondition", "Le cabinet doit garder au moins un administrateur.");
  }
}

/** L'admin invite un collaborateur : crée l'invitation et envoie le lien par email. */
export const inviter = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await assertCabinetAdmin(request);
  const email = requireEmail(request.data?.email);
  const role = requireCabinetRole(request.data?.role);
  const appUrl = requireString(request.data?.appUrl, "appUrl", 300);

  const db = admin.firestore();
  const invitation = db.collection(invitationsPath(cabinetId)).doc();
  const expiresAt = Timestamp.fromMillis(Date.now() + INVITATION_TTL_DAYS * 24 * 3600 * 1000);

  // Comptage des sièges et création de l'invitation dans la même transaction.
  await db.runTransaction(async tx => {
    const pending = await tx.get(
      db.collection(invitationsPath(cabinetId)).where("email", "==", email).where("status", "==", "pending").limit(1),
    );
    if (!pending.empty) {
      throw new HttpsError("already-exists", "Une invitation est déjà en attente pour cet email.");
    }
    // Une invitation réserve une place : membres actifs + invitations en attente + celle-ci.
    const usage = await getSeatUsage(cabinetId, tx);
    assertSeatAvailable(usage, usage.activeMembers + usage.pendingInvitations + 1);
    lockSeats(tx, cabinetId);
    tx.create(invitation, {
      email,
      role,
      status: "pending",
      invitedBy: uid,
      expiresAt,
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  const cabinet = await db.doc(cabinetPath(cabinetId)).get();
  const cabinetName = escapeHtml(String(cabinet.get("name") ?? ""));
  const link = `${appUrl.replace(/\/$/, "")}/invitation?cabinet=${cabinetId}&invitation=${invitation.id}`;
  await db.collection(MAIL_COLLECTION).add({
    to: email,
    message: {
      subject: `Invitation à rejoindre ${cabinetName} sur Courtier Intelligent`,
      html:
        `<p>Vous êtes invité à rejoindre le cabinet <strong>${cabinetName}</strong> sur Courtier Intelligent.</p>` +
        `<p><a href="${link}">Accepter l'invitation</a></p>` +
        `<p><strong>Important :</strong> connectez-vous ou créez votre compte avec cette adresse email, ` +
        `<strong>${escapeHtml(email)}</strong>. L'invitation ne peut pas être acceptée depuis un autre compte.</p>` +
        `<p>Ce lien expire dans ${INVITATION_TTL_DAYS} jours.</p>`,
    },
  });

  return { invitationId: invitation.id };
});

/** L'invité (connecté avec l'email invité) accepte : il devient membre du cabinet. */
export const accepterInvitation = onCall(CALLABLE_OPTIONS, async request => {
  const uid = assertSignedIn(request);
  if (request.auth?.token[CLAIM_CABINET_ID]) {
    throw new HttpsError("failed-precondition", "Ce compte est déjà rattaché à un cabinet.");
  }
  const cabinetId = requireString(request.data?.cabinetId, "cabinet");
  const invitationId = requireString(request.data?.invitationId, "invitation");
  const user = await admin.auth().getUser(uid);

  const db = admin.firestore();
  const invitationRef = db.doc(invitationPath(cabinetId, invitationId));

  const role = await db.runTransaction(async tx => {
    const invitation = await tx.get(invitationRef);
    const cabinet = await tx.get(db.doc(cabinetPath(cabinetId)));
    // L'invitation occupait déjà une place : il suffit qu'une place de membre actif reste libre.
    const usage = await getSeatUsage(cabinetId, tx);
    assertSeatAvailable(usage, usage.activeMembers + 1);
    lockSeats(tx, cabinetId);
    if (cabinet.get("active") !== true) {
      throw new HttpsError("permission-denied", "Ce cabinet est désactivé.");
    }
    if (!invitation.exists || invitation.get("status") !== "pending") {
      throw new HttpsError("not-found", "Invitation introuvable ou déjà utilisée.");
    }
    if ((invitation.get("expiresAt") as Timestamp).toMillis() < Date.now()) {
      throw new HttpsError("deadline-exceeded", "Cette invitation a expiré.");
    }
    if (invitation.get("email") !== user.email?.toLowerCase()) {
      throw new HttpsError("permission-denied", "Cette invitation a été envoyée à une autre adresse email.", {
        reason: "wrong_email",
      });
    }
    const invitedRole = invitation.get("role") as UserRole;
    tx.set(db.doc(memberPath(cabinetId, uid)), {
      email: user.email,
      displayName: user.displayName ?? null,
      role: invitedRole,
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(invitationRef, { status: "accepted", acceptedBy: uid, acceptedAt: FieldValue.serverTimestamp() });
    return invitedRole;
  });

  await setCabinetClaims(uid, cabinetId, role);
  return { cabinetId, role };
});

/** L'admin change le rôle d'un membre. */
export const changerRole = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId } = await assertCabinetAdmin(request);
  const memberUid = requireString(request.data?.uid, "uid");
  const role = requireCabinetRole(request.data?.role);

  const ref = admin.firestore().doc(memberPath(cabinetId, memberUid));
  const member = await ref.get();
  if (!member.exists) {
    throw new HttpsError("not-found", "Membre introuvable.");
  }
  if (member.get("role") === "admin" && role !== "admin") {
    await assertNotLastAdmin(cabinetId, memberUid);
  }

  await ref.update({ role, updatedAt: FieldValue.serverTimestamp() });
  if (member.get("status") === "active") {
    await setCabinetClaims(memberUid, cabinetId, role);
  }
  return { success: true };
});

/** L'admin désactive ou réactive un membre. Un membre désactivé perd ses accès et ses sessions. */
export const activerMembre = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId } = await assertCabinetAdmin(request);
  const memberUid = requireString(request.data?.uid, "uid");
  const status = request.data?.status;
  if (status !== "active" && status !== "disabled") {
    throw new HttpsError("invalid-argument", "Statut invalide.");
  }

  const db = admin.firestore();
  const ref = db.doc(memberPath(cabinetId, memberUid));
  const member = await ref.get();
  if (!member.exists) {
    throw new HttpsError("not-found", "Membre introuvable.");
  }
  if (status === "disabled" && member.get("role") === "admin") {
    await assertNotLastAdmin(cabinetId, memberUid);
  }

  await db.runTransaction(async tx => {
    // Réactivation : il faut une place libre, comptée dans la même transaction que l'écriture.
    if (status === "active" && member.get("status") !== "active") {
      const usage = await getSeatUsage(cabinetId, tx);
      assertSeatAvailable(usage, usage.activeMembers + usage.pendingInvitations + 1);
      lockSeats(tx, cabinetId);
    }
    // Désactivation : la place libérée peut ramener un cabinet en dépassement dans sa limite.
    if (status === "disabled" && member.get("status") === "active") {
      const usage = await getSeatUsage(cabinetId, tx);
      const grace = graceUpdate(usage.activeMembers - 1, usage.maxUtilisateurs, usage.graceEndsAt, usage.delaiGraceJours);
      // Rien à écrire quand le cabinet n'était pas en dépassement : Firestore refuse une mise à jour vide.
      if (Object.keys(grace).length > 0) {
        tx.update(db.doc(cabinetPath(cabinetId)), grace);
      }
    }
    tx.update(ref, {
      status,
      updatedAt: FieldValue.serverTimestamp(),
      // Désactivation : la session de son appareil est supprimée, il perd l'accès immédiatement.
      ...(status === "disabled" ? { session: FieldValue.delete() } : {}),
    });
  });
  if (status === "disabled") {
    await setCabinetClaims(memberUid, null, null);
    await admin.auth().revokeRefreshTokens(memberUid);
  } else {
    await setCabinetClaims(memberUid, cabinetId, member.get("role") as UserRole);
  }
  return { success: true };
});

/** L'admin annule une invitation en attente : la place réservée est libérée. */
export const annulerInvitation = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId } = await assertCabinetAdmin(request);
  const invitationId = requireString(request.data?.invitationId, "invitation");
  const ref = admin.firestore().doc(invitationPath(cabinetId, invitationId));
  const invitation = await ref.get();
  if (!invitation.exists || invitation.get("status") !== "pending") {
    throw new HttpsError("not-found", "Invitation introuvable ou déjà utilisée.");
  }
  await ref.update({ status: "cancelled", cancelledAt: FieldValue.serverTimestamp() });
  return { success: true };
});

/** Mois en cours (« AAAA-MM », UTC) : période du quota de réinitialisations. */
const currentMonth = () => new Date().toISOString().substring(0, 7);

/**
 * L'admin réinitialise l'appareil lié d'un membre (poste perdu ou changé) : le prochain appareil
 * avec lequel il se connecte devient le sien. Limité par mois selon l'offre du cabinet.
 */
export const reinitialiserAppareil = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid: adminUid } = await assertCabinetAdmin(request);
  const memberUid = requireString(request.data?.uid, "uid");
  // Un admin ne libère pas son propre appareil : un autre admin le fait, ou le support (ops/reset-device).
  if (memberUid === adminUid) {
    throw new HttpsError(
      "permission-denied",
      "Vous ne pouvez pas réinitialiser votre propre appareil. Demandez-le à un autre administrateur du cabinet ou au support.",
      { reason: "self_reset" },
    );
  }
  const month = currentMonth();

  const db = admin.firestore();
  const cabinetRef = db.doc(cabinetPath(cabinetId));
  const memberRef = db.doc(memberPath(cabinetId, memberUid));

  const result = await db.runTransaction(async tx => {
    const [cabinet, member] = await Promise.all([tx.get(cabinetRef), tx.get(memberRef)]);
    if (!member.exists) {
      throw new HttpsError("not-found", "Membre introuvable.");
    }
    if (!member.get("device")) {
      throw new HttpsError("failed-precondition", "Aucun appareil n'est lié à ce membre.");
    }
    const quota =
      (cabinet.get("limits.resetsAppareilParMois") as number | undefined) ?? FALLBACK_LIMITS.resetsAppareilParMois;
    const used = cabinet.get("deviceResets.month") === month ? (cabinet.get("deviceResets.count") as number) : 0;
    if (used >= quota) {
      return { refused: true as const, quota };
    }
    tx.update(cabinetRef, { deviceResets: { month, count: used + 1 } });
    // L'appareil et la session sont supprimés : l'ancien appareil perd l'accès immédiatement.
    tx.update(memberRef, deviceResetUpdate());
    return { refused: false as const, remaining: quota - used - 1 };
  });

  if (result.refused) {
    await writeAudit(cabinetId, {
      type: "reinitialisation_refusee_quota",
      uid: memberUid,
      by: adminUid,
      data: { quota: result.quota, month },
    });
    throw new HttpsError(
      "resource-exhausted",
      `Quota atteint : ${result.quota} réinitialisation(s) d'appareil par mois pour votre offre. ` +
        "Réessayez le mois prochain ou changez d'offre.",
      { reason: "device_reset_quota" },
    );
  }
  await completeDeviceReset(cabinetId, memberUid, adminUid, { month });
  return { success: true, remaining: result.remaining };
});
