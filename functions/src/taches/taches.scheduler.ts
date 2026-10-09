import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { APP_URL, MAIL_COLLECTION, REGION_ID } from "../core/config";
import { addEvent } from "../core/dossier.utils";
import { assurePath, cabinetPath, memberPath } from "../core/firestore-paths";
import { getSeatUsage, graceUpdate } from "../core/seats.utils";
import { PROPOSAL_REMINDER_DAYS } from "../shared/index.js";
import { assureDisplayName, buildReminderEmail, dossierLink, needsReminder } from "../propositions/proposition.utils";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Auteur des événements écrits par les tâches planifiées. */
const SYSTEM_UID = "system";

/**
 * Le projet Firebase est partagé avec d'autres apps : une requête collectionGroup peut renvoyer des collections
 * homonymes hors de `cabinets/{id}/…`. On ne garde que les nôtres et on renvoie l'identifiant du cabinet.
 */
function cabinetIdOf(ref: FirebaseFirestore.DocumentReference): string | null {
  const cabinet = ref.parent.parent;
  return cabinet && cabinet.parent.id === "cabinets" && !cabinet.parent.parent ? cabinet.id : null;
}

/** (a) Relance du courtier en charge pour les propositions sans réponse depuis `PROPOSAL_REMINDER_DAYS` jours. */
export async function sendProposalReminders(now: Date): Promise<number> {
  const db = admin.firestore();
  const nowMs = now.getTime();
  const threshold = Timestamp.fromMillis(nowMs - PROPOSAL_REMINDER_DAYS * DAY_MS);
  const candidates = await db
    .collectionGroup("dossiers")
    .where("status", "==", "proposition_envoyee")
    .where("proposal.sentAt", "<=", threshold)
    .get();

  let sent = 0;
  for (const doc of candidates.docs) {
    const cabinetId = cabinetIdOf(doc.ref);
    if (!cabinetId) continue;
    try {
      const reminded = await db.runTransaction(async tx => {
        const dossier = await tx.get(doc.ref);
        const proposal = dossier.get("proposal") as { sentAt?: Timestamp; sentTo?: string; lastReminderAt?: Timestamp | null } | null;
        const candidate = {
          status: dossier.get("status") as string,
          sentAtMs: proposal?.sentAt?.toMillis() ?? null,
          lastReminderAtMs: proposal?.lastReminderAt?.toMillis() ?? null,
        };
        if (!needsReminder(candidate, nowMs)) return false;
        const assignedTo = dossier.get("assignedTo") as string;
        const [member, cabinet, assure] = await Promise.all([
          tx.get(db.doc(memberPath(cabinetId, assignedTo))),
          tx.get(db.doc(cabinetPath(cabinetId))),
          tx.get(db.doc(assurePath(cabinetId, dossier.get("assureId")))),
        ]);
        const to = member.get("email") as string | null;
        if (!to || cabinet.get("active") !== true) return false;
        tx.create(db.collection(MAIL_COLLECTION).doc(), {
          to,
          message: buildReminderEmail({
            cabinetName: cabinet.get("name") ?? "",
            reference: dossier.get("reference") ?? null,
            assureName: assureDisplayName(assure.data() as never),
            sentTo: proposal?.sentTo ?? "",
            daysSinceSent: Math.floor((nowMs - candidate.sentAtMs!) / DAY_MS),
            link: dossierLink(APP_URL.value(), doc.id),
          }),
        });
        tx.update(doc.ref, {
          "proposal.reminders": FieldValue.increment(1),
          "proposal.lastReminderAt": Timestamp.fromMillis(nowMs),
        });
        addEvent(tx, cabinetId, doc.id, SYSTEM_UID, "proposal_reminder", { to: assignedTo });
        return true;
      });
      if (reminded) sent++;
    } catch (error) {
      logger.error("Relance de proposition impossible", { cabinetId, dossierId: doc.id, error: String(error) });
    }
  }
  return sent;
}

/**
 * (b) Invitations en attente dont la date d'expiration est passée : statut « expired ».
 * Le décompte des places (`getSeatUsage`) ignore déjà les invitations expirées par leur date : le statut ne change rien
 * au calcul, il rend seulement l'état lisible dans l'écran Équipe.
 */
export async function expireInvitations(now: Date): Promise<number> {
  const db = admin.firestore();
  const expired = await db
    .collectionGroup("invitations")
    .where("status", "==", "pending")
    .where("expiresAt", "<", Timestamp.fromDate(now))
    .get();
  const docs = expired.docs.filter(doc => cabinetIdOf(doc.ref));
  const writer = db.bulkWriter();
  for (const doc of docs) {
    writer.update(doc.ref, { status: "expired", expiredAt: FieldValue.serverTimestamp() });
  }
  await writer.close();
  return docs.length;
}

/** (c) Délai de grâce des cabinets au-delà de leur limite d'utilisateurs : ouvert ou fermé par les helpers existants. */
export async function refreshGracePeriods(): Promise<number> {
  const db = admin.firestore();
  const cabinets = await db.collection("cabinets").where("active", "==", true).get();
  let updated = 0;
  for (const cabinet of cabinets.docs) {
    try {
      const usage = await getSeatUsage(cabinet.id);
      const update = graceUpdate(usage.activeMembers, usage.maxUtilisateurs, usage.graceEndsAt, usage.delaiGraceJours);
      if (Object.keys(update).length) {
        await cabinet.ref.update(update);
        updated++;
      }
    } catch (error) {
      logger.error("Délai de grâce non recalculé", { cabinetId: cabinet.id, error: String(error) });
    }
  }
  return updated;
}

/** Tâches quotidiennes, appelables sans le planificateur (tests, scripts ops). */
export async function runDailyTasks(now: Date = new Date()) {
  const reminders = await sendProposalReminders(now);
  const invitations = await expireInvitations(now);
  const graces = await refreshGracePeriods();
  return { reminders, invitations, graces };
}

/** `taches-quotidiennes` : chaque jour à 7 h (heure de Paris). */
export const quotidiennes = onSchedule(
  { schedule: "0 7 * * *", timeZone: "Europe/Paris", region: REGION_ID },
  async () => {
    const result = await runDailyTasks();
    logger.info("Tâches quotidiennes terminées", result);
  },
);
