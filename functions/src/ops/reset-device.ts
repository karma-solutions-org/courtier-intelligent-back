import * as admin from "firebase-admin";
import { completeDeviceReset, deviceResetUpdate } from "../core/device.utils";
import { memberPath } from "../core/firestore-paths";
import type { BoundDevice } from "../shared/index.js";
import { fail, initOps, required, run } from "./ops.utils";

const USAGE =
  "npm run ops:reset-device -- (--emulator | --project <id>) --cabinet <id> (--uid <uid> | --email <email>) [--yes]\n" +
  "  sans --yes, affiche seulement ce qui serait réinitialisé";

/**
 * Réinitialise l'appareil lié d'un membre depuis l'exploitation : cas du seul admin d'un cabinet qui a perdu
 * son poste (personne ne peut appeler `equipe-reinitialiserAppareil` pour lui).
 * Même effet que la fonction : appareils déliés, session fermée, jetons révoqués, journal d'audit (by : « ops »).
 * Ne consomme PAS le quota mensuel de réinitialisations du cabinet.
 */
run(async () => {
  const args = initOps(
    {
      cabinet: { type: "string" },
      uid: { type: "string" },
      email: { type: "string" },
      yes: { type: "boolean" },
    },
    USAGE,
  );
  const cabinetId = required(args.cabinet, "cabinet", USAGE);
  if (!args.uid === !args.email) {
    fail(`Indiquez --uid ou --email (un seul des deux).\n\nUsage : ${USAGE}`);
  }
  const uid = args.uid?.trim() || (await admin.auth().getUserByEmail(args.email!.trim().toLowerCase()).catch(() => null))?.uid;
  if (!uid) {
    fail(`Aucun compte pour ${args.email}.`);
  }

  const ref = admin.firestore().doc(memberPath(cabinetId, uid));
  const member = await ref.get();
  if (!member.exists) {
    fail(`Le compte ${uid} n'est pas membre du cabinet ${cabinetId}.`);
  }
  const devices = [member.get("device"), ...((member.get("extraDevices") as BoundDevice[] | undefined) ?? [])].filter(
    Boolean,
  ) as BoundDevice[];
  console.log(`Membre ${uid} (${String(member.get("email") ?? "?")}, ${String(member.get("role"))}, ${String(member.get("status"))})`);
  console.log(
    devices.length
      ? devices.map(device => `  appareil lié : ${device.label ?? "(sans nom)"} [${device.id}]`).join("\n")
      : "  aucun appareil lié",
  );
  if (!devices.length && !member.get("session")) {
    console.log("Rien à réinitialiser.");
    return;
  }
  if (!args.yes) {
    console.log("\nSimulation : relancez avec --yes pour réinitialiser (le quota mensuel du cabinet n'est pas consommé).");
    return;
  }

  await ref.update(deviceResetUpdate());
  await completeDeviceReset(cabinetId, uid, "ops", { source: "ops" });
  console.log("Appareil réinitialisé : le prochain appareil avec lequel ce membre se connecte deviendra le sien.");
});
