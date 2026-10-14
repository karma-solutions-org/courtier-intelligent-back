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

/** Écrit des mises à jour par lots (un lot Firestore est limité à 500 écritures). */
async function updateInChunks(updates: { ref: admin.firestore.DocumentReference; data: admin.firestore.UpdateData<admin.firestore.DocumentData> }[]) {
  for (let i = 0; i < updates.length; i += 400) {
    const batch = admin.firestore().batch();
    for (const { ref, data } of updates.slice(i, i + 400)) batch.update(ref, data);
    await batch.commit();
  }
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

  const mark = { deletedAt: FieldValue.serverTimestamp(), deletedBy: uid };
  const updates: Parameters<typeof updateInChunks>[0] = [];
  if (kind === "assure") {
    const dossiers = await dossiersOf(cabinetId, id);
    for (const dossier of dossiers.docs) {
      if (!dossier.get("deletedAt")) {
        updates.push({ ref: dossier.ref, data: { ...mark, deletedWith: id } });
      }
    }
  }
  // Le client en dernier : s'il est marqué, tous ses dossiers le sont déjà.
  updates.push({ ref, data: mark });
  await updateInChunks(updates);
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

  // Les dossiers partis avec le client reviennent avec lui (pas ceux supprimés un par un avant).
  const dossiers = await dossiersOf(cabinetId, id);
  const updates: Parameters<typeof updateInChunks>[0] = [{ ref, data: unmark }];
  for (const dossier of dossiers.docs) {
    if (dossier.get("deletedWith") === id) {
      updates.push({ ref: dossier.ref, data: unmark });
    }
  }
  await updateInChunks(updates);
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
    // Fichiers Storage du dossier (documents, devis) : Storage garde ses chemins « cabinets/… », sans préfixe ci_.
    await bucket.deleteFiles({ prefix: `cabinets/${cabinetId}/dossiers/${dossierId}/` });
    await db.recursiveDelete(db.doc(dossierPath(cabinetId, dossierId)));
  };

  if (kind === "dossier") {
    await removeDossier(id);
    return { ok: true };
  }
  // Un client part avec tous ses dossiers : aucun dossier ne doit rester sans client. Un dossier encore actif
  // (hors corbeille) bloque la suppression : il ne doit jamais disparaître sans être passé par la corbeille.
  const dossiers = await dossiersOf(cabinetId, id);
  if (dossiers.docs.some(dossier => !dossier.get("deletedAt"))) {
    throw new HttpsError("failed-precondition", "Ce client a un dossier actif : mettez-le d'abord dans la corbeille.", {
      reason: "assure_has_active_dossiers",
    });
  }
  for (const dossier of dossiers.docs) {
    await removeDossier(dossier.id);
  }
  await bucket.deleteFiles({ prefix: `${assureDocumentsFolder(cabinetId, id)}/` });
  await db.recursiveDelete(ref);
  return { ok: true };
});
