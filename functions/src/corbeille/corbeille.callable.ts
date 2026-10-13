import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertCabinetAdmin, requireString } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";
import { assurePath, dossierPath, dossiersPath } from "../core/firestore-paths";
import { assureDocumentsFolder } from "../shared/index.js";

/**
 * Corbeille : un client ou un dossier supprimé n'est pas effacé, il est marqué (`deletedAt`, `deletedBy`) et disparaît
 * des listes de l'app. Il peut être restauré, ou supprimé définitivement (fiche, sous-collections et fichiers).
 * Réservé aux admins du cabinet. Les dossiers d'un client supprimé partent avec lui (`deletedWith`) et reviennent avec lui.
 */

type Kind = "assure" | "dossier";

function requireKind(value: unknown): Kind {
  if (value !== "assure" && value !== "dossier") {
    throw new HttpsError("invalid-argument", "Élément invalide.");
  }
  return value;
}

function refOf(cabinetId: string, kind: Kind, id: string) {
  return admin.firestore().doc(kind === "assure" ? assurePath(cabinetId, id) : dossierPath(cabinetId, id));
}

async function existing(ref: admin.firestore.DocumentReference) {
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Élément introuvable.");
  }
  return snapshot;
}

/** Dossiers rattachés au client (tous, y compris ceux déjà dans la corbeille). */
function dossiersOf(cabinetId: string, assureId: string) {
  return admin.firestore().collection(dossiersPath(cabinetId)).where("assureId", "==", assureId).get();
}

/** Met un client (et ses dossiers encore actifs) ou un dossier dans la corbeille. */
export const supprimer = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId, uid } = await assertCabinetAdmin(request);
  const kind = requireKind(request.data?.kind);
  const id = requireString(request.data?.id, "élément");
  const ref = refOf(cabinetId, kind, id);
  const snapshot = await existing(ref);
  if (snapshot.get("deletedAt")) {
    return { ok: true };
  }

  const batch = admin.firestore().batch();
  const mark = { deletedAt: FieldValue.serverTimestamp(), deletedBy: uid };
  batch.update(ref, mark);
  if (kind === "assure") {
    const dossiers = await dossiersOf(cabinetId, id);
    for (const dossier of dossiers.docs) {
      if (!dossier.get("deletedAt")) {
        batch.update(dossier.ref, { ...mark, deletedWith: id });
      }
    }
  }
  await batch.commit();
  return { ok: true };
});

/** Sort un élément de la corbeille. Un dossier dont le client est encore dans la corbeille ne peut pas revenir seul. */
export const restaurer = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId } = await assertCabinetAdmin(request);
  const kind = requireKind(request.data?.kind);
  const id = requireString(request.data?.id, "élément");
  const ref = refOf(cabinetId, kind, id);
  const snapshot = await existing(ref);
  const unmark = { deletedAt: FieldValue.delete(), deletedBy: FieldValue.delete(), deletedWith: FieldValue.delete() };

  if (kind === "dossier") {
    const assure = await admin.firestore().doc(assurePath(cabinetId, snapshot.get("assureId"))).get();
    if (assure.get("deletedAt")) {
      throw new HttpsError("failed-precondition", "Le client de ce dossier est dans la corbeille : restaurez d'abord le client.", {
        reason: "assure_deleted",
      });
    }
    await ref.update(unmark);
    return { ok: true };
  }

  const batch = admin.firestore().batch();
  batch.update(ref, unmark);
  // Les dossiers partis avec le client reviennent avec lui (pas ceux supprimés un par un avant).
  const dossiers = await dossiersOf(cabinetId, id);
  for (const dossier of dossiers.docs) {
    if (dossier.get("deletedWith") === id) {
      batch.update(dossier.ref, unmark);
    }
  }
  await batch.commit();
  return { ok: true };
});

/** Suppression définitive d'un élément de la corbeille : fiche, sous-collections et fichiers. Irréversible. */
export const supprimerDefinitivement = onCall({ ...CALLABLE_OPTIONS, timeoutSeconds: 300 }, async request => {
  const { cabinetId } = await assertCabinetAdmin(request);
  const kind = requireKind(request.data?.kind);
  const id = requireString(request.data?.id, "élément");
  const ref = refOf(cabinetId, kind, id);
  const snapshot = await existing(ref);
  if (!snapshot.get("deletedAt")) {
    throw new HttpsError("failed-precondition", "Seul un élément de la corbeille peut être supprimé définitivement.");
  }

  const db = admin.firestore();
  const bucket = admin.storage().bucket();
  const removeDossier = async (dossierId: string) => {
    await bucket.deleteFiles({ prefix: `${dossierPath(cabinetId, dossierId)}/` });
    await db.recursiveDelete(db.doc(dossierPath(cabinetId, dossierId)));
  };

  if (kind === "dossier") {
    await removeDossier(id);
    return { ok: true };
  }
  // Un client part avec tous ses dossiers : aucun dossier ne doit rester sans client.
  const dossiers = await dossiersOf(cabinetId, id);
  for (const dossier of dossiers.docs) {
    await removeDossier(dossier.id);
  }
  await bucket.deleteFiles({ prefix: `${assureDocumentsFolder(cabinetId, id)}/` });
  await db.recursiveDelete(ref);
  return { ok: true };
});
