import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import type { ExtensionReport } from "../shared/index.js";
import { initOps, optionalCount, run } from "./ops.utils";

const USAGE = "npm run ops:extension-report -- (--emulator | --project <id>) [--days <n>] [--last <n>]";

/**
 * Bilan de l'extension par assureur sur les `--days` derniers jours (30 par défaut).
 *
 * Méthode : l'extension ne remonte dans `extensionReports` QUE ses échecs (insurerId, origin, step, issue, at).
 * - échecs : comptés par assureur et par étape depuis `extensionReports` (champ `at` dans la fenêtre) ;
 * - réussites : approximées par les offres capturées automatiquement (collectionGroup `offers`, `source == "auto"`,
 *   `capturedAt` dans la fenêtre), par assureur. Il n'y a pas de réussite « par étape » : une offre capturée
 *   signifie que toutes les étapes ont réussi ; la colonne de réussites n'apparaît donc qu'au total de l'assureur.
 * Affiche ensuite les `--last` derniers échecs (20 par défaut). Aucune donnée client n'est lue ni affichée.
 */
run(async () => {
  const args = initOps({ days: { type: "string" }, last: { type: "string" } }, USAGE);
  const days = optionalCount(args.days, "days") ?? 30;
  const last = optionalCount(args.last, "last") ?? 20;
  const since = Timestamp.fromMillis(Date.now() - days * 24 * 60 * 60 * 1000);
  const db = admin.firestore();

  const [reports, offers] = await Promise.all([
    db.collection("extensionReports").where("at", ">=", since).orderBy("at", "desc").get(),
    db.collectionGroup("offers").where("source", "==", "auto").where("capturedAt", ">=", since).get(),
  ]);
  const failures = reports.docs.map(doc => ({ ...(doc.data() as ExtensionReport), id: doc.id }));

  const successByInsurer = new Map<string, number>();
  for (const offer of offers.docs) {
    const insurerId = offer.id; // offers/{insurerId}
    successByInsurer.set(insurerId, (successByInsurer.get(insurerId) ?? 0) + 1);
  }
  const failuresByInsurer = new Map<string, Map<string, number>>();
  for (const report of failures) {
    const steps = failuresByInsurer.get(report.insurerId) ?? new Map<string, number>();
    steps.set(report.step, (steps.get(report.step) ?? 0) + 1);
    failuresByInsurer.set(report.insurerId, steps);
  }

  console.log(`\nBilan sur ${days} jour(s) : ${offers.size} offre(s) capturée(s) automatiquement, ${failures.length} échec(s) remonté(s).\n`);
  const insurers = [...new Set([...successByInsurer.keys(), ...failuresByInsurer.keys()])].sort();
  if (!insurers.length) {
    console.log("Aucune activité de l'extension sur la période.");
  }
  for (const insurerId of insurers) {
    const success = successByInsurer.get(insurerId) ?? 0;
    const steps = failuresByInsurer.get(insurerId) ?? new Map<string, number>();
    const failed = [...steps.values()].reduce((sum, count) => sum + count, 0);
    const rate = success + failed ? Math.round((success / (success + failed)) * 100) : 0;
    console.log(`${insurerId.padEnd(30)} réussites ${String(success).padStart(5)}   échecs ${String(failed).padStart(5)}   (${rate} % de réussite)`);
    for (const [step, count] of [...steps.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${step.padEnd(28)} échecs ${String(count).padStart(5)}`);
    }
  }

  console.log(`\n${Math.min(last, failures.length)} dernier(s) échec(s) :`);
  for (const report of failures.slice(0, last)) {
    const at = (report.at as Timestamp | undefined)?.toDate().toISOString() ?? "?";
    console.log(`  ${at}  ${report.insurerId.padEnd(24)} ${report.step.padEnd(20)} ${report.issue.padEnd(20)} ${report.origin}`);
  }
});
