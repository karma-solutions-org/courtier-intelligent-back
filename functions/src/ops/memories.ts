import * as admin from "firebase-admin";
import type { Timestamp } from "firebase-admin/firestore";
import { formatRow, hasCriteria, MemoryRow, PurgeCriteria, selectMemories } from "./memories-select";
import { fail, initOps, optionalCount, run } from "./ops.utils";

const USAGE =
  "npm run ops:memories -- (--emulator | --project <id>) <commande> [options]\n" +
  "  list   [--origin <https://…>] [--invalidated]            liste les mémoires (une ligne chacune)\n" +
  "  show   <clé>                                             détaille une mémoire : champs, chemins canoniques, confiance\n" +
  "  purge  (--key <clé> | --origin <https://…> | --invalidated | --older-than-days <n>) [--yes]\n" +
  "                                                           supprime les mémoires qui correspondent à TOUS les critères ;\n" +
  "                                                           sans --yes, affiche seulement ce qui serait supprimé";

const toDate = (value: unknown): Date | null => (value ? (value as Timestamp).toDate() : null);

async function readAll(): Promise<{ row: MemoryRow; ref: admin.firestore.DocumentReference }[]> {
  const snapshot = await admin.firestore().collection("formMemories").get();
  return snapshot.docs.map(doc => ({
    ref: doc.ref,
    row: {
      key: doc.id,
      origin: doc.get("origin") ?? "?",
      formFingerprint: doc.get("formFingerprint") ?? "?",
      version: doc.get("version") ?? 0,
      fieldCount: (doc.get("fields") as unknown[] | undefined)?.length ?? 0,
      hits: doc.get("hits") ?? 0,
      failures: doc.get("failures") ?? 0,
      invalidated: !!doc.get("invalidatedAt"),
      lastUsedAt: toDate(doc.get("lastUsedAt")),
      createdAt: toDate(doc.get("createdAt")),
    },
  }));
}

/**
 * Consulte et purge la mémoire partagée des formulaires (E8). La mémoire ne contient que de la structure
 * (jamais de donnée client) ; la purger force simplement l'extension à réapprendre (synonymes, puis IA).
 */
run(async () => {
  const args = initOps(
    {
      origin: { type: "string" },
      invalidated: { type: "boolean" },
      key: { type: "string" },
      "older-than-days": { type: "string" },
      yes: { type: "boolean" },
    },
    USAGE,
    { positionals: true },
  );
  const [command, argument] = args.positionals;
  const all = await readAll();

  switch (command) {
    case "list": {
      const rows = all.map(entry => entry.row).filter(row => (args.origin ? row.origin === args.origin : true) && (args.invalidated ? row.invalidated : true));
      rows.sort((a, b) => a.origin.localeCompare(b.origin) || a.key.localeCompare(b.key));
      console.log(rows.length ? rows.map(formatRow).join("\n") : "Aucune mémoire.");
      console.log(`\n${rows.length} mémoire(s) sur ${all.length}.`);
      return;
    }
    case "show": {
      if (!argument) fail(`Clé manquante.\n\n${USAGE}`);
      const doc = await admin.firestore().collection("formMemories").doc(argument).get();
      if (!doc.exists) fail(`Mémoire ${argument} introuvable.`);
      const row = all.find(entry => entry.row.key === argument)!.row;
      console.log(formatRow(row));
      for (const field of (doc.get("fields") as { fieldKey: string; label: string | null; canonicalPath: string | null; confidence: number }[]) ?? []) {
        console.log(`  ${field.fieldKey.padEnd(40)} ${(field.canonicalPath ?? "(aucun)").padEnd(40)} ${field.confidence}  ${field.label ?? ""}`);
      }
      return;
    }
    case "purge": {
      const criteria: PurgeCriteria = {
        ...(args.key !== undefined ? { key: args.key } : {}),
        ...(args.origin !== undefined ? { origin: args.origin } : {}),
        ...(args.invalidated ? { invalidated: true } : {}),
        ...(args["older-than-days"] !== undefined ? { olderThanDays: optionalCount(args["older-than-days"], "older-than-days") } : {}),
      };
      if (!hasCriteria(criteria)) fail(`Aucun critère : purger sans critère viderait toute la mémoire partagée.\n\n${USAGE}`);
      const selected = selectMemories(all.map(entry => entry.row), criteria);
      console.log(selected.length ? selected.map(formatRow).join("\n") : "Aucune mémoire ne correspond.");
      if (selected.length === 0) return;
      if (!args.yes) {
        console.log(`\n${selected.length} mémoire(s) seraient supprimées. Relancez avec --yes pour confirmer.`);
        return;
      }
      const keys = new Set(selected.map(row => row.key));
      for (const { ref, row } of all) if (keys.has(row.key)) await ref.delete();
      console.log(`\n${selected.length} mémoire(s) supprimée(s).`);
      return;
    }
    default:
      fail(`Commande inconnue ou manquante.\n\n${USAGE}`);
  }
});
