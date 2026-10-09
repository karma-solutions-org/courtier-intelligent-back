// Mémoire partagée des formulaires : clé de document, validation stricte de la structure, recouvrement des versions.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fieldOverlap, looksLikePersonalData, memoryKey, sameMapping, validateMemoryInput } = require('../lib/core/form-memory.utils.js');

const field = (overrides = {}) => ({ fieldKey: 'text:nom', label: 'Nom', type: 'text', order: 0, canonicalPath: 'client.lastName', confidence: 0.9, ...overrides });
const input = (overrides = {}) => ({ origin: 'https://extranet.assureur-a.fr', formFingerprint: 'v1:0123456789abcd', fields: [field()], ...overrides });
const rejects = (data, pattern) => assert.throws(() => validateMemoryInput(data), error => pattern.test(error.message));

describe('memoryKey', () => {
  it('est le sha256 hexadécimal tronqué à 32 caractères de « origine|empreinte » (l\'extension calcule la même chose)', () => {
    // Vecteur de référence, repris à l'identique dans les tests de l'extension.
    assert.equal(memoryKey('https://extranet.assureur-a.fr', 'v1:0123456789abcd'), '2fe4dee1e2591c20e03a9bc47a9abe63');
  });

  it('change avec l\'origine et avec l\'empreinte', () => {
    const base = memoryKey('https://a.fr', 'v1:0123456789abcd');
    assert.notEqual(base, memoryKey('https://b.fr', 'v1:0123456789abcd'));
    assert.notEqual(base, memoryKey('https://a.fr', 'v1:0123456789abce'));
    assert.equal(base, memoryKey('https://a.fr', 'v1:0123456789abcd'));
  });
});

describe('validateMemoryInput : seule de la structure est acceptée', () => {
  it('accepte une mémoire valide, avec un champ sans équivalent (chemin null)', () => {
    const result = validateMemoryInput(input({ fields: [field(), field({ fieldKey: 'radio:civilite', type: 'radio', label: 'Civilité', order: 1, canonicalPath: null, confidence: 0 })] }));
    assert.equal(result.fields.length, 2);
    assert.equal(result.fields[1].canonicalPath, null);
  });

  it('arrondit la confiance et garde les champs dans leur ordre', () => {
    assert.equal(validateMemoryInput(input({ fields: [field({ confidence: 0.87654 })] })).fields[0].confidence, 0.88);
  });

  it('refuse une origine invalide (http, chemin, schéma inconnu)', () => {
    for (const origin of ['http://extranet.assureur-a.fr', 'https://extranet.assureur-a.fr/devis', 'javascript:alert(1)', 'extranet.assureur-a.fr', '', 42]) {
      rejects(input({ origin }), /Origine/);
    }
    assert.doesNotThrow(() => validateMemoryInput(input({ origin: 'http://localhost:8080' })));
  });

  it('refuse une empreinte invalide', () => {
    for (const formFingerprint of ['', 'v1:xyz', '0123456789abcd', 'v1:0123456789ABCD']) rejects(input({ formFingerprint }), /Empreinte/);
  });

  it('refuse une liste de champs vide, trop longue ou qui n\'est pas une liste', () => {
    rejects(input({ fields: [] }), /champs attendus/);
    rejects(input({ fields: 'x' }), /champs attendus/);
    rejects(input({ fields: Array.from({ length: 301 }, (_, i) => field({ fieldKey: `text:f${i}` })) }), /champs attendus/);
  });

  it('refuse un chemin hors du modèle canonique', () => {
    rejects(input({ fields: [field({ canonicalPath: 'client.shoeSize' })] }), /hors du modèle canonique/);
    rejects(input({ fields: [field({ canonicalPath: '__proto__' })] }), /hors du modèle canonique/);
    rejects(input({ fields: [field({ canonicalPath: 42 })] }), /hors du modèle canonique/);
  });

  it('refuse toute propriété en plus : une valeur ne peut pas se glisser dans la mémoire', () => {
    rejects(input({ fields: [field({ value: 'Dupont' })] }), /propriété inattendue \(value\)/);
    rejects(input({ fields: [field({ valeur: 'Dupont', client: 'x' })] }), /propriété inattendue/);
  });

  it('refuse un libellé qui ressemble à une donnée personnelle', () => {
    for (const label of ['jean.dupont@example.fr', '06 12 34 56 78', '0612345678', 'FR7630006000011234567890189', 'x'.repeat(121)]) {
      rejects(input({ fields: [field({ label })] }), /libellé invalide/);
    }
    assert.doesNotThrow(() => validateMemoryInput(input({ fields: [field({ label: 'Date de première mise en circulation (JJ/MM/AAAA)' })] })));
    assert.doesNotThrow(() => validateMemoryInput(input({ fields: [field({ label: null })] })));
  });

  it('refuse une clé de champ qui n\'est pas de la structure, ou en double', () => {
    for (const fieldKey of ['Nom', 'text:', 'text:Dupont Jean', 'text:' + 'a'.repeat(101), 'text:a@b.fr', 'autre:nom']) {
      rejects(input({ fields: [field({ fieldKey })] }), /clé invalide|type invalide/);
    }
    rejects(input({ fields: [field(), field()] }), /en double/);
    assert.doesNotThrow(() => validateMemoryInput(input({ fields: [field({ fieldKey: 'text:nom' }), field({ fieldKey: 'text:nom#2', order: 1 })] })));
  });

  it('refuse un type inconnu ou différent de celui de la clé, un ordre ou une confiance invalides', () => {
    rejects(input({ fields: [field({ type: 'iframe', fieldKey: 'iframe:nom' })] }), /type invalide/);
    rejects(input({ fields: [field({ type: 'select' })] }), /type invalide/);
    rejects(input({ fields: [field({ order: -1 })] }), /ordre invalide/);
    rejects(input({ fields: [field({ order: 1.5 })] }), /ordre invalide/);
    for (const confidence of [-0.1, 1.1, '0.9', NaN, undefined]) rejects(input({ fields: [field({ confidence })] }), /confiance invalide/);
  });

  it('refuse un corps qui n\'est pas un objet', () => {
    for (const data of [null, undefined, 'x', 42, []]) rejects(data, /Origine/);
  });
});

describe('looksLikePersonalData', () => {
  it('repère e-mails, numéros et IBAN, pas les libellés de formulaire', () => {
    assert.equal(looksLikePersonalData('a@b.fr'), true);
    assert.equal(looksLikePersonalData('06.12.34.56.78'), true);
    assert.equal(looksLikePersonalData('12/03/1985 75002 Paris'), true); // une date et un code postal saisis ne sont pas un libellé
    assert.equal(looksLikePersonalData('Code postal'), false);
    assert.equal(looksLikePersonalData('Puissance fiscale (CV)'), false);
  });
});

describe('sameMapping / fieldOverlap', () => {
  it('compare les associations, sans tenir compte de l\'ordre ni de la confiance', () => {
    const a = [field(), field({ fieldKey: 'text:prenom', canonicalPath: 'client.firstName' })];
    const b = [field({ fieldKey: 'text:prenom', canonicalPath: 'client.firstName', confidence: 0.5 }), field({ confidence: 0.99 })];
    assert.equal(sameMapping(a, b), true);
    assert.equal(sameMapping(a, [field({ canonicalPath: 'client.firstName' }), a[1]]), false);
  });

  it('mesure combien de champs de l\'ancien formulaire se retrouvent dans le nouveau', () => {
    const old = ['a', 'b', 'c', 'd'].map(k => ({ fieldKey: `text:${k}` }));
    assert.equal(fieldOverlap(old, ['a', 'b', 'c', 'x'].map(k => ({ fieldKey: `text:${k}` }))), 0.75);
    assert.equal(fieldOverlap(old, [{ fieldKey: 'text:z' }]), 0);
    assert.equal(fieldOverlap([], old), 0);
  });
});
