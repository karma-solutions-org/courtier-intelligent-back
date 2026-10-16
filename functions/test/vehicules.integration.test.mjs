// Tests d'intégration de la recherche par plaque dans les emulators (fournisseur démo, sans token) :
// membre actif requis, plaque invalide refusée sans consommer de quota, limite mensuelle par cabinet.
// Lancer avec : npm run test:integration
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { call, ops, ouvrir, PASSWORD, signIn } from './helpers.mjs';

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
const { createCabinet } = require('../lib/core/cabinet.utils.js');

admin.initializeApp({ projectId: 'demo-courtier-intelligent' });
const db = admin.firestore();

const month = () => new Date().toISOString().substring(0, 7);
let token;
let cabinetId;

const rechercher = plate => call('vehicules-rechercher', token, { plate });
const usage = async () => (await db.doc(`ci_cabinets/${cabinetId}/ci_usage/plaque-${month()}`).get()).get('calls') ?? 0;

before(async () => {
  ops('seed-catalog');
  const user = await admin.auth().createUser({ email: 'plaque@test.fr', password: PASSWORD });
  cabinetId = await createCabinet({ name: 'Cabinet Plaque', orias: null, ownerUid: user.uid, planId: 'essentiel', overrides: { appelsPlaqueParMois: 2 } });
  token = await signIn('plaque@test.fr');
  await ouvrir(token);
});

describe('vehicules-rechercher', () => {
  it("refuse un compte qui n'est membre d'aucun cabinet, sans consommer de quota", async () => {
    await admin.auth().createUser({ email: 'sans-cabinet-plaque@test.fr', password: PASSWORD });
    const outsider = await signIn('sans-cabinet-plaque@test.fr');
    assert.equal((await call('vehicules-rechercher', outsider, { plate: 'AB-123-CD' })).error?.status, 'FAILED_PRECONDITION');
    assert.equal(await usage(), 0);
  });

  it('refuse une plaque invalide, sans consommer de quota', async () => {
    const result = await rechercher('AB-12');
    assert.equal(result.error?.status, 'INVALID_ARGUMENT');
    assert.equal(await usage(), 0);
  });

  it('renvoie le véhicule de démo, plaque normalisée', async () => {
    const { data } = await rechercher('ab 123 cd');
    assert.equal(data?.vehicle.plate, 'AB-123-CD');
    assert.equal(data.vehicle.brand, 'Peugeot');
    assert.equal(await usage(), 1);
  });

  it('une plaque inconnue est signalée et compte (le fournisseur a été interrogé)', async () => {
    assert.equal((await rechercher('ZZ-999-ZZ')).error?.status, 'NOT_FOUND');
    assert.equal(await usage(), 2);
  });

  it('au-delà de la limite du mois, la recherche est refusée sans appeler le fournisseur', async () => {
    const refused = await rechercher('EF-456-GH');
    assert.equal(refused.error?.status, 'RESOURCE_EXHAUSTED');
    assert.equal(refused.error.details?.reason, 'plaque_quota');
    assert.match(refused.error.message, /2 recherches/);
    assert.equal(await usage(), 2);
  });
});
