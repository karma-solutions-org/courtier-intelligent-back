// Tests d'intégration des functions dossiers-* dans les emulators : création et référence, sauvegarde du brouillon,
// complétude, machine à états, historique et assignation.
// Lancer avec : npm run test:integration
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { call, completeAutoData, DEVICE_A, ops, ouvrir, PASSWORD, signIn } from './helpers.mjs';

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
const { createCabinet } = require('../lib/core/cabinet.utils.js');
const { setCabinetClaims } = require('../lib/core/auth.utils.js');

admin.initializeApp({ projectId: 'demo-courtier-intelligent' });
const db = admin.firestore();
const year = new Date().getUTCFullYear();

let cabinetId;
let adminUid;
let courtierUid;
let adminToken;
let courtierToken;

const events = async dossierId => {
  const snapshot = await db.collection(`cabinets/${cabinetId}/dossiers/${dossierId}/events`).get();
  return snapshot.docs.map(d => d.data()).sort((a, b) => a.at.toMillis() - b.at.toMillis());
};
const dossier = async dossierId => (await db.doc(`cabinets/${cabinetId}/dossiers/${dossierId}`).get()).data();
const creer = (token = adminToken, assureId = 'assure-1') => call('dossiers-creer', token, { assureId, productId: 'auto' });

before(async () => {
  ops('seed-catalog');
  const owner = await admin.auth().createUser({ email: 'admin-dossiers@test.fr', password: PASSWORD });
  const courtier = await admin.auth().createUser({ email: 'courtier-dossiers@test.fr', password: PASSWORD });
  adminUid = owner.uid;
  courtierUid = courtier.uid;
  cabinetId = await createCabinet({ name: 'Cabinet Dossiers', orias: null, ownerUid: adminUid, planId: 'cabinet' });
  await db.doc(`cabinets/${cabinetId}/members/${courtierUid}`).set({ email: 'courtier-dossiers@test.fr', role: 'courtier', status: 'active' });
  await setCabinetClaims(courtierUid, cabinetId, 'courtier');
  await db.doc(`cabinets/${cabinetId}/assures/assure-1`).set({
    type: 'particulier',
    firstName: 'Jean',
    lastName: 'Dupont',
    email: 'jean@example.fr',
    birthDate: '1985-03-12',
    phone: null,
    address: { street: '1 rue de la Paix', postalCode: '75002', city: 'Paris', country: 'FR' },
  });
  adminToken = await signIn('admin-dossiers@test.fr');
  courtierToken = await signIn('courtier-dossiers@test.fr');
  await ouvrir(adminToken, DEVICE_A);
  await ouvrir(courtierToken, DEVICE_A);
});

describe('Création et référence', () => {
  it("crée un brouillon assigné au créateur, avec la référence AAAA-000001 et les infos de l'assuré", async () => {
    const result = await creer();
    assert.equal(result.data.reference, `${year}-000001`);
    const created = await dossier(result.data.dossierId);
    assert.equal(created.status, 'brouillon');
    assert.equal(created.assignedTo, adminUid);
    assert.equal(created.productId, 'auto');
    assert.equal(created.data['client.lastName'], 'Dupont');
    assert.equal(created.data['client.address.postalCode'], '75002');
    assert.equal(created.data['client.phone'], undefined, 'un champ vide de l’assuré n’est pas repris');
    assert.equal(created.completeness.ok, false);
    assert.ok(created.completeness.missing.includes('vehicle.registration'));
    assert.ok(!created.completeness.missing.includes('client.lastName'));
    assert.deepEqual(created.draft, { sectionIndex: 0 });
    assert.deepEqual((await events(result.data.dossierId)).map(e => e.type), ['created']);
  });

  it('numérote sans doublon, même pour des créations simultanées', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => creer(courtierToken)));
    const references = results.map(r => r.data.reference);
    assert.equal(new Set(references).size, 5, references.join(', '));
    assert.ok(references.every(r => /^\d{4}-\d{6}$/.test(r)));
    const numbers = references.map(r => Number(r.slice(5))).sort((a, b) => a - b);
    assert.deepEqual(numbers, [2, 3, 4, 5, 6]);
  });

  it('refuse un assuré inconnu et un produit inconnu', async () => {
    assert.equal((await creer(adminToken, 'inexistant')).error?.status, 'NOT_FOUND');
    const unknownProduct = await call('dossiers-creer', adminToken, { assureId: 'assure-1', productId: 'habitation' });
    assert.equal(unknownProduct.error?.status, 'NOT_FOUND');
  });

  it("refuse un produit que le cabinet n'a pas activé", async () => {
    await db.doc(`cabinets/${cabinetId}`).update({ enabledProducts: ['moto'] });
    assert.equal((await creer()).error?.status, 'FAILED_PRECONDITION');
    await db.doc(`cabinets/${cabinetId}`).update({ enabledProducts: ['auto'] });
    assert.ok((await creer()).data?.dossierId);
  });
});

describe('Sauvegarde automatique du brouillon', () => {
  let dossierId;
  before(async () => {
    dossierId = (await creer()).data.dossierId;
  });

  it('enregistre les réponses, recalcule la complétude et mémorise la section', async () => {
    const before = await dossier(dossierId);
    const result = await call('dossiers-sauvegarder', adminToken, {
      dossierId,
      patch: { 'vehicle.brand': 'Renault', 'vehicle.fiscalPower': 0, 'vehicle.version': null },
      sectionIndex: 2,
    });
    assert.equal(result.data.status, 'brouillon');
    const saved = await dossier(dossierId);
    assert.equal(saved.data['vehicle.brand'], 'Renault');
    assert.equal(saved.data['vehicle.fiscalPower'], 0, '0 est une réponse');
    assert.equal(saved.data['vehicle.version'], null, 'null est conservé');
    assert.equal(saved.data['client.lastName'], 'Dupont', 'les autres réponses sont conservées');
    assert.deepEqual(saved.draft, { sectionIndex: 2 });
    assert.equal(saved.completeness.missing.length, before.completeness.missing.length - 2);
    assert.deepEqual((await events(dossierId)).map(e => e.type), ['created'], 'la sauvegarde automatique ne pollue pas l’historique');
  });

  it("refuse un champ inconnu, hors modèle canonique ou d'un mauvais type", async () => {
    const attempt = patch => call('dossiers-sauvegarder', adminToken, { dossierId, patch });
    assert.equal((await attempt({ 'client.inconnu': 'x' })).error?.status, 'INVALID_ARGUMENT');
    assert.equal((await attempt({ 'driver.phone': '0600000000' })).error?.status, 'INVALID_ARGUMENT', 'canonique mais absent du questionnaire');
    assert.equal((await attempt({ 'vehicle.fiscalPower': 'cinq' })).error?.status, 'INVALID_ARGUMENT');
    assert.equal((await attempt({ 'vehicle.usage': 'spatial' })).error?.status, 'INVALID_ARGUMENT');
    assert.equal((await attempt({ 'insuranceHistory.claimsCount': 3 })).error?.status, 'INVALID_ARGUMENT', 'niveau de connaissance requis');
  });

  it("trace dans l'historique quand la modification est explicite", async () => {
    await call('dossiers-sauvegarder', adminToken, { dossierId, patch: { 'vehicle.model': 'Clio' }, event: true });
    const types = (await events(dossierId)).map(e => e.type);
    assert.deepEqual(types, ['created', 'data_updated']);
  });
});

describe('Complétude et machine à états', () => {
  let dossierId;
  before(async () => {
    dossierId = (await creer()).data.dossierId;
  });

  it('bloque le statut « complet » tant qu’il manque un champ obligatoire', async () => {
    const refused = await call('dossiers-changerStatut', adminToken, { dossierId, status: 'complet' });
    assert.equal(refused.error?.status, 'FAILED_PRECONDITION');
    assert.equal(refused.error.details?.reason, 'incomplete');
    assert.ok(refused.error.details.missing.includes('vehicle.registration'));
    assert.equal((await dossier(dossierId)).status, 'brouillon');
  });

  it('refuse une transition interdite', async () => {
    const refused = await call('dossiers-changerStatut', adminToken, { dossierId, status: 'tarification' });
    assert.equal(refused.error?.status, 'FAILED_PRECONDITION');
    assert.equal(refused.error.details?.reason, 'invalid_transition');
    assert.equal((await call('dossiers-changerStatut', adminToken, { dossierId, status: 'nimporte' })).error?.status, 'INVALID_ARGUMENT');
  });

  it('passe en « complet » une fois tout renseigné, et le trace', async () => {
    await call('dossiers-sauvegarder', adminToken, { dossierId, patch: completeAutoData() });
    assert.deepEqual((await dossier(dossierId)).completeness, { ok: true, missing: [] });
    assert.deepEqual((await call('dossiers-changerStatut', adminToken, { dossierId, status: 'complet' })).data, { status: 'complet' });
    const last = (await events(dossierId)).at(-1);
    assert.equal(last.type, 'status_changed');
    assert.deepEqual(last.data, { from: 'brouillon', to: 'complet' });
  });

  it('un dossier « complet » qui perd une information obligatoire repasse en brouillon', async () => {
    const result = await call('dossiers-sauvegarder', adminToken, { dossierId, patch: { 'vehicle.registration': '' } });
    assert.equal(result.data.status, 'brouillon');
    assert.equal((await dossier(dossierId)).status, 'brouillon');
    const last = (await events(dossierId)).at(-1);
    assert.deepEqual(last.data, { from: 'complet', to: 'brouillon', automatic: true });
  });

  it('un dossier « sans suite » est définitif et n’est plus modifiable', async () => {
    assert.deepEqual((await call('dossiers-changerStatut', adminToken, { dossierId, status: 'sans_suite' })).data, { status: 'sans_suite' });
    const edit = await call('dossiers-sauvegarder', adminToken, { dossierId, patch: { 'vehicle.brand': 'Peugeot' } });
    assert.equal(edit.error?.status, 'FAILED_PRECONDITION');
    assert.equal(edit.error.details?.reason, 'not_editable');
    const reopen = await call('dossiers-changerStatut', adminToken, { dossierId, status: 'brouillon' });
    assert.equal(reopen.error?.details?.reason, 'invalid_transition');
  });
});

describe('Assignation', () => {
  let dossierId;
  before(async () => {
    dossierId = (await creer(adminToken)).data.dossierId;
  });

  it("un courtier ne réassigne pas le dossier d'un autre", async () => {
    const refused = await call('dossiers-assigner', courtierToken, { dossierId, uid: courtierUid });
    assert.equal(refused.error?.status, 'PERMISSION_DENIED');
  });

  it("l'admin assigne à un courtier, qui peut ensuite le réassigner, avec trace", async () => {
    assert.deepEqual((await call('dossiers-assigner', adminToken, { dossierId, uid: courtierUid })).data, { success: true });
    assert.equal((await dossier(dossierId)).assignedTo, courtierUid);
    assert.deepEqual((await call('dossiers-assigner', courtierToken, { dossierId, uid: adminUid })).data, { success: true });
    const assigned = (await events(dossierId)).filter(e => e.type === 'assigned');
    assert.deepEqual(assigned.map(e => e.data), [
      { from: adminUid, to: courtierUid },
      { from: courtierUid, to: adminUid },
    ]);
  });

  it('refuse un membre désactivé ou étranger au cabinet', async () => {
    assert.equal((await call('dossiers-assigner', adminToken, { dossierId, uid: 'inconnu' })).error?.status, 'FAILED_PRECONDITION');
    await db.doc(`cabinets/${cabinetId}/members/${courtierUid}`).update({ status: 'disabled' });
    assert.equal((await call('dossiers-assigner', adminToken, { dossierId, uid: courtierUid })).error?.status, 'FAILED_PRECONDITION');
    await db.doc(`cabinets/${cabinetId}/members/${courtierUid}`).update({ status: 'active' });
  });

  it('ne trace rien quand le dossier est déjà assigné à cette personne', async () => {
    const before = (await events(dossierId)).length;
    await call('dossiers-assigner', adminToken, { dossierId, uid: adminUid });
    assert.equal((await events(dossierId)).length, before);
  });
});
