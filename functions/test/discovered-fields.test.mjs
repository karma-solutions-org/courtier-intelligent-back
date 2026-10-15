// Champs découverts sur les extranets : filtre, fusion des doublons, création des questions.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isCanonicalPath, isRelevantField, mergeDiscoveredFields, schemaForCabinet, DISCOVERED_SECTION_TITLE } = require('../lib/shared/index.js');

const SCHEMA = [
  {
    title: 'Véhicule',
    questions: [{ canonicalPath: 'vehicle.brand', label: 'Marque', type: 'text', required: true }],
  },
];
const field = (label, extra = {}) => ({
  fieldKey: `text:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  label,
  kind: 'text',
  inputType: 'text',
  name: null,
  section: null,
  options: [],
  ...extra,
});
const A = { insurerId: 'assureur-a', origin: 'https://extranet-a.fr' };
const B = { insurerId: 'assureur-b', origin: 'https://extranet-b.fr' };

describe('Champs découverts', () => {
  it('crée une question facultative dans « Questions des assureurs »', () => {
    const { schema, added, mapping } = mergeDiscoveredFields(SCHEMA, [field('Kilométrage annuel :', { kind: 'number', inputType: 'number' })], A);
    assert.equal(added.length, 1);
    const section = schema.at(-1);
    assert.equal(section.title, DISCOVERED_SECTION_TITLE);
    assert.equal(section.discovered, true);
    assert.deepEqual(section.questions[0], {
      canonicalPath: 'extra.kilometrage_annuel',
      label: 'Kilométrage annuel',
      type: 'number',
      required: false,
      discoveredOn: [{ ...A, fieldKey: 'text:kilom-trage-annuel-' }],
    });
    assert.equal(mapping['text:kilom-trage-annuel-'], 'extra.kilometrage_annuel');
    assert.ok(isCanonicalPath('extra.kilometrage_annuel'));
    assert.equal(SCHEMA.length, 1, 'le questionnaire reçu n’est pas modifié');
  });

  it('fusionne le même champ vu chez un autre assureur (ordre des mots, accents, articles)', () => {
    const first = mergeDiscoveredFields(SCHEMA, [field('Kilométrage annuel')], A);
    const second = mergeDiscoveredFields(first.schema, [field('Le kilometrage annuel *', { fieldKey: 'text:km' })], B);
    assert.equal(second.added.length, 0);
    const question = second.schema.at(-1).questions[0];
    assert.deepEqual(question.discoveredOn.map(s => s.insurerId), ['assureur-a', 'assureur-b']);
    assert.equal(second.mapping['text:km'], 'extra.kilometrage_annuel');
  });

  it('rattache à une question existante de la liste fermée au lieu d’en créer une', () => {
    const { added, mapping } = mergeDiscoveredFields(SCHEMA, [field('Marque', { fieldKey: 'text:mq' })], A);
    assert.equal(added.length, 0);
    assert.equal(mapping['text:mq'], 'vehicle.brand');
  });

  it('ignore captcha, mot de passe, CGU, newsletter, champs cachés', () => {
    for (const f of [
      field('Recopiez le captcha'),
      field('Mot de passe', { inputType: 'password' }),
      field("J'accepte les CGU", { kind: 'checkbox', inputType: 'checkbox' }),
      field('Recevoir la newsletter'),
      field('Jeton', { inputType: 'hidden' }),
    ]) {
      assert.equal(isRelevantField(f), false, f.label);
    }
    assert.equal(mergeDiscoveredFields(SCHEMA, [field('Recopiez le captcha')], A).added.length, 0);
  });

  it('une liste devient un choix, sans l’option vide', () => {
    const { added } = mergeDiscoveredFields(
      SCHEMA,
      [field('Situation familiale', { kind: 'select', inputType: 'select', options: [{ value: '', label: 'Choisir…' }, { value: 'C', label: 'Célibataire' }, { value: 'M', label: 'Marié(e)' }] })],
      A,
    );
    assert.equal(added[0].type, 'choice');
    assert.deepEqual(added[0].choices, [{ value: 'C', label: 'Célibataire' }, { value: 'M', label: 'Marié(e)' }]);
  });

  it('deux libellés différents au même code reçoivent des chemins distincts', () => {
    const { added } = mergeDiscoveredFields(SCHEMA, [field('Usage : loisir'), field('Usage loisir ?', { fieldKey: 'text:u2' })], A);
    assert.equal(added.length, 1, 'même sens : fusionnés dans le même signalement');
  });
});

describe('Exigences des extranets', () => {
  const { applyInsurerRequirements, computeMissing } = require('../lib/shared/index.js');
  const schema = [
    {
      title: 'Historique',
      questions: [
        { canonicalPath: 'insuranceHistory.bonusMalus', label: 'Bonus-malus', type: 'number', required: false, withKnowledge: true },
        { canonicalPath: 'driver.profession', label: 'Profession', type: 'text', required: false },
      ],
    },
  ];

  it('rend obligatoires les champs exigés, et exige un chiffre pour une question à niveau de connaissance', () => {
    const { schema: next, changed } = applyInsurerRequirements(schema, ['insuranceHistory.bonusMalus', 'driver.profession']);
    assert.equal(changed, true);
    assert.deepEqual(next[0].questions.map(q => [q.required, q.mustBeKnown]), [[true, true], [true, undefined]]);
    assert.equal(applyInsurerRequirements(next, ['insuranceHistory.bonusMalus']).changed, false, 'déjà appliqué');
  });

  it('« le client ne sait pas » ne suffit plus pour un chiffre exigé', () => {
    const { schema: next } = applyInsurerRequirements(schema, ['insuranceHistory.bonusMalus']);
    const unknown = { 'insuranceHistory.bonusMalus': { value: null, knowledge: 'DECLARED_UNKNOWN' } };
    assert.deepEqual(computeMissing(next, unknown), ['insuranceHistory.bonusMalus']);
    assert.deepEqual(computeMissing(next, { 'insuranceHistory.bonusMalus': { value: 0.85, knowledge: 'KNOWN' } }), []);
  });

  it('un champ découvert obligatoire sur l’extranet crée une question obligatoire', () => {
    const { added } = mergeDiscoveredFields(SCHEMA, [field('Kilométrage annuel', { required: true })], A);
    assert.equal(added[0].required, true);
  });
});

describe('schemaForCabinet', () => {
  const learned = (insurerId) => ({
    canonicalPath: `extra.${insurerId}`, label: insurerId, type: 'text', required: true,
    discoveredOn: [{ insurerId, origin: 'https://x', fieldKey: 'k' }],
  });
  const schema = [...SCHEMA, { title: DISCOVERED_SECTION_TITLE, discovered: true, questions: [learned('axa'), learned('maif')] }];

  it('garde seulement les questions des assureurs activés', () => {
    const result = schemaForCabinet(schema, ['maif']);
    assert.deepEqual(result.flatMap(s => s.questions.map(q => q.label)), ['Marque', 'maif']);
  });

  it('retire la section découverte quand elle est vide', () => {
    assert.equal(schemaForCabinet(schema, ['allianz']).length, 1);
  });

  it('aucun assureur choisi : tout le questionnaire', () => {
    assert.equal(schemaForCabinet(schema, []), schema);
  });
});
