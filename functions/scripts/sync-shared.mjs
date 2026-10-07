// Copie les types partagés du repo front (courtier-intelligent/shared) dans src/shared.
// Ajoute l'extension « .js » aux imports relatifs, exigée par la résolution NodeNext.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const functionsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(functionsDir, process.env.SHARED_SOURCE ?? '../../courtier-intelligent/shared');
const target = path.join(functionsDir, 'src/shared');

// src/shared est versionné dans ce repo : sans le repo front à côté (CI GitHub Actions),
// on garde la copie existante.
if (!fs.existsSync(source)) {
  if (fs.existsSync(path.join(target, 'index.ts'))) {
    console.log(`Repo front introuvable (${source}) : copie existante de src/shared conservée.`);
    process.exit(0);
  }
  console.error(`Types partagés introuvables : ni ${source}, ni src/shared.`);
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
for (const file of fs.readdirSync(source).filter(f => f.endsWith('.ts'))) {
  const content = fs
    .readFileSync(path.join(source, file), 'utf8')
    .replace(/from '(\.\/[^']+)'/g, (_m, rel) => `from '${rel}.js'`);
  fs.writeFileSync(path.join(target, file), `// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.\n${content}`);
}
console.log(`Types partagés synchronisés depuis ${source}`);
