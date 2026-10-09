// Analyse du besoin : validation, trace des modifications et suggestions (sur le référentiel Auto du catalogue).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { diffNeed, EMPTY_NEED, isNeedValidatable, normalizeNeed, suggestNeed, validateNeed } = require('../lib/shared/index.js');
const { loadCatalog } = require('../lib/ops/catalog.js');

const auto = loadCatalog().catalog.products.find(p => p.id === 'auto');
const codes = auto.guaranteeCatalog.map(g => g.code);
const NOW = new Date('2026-10-09T12:00:00');

const need = overrides => ({ ...EMPTY_NEED, ...overrides });

describe('validateNeed', () => {
  it('accepte un besoin complet et un besoin vide', () => {
    assert.deepEqual(validateNeed(EMPTY_NEED, codes), []);
    assert.deepEqual(
      validateNeed(
        need({ coverageLevel: 'tous_risques', budgetMax: 650, maxDeductible: 0, mandatoryGuarantees: ['RC', 'VOL'], niceToHave: ['ASS'], notes: 'RAS' }),
        codes,
      ),
      [],
    );
  });

  it('refuse un niveau de couverture ou des montants invalides', () => {
    assert.match(validateNeed(need({ coverageLevel: 'luxe' }), codes).join(), /couverture/);
    assert.match(validateNeed(need({ budgetMax: -1 }), codes).join(), /Budget/);
    assert.match(validateNeed(need({ maxDeductible: '300' }), codes).join(), /Franchise/);
    assert.match(validateNeed(need({ budgetMax: Number.NaN }), codes).join(), /Budget/);
    assert.deepEqual(validateNeed(need({ budgetMax: 0 }), codes), [], '0 est un montant valide');
  });

  it('refuse une garantie inconnue, en double, ou à la fois indispensable et souhaitée', () => {
    assert.match(validateNeed(need({ mandatoryGuarantees: ['ZZZ'] }), codes).join(), /inconnue \(ZZZ\)/);
    assert.match(validateNeed(need({ niceToHave: ['ASS', 'ASS'] }), codes).join(), /double/);
    assert.match(validateNeed(need({ mandatoryGuarantees: ['VOL'], niceToHave: ['VOL'] }), codes).join(), /à la fois/);
  });

  it('refuse des notes trop longues et un besoin qui n’est pas un objet', () => {
    assert.match(validateNeed(need({ notes: 'x'.repeat(2001) }), codes).join(), /Notes/);
    assert.deepEqual(validateNeed(null, codes), ['Besoin invalide.']);
    assert.deepEqual(validateNeed([], codes), ['Besoin invalide.']);
    assert.match(validateNeed(need({ mandatoryGuarantees: 'RC' }), codes).join(), /liste/);
  });
});

describe('diffNeed (trace des modifications)', () => {
  const base = need({ coverageLevel: 'tiers', budgetMax: 500, mandatoryGuarantees: ['RC', 'DR'] });

  it('ne signale rien quand rien ne change, même si l’ordre des garanties ou les espaces des notes changent', () => {
    assert.deepEqual(diffNeed(base, need({ coverageLevel: 'tiers', budgetMax: 500, mandatoryGuarantees: ['DR', 'RC'] })), []);
    assert.deepEqual(diffNeed(need({ notes: 'a' }), need({ notes: '  a  ' })), []);
    assert.deepEqual(diffNeed(need({ notes: null }), need({ notes: '   ' })), []);
  });

  it('liste les champs modifiés', () => {
    const changed = diffNeed(base, need({ coverageLevel: 'tous_risques', budgetMax: 500, mandatoryGuarantees: ['RC'], notes: 'client pressé' }));
    assert.deepEqual(changed.sort(), ['coverageLevel', 'mandatoryGuarantees', 'notes']);
  });

  it('un premier enregistrement compare avec un besoin vide', () => {
    assert.deepEqual(diffNeed(null, need({ budgetMax: 0 })), ['budgetMax'], '0 ≠ non renseigné');
    assert.deepEqual(diffNeed(null, EMPTY_NEED), []);
  });
});

describe('normalizeNeed / isNeedValidatable', () => {
  it('écarte les champs inconnus et trie les garanties', () => {
    const normalized = normalizeNeed({ ...need({ mandatoryGuarantees: ['VOL', 'RC'] }), extra: 1, validatedAt: 'x' });
    assert.deepEqual(normalized.mandatoryGuarantees, ['RC', 'VOL']);
    assert.ok(!('extra' in normalized) && !('validatedAt' in normalized));
  });

  it('un besoin se valide dès que la couverture est choisie', () => {
    assert.equal(isNeedValidatable(null), false);
    assert.equal(isNeedValidatable({ coverageLevel: null }), false);
    assert.equal(isNeedValidatable({ coverageLevel: 'tiers' }), true);
  });
});

describe('suggestNeed', () => {
  const suggest = (data, productId = 'auto') => suggestNeed(productId, data, codes, NOW);

  it('véhicule récent → tous risques et garanties dommages', () => {
    const s = suggest({ 'vehicle.firstRegistrationDate': '2024-05-01' });
    assert.equal(s.coverageLevel, 'tous_risques');
    assert.deepEqual(s.mandatoryGuarantees.sort(), ['BDG', 'DR', 'DTC', 'INC', 'RC', 'VOL']);
    assert.ok(s.reasons.some(r => /récent \(2 ans\)/.test(r)));
  });

  it('véhicule de valeur élevée → tous risques, même s’il est ancien', () => {
    assert.equal(suggest({ 'vehicle.firstRegistrationDate': '2012-01-01', 'vehicle.vehicleValue': 30000 }).coverageLevel, 'tous_risques');
  });

  it('véhicule d’âge moyen → tiers étendu ; ancien → tiers', () => {
    assert.equal(suggest({ 'vehicle.firstRegistrationDate': '2019-05-01' }).coverageLevel, 'tiers_plus');
    const old = suggest({ 'vehicle.firstRegistrationDate': '2005-05-01' });
    assert.equal(old.coverageLevel, 'tiers');
    assert.deepEqual(old.mandatoryGuarantees.sort(), ['DR', 'RC']);
  });

  it('stationnement sur la voie publique → vol indispensable', () => {
    const s = suggest({ 'vehicle.firstRegistrationDate': '2005-05-01', 'vehicle.parkingType': 'voie_publique' });
    assert.ok(s.mandatoryGuarantees.includes('VOL'));
  });

  it('usage professionnel → équipements et véhicule de remplacement souhaités', () => {
    const s = suggest({ 'vehicle.firstRegistrationDate': '2019-05-01', 'vehicle.usage': 'professionnel' });
    assert.ok(s.niceToHave.includes('EQP') && s.niceToHave.includes('VRP'));
  });

  it('une garantie n’est jamais à la fois indispensable et souhaitée', () => {
    const s = suggest({ 'vehicle.firstRegistrationDate': '2024-05-01', 'vehicle.usage': 'professionnel' });
    assert.deepEqual(s.mandatoryGuarantees.filter(c => s.niceToHave.includes(c)), []);
  });

  it('sans information sur le véhicule, ne suggère aucune couverture (rien d’inventé) ni budget', () => {
    const s = suggest({});
    assert.equal(s.coverageLevel, null);
    assert.ok(!('budgetMax' in s) && !('maxDeductible' in s));
  });

  it('une date future ou invalide est ignorée', () => {
    assert.equal(suggest({ 'vehicle.firstRegistrationDate': '2030-01-01' }).coverageLevel, null);
    assert.equal(suggest({ 'vehicle.firstRegistrationDate': 'hier' }).coverageLevel, null);
  });

  it('ne propose que des garanties du référentiel du produit, et rien pour un autre produit', () => {
    const limited = suggestNeed('auto', { 'vehicle.firstRegistrationDate': '2024-05-01' }, ['RC', 'VOL'], NOW);
    assert.deepEqual(limited.mandatoryGuarantees.sort(), ['RC', 'VOL']);
    assert.deepEqual(suggest({ 'vehicle.firstRegistrationDate': '2024-05-01' }, 'habitation'), {
      coverageLevel: null,
      mandatoryGuarantees: [],
      niceToHave: [],
      reasons: [],
    });
  });

  it('toute suggestion est un besoin valide', () => {
    const s = suggest({ 'vehicle.firstRegistrationDate': '2024-05-01', 'vehicle.usage': 'professionnel', 'vehicle.parkingType': 'voie_publique' });
    assert.deepEqual(
      validateNeed({ ...EMPTY_NEED, coverageLevel: s.coverageLevel, mandatoryGuarantees: s.mandatoryGuarantees, niceToHave: s.niceToHave }, codes),
      [],
    );
  });
});
