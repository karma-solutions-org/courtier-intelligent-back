// Règles du questionnaire (complétude, conditions, validation, quoteData) et machine à états des dossiers,
// vérifiées sur le vrai questionnaire Auto du catalogue.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildQuoteData,
  computeCompleteness,
  isAnswered,
  isQuestionVisible,
  isTransitionAllowed,
  questionFor,
  validateAnswer,
} = require('../lib/shared/index.js');
const { loadCatalog } = require('../lib/ops/catalog.js');
const { formatReference } = require('../lib/core/dossier-reference.js');

const { catalog } = loadCatalog();
const schema = catalog.products.find(p => p.id === 'auto').questionnaireSchema;
const question = path => questionFor(schema, path);

/** Toutes les réponses obligatoires d'un dossier Auto sans historique d'assurance particulier. */
const completeData = () => ({
  'client.lastName': 'Dupont',
  'client.firstName': 'Jean',
  'client.birthDate': '1985-03-12',
  'client.email': 'jean@example.fr',
  'client.address.street': '1 rue de la Paix',
  'client.address.postalCode': '75002',
  'client.address.city': 'Paris',
  'vehicle.registration': 'AB-123-CD',
  'vehicle.brand': 'Renault',
  'vehicle.model': 'Clio',
  'vehicle.firstRegistrationDate': '2019-05-01',
  'vehicle.fiscalPower': 5,
  'vehicle.vehicleType': 'voiture',
  'vehicle.usage': 'prive',
  'vehicle.parkingType': 'garage_prive',
  'driver.lastName': 'Dupont',
  'driver.firstName': 'Jean',
  'driver.birthDate': '1985-03-12',
  'driver.licenseDate': '2004-07-01',
  'driver.licenseType': 'B',
  'insuranceHistory.currentlyInsured': false,
  'insuranceHistory.bonusMalus': { value: 0.9, knowledge: 'KNOWN' },
  'insuranceHistory.claimsCount': { value: 0, knowledge: 'KNOWN' },
  'insuranceHistory.wasTerminated': false,
});

describe('Complétude', () => {
  it('un dossier vide liste tous les champs obligatoires visibles', () => {
    const { ok, missing } = computeCompleteness(schema, {});
    assert.equal(ok, false);
    assert.ok(missing.includes('client.lastName'));
    assert.ok(missing.includes('insuranceHistory.currentlyInsured'));
    // Les champs conditionnels ne sont pas demandés tant que leur condition n'est pas remplie.
    assert.ok(!missing.includes('insuranceHistory.previousInsurer'));
    assert.ok(!missing.includes('insuranceHistory.terminatedByInsurer'));
  });

  it('un dossier avec toutes les réponses obligatoires est complet', () => {
    assert.deepEqual(computeCompleteness(schema, completeData()), { ok: true, missing: [] });
  });

  it('une condition remplie rend ses champs obligatoires', () => {
    const data = { ...completeData(), 'insuranceHistory.currentlyInsured': true };
    assert.deepEqual(computeCompleteness(schema, data).missing, ['insuranceHistory.previousInsurer']);
  });

  it('0 et false sont des réponses, pas des champs manquants', () => {
    assert.equal(isAnswered(0), true);
    assert.equal(isAnswered(false), true);
    assert.equal(isAnswered(''), false);
    assert.equal(isAnswered('  '), false);
    assert.equal(isAnswered(null), false);
    assert.equal(isAnswered(undefined), false);
  });

  it("« l'assuré ne sait pas » est une réponse, « inconnu » n'en est pas une", () => {
    assert.equal(isAnswered({ value: null, knowledge: 'DECLARED_UNKNOWN' }), true);
    assert.equal(isAnswered({ value: null, knowledge: 'UNKNOWN' }), false);
    assert.equal(isAnswered({ value: null, knowledge: 'KNOWN' }), false);
    assert.equal(isAnswered({ value: 0, knowledge: 'KNOWN' }), true);
  });

  it('visibilité conditionnelle', () => {
    const q = question('insuranceHistory.previousInsurer');
    assert.equal(isQuestionVisible(q, {}), false);
    assert.equal(isQuestionVisible(q, { 'insuranceHistory.currentlyInsured': false }), false);
    assert.equal(isQuestionVisible(q, { 'insuranceHistory.currentlyInsured': true }), true);
  });
});

describe('Validation des réponses', () => {
  it('accepte les bons types', () => {
    assert.equal(validateAnswer(question('client.lastName'), 'Dupont'), null);
    assert.equal(validateAnswer(question('vehicle.fiscalPower'), 5), null);
    assert.equal(validateAnswer(question('insuranceHistory.currentlyInsured'), true), null);
    assert.equal(validateAnswer(question('client.birthDate'), '1985-03-12'), null);
    assert.equal(validateAnswer(question('vehicle.usage'), 'prive'), null);
    assert.equal(validateAnswer(question('insuranceHistory.claimsCount'), { value: 2, knowledge: 'KNOWN' }), null);
    assert.equal(validateAnswer(question('client.lastName'), null), null);
  });

  it('refuse les mauvais types et valeurs', () => {
    assert.match(validateAnswer(question('vehicle.fiscalPower'), '5'), /nombre/);
    assert.match(validateAnswer(question('vehicle.fiscalPower'), Number.NaN), /nombre/);
    assert.match(validateAnswer(question('insuranceHistory.currentlyInsured'), 'oui'), /oui ou non/);
    assert.match(validateAnswer(question('client.birthDate'), '12/03/1985'), /date/);
    assert.match(validateAnswer(question('client.birthDate'), '1985-13-45'), /date/);
    assert.match(validateAnswer(question('vehicle.usage'), 'spatial'), /choix invalide/);
    assert.match(validateAnswer(question('client.lastName'), 42), /texte/);
  });

  it('un champ avec niveau de connaissance exige une réponse structurée et cohérente', () => {
    const q = question('insuranceHistory.claimsCount');
    assert.match(validateAnswer(q, 2), /niveau de connaissance/);
    assert.match(validateAnswer(q, { value: 2, knowledge: 'AUTRE' }), /invalide/);
    assert.match(validateAnswer(q, { value: null, knowledge: 'KNOWN' }), /manquante/);
    assert.equal(validateAnswer(q, { value: null, knowledge: 'DECLARED_UNKNOWN' }), null);
  });

  it('retrouve une question par chemin, et jamais hors du modèle canonique', () => {
    assert.ok(question('client.lastName'));
    assert.equal(question('client.inconnu'), null);
    assert.equal(question('__proto__'), null);
  });
});

describe('quoteData', () => {
  it('conserve null, 0 et false, sans inventer de valeur', () => {
    const quote = buildQuoteData(schema, {
      ...completeData(),
      'vehicle.vehicleValue': 0,
      'client.phone': '',
    });
    assert.equal(quote['vehicle.vehicleValue'], 0);
    assert.equal(quote['insuranceHistory.currentlyInsured'], false);
    assert.equal(quote['client.phone'], null, 'chaîne vide = non renseigné');
    assert.equal(quote['vehicle.version'], null, 'jamais demandé = null, pas de valeur par défaut');
  });

  it('conserve le niveau de connaissance des champs sensibles', () => {
    const quote = buildQuoteData(schema, {
      ...completeData(),
      'insuranceHistory.claimsCount': { value: 2, knowledge: 'KNOWN' },
      'insuranceHistory.seniority': { value: null, knowledge: 'DECLARED_UNKNOWN' },
    });
    assert.deepEqual(quote['insuranceHistory.claimsCount'], { value: 2, knowledge: 'KNOWN' });
    assert.deepEqual(quote['insuranceHistory.seniority'], { value: null, knowledge: 'DECLARED_UNKNOWN' });
    assert.deepEqual(quote['insuranceHistory.responsibleClaimsCount'], { value: null, knowledge: 'UNKNOWN' });
  });

  it('écarte les champs masqués par une condition, même s’ils ont une valeur', () => {
    const quote = buildQuoteData(schema, { ...completeData(), 'insuranceHistory.previousInsurer': 'Ancien assureur' });
    assert.ok(!('insuranceHistory.previousInsurer' in quote));
    const insured = buildQuoteData(schema, {
      ...completeData(),
      'insuranceHistory.currentlyInsured': true,
      'insuranceHistory.previousInsurer': 'Ancien assureur',
    });
    assert.equal(insured['insuranceHistory.previousInsurer'], 'Ancien assureur');
  });

  it("n'inclut aucun chemin hors du questionnaire du produit", () => {
    const quote = buildQuoteData(schema, { ...completeData(), 'driver.phone': '0600000000' });
    assert.ok(!('driver.phone' in quote));
  });
});

describe('Machine à états', () => {
  it('autorise les transitions prévues', () => {
    assert.equal(isTransitionAllowed('brouillon', 'complet'), true);
    assert.equal(isTransitionAllowed('complet', 'brouillon'), true);
    assert.equal(isTransitionAllowed('complet', 'besoin_valide'), true);
    assert.equal(isTransitionAllowed('proposition_envoyee', 'souscrit'), true);
  });

  it('refuse les transitions interdites', () => {
    assert.equal(isTransitionAllowed('brouillon', 'tarification'), false);
    assert.equal(isTransitionAllowed('brouillon', 'souscrit'), false);
    assert.equal(isTransitionAllowed('brouillon', 'brouillon'), false);
    assert.equal(isTransitionAllowed('complet', 'decision'), false);
  });

  it('les statuts finaux sont définitifs', () => {
    for (const final of ['souscrit', 'refuse', 'sans_suite']) {
      for (const target of ['brouillon', 'complet', 'tarification', 'sans_suite']) {
        assert.equal(isTransitionAllowed(final, target), false, `${final} → ${target}`);
      }
    }
  });
});

describe('Référence du dossier', () => {
  it('suit le format AAAA-NNNNNN', () => {
    assert.equal(formatReference(2026, 123), '2026-000123');
    assert.equal(formatReference(2026, 1), '2026-000001');
    assert.equal(formatReference(2027, 1234567), '2027-1234567');
  });
});
