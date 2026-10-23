// Génère les règles Firestore à partir de la seule source : courtier-intelligent/firestore.courtier-intelligent.rules.
// - firestore.rules : le bloc enveloppé, pour les emulators et les tests (les tests testent donc le bloc déployé).
// - firestore.shared.rules : le bloc remplacé à sa place dans les règles communes aux autres applications.
// Usage : node scripts/build-rules.mjs [--check] (--check échoue si un fichier n'est pas à jour, sans écrire).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.resolve(root, process.env.RULES_SOURCE ?? '../courtier-intelligent/firestore.courtier-intelligent.rules');
const BLOCK_START = '    // ═══ À COLLER dans match /databases/{database}/documents, AVANT le catch-all ═══';
const check = process.argv.includes('--check');

const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

// Sans le repo front à côté (CI GitHub Actions), on garde les fichiers versionnés.
if (!fs.existsSync(source)) {
  console.log(`Règles source introuvables (${source}) : fichiers existants conservés.`);
  process.exit(0);
}

const block = read(source).trimEnd();
if (!block.startsWith(BLOCK_START)) {
  console.error(`${source} doit commencer par la ligne « ${BLOCK_START.trim()} ».`);
  process.exit(1);
}

const sharedPath = path.join(root, 'firestore.shared.rules');
const shared = read(sharedPath);

// Fonctions des règles communes utilisées par le bloc : recopiées telles quelles pour que firestore.rules se comporte comme en ligne.
const SHARED_HELPERS = ['isConnected', 'onlyChangedKeys'];
const helpers = SHARED_HELPERS.map(name => {
  const match = shared.match(new RegExp(`^    function ${name}\\(.*?\\n    }\\n`, 'ms'));
  if (!match) {
    console.error(`Fonction ${name} introuvable dans ${sharedPath}.`);
    process.exit(1);
  }
  return match[0];
}).join('\n');

const standalone = `rules_version = '2';

// ⚠️ Fichier généré par functions/scripts/build-rules.mjs — modifier courtier-intelligent/firestore.courtier-intelligent.rules.
// Le projet de test aibs-partenaire-testing est PARTAGÉ avec aibs-partenaire et compli-scan :
// ces règles servent aux emulators. Ne jamais les déployer seules sur ce projet — voir README.
service cloud.firestore {
  match /databases/{database}/documents {
    // Recopiées depuis firestore.shared.rules (règles communes aux autres applications).
${helpers}
${block}
  }
}
`;

const start = shared.indexOf(BLOCK_START);
const end = shared.lastIndexOf('\n  }\n}');
if (start < 0 || end < start) {
  console.error(`Bloc Courtier Intelligent introuvable dans ${sharedPath}.`);
  process.exit(1);
}
const merged = `${shared.slice(0, start)}${block}${shared.slice(end)}`;

const outputs = [
  [path.join(root, 'firestore.rules'), standalone],
  [sharedPath, merged],
];
const stale = outputs.filter(([file, content]) => !fs.existsSync(file) || read(file) !== content);
if (check) {
  for (const [file] of stale) console.error(`Pas à jour : ${file} (lancer npm run build-rules).`);
  process.exit(stale.length ? 1 : 0);
}
for (const [file, content] of stale) fs.writeFileSync(file, content);
console.log(`Règles générées depuis ${source} (${stale.length} fichier(s) modifié(s)).`);
