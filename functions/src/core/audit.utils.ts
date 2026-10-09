import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { auditLogPath } from "./firestore-paths";
import type { AuditLogType } from "../shared/index.js";

export interface AuditEvent {
  type: AuditLogType;
  /** Utilisateur concerné. */
  uid: string;
  /** Auteur de l'action (identique à `uid` pour une connexion). */
  by?: string;
  data?: Record<string, unknown>;
}

/** Trace une action dans le journal du cabinet. Lecture réservée aux admins, écriture serveur uniquement. */
export async function writeAudit(cabinetId: string, event: AuditEvent): Promise<void> {
  await admin
    .firestore()
    .collection(auditLogPath(cabinetId))
    .add({ type: event.type, uid: event.uid, by: event.by ?? event.uid, data: event.data ?? {}, at: FieldValue.serverTimestamp() });
}
