// Pièces des clients (CIN, Kbis) : contrôle de la réponse de l'IA et chemins du dépôt provisoire.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildAssureOcrPrompt, dossierTypeForAssureDocument, parseAssureClassifyResponse, isAssureImportPath, isAssureReadableType, parseAssureOcrResponse } = require('../lib/shared/index.js');

describe('Lecture d’une pièce de client', () => {
  it('garde les champs d’une CIN au bon format', () => {
    const values = parseAssureOcrResponse(
      '```json\n{"civilite":"Mme","firstName":" Marie ","lastName":"Durand","birthDate":"1990-04-12","postalCode":"75002","city":"Paris"}\n```',
      'cin',
    );
    assert.deepEqual(values, { civilite: 'Mme', firstName: 'Marie', lastName: 'Durand', birthDate: '1990-04-12', postalCode: '75002', city: 'Paris' });
  });

  it('écarte les valeurs invalides au lieu de les inventer', () => {
    const values = parseAssureOcrResponse(
      '{"civilite":"Madame","firstName":"","birthDate":"2999-01-01","postalCode":"7500","siret":"12345678901234"}',
      'cin',
    );
    assert.deepEqual(values, {}, 'civilité hors liste, date future, code postal tronqué, SIRET sur une CIN');
  });

  it('lit raison sociale et SIRET sur un Kbis, sans date de naissance', () => {
    const values = parseAssureOcrResponse('{"companyName":"Dupont SARL","siret":"123 456 789 01234","birthDate":"1980-01-01"}', 'kbis');
    assert.deepEqual(values, { companyName: 'Dupont SARL', siret: '12345678901234' });
  });

  it('renvoie null pour une réponse inexploitable', () => {
    assert.equal(parseAssureOcrResponse('Document illisible.', 'cin'), null);
  });

  it('la consigne ne demande jamais email ni téléphone', () => {
    const prompt = buildAssureOcrPrompt('cin');
    assert.ok(!/email|phone|téléphone/i.test(prompt));
  });
});

describe('Dépôt provisoire', () => {
  it('n’accepte que le dépôt du courtier, sans sous-dossier', () => {
    assert.equal(isAssureImportPath('cabinets/c1/imports/u1/123-cin.pdf', 'c1', 'u1'), true);
    assert.equal(isAssureImportPath('cabinets/c1/imports/u2/123-cin.pdf', 'c1', 'u1'), false);
    assert.equal(isAssureImportPath('cabinets/c1/imports/u1/../x.pdf', 'c1', 'u1'), false);
    assert.equal(isAssureImportPath('cabinets/c2/imports/u1/a.pdf', 'c1', 'u1'), false);
  });
});

describe('Pièces reprises dans les dossiers', () => {
  it('seules la CIN et le Kbis sont lues pour la fiche', () => {
    assert.equal(isAssureReadableType('cin'), true);
    assert.equal(isAssureReadableType('kbis'), true);
    assert.equal(isAssureReadableType('carte_grise'), false);
  });

  it('donne le type du document du dossier ; le Kbis n’est pas repris', () => {
    assert.equal(dossierTypeForAssureDocument('carte_grise'), 'carte_grise');
    assert.equal(dossierTypeForAssureDocument('permis'), 'permis');
    assert.equal(dossierTypeForAssureDocument('cin'), 'cin');
    assert.equal(dossierTypeForAssureDocument('kbis'), null);
  });
});

describe('Type d’une pièce reconnu par l’IA', () => {
  it('garde un type connu, sinon null', () => {
    assert.equal(parseAssureClassifyResponse('```json\n{"type":"carte_grise"}\n```'), 'carte_grise');
    assert.equal(parseAssureClassifyResponse('{"type":"passeport"}'), null);
    assert.equal(parseAssureClassifyResponse('pas de json'), null);
  });
});
