import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getActiveMembership } from "../core/auth.utils";
import { CALLABLE_OPTIONS } from "../core/config";

const invalid = (message: string) => new HttpsError("invalid-argument", message);

/** Texte facultatif : null si vide, refusé s'il dépasse [max] ou ne respecte pas [pattern]. */
function optText(value: unknown, label: string, max: number, pattern?: RegExp): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid(`${label} invalide.`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max || (pattern && !pattern.test(trimmed))) throw invalid(`${label} invalide.`);
  return trimmed;
}

/** Mêmes contrôles que les règles Firestore (`assureAssureValid`) : la function est désormais le seul chemin de création. */
function validAssure(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("Fiche client invalide.");
  const d = raw as Record<string, unknown>;
  const type = d.type;
  if (type !== "particulier" && type !== "pro") throw invalid("Type de client invalide.");
  const isPro = type === "pro";
  const firstName = optText(d.firstName, "Prénom", 100) ?? "";
  const lastName = optText(d.lastName, "Nom", 100) ?? "";
  const companyName = isPro ? optText(d.companyName, "Raison sociale", 200) : null;
  if (!firstName && !lastName && !companyName) throw invalid("Renseignez au moins un nom ou une raison sociale.");
  const civilite = isPro ? null : optText(d.civilite, "Civilité", 3);
  if (civilite !== null && civilite !== "M." && civilite !== "Mme") throw invalid("Civilité invalide.");
  const rawSiret = typeof d.siret === "string" ? d.siret.replace(/\s/g, "") : d.siret;
  const siret = isPro ? optText(rawSiret, "SIRET", 14, /^[0-9]{14}$/) : null;
  const birthDate = isPro ? null : optText(d.birthDate, "Date de naissance", 10, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  const email = optText(d.email, "Email", 254, /^[^ @]+@[^ @]+[.][^ @]{2,}$/)?.toLowerCase() ?? null;
  const phone = optText(d.phone, "Téléphone", 30);
  const a = d.address && typeof d.address === "object" && !Array.isArray(d.address) ? (d.address as Record<string, unknown>) : {};
  const address = {
    street: optText(a.street, "Adresse", 200),
    postalCode: optText(a.postalCode, "Code postal", 5, /^[0-9]{5}$/),
    city: optText(a.city, "Ville", 100),
    country: optText(a.country, "Pays", 2) ?? "FR",
  };
  return { type, civilite, firstName, lastName, companyName, siret, birthDate, email, phone, address };
}

/**
 * Crée un client. Doublon « fort » BLOQUANT : même SIRET ou même email qu'un client du cabinet hors corbeille
 * (`already-exists`, raison `duplicate_assure`). La recherche et la création sont dans la même transaction :
 * deux créations simultanées du même client ne passent pas toutes les deux.
 * Le doublon « faible » (nom + date de naissance, raison sociale) reste un simple avertissement (`assures-verifierDoublon`).
 * Données : fiche du client (voir `validAssure`) → { id }.
 */
export const creer = onCall(CALLABLE_OPTIONS, async request => {
  const { uid, cabinetId } = await getActiveMembership(request);
  const data = validAssure(request.data);

  const db = admin.firestore();
  const assures = db.collection(`ci_cabinets/${cabinetId}/ci_assures`);
  const ref = assures.doc();

  await db.runTransaction(async tx => {
    await assertNoDuplicate(tx, assures, data, null);
    tx.create(ref, { ...data, createdBy: uid, createdAt: FieldValue.serverTimestamp() });
  });

  return { id: ref.id };
});

/**
 * Doublon « fort » : même SIRET ou même email qu'un autre client du cabinet hors corbeille ([selfId] exclu).
 * Lu dans la transaction [tx] : deux écritures simultanées du même client ne passent pas toutes les deux.
 */
async function assertNoDuplicate(
  tx: FirebaseFirestore.Transaction,
  assures: FirebaseFirestore.CollectionReference,
  data: { siret: string | null; email: string | null },
  selfId: string | null,
): Promise<void> {
  const [bySiret, byEmail] = await Promise.all([
    data.siret ? tx.get(assures.where("siret", "==", data.siret).limit(20)) : null,
    data.email ? tx.get(assures.where("email", "==", data.email).limit(20)) : null,
  ]);
  const duplicate = [...(bySiret?.docs ?? []), ...(byEmail?.docs ?? [])].find(doc => doc.id !== selfId && !doc.get("deletedAt"));
  if (!duplicate) return;
  const sameSiret = !!data.siret && duplicate.get("siret") === data.siret;
  const action = selfId ? "Ouvrez sa fiche plutôt que de modifier celle-ci." : "Ouvrez sa fiche plutôt que d'en créer un nouveau.";
  throw new HttpsError(
    "already-exists",
    `Un client avec ${sameSiret ? "ce SIRET" : "cet email"} existe déjà dans le cabinet. ${action}`,
    { reason: "duplicate_assure", duplicateId: duplicate.id, field: sameSiret ? "siret" : "email" },
  );
}

/**
 * Modifie la fiche d'un client : mêmes contrôles que la création, et même doublon BLOQUANT (SIRET / email d'un autre
 * client hors corbeille), vérifié en transaction. Seul chemin pour changer le SIRET ou l'email (les règles le refusent).
 * Données : { id, fiche } → { id }.
 */
export const modifier = onCall(CALLABLE_OPTIONS, async request => {
  const { cabinetId } = await getActiveMembership(request);
  const raw = (request.data ?? {}) as Record<string, unknown>;
  const id = raw.id;
  if (typeof id !== "string" || !id || id.includes("/")) throw invalid("Client invalide.");
  const data = validAssure(raw.fiche);

  const db = admin.firestore();
  const assures = db.collection(`ci_cabinets/${cabinetId}/ci_assures`);
  const ref = assures.doc(id);

  await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists) throw new HttpsError("not-found", "Client introuvable.");
    if (current.get("deletedAt")) throw new HttpsError("failed-precondition", "Ce client est dans la corbeille.");
    await assertNoDuplicate(tx, assures, data, id);
    tx.update(ref, { ...data, updatedAt: FieldValue.serverTimestamp() });
  });

  return { id };
});
