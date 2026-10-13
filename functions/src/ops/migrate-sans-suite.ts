import * as admin from "firebase-admin";
import { parseArgs } from "node:util";
import { addEvent, loadProduct } from "../core/dossier.utils";
import { computeCompleteness, type CanonicalData, type DossierStatus } from "../shared/index.js";
import { initOps, run } from "./ops.utils";

const USAGE = "npm run ops:migrate-sans-suite -- (--emulator | --project <id>) [--dry-run]";

/**
 * Le statut « sans suite » a été supprimé : chaque dossier qui l'a encore reprend le statut correspondant à ce qu'il
 * contient (proposition envoyée, offre retenue, couverture validée, sinon complet ou brouillon selon la complétude).
 * Sans risque à relancer : un dossier déjà migré n'est plus « sans_suite ». Le changement est tracé dans l'historique.
 */
run(async () => {
  const dryRun = parseArgs({ options: { "dry-run": { type: "boolean" } }, strict: false }).values["dry-run"] === true;
  initOps({ "dry-run": { type: "boolean" } }, USAGE);
  const db = admin.firestore();
  const snapshot = await db.collectionGroup("dossiers").where("status", "==", "sans_suite").get();
  if (snapshot.empty) {
    console.log("Aucun dossier « sans suite » : rien à migrer.");
    return;
  }

  for (const document of snapshot.docs) {
    const cabinetId = document.ref.parent.parent?.id;
    if (!cabinetId) continue;
    const target = await db.runTransaction(async tx => {
      const dossier = await tx.get(document.ref);
      if (dossier.get("status") !== "sans_suite") return null;
      const { questionnaireSchema: schema } = await loadProduct(tx, cabinetId, dossier.get("productId"));
      const completeness = computeCompleteness(schema, dossier.get("data") as CanonicalData);
      const outcome = dossier.get("outcome") as { result?: string } | null;
      const proposalSent = !!dossier.get("proposal");
      let status: DossierStatus = proposalSent
        ? "proposition_envoyee"
        : dossier.get("decision")
          ? "decision"
          : dossier.get("needAnalysis.validatedAt")
            ? "besoin_valide"
            : "complet";
      if (!completeness.ok && ["complet", "besoin_valide"].includes(status)) status = "brouillon";
      if (dryRun) return status;
      tx.update(document.ref, {
        status,
        completeness,
        // Réponse « sans suite » à une proposition : la proposition redevient en attente de réponse.
        ...(outcome?.result === "sans_suite" ? { outcome: null } : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      addEvent(tx, cabinetId, document.id, "system", "status_changed", { from: "sans_suite", to: status, automatic: true });
      return status;
    });
    if (target) {
      console.log(`${dryRun ? "[simulation] " : ""}${dossierLabel(document)} : sans suite → ${target}`);
    }
  }
  console.log(dryRun ? "Simulation terminée : rien n'a été écrit (--dry-run)." : `${snapshot.size} dossier(s) migré(s).`);
});

function dossierLabel(document: admin.firestore.QueryDocumentSnapshot): string {
  return `${document.get("reference") ?? document.id} (cabinet ${document.ref.parent.parent?.id})`;
}
