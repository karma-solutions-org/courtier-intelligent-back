// Tests d'intégration de l'analyse du besoin dans les emulators : enregistrement validé, trace des modifications,
// validation (« besoin_valide ») et annulation de la validation.
// Lancer avec : npm run test:integration
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { call, completeAutoData, DEVICE_A, ops, ouvrir, PASSWORD, signIn } from './helpers.mjs';

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
const { createCabinet } = require('../lib/core/cabinet.utils.js');

admin.initializeApp({ projectId: 'demo-courtier-intelligent' });
const db = admin.firestore();

let cabinetId;
let token;

const events = async dossierId => {
  const snapshot = await db.collection(`cabinets/${cabinetId}/dossiers/${dossierId}/events`).get();
  return snapshot.docs.map(d => d.data()).sort((a, b) => a.at.toMillis() - b.at.toMillis());
};
const dossier = async dossierId => (await db.doc(`cabinets/${cabinetId}/dossiers/${dossierId}`).get()).data();

/** Un dossier Auto complet, prêt pour l'analyse du besoin. */
async function completeDossier() {
  const { dossierId } = (await call('dossiers-creer', token, { assureId: 'assure-1', productId: 'auto' })).data;
  await call('dossiers-sauvegarder', token, { dossierId, patch: completeAutoData() });
  await call('dossiers-changerStatut', token, { dossierId, status: 'complet' });
  return dossierId;
}

const need = overrides => ({
  coverageLevel: 'tous_risques',
  budgetMax: 650,
  maxDeductible: 300,
  mandatoryGuarantees: ['RC', 'VOL'],
  niceToHave: ['ASS'],
  notes: 'Client sensible au prix',
  ...overrides,
});

before(async () => {
  ops('seed-catalog');
  const owner = await admin.auth().createUser({ email: 'admin-besoin@test.fr', password: PASSWORD });
  cabinetId = await createCabinet({ name: 'Cabinet Besoin', orias: null, ownerUid: owner.uid, planId: 'cabinet' });
  await db.doc(`cabinets/${cabinetId}/assures/assure-1`).set({
    type: 'particulier',
    firstName: 'Jean',
    lastName: 'Dupont',
    address: { city: 'Paris' },
  });
  token = await signIn('admin-besoin@test.fr');
  await ouvrir(token, DEVICE_A);
});

describe('Enregistrement du besoin', () => {
  let dossierId;
  const saveNeed = value => call('dossiers-enregistrerBesoin', token, { dossierId, need: value });

  before(async () => {
    const { dossierId: draft } = (await call('dossiers-creer', token, { assureId: 'assure-1', productId: 'auto' })).data;
    dossierId = draft;
  });

  it("refuse le besoin tant que le dossier n'est pas complet", async () => {
    const refused = await saveNeed(need());
    assert.equal(refused.error?.status, 'FAILED_PRECONDITION');
    assert.equal(refused.error.details?.reason, 'need_not_editable');
    await call('dossiers-sauvegarder', token, { dossierId, patch: completeAutoData() });
    await call('dossiers-changerStatut', token, { dossierId, status: 'complet' });
  });

  it('refuse un besoin invalide, sans rien enregistrer', async () => {
    assert.equal((await saveNeed(need({ coverageLevel: 'luxe' }))).error?.status, 'INVALID_ARGUMENT');
    assert.equal((await saveNeed(need({ budgetMax: -5 }))).error?.status, 'INVALID_ARGUMENT');
    assert.equal((await saveNeed(need({ mandatoryGuarantees: ['ZZZ'] }))).error?.status, 'INVALID_ARGUMENT');
    assert.equal((await saveNeed(need({ mandatoryGuarantees: ['VOL'], niceToHave: ['VOL'] }))).error?.status, 'INVALID_ARGUMENT');
    assert.equal((await dossier(dossierId)).needAnalysis, null);
  });

  it('enregistre le besoin et trace chaque champ modifié, sans le contenu des notes', async () => {
    const result = await saveNeed(need({ budgetMax: 0 }));
    assert.equal(result.data.status, 'complet');
    assert.deepEqual(result.data.changed.sort(), ['budgetMax', 'coverageLevel', 'mandatoryGuarantees', 'maxDeductible', 'niceToHave', 'notes']);

    const stored = (await dossier(dossierId)).needAnalysis;
    assert.equal(stored.coverageLevel, 'tous_risques');
    assert.equal(stored.budgetMax, 0, '0 est un budget, pas un champ vide');
    assert.equal(stored.validatedAt, null);

    const event = (await events(dossierId)).filter(e => e.type === 'need_updated').at(-1);
    assert.deepEqual(event.data.changes.coverageLevel, { from: null, to: 'tous_risques' });
    assert.deepEqual(event.data.changes.mandatoryGuarantees, { from: [], to: ['RC', 'VOL'] });
    assert.deepEqual(event.data.changes.notes, { changed: true });
    assert.ok(!JSON.stringify(event.data).includes('sensible au prix'));
  });

  it("n'écrit rien dans l'historique quand rien n'a changé", async () => {
    const before = (await events(dossierId)).length;
    const result = await saveNeed(need({ budgetMax: 0, mandatoryGuarantees: ['VOL', 'RC'] }));
    assert.deepEqual(result.data.changed, []);
    assert.equal((await events(dossierId)).length, before);
  });

  it('un dossier sans suite n’a plus de besoin à analyser', async () => {
    await call('dossiers-changerStatut', token, { dossierId, status: 'sans_suite' });
    assert.equal((await saveNeed(need({ budgetMax: 1 }))).error?.details?.reason, 'need_not_editable');
  });
});

describe('Validation du besoin', () => {
  let dossierId;
  const saveNeed = value => call('dossiers-enregistrerBesoin', token, { dossierId, need: value });
  const validate = () => call('dossiers-validerBesoin', token, { dossierId });

  before(async () => {
    dossierId = await completeDossier();
  });

  it('refuse de valider un besoin absent ou sans niveau de couverture', async () => {
    const absent = await validate();
    assert.equal(absent.error?.status, 'FAILED_PRECONDITION');
    assert.equal(absent.error.details?.reason, 'need_incomplete');

    await saveNeed(need({ coverageLevel: null }));
    assert.equal((await validate()).error?.details?.reason, 'need_incomplete');
    assert.equal((await dossier(dossierId)).status, 'complet');
  });

  it('valide le besoin : statut « besoin_valide », date de validation et trace', async () => {
    await saveNeed(need());
    assert.deepEqual((await validate()).data, { status: 'besoin_valide' });

    const validated = await dossier(dossierId);
    assert.equal(validated.status, 'besoin_valide');
    assert.ok(validated.needAnalysis.validatedAt);
    assert.deepEqual((await events(dossierId)).at(-1).data, { from: 'complet', to: 'besoin_valide', need: true });
  });

  it('refuse une seconde validation', async () => {
    assert.equal((await validate()).error?.details?.reason, 'invalid_transition');
  });

  it('le statut « besoin_valide » ne se pose que par la validation du besoin', async () => {
    const other = await completeDossier();
    const refused = await call('dossiers-changerStatut', token, { dossierId: other, status: 'besoin_valide' });
    assert.equal(refused.error?.details?.reason, 'use_validate_need');
  });

  it('modifier un besoin validé annule la validation, et les deux changements sont tracés', async () => {
    const result = await saveNeed(need({ budgetMax: 800 }));
    assert.equal(result.data.status, 'complet');

    const reopened = await dossier(dossierId);
    assert.equal(reopened.status, 'complet');
    assert.equal(reopened.needAnalysis.validatedAt, null);
    assert.equal(reopened.needAnalysis.budgetMax, 800);

    // Les deux événements sont écrits dans la même transaction (même horodatage) : on les cherche par type.
    const all = await events(dossierId);
    const updated = all.filter(e => e.type === 'need_updated').at(-1);
    const statusChange = all.filter(e => e.type === 'status_changed').at(-1);
    assert.deepEqual(updated.data.changes.budgetMax, { from: 650, to: 800 });
    assert.deepEqual(statusChange.data, { from: 'besoin_valide', to: 'complet', automatic: true });
  });

  it('repasser un dossier validé en « complet » annule aussi la validation', async () => {
    await validate();
    assert.deepEqual((await call('dossiers-changerStatut', token, { dossierId, status: 'complet' })).data, { status: 'complet' });
    assert.equal((await dossier(dossierId)).needAnalysis.validatedAt, null);
  });
});
