// Validation du catalogue : le catalogue du dépôt est valide, un JSON invalide est détecté.
// Lancer avec : npm run test:unit
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadCatalog, CATALOG_DIR } = require('../lib/ops/catalog.js');

/** Copie le catalogue du dépôt dans un dossier temporaire, après y avoir appliqué `mutate`. */
function withCatalog(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
  fs.cpSync(CATALOG_DIR, dir, { recursive: true });
  mutate((relative, update) => {
    const file = path.join(dir, relative);
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(update(json)));
  });
  try {
    return loadCatalog(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const questionnaire = 'products/auto/questionnaire.json';

describe('Catalogue du dépôt', () => {
  it('est valide et contient le produit Auto, 3 assureurs et des offres', () => {
    const { catalog, issues } = loadCatalog();
    assert.deepEqual(issues, []);
    assert.equal(catalog.insurers.length, 3);
    assert.ok(catalog.plans.length >= 2);
    assert.deepEqual(catalog.products.map(p => p.id), ['auto']);
  });
});

describe('Validation : un JSON invalide est détecté', () => {
  it('un canonicalPath absent du modèle canonique', () => {
    const { issues } = withCatalog(edit => edit(questionnaire, q => { q[0].questions[0].canonicalPath = 'client.inconnu'; return q; }));
    assert.ok(issues.some(i => i.file === questionnaire && /modèle canonique/.test(i.message)));
  });

  it('un champ en double', () => {
    const { issues } = withCatalog(edit => edit(questionnaire, q => { q[0].questions[1].canonicalPath = q[0].questions[0].canonicalPath; return q; }));
    assert.ok(issues.some(i => /en double/.test(i.message)));
  });

  it('un type de question invalide ou un choix sans valeurs', () => {
    const { issues } = withCatalog(edit => edit(questionnaire, q => {
      q[0].questions[0].type = 'inconnu';
      q[1].questions.find(x => x.type === 'choice').choices = [];
      return q;
    }));
    assert.ok(issues.some(i => /type invalide/.test(i.message)));
    assert.ok(issues.some(i => /choices/.test(i.message)));
  });

  it("une condition d'affichage qui référence un champ absent", () => {
    const { issues } = withCatalog(edit => edit(questionnaire, q => {
      q[0].questions[0].visibleIf = { path: 'driver.profession', equals: 'x' };
      q[3].questions = q[3].questions.filter(x => x.canonicalPath !== 'insuranceHistory.currentlyInsured');
      return q;
    }));
    assert.ok(issues.some(i => /visibleIf/.test(i.message)));
  });

  it('un synonyme qui pointe vers une garantie inconnue ou vers deux garanties', () => {
    const { issues } = withCatalog(edit => edit('products/auto/synonyms.json', s => {
      s.ZZZ = ['autre'];
      s.VOL.push('incendie');
      return s;
    }));
    assert.ok(issues.some(i => /code de garantie inconnu : ZZZ/.test(i.message)));
    assert.ok(issues.some(i => /ambiguë/.test(i.message)));
  });

  it("un assureur dont les domaines ne couvrent pas l'URL, ou avec un produit inconnu", () => {
    const { issues } = withCatalog(edit => edit('insurers/assureur-a.json', i => {
      i.extranetDomains = ['autre-domaine.example'];
      i.productsSupported = ['habitation'];
      return i;
    }));
    assert.ok(issues.some(i => /extranetDomains/.test(i.message)));
    assert.ok(issues.some(i => /produit inconnu/.test(i.message)));
  });

  it('une offre avec une limite invalide', () => {
    const { issues } = withCatalog(edit => edit('plans/essentiel.json', p => { p.limits.maxUtilisateurs = 0; return p; }));
    assert.ok(issues.some(i => i.file === 'plans/essentiel.json'));
  });

  it('un fichier JSON mal formé', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
    fs.cpSync(CATALOG_DIR, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plans/cabinet.json'), '{ pas du json');
    try {
      const { issues } = loadCatalog(dir);
      assert.ok(issues.some(i => i.file === 'plans/cabinet.json' && /illisible/.test(i.message)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
