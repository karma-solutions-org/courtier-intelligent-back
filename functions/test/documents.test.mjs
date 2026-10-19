// Documents des dossiers (E12) : contrôle de la réponse de l'IA (OCR), chemins Storage, noms de fichiers.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildOcrPrompt,
  isAnalyzableDocumentType,
  isDossierDocumentPath,
  ocrQuestions,
  parseOcrResponse,
  safeDocumentFileName,
} = require('../lib/shared/index.js');

const SCHEMA = [
  {
    title: 'Véhicule',
    questions: [
      { canonicalPath: 'vehicle.registration', label: 'Immatriculation', type: 'text', required: true },
      { canonicalPath: 'vehicle.brand', label: 'Marque', type: 'text', required: true },
      { canonicalPath: 'vehicle.firstRegistrationDate', label: '1re mise en circulation', type: 'date', required: true },
      { canonicalPath: 'vehicle.fiscalPower', label: 'Puissance fiscale', type: 'number', required: false },
      {
        canonicalPath: 'vehicle.vehicleType',
        label: 'Type',
        type: 'choice',
        required: true,
        choices: [{ value: 'VP', label: 'Voiture' }],
      },
    ],
  },
  {
    title: 'Conducteur',
    questions: [{ canonicalPath: 'driver.licenseDate', label: 'Date du permis', type: 'date', required: true }],
  },
  {
    title: 'Historique',
    questions: [
      { canonicalPath: 'insuranceHistory.bonusMalus', label: 'Bonus-malus', type: 'number', required: true, withKnowledge: true },
    ],
  },
];

const response = fields => JSON.stringify({ fields });

describe('parseOcrResponse', () => {
  it('garde les champs canoniques du type de document, valeurs validées et confiance bornée', () => {
    const fields = parseOcrResponse(
      response([
        { canonicalPath: 'vehicle.registration', value: ' AB-123-CD ', confidence: 0.97 },
        { canonicalPath: 'vehicle.fiscalPower', value: '7', confidence: 1.4 },
        { canonicalPath: 'vehicle.firstRegistrationDate', value: '2019-03-12', confidence: -2 },
        { canonicalPath: 'vehicle.vehicleType', value: 'VP' },
      ]),
      'carte_grise',
      SCHEMA,
    );
    assert.deepEqual(fields, [
      { canonicalPath: 'vehicle.registration', value: 'AB-123-CD', confidence: 0.97 },
      { canonicalPath: 'vehicle.fiscalPower', value: 7, confidence: 1 },
      { canonicalPath: 'vehicle.firstRegistrationDate', value: '2019-03-12', confidence: 0 },
      { canonicalPath: 'vehicle.vehicleType', value: 'VP', confidence: 0 },
    ]);
  });

  it('écarte les chemins hors modèle, hors type de document ou hors questionnaire', () => {
    const fields = parseOcrResponse(
      response([
        { canonicalPath: 'vehicle.color', value: 'rouge', confidence: 0.9 },
        { canonicalPath: 'driver.licenseDate', value: '2010-01-01', confidence: 0.9 },
        { canonicalPath: 'vehicle.model', value: 'Clio', confidence: 0.9 },
        { canonicalPath: 'client.lastName', value: 'Dupont', confidence: 0.9 },
      ]),
      'carte_grise',
      SCHEMA,
    );
    assert.deepEqual(fields, []);
  });

  it("n'invente rien : valeurs vides ou invalides écartées, doublons ignorés", () => {
    const fields = parseOcrResponse(
      response([
        { canonicalPath: 'vehicle.brand', value: '', confidence: 0.9 },
        { canonicalPath: 'vehicle.registration', value: null, confidence: 0.9 },
        { canonicalPath: 'vehicle.firstRegistrationDate', value: '12/03/2019', confidence: 0.9 },
        { canonicalPath: 'vehicle.vehicleType', value: 'Camion', confidence: 0.9 },
        { canonicalPath: 'vehicle.fiscalPower', value: 'sept', confidence: 0.9 },
        { canonicalPath: 'vehicle.brand', value: 'Renault', confidence: 0.6 },
        { canonicalPath: 'vehicle.brand', value: 'Peugeot', confidence: 0.9 },
        'texte',
        null,
      ]),
      'carte_grise',
      SCHEMA,
    );
    assert.deepEqual(fields, [{ canonicalPath: 'vehicle.brand', value: 'Renault', confidence: 0.6 }]);
  });

  it('met un champ avec niveau de connaissance au format { value, knowledge }', () => {
    const fields = parseOcrResponse(
      '```json\n' + response([{ canonicalPath: 'insuranceHistory.bonusMalus', value: '0,85', confidence: 0.9 }]) + '\n```',
      'releve_information',
      SCHEMA,
    );
    assert.deepEqual(fields, [{ canonicalPath: 'insuranceHistory.bonusMalus', value: { value: 0.85, knowledge: 'KNOWN' }, confidence: 0.9 }]);
  });

  it('renvoie null pour une réponse inexploitable', () => {
    assert.equal(parseOcrResponse('Je ne peux pas lire ce document.', 'permis', SCHEMA), null);
    assert.equal(parseOcrResponse('{"champs": []}', 'permis', SCHEMA), null);
    assert.equal(parseOcrResponse('{pas du json}', 'permis', SCHEMA), null);
  });

  it('« autre » ne propose jamais rien', () => {
    assert.deepEqual(parseOcrResponse(response([{ canonicalPath: 'vehicle.brand', value: 'Renault', confidence: 1 }]), 'autre', SCHEMA), []);
    assert.equal(isAnalyzableDocumentType('autre'), false);
    assert.equal(isAnalyzableDocumentType('carte_grise'), true);
    assert.equal(isAnalyzableDocumentType('devis'), false);
  });
});

describe('consigne et questions OCR', () => {
  it('ne demande que les champs du questionnaire lisibles sur le document', () => {
    const questions = ocrQuestions(SCHEMA, 'permis');
    assert.deepEqual(questions.map(q => q.canonicalPath), ['driver.licenseDate']);
    const prompt = buildOcrPrompt('permis', questions);
    assert.match(prompt, /driver\.licenseDate/);
    assert.doesNotMatch(prompt, /vehicle\./);
  });
});

describe('chemins et noms de fichiers', () => {
  it("n'accepte que le dossier des documents de CE dossier", () => {
    assert.equal(isDossierDocumentPath('cabinets/A/dossiers/d1/documents/carte-grise.pdf', 'A', 'd1'), true);
    assert.equal(isDossierDocumentPath('cabinets/A/dossiers/d2/documents/carte-grise.pdf', 'A', 'd1'), false);
    assert.equal(isDossierDocumentPath('cabinets/A/dossiers/d1/documents/../devis/x.pdf', 'A', 'd1'), false);
    assert.equal(isDossierDocumentPath('cabinets/A/dossiers/d1/documents/.cache', 'A', 'd1'), false);
    assert.equal(isDossierDocumentPath('cabinets/A/dossiers/d1/documents/a/b.pdf', 'A', 'd1'), false);
  });

  it('rend un nom de fichier sûr', () => {
    assert.equal(safeDocumentFileName('Carte grise été 2024.PDF'), 'Carte-grise-ete-2024.PDF');
    assert.equal(safeDocumentFileName('../../etc/passwd'), 'etc-passwd');
    assert.equal(safeDocumentFileName('***'), 'document');
  });
});
