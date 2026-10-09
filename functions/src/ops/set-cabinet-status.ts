import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { cabinetPath } from "../core/firestore-paths";
import { fail, initOps, required, run } from "./ops.utils";

const USAGE = "npm run ops:set-cabinet-status -- (--emulator | --project <id>) --cabinet <id> --status (active|disabled)";

/**
 * Active ou désactive un cabinet. Un cabinet désactivé est refusé par `sessions-ouvrir`, par les autres
 * functions et par les règles Firestore : ses membres perdent l'accès dès leur prochaine requête.
 */
run(async () => {
  const args = initOps({ cabinet: { type: "string" }, status: { type: "string" } }, USAGE);
  const cabinetId = required(args.cabinet, "cabinet", USAGE);
  const status = required(args.status, "status", USAGE);
  if (status !== "active" && status !== "disabled") {
    fail(`--status doit valoir « active » ou « disabled » (reçu : ${status}).\n\nUsage : ${USAGE}`);
  }

  const ref = admin.firestore().doc(cabinetPath(cabinetId));
  if (!(await ref.get()).exists) {
    fail(`Cabinet ${cabinetId} introuvable.`);
  }
  await ref.update({ active: status === "active", statusChangedAt: FieldValue.serverTimestamp() });
  console.log(`Cabinet ${cabinetId} ${status === "active" ? "activé" : "désactivé"}.`);
});
