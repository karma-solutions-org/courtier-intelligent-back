import * as admin from "firebase-admin";
import { parseArgs, type ParseArgsConfig } from "node:util";

const EMULATOR_PROJECT_ID = "demo-courtier-intelligent";

type Options = NonNullable<ParseArgsConfig["options"]>;

/** Options communes à tous les scripts ops : la cible (emulators ou projet Firebase). */
const TARGET_OPTIONS = {
  emulator: { type: "boolean" },
  project: { type: "string" },
} as const satisfies Options;

/**
 * Lit les arguments d'un script et initialise le SDK Admin.
 * La cible est toujours explicite : `--emulator` ou `--project <id>`. Le projet de test est partagé
 * avec d'autres applications, on ne vise jamais un projet réel par défaut.
 */
export function initOps<T extends Options>(options: T, usage: string, { positionals = false }: { positionals?: boolean } = {}) {
  const parsed = parseArgs({ options: { ...TARGET_OPTIONS, ...options }, strict: true, allowPositionals: positionals });
  const values = parsed.values;
  const target = values as { emulator?: boolean; project?: string };

  if (target.emulator) {
    process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
    process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
  } else if (!target.project) {
    fail(`Cible manquante : ajoutez --emulator ou --project <id>.\n\nUsage : ${usage}`);
  }
  admin.initializeApp({ projectId: target.emulator ? EMULATOR_PROJECT_ID : target.project });
  admin.firestore().settings({ ignoreUndefinedProperties: true });
  console.log(target.emulator ? "Cible : emulators locaux" : `Cible : projet ${target.project}`);
  return Object.assign(values as typeof values & { emulator?: boolean; project?: string }, { positionals: parsed.positionals });
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Argument texte obligatoire. */
export function required(value: unknown, option: string, usage: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(`Option --${option} manquante.\n\nUsage : ${usage}`);
  }
  return value.trim();
}

/** Argument entier positif ou nul facultatif. */
export function optionalCount(value: unknown, option: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    fail(`--${option} doit être un entier positif ou nul (reçu : ${String(value)}).`);
  }
  return count;
}

/** Exécute un script en affichant l'erreur proprement. */
export function run(main: () => Promise<void>): void {
  main().then(
    () => process.exit(0),
    error => fail(`Échec : ${error instanceof Error ? error.message : String(error)}`),
  );
}
