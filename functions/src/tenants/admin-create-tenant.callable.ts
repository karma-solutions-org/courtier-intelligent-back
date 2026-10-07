import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertSuperAdmin, requireEmail, requireString, setTenantClaims } from "../core/auth.utils";
import { CLAIM_TENANT_ID, MAIL_COLLECTION, CALLABLE_OPTIONS } from "../core/config";
import { escapeHtml } from "../core/html.utils";
import { memberPath, tenantPath } from "../core/firestore-paths";

/**
 * Le super-admin crée un cabinet et son administrateur.
 * Si aucun compte n'existe pour l'email, il est créé sans mot de passe et l'admin
 * reçoit un lien pour choisir le sien. Un compte déjà rattaché à un cabinet est refusé.
 */
export const adminCreateTenant = onCall(CALLABLE_OPTIONS, async request => {
  const callerUid = assertSuperAdmin(request);
  const name = requireString(request.data?.name, "nom du cabinet", 120);
  const orias = typeof request.data?.orias === "string" ? request.data.orias.trim().substring(0, 20) : null;
  const adminEmail = requireEmail(request.data?.adminEmail);
  const adminName = requireString(request.data?.adminName, "nom de l'administrateur", 120);
  const appUrl = requireString(request.data?.appUrl, "appUrl", 300).replace(/\/$/, "");

  // Compte de l'administrateur : existant ou créé.
  let adminUser: admin.auth.UserRecord;
  let isNewAccount = false;
  try {
    adminUser = await admin.auth().getUserByEmail(adminEmail);
    if (adminUser.customClaims?.[CLAIM_TENANT_ID]) {
      throw new HttpsError("already-exists", "Ce compte est déjà rattaché à un cabinet.");
    }
  } catch (error) {
    if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
    adminUser = await admin.auth().createUser({ email: adminEmail, displayName: adminName });
    isNewAccount = true;
  }

  const db = admin.firestore();
  const tenantRef = db.collection("tenants").doc();
  const tenantId = tenantRef.id;

  await db.runTransaction(async tx => {
    tx.set(db.doc(tenantPath(tenantId)), {
      name,
      orias,
      active: true,
      ownerUid: adminUser.uid,
      createdBy: callerUid,
      enabledInsurers: [],
      enabledProducts: [],
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.doc(memberPath(tenantId, adminUser.uid)), {
      email: adminEmail,
      displayName: adminUser.displayName ?? adminName,
      role: "admin",
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  await setTenantClaims(adminUser.uid, tenantId, "admin");

  // Email d'accueil : lien pour choisir son mot de passe si le compte vient d'être créé.
  const link = isNewAccount
    ? await admin.auth().generatePasswordResetLink(adminEmail, { url: `${appUrl}/connexion` })
    : `${appUrl}/connexion`;
  await db.collection(MAIL_COLLECTION).add({
    to: adminEmail,
    message: {
      subject: `Votre cabinet ${escapeHtml(name)} est ouvert sur Courtier Intelligent`,
      html:
        `<p>Bonjour ${escapeHtml(adminName)},</p>` +
        `<p>Le cabinet <strong>${escapeHtml(name)}</strong> a été créé sur Courtier Intelligent. Vous en êtes l'administrateur.</p>` +
        `<p><a href="${link}">${isNewAccount ? "Choisir mon mot de passe" : "Me connecter"}</a></p>`,
    },
  });

  return { tenantId, adminUid: adminUser.uid, isNewAccount };
});
