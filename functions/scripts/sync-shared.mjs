// Copie les types partagés du repo front (courtier-intelligent/shared) dans src/shared.
// Ajoute l'extension « .js » aux imports relatifs, exigée par la résolution NodeNext.
//
// Garde-fous (la copie écrasait sans prévenir du code plus récent) : chaque synchro enregistre dans
// src/shared/.sync.json le commit du front d'origine et l'empreinte de chaque fichier écrit. La synchro suivante refuse :
//   1. un fichier de src/shared modifié à la main depuis (empreinte différente) ;
//   2. une source qui ne contient plus le commit de la dernière synchro (branche du front en retard ou divergente) ;
//   3. sans .sync.json (première fois), toute modification ou suppression d'un fichier existant.
// Options : --check (compare sans écrire, code 1 si la copie n'est pas à jour), --force (passe outre les refus).
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEADER = "// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.\n";
const MANIFEST = ".sync.json";
const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const force = args.has("--force") || process.env.SYNC_SHARED_FORCE === "1";

const functionsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(functionsDir, process.env.SHARED_SOURCE ?? "../../courtier-intelligent/shared");
const target = path.join(functionsDir, "src/shared");

// src/shared est versionné dans ce repo : sans le repo front à côté (CI GitHub Actions),
// on garde la copie existante.
if (!fs.existsSync(source)) {
  if (fs.existsSync(path.join(target, "index.ts"))) {
    console.log(`Repo front introuvable (${source}) : copie existante de src/shared conservée.`);
    process.exit(0);
  }
  console.error(`Types partagés introuvables : ni ${source}, ni src/shared.`);
  process.exit(1);
}

const sha = text => crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
const git = (...gitArgs) => {
  try {
    return execFileSync("git", ["-C", source, ...gitArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

/** Contenu à écrire, par nom de fichier. */
const generated = new Map(
  fs
    .readdirSync(source)
    .filter(f => f.endsWith(".ts"))
    .map(file => {
      const content = fs
        .readFileSync(path.join(source, file), "utf8")
        .replace(/from '(\.\/[^']+)'/g, (_m, rel) => `from '${rel}.js'`);
      return [file, HEADER + content];
    }),
);
const existing = fs.existsSync(target) ? fs.readdirSync(target).filter(f => f.endsWith(".ts")) : [];
const read = file => fs.readFileSync(path.join(target, file), "utf8");

const changed = [...generated]
  .filter(([file, content]) => !existing.includes(file) || sha(read(file)) !== sha(content))
  .map(([f]) => f);
const removed = existing.filter(file => !generated.has(file));

if (check) {
  if (!changed.length && !removed.length) {
    console.log("src/shared est à jour avec le front.");
    process.exit(0);
  }
  console.error(`src/shared diffère du front (${source}) :`);
  for (const f of changed) console.error(`  ~ ${f}`);
  for (const f of removed) console.error(`  - ${f} (absent du front)`);
  process.exit(1);
}

const manifestPath = path.join(target, MANIFEST);
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
const sourceCommit = git("rev-parse", "HEAD");
const writeManifest = () => {
  const files = Object.fromEntries([...generated].map(([file, content]) => [file, sha(content)]));
  const record = { sourceCommit, sourceBranch: git("rev-parse", "--abbrev-ref", "HEAD"), files };
  fs.writeFileSync(manifestPath, JSON.stringify(record, null, 2) + "\n");
};

if (!changed.length && !removed.length) {
  // Copie identique au front : on (ré)enregistre la synchro, ce qui arme les garde-fous pour la suivante.
  writeManifest();
  console.log("Types partagés déjà à jour.");
  process.exit(0);
}
const problems = [];

if (manifest) {
  const handEdited = existing.filter(file => manifest.files?.[file] && manifest.files[file] !== sha(read(file)));
  if (handEdited.length)
    problems.push(`modifiés à la main dans src/shared depuis la dernière synchro : ${handEdited.join(", ")}`);
  if (
    manifest.sourceCommit &&
    sourceCommit &&
    git("merge-base", "--is-ancestor", manifest.sourceCommit, "HEAD") === null
  ) {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    problems.push(
      `la branche « ${branch} » du front ne contient pas le commit ${manifest.sourceCommit.slice(0, 7)} de la dernière synchro ` +
        "(elle est en retard ou a divergé : fusionnez-la d'abord)",
    );
  }
} else if (existing.length) {
  problems.push(
    "aucune synchro enregistrée (.sync.json absent) et la copie actuelle diffère du front : " +
      [...changed.filter(f => existing.includes(f)), ...removed].join(", "),
  );
}

if (problems.length && !force) {
  console.error("Synchro refusée, pour ne pas écraser du code plus récent :");
  for (const p of problems) console.error(`  • ${p}`);
  console.error(
    "\nComparez avec « git diff » (back) et le front, reportez dans le front ce qui manque, puis relancez.",
  );
  console.error("Pour écraser quand même : npm run sync-shared -- --force");
  process.exit(1);
}
if (problems.length) console.warn(`--force : refus ignorés (${problems.length}).`);

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const [file, content] of generated) fs.writeFileSync(path.join(target, file), content);
writeManifest();
console.log(
  `Types partagés synchronisés depuis ${source} (${changed.length} modifié(s), ${removed.length} supprimé(s)).`,
);
