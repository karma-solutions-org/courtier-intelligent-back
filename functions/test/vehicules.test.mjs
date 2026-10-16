// Recherche par plaque : normalisation (SIV, FNI), fournisseur démo, et pré-remplissage du vrai questionnaire Auto
// (seulement les champs vides, jamais une réponse déjà saisie).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeRegistration, prefillAnswers, supportsVehicleLookup, vehicleInfoToAnswers } = require('../lib/shared/index.js');
const { demoProvider, DEMO_VEHICLES, fromApiPlaque } = require('../lib/vehicules/vehicle-providers.js');
const { loadCatalog } = require('../lib/ops/catalog.js');

const { catalog } = loadCatalog();
const autoSchema = catalog.products.find(p => p.id === 'auto').questionnaireSchema;

describe('normalizeRegistration', () => {
  it('accepte une plaque SIV, quelle que soit la saisie', () => {
    for (const raw of ['AB-123-CD', 'ab123cd', ' ab 123 cd ', 'AB.123.CD']) {
      assert.deepEqual(normalizeRegistration(raw), { format: 'SIV', plate: 'AB-123-CD' });
    }
  });

  it('accepte une ancienne plaque FNI, Corse et outre-mer compris', () => {
    assert.deepEqual(normalizeRegistration('1234 ab 75'), { format: 'FNI', plate: '1234 AB 75' });
    assert.deepEqual(normalizeRegistration('56-ABC-2A'), { format: 'FNI', plate: '56 ABC 2A' });
    assert.deepEqual(normalizeRegistration('123AB971'), { format: 'FNI', plate: '123 AB 971' });
  });

  it('refuse ce qui n\'est pas une plaque française', () => {
    for (const raw of ['', 'AB-000-CD', 'AI-123-CD', 'SS-123-CD', 'ABC-123', '0 AB 75', 42, null, 'A'.repeat(30)]) {
      assert.equal(normalizeRegistration(raw), null, String(raw));
    }
  });
});

describe('fournisseur démo', () => {
  it('connaît ses plaques de test et ignore les autres', async () => {
    for (const plate of Object.keys(DEMO_VEHICLES)) {
      assert.equal(normalizeRegistration(plate)?.plate, plate, `plaque de test non normalisée : ${plate}`);
      assert.equal((await demoProvider.lookup(plate)).plate, plate);
    }
    assert.equal(await demoProvider.lookup('ZZ-999-ZZ'), null);
  });
});

describe('pré-remplissage du questionnaire Auto', () => {
  it('le questionnaire Auto permet la recherche', () => {
    assert.equal(supportsVehicleLookup(autoSchema), true);
  });

  it('remplit les champs vides avec des réponses valides, sans écraser une réponse saisie', async () => {
    const found = vehicleInfoToAnswers(await demoProvider.lookup('AB-123-CD'));
    const patch = prefillAnswers(autoSchema, { 'vehicle.registration': 'AB-123-CD', 'vehicle.brand': 'Peugeot (saisi)' }, found);
    assert.deepEqual(patch, {
      'vehicle.model': '208',
      'vehicle.version': '1.2 PureTech 100 Allure',
      'vehicle.firstRegistrationDate': '2021-03-15',
      'vehicle.fiscalPower': 5,
      'vehicle.energyType': 'essence',
      'vehicle.vehicleType': 'voiture',
    });
  });
});

describe('apiplaqueimmatriculation.com', () => {
  // Extrait de l'exemple de réponse de leur documentation.
  const MEGANE = {
    data: {
      erreur: '', immat: 'AA123BC', marque: 'RENAULT', modele: 'MEGANE III Coupé', version: '1.9 dCi',
      date1erCir_us: '2009-04-18', date1erCir_fr: '18/04/2009', energie: '2', energieNGC: 'DIESEL',
      genreVCG: '1', genreVCGNGC: 'VP', puisFisc: '7', vin: 'VF1DZ0N0641118804',
    },
    'api-version': '1.0.0', message: '', code_erreur: 200,
  };

  it('traduit la réponse en données du questionnaire', () => {
    assert.deepEqual(fromApiPlaque('AA-123-BC', MEGANE), {
      plate: 'AA-123-BC', brand: 'RENAULT', model: 'MEGANE III Coupé', version: '1.9 dCi',
      firstRegistrationDate: '2009-04-18', fiscalPower: 7, energyType: 'diesel', vehicleType: 'voiture',
    });
  });

  it('prend la date française si la date ISO manque, et ignore un code sans équivalent', () => {
    const body = { data: { ...MEGANE.data, date1erCir_us: '', energie: '8', genreVCG: '4', puisFisc: '' } };
    const info = fromApiPlaque('AA-123-BC', body);
    assert.equal(info.firstRegistrationDate, '2009-04-18');
    assert.equal('energyType' in info, false);
    assert.equal('vehicleType' in info, false);
    assert.equal('fiscalPower' in info, false);
  });

  it('une réponse sans véhicule donne null (plaque inconnue)', () => {
    assert.equal(fromApiPlaque('AA-123-BC', { data: [], message: 'Plaque inconnue', code_erreur: 404 }), null);
    assert.equal(fromApiPlaque('AA-123-BC', { data: { erreur: 'Aucun résultat', marque: '' } }), null);
    assert.equal(fromApiPlaque('AA-123-BC', null), null);
  });
});
