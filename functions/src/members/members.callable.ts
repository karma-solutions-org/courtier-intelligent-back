import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertSignedIn, assertTenantAdmin, requireEmail, requireString, setTenantClaims } from "../core/auth.utils";
import { CLAIM_TENANT_ID, INVITATION_TTL_DAYS, MAIL_COLLECTION, REGION_ID, TENANT_ROLES, UserRole } from "../core/config";
import { escapeHtml } from "../core/html.utils";
import { invitationPath, invitationsPath, memberPath, tenantPath } from "../core/firestore-paths";
import type { TenantRole } from "../shared/index.js";

function requireTenantRole(value: unknown): TenantRole {
  if (!TENANT_ROLES.includes(value as TenantRole)) {
    throw new HttpsError("invalid-argument", "Rôle invalide.");
  }
  return value as TenantRole;
}

/** Un cabinet doit toujours garder au moins un administrateur actif. */
async function assertNotLastAdmin(tenantId: string, uid: string): Promise<void> {
  const admins = await admin
    .firestore()
    .collection(`${tenantPath(tenantId)}/members`)
    .where("role", "==", "admin")
    .where("status", "==", "active")
    .get();
  if (admins.size <= 1 && admins.docs[0]?.id === uid) {
    throw new HttpsError("failed-precondition", "Le cabinet doit garder au moins un administrateur.");
  }
}

/** L'admin invite un collaborateur : crée l'invitation et envoie le lien par email. */
export const inviteMember = onCall({ region: REGION_ID }, async request => {
  const { tenantId, uid } = await assertTenantAdmin(request);
  const email = requireEmail(request.data?.email);
  const role = requireTenantRole(request.data?.role);
  const appUrl = requireString(request.data?.appUrl, "appUrl", 300);

  const db = admin.firestore();
  const pending = await db
    .collection(invitationsPath(tenantId))
    .where("email", "==", email)
    .where("status", "==", "pending")
    .limit(1)
    .get();
  if (!pending.empty) {
    throw new HttpsError("already-exists", "Une invitation est déjà en attente pour cet email.");
  }

  const expiresAt = Timestamp.fromMillis(Date.now() + INVITATION_TTL_DAYS * 24 * 3600 * 1000);
  const invitation = await db.collection(invitationsPath(tenantId)).add({
    email,
    role,
    status: "pending",
    invitedBy: uid,
    expiresAt,
    createdAt: FieldValue.serverTimestamp(),
  });

  const tenant = await db.doc(tenantPath(tenantId)).get();
  const tenantName = escapeHtml(String(tenant.get("name") ?? ""));
  const link = `${appUrl.replace(/\/$/, "")}/invitation?cabinet=${tenantId}&invitation=${invitation.id}`;
  await db.collection(MAIL_COLLECTION).add({
    to: email,
    message: {
      subject: `Invitation à rejoindre ${tenantName} sur Courtier Intelligent`,
      html:
        `<p>Vous êtes invité à rejoindre le cabinet <strong>${tenantName}</strong> sur Courtier Intelligent.</p>` +
        `<p><a href="${link}">Accepter l'invitation</a></p>` +
        `<p>Ce lien expire dans ${INVITATION_TTL_DAYS} jours.</p>`,
    },
  });

  return { invitationId: invitation.id };
});

/** L'invité (connecté avec l'email invité) accepte : il devient membre du cabinet. */
export const acceptInvitation = onCall({ region: REGION_ID }, async request => {
  const uid = assertSignedIn(request);
  if (request.auth?.token[CLAIM_TENANT_ID]) {
    throw new HttpsError("failed-precondition", "Ce compte est déjà rattaché à un cabinet.");
  }
  const tenantId = requireString(request.data?.tenantId, "cabinet");
  const invitationId = requireString(request.data?.invitationId, "invitation");
  const user = await admin.auth().getUser(uid);

  const db = admin.firestore();
  const invitationRef = db.doc(invitationPath(tenantId, invitationId));

  const role = await db.runTransaction(async tx => {
    const invitation = await tx.get(invitationRef);
    const tenant = await tx.get(db.doc(tenantPath(tenantId)));
    if (tenant.get("active") !== true) {
      throw new HttpsError("permission-denied", "Ce cabinet est désactivé.");
    }
    if (!invitation.exists || invitation.get("status") !== "pending") {
      throw new HttpsError("not-found", "Invitation introuvable ou déjà utilisée.");
    }
    if ((invitation.get("expiresAt") as Timestamp).toMillis() < Date.now()) {
      throw new HttpsError("deadline-exceeded", "Cette invitation a expiré.");
    }
    if (invitation.get("email") !== user.email?.toLowerCase()) {
      throw new HttpsError("permission-denied", "Cette invitation a été envoyée à une autre adresse email.");
    }
    const invitedRole = invitation.get("role") as UserRole;
    tx.set(db.doc(memberPath(tenantId, uid)), {
      email: user.email,
      displayName: user.displayName ?? null,
      role: invitedRole,
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(invitationRef, { status: "accepted", acceptedBy: uid, acceptedAt: FieldValue.serverTimestamp() });
    return invitedRole;
  });

  await setTenantClaims(uid, tenantId, role);
  return { tenantId, role };
});

/** L'admin change le rôle d'un membre. */
export const setMemberRole = onCall({ region: REGION_ID }, async request => {
  const { tenantId } = await assertTenantAdmin(request);
  const memberUid = requireString(request.data?.uid, "uid");
  const role = requireTenantRole(request.data?.role);

  const ref = admin.firestore().doc(memberPath(tenantId, memberUid));
  const member = await ref.get();
  if (!member.exists) {
    throw new HttpsError("not-found", "Membre introuvable.");
  }
  if (member.get("role") === "admin" && role !== "admin") {
    await assertNotLastAdmin(tenantId, memberUid);
  }

  await ref.update({ role, updatedAt: FieldValue.serverTimestamp() });
  if (member.get("status") === "active") {
    await setTenantClaims(memberUid, tenantId, role);
  }
  return { success: true };
});

/** L'admin désactive ou réactive un membre. Un membre désactivé perd ses accès et ses sessions. */
export const setMemberStatus = onCall({ region: REGION_ID }, async request => {
  const { tenantId } = await assertTenantAdmin(request);
  const memberUid = requireString(request.data?.uid, "uid");
  const status = request.data?.status;
  if (status !== "active" && status !== "disabled") {
    throw new HttpsError("invalid-argument", "Statut invalide.");
  }

  const ref = admin.firestore().doc(memberPath(tenantId, memberUid));
  const member = await ref.get();
  if (!member.exists) {
    throw new HttpsError("not-found", "Membre introuvable.");
  }
  if (status === "disabled" && member.get("role") === "admin") {
    await assertNotLastAdmin(tenantId, memberUid);
  }

  await ref.update({ status, updatedAt: FieldValue.serverTimestamp() });
  if (status === "disabled") {
    await setTenantClaims(memberUid, null, null);
    await admin.auth().revokeRefreshTokens(memberUid);
  } else {
    await setTenantClaims(memberUid, tenantId, member.get("role") as UserRole);
  }
  return { success: true };
});
