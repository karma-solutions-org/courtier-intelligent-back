// Tests d'intégration des functions tarification-* dans les emulators : lancement (bloqué sans besoin validé),
// relance d'un job en échec, réponses aux champs manquants, saisie manuelle d'une offre.
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
let uid;
let token;

const dossier = async dossierId => (await db.doc(`cabinets/${cabinetId}/dossiers/${dossierId}`).get()).data();
const job = async (dossierId, insurerId = 'assureur-a') =>
  (await db.doc(`cabinets/${cabinetId}/dossiers/${dossierId}/quoteJobs/${insurerId}`).get()).data();
const offer = async (dossierId, insurerId = 'assureur-a') =>
  (await db.doc(`cabinets/${cabinetId}/dossiers/${dossierId}/offers/${insurerId}`).get()).data();
const eventTypes = async dossierId =>
  (await db.collection(`cabinets/${cabinetId}/dossiers/${dossierId}/events`).get()).docs.map(d => d.get('type'));

const lancer = (dossierId, insurerId = 'assureur-a') => call('tarification-lancer', token, { dossierId, insurerId });

/** Un dossier Auto complet ; `validated` : besoin validé, prêt à tarifer. */
async function newDossier({ validated = true } = {}) {
  const { dossierId } = (await call('dossiers-creer', token, { assureId: 'assure-1', productId: 'auto' })).data;
  await call('dossiers-sauvegarder', token, { dossierId, patch: completeAutoData() });
  await call('dossiers-changerStatut', token, { dossierId, status: 'complet' });
  if (validated) {
    await call('dossiers-enregistrerBesoin', token, {
      dossierId,
      need: { coverageLevel: 'tous_risques', budgetMax: 700, maxDeductible: 300, mandatoryGuarantees: ['RC'], niceToHave: [], notes: null },
    });
    await call('dossiers-validerBesoin', token, { dossierId });
  }
  return dossierId;
}

const manualOffer = overrides => ({
  quoteNumber: ' DEV-42 ',
  premiumAnnual: 640,
  premiumMonthly: null,
  deductibles: { general: 300 },
  guarantees: [{ code: 'RC', label: 'x', included: true, limit: null, deductible: null }],
  exclusions: [' Conduite sans permis '],
  ...overrides,
});

before(async () => {
  ops('seed-catalog');
  const owner = await admin.auth().createUser({ email: 'admin-tarif@test.fr', password: PASSWORD });
  uid = owner.uid;
  cabinetId = await createCabinet({ name: 'Cabinet Tarification', orias: null, ownerUid: uid, planId: 'cabinet' });
  await db.doc(`cabinets/${cabinetId}/assures/assure-1`).set({ type: 'particulier', firstName: 'Jean', lastName: 'Dupont' });
  token = await signIn('admin-tarif@test.fr');
  await ouvrir(token, DEVICE_A);
});

describe('Lancer une tarification', () => {
  it('refuse tant que le besoin n’est pas validé', async () => {
    const dossierId = await newDossier({ validated: false });
    const { error } = await lancer(dossierId);
    assert.equal(error.status, 'FAILED_PRECONDITION');
    assert.equal(error.details.reason, 'need_not_validated');
    assert.equal(await job(dossierId), undefined);
  });

  it('écrit le job « requested » avec quoteData, passe le dossier en tarification et renvoie l’extranet', async () => {
    const dossierId = await newDossier();
    const { data } = await lancer(dossierId);
    assert.equal(data.dossierStatus, 'tarification');
    assert.equal(data.attempts, 1);
    assert.match(data.extranetUrl, /^https:\/\/extranet\.assureur-a/);

    const written = await job(dossierId);
    assert.equal(written.status, 'requested');
    assert.equal(written.ownerUid, uid);
    assert.equal(written.quoteData['vehicle.registration'], 'AB-123-CD');
    assert.deepEqual(written.quoteData['insuranceHistory.claimsCount'], { value: 0, knowledge: 'KNOWN' });
    assert.equal(written.dossierReference, (await dossier(dossierId)).reference);
    assert.equal((await dossier(dossierId)).status, 'tarification');
    assert.ok((await eventTypes(dossierId)).includes('pricing_requested'));
  });

  it('ne relance pas un job en cours, refuse un assureur inconnu', async () => {
    const dossierId = await newDossier();
    await lancer(dossierId);
    assert.equal((await lancer(dossierId)).error.details.reason, 'job_in_progress');
    assert.equal((await lancer(dossierId, 'assureur-inconnu')).error.status, 'NOT_FOUND');
  });

  it('relance un job en échec : nouvelle tentative, erreur effacée', async () => {
    const dossierId = await newDossier();
    await lancer(dossierId);
    await db.doc(`cabinets/${cabinetId}/dossiers/${dossierId}/quoteJobs/assureur-a`).update({ status: 'failed', error: 'Page inconnue' });
    const { data } = await lancer(dossierId);
    assert.equal(data.attempts, 2);
    const relaunched = await job(dossierId);
    assert.equal(relaunched.status, 'requested');
    assert.equal(relaunched.error, null);
  });
});

describe('Champs manquants', () => {
  let dossierId;
  const completer = answers => call('tarification-completer', token, { dossierId, insurerId: 'assureur-a', answers });

  before(async () => {
    dossierId = await newDossier();
    await lancer(dossierId);
    await db.doc(`cabinets/${cabinetId}/dossiers/${dossierId}/quoteJobs/assureur-a`).update({
      status: 'needs_info',
      missingFields: [
        { canonicalPath: 'driver.profession', label: 'Profession', type: 'text' },
        { canonicalPath: 'vehicle.purchaseDate', label: "Date d'achat", type: 'date' },
      ],
    });
  });

  it('refuse un champ non demandé, une valeur invalide ou une réponse incomplète', async () => {
    assert.equal((await completer({ 'driver.phone': '0600000000' })).error.status, 'INVALID_ARGUMENT');
    assert.equal((await completer({ 'driver.profession': 'Infirmière', 'vehicle.purchaseDate': 'hier' })).error.status, 'INVALID_ARGUMENT');
    assert.equal((await completer({ 'driver.profession': 'Infirmière' })).error.details.reason, 'incomplete');
  });

  it('enregistre les réponses dans le dossier et met à jour quoteData (signal de reprise pour l’extension)', async () => {
    const { data } = await completer({ 'driver.profession': 'Infirmière', 'vehicle.purchaseDate': '2020-02-01' });
    assert.equal(data.success, true);
    assert.equal((await dossier(dossierId)).data['driver.profession'], 'Infirmière');
    const updated = await job(dossierId);
    assert.equal(updated.quoteData['driver.profession'], 'Infirmière');
    assert.equal(updated.quoteData['vehicle.purchaseDate'], '2020-02-01');
    assert.deepEqual(updated.missingFields, []);
    assert.ok((await eventTypes(dossierId)).includes('pricing_completed'));
  });

  it('refuse quand le job n’attend plus d’informations', async () => {
    await db.doc(`cabinets/${cabinetId}/dossiers/${dossierId}/quoteJobs/assureur-a`).update({ status: 'filling' });
    assert.equal((await completer({ 'driver.profession': 'Infirmière' })).error.details.reason, 'not_waiting_info');
  });
});

describe('Saisie manuelle d’une offre', () => {
  const saisir = (dossierId, offerInput, document) =>
    call('tarification-saisirOffre', token, { dossierId, insurerId: 'assureur-b', offer: offerInput, ...(document ? { document } : {}) });

  it('refuse sans besoin validé, sans prime ou avec une garantie inconnue', async () => {
    const draft = await newDossier({ validated: false });
    assert.equal((await saisir(draft, manualOffer())).error.details.reason, 'need_not_validated');
    const dossierId = await newDossier();
    assert.equal((await saisir(dossierId, manualOffer({ premiumAnnual: null }))).error.status, 'INVALID_ARGUMENT');
    assert.equal((await saisir(dossierId, manualOffer({ guarantees: [{ code: 'XYZ', included: true, limit: null, deductible: null }] }))).error.status, 'INVALID_ARGUMENT');
  });

  it('refuse un devis rangé hors du dossier', async () => {
    const dossierId = await newDossier();
    const document = { storagePath: `cabinets/autre/dossiers/${dossierId}/devis/devis.pdf`, fileName: 'devis.pdf' };
    assert.equal((await saisir(dossierId, manualOffer(), document)).error.status, 'INVALID_ARGUMENT');
  });

  it('écrit l’offre « manual » nettoyée, le devis joint, et marque le job en tarif obtenu', async () => {
    const dossierId = await newDossier();
    await lancer(dossierId, 'assureur-b');
    await db.doc(`cabinets/${cabinetId}/dossiers/${dossierId}/quoteJobs/assureur-b`).update({ status: 'failed', error: 'Extranet indisponible' });

    const storagePath = `cabinets/${cabinetId}/dossiers/${dossierId}/devis/assureur-b-1.pdf`;
    const { data } = await saisir(dossierId, manualOffer(), { storagePath, fileName: 'devis B.pdf' });
    assert.ok(data.documentId);

    const saved = await offer(dossierId, 'assureur-b');
    assert.equal(saved.source, 'manual');
    assert.equal(saved.quoteNumber, 'DEV-42');
    assert.equal(saved.guarantees[0].label, 'Responsabilité civile');
    assert.deepEqual(saved.exclusions, ['Conduite sans permis']);
    assert.equal(saved.enteredBy, uid);
    assert.equal(saved.documentId, data.documentId);

    const document = (await db.doc(`cabinets/${cabinetId}/dossiers/${dossierId}/documents/${data.documentId}`).get()).data();
    assert.equal(document.type, 'devis');
    assert.equal(document.storagePath, storagePath);
    assert.equal((await job(dossierId, 'assureur-b')).status, 'captured');
    assert.ok((await eventTypes(dossierId)).includes('offer_entered'));
  });

  it('sans job lancé : passe le dossier en tarification', async () => {
    const dossierId = await newDossier();
    const { data } = await saisir(dossierId, manualOffer({ premiumAnnual: null, premiumMonthly: 55 }));
    assert.equal(data.dossierStatus, 'tarification');
    assert.equal(await job(dossierId, 'assureur-b'), undefined);
  });
});
