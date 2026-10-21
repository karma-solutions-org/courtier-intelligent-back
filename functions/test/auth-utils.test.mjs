// Identifiants reçus du client et placés dans un chemin Firestore ou Storage.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { requireId } = require('../lib/core/auth.utils.js');

describe('requireId', () => {
  it('accepte un identifiant Firestore ordinaire', () => {
    assert.equal(requireId(' Wv5zvDdYnr6ooXWPgFYz ', 'dossier'), 'Wv5zvDdYnr6ooXWPgFYz');
    assert.equal(requireId('cab-assureur-a', 'assureur'), 'cab-assureur-a');
  });

  it('refuse un identifiant qui ajouterait des segments au chemin ou que Firestore réserve', () => {
    for (const value of ['a/b', 'dossier/ci_documents/x', '.', '..', '__name__']) {
      assert.throws(() => requireId(value, 'dossier'), { code: 'invalid-argument' }, value);
    }
  });

  it('refuse un identifiant vide ou trop long au lieu de le tronquer', () => {
    assert.throws(() => requireId('   ', 'dossier'), { code: 'invalid-argument' });
    assert.throws(() => requireId(42, 'dossier'), { code: 'invalid-argument' });
    assert.throws(() => requireId('x'.repeat(201), 'dossier'), { code: 'invalid-argument' });
    assert.equal(requireId('x'.repeat(200), 'dossier').length, 200);
  });
});
