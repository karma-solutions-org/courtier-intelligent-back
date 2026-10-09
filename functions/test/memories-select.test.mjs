// Script ops `memories` : sélection des mémoires à purger.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatRow, hasCriteria, selectMemories } = require('../lib/ops/memories-select.js');

const NOW = new Date('2026-10-09T12:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 3600 * 1000);
const row = (key, overrides = {}) => ({
  key,
  origin: 'https://extranet.assureur-a.fr',
  formFingerprint: 'v1:0123456789abcd',
  version: 1,
  fieldCount: 12,
  hits: 3,
  failures: 0,
  invalidated: false,
  lastUsedAt: daysAgo(1),
  createdAt: daysAgo(30),
  ...overrides,
});

const rows = [
  row('a'),
  row('b', { invalidated: true, failures: 2 }),
  row('c', { origin: 'https://courtiers.assureur-b.com', lastUsedAt: daysAgo(200) }),
  row('d', { lastUsedAt: null, createdAt: daysAgo(400) }),
  row('e', { lastUsedAt: null, createdAt: daysAgo(2) }),
];
const keys = criteria => selectMemories(rows, criteria, NOW).map(r => r.key);

describe('selectMemories', () => {
  it('sans critère, ne sélectionne rien : purger ne vide jamais toute la mémoire partagée', () => {
    assert.equal(hasCriteria({}), false);
    assert.equal(hasCriteria({ invalidated: false }), false);
    assert.deepEqual(keys({}), []);
  });

  it('par clé, par origine, par statut invalidé', () => {
    assert.deepEqual(keys({ key: 'c' }), ['c']);
    assert.deepEqual(keys({ origin: 'https://courtiers.assureur-b.com' }), ['c']);
    assert.deepEqual(keys({ invalidated: true }), ['b']);
    assert.deepEqual(keys({ key: 'zzz' }), []);
  });

  it('par ancienneté : sans utilisation depuis plus de N jours (la date de création sert à défaut)', () => {
    assert.deepEqual(keys({ olderThanDays: 180 }), ['c', 'd']);
    assert.deepEqual(keys({ olderThanDays: 0 }), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(keys({ olderThanDays: 500 }), []);
  });

  it('cumule les critères : ils doivent tous correspondre', () => {
    assert.deepEqual(keys({ origin: 'https://extranet.assureur-a.fr', olderThanDays: 180 }), ['d']);
    assert.deepEqual(keys({ origin: 'https://courtiers.assureur-b.com', invalidated: true }), []);
  });
});

describe('formatRow', () => {
  it('résume une mémoire sur une ligne, en signalant celle qui est invalidée', () => {
    const line = formatRow(row('b', { invalidated: true, failures: 2 }));
    assert.match(line, /^b  https:\/\/extranet\.assureur-a\.fr  v1:0123456789abcd  v1  12 champs  3 utilisation\(s\)  2 échec\(s\)  INVALIDÉE/);
    assert.match(formatRow(row('a')), /dernière utilisation 2026-10-08/);
    assert.match(formatRow(row('d', { lastUsedAt: null })), /dernière utilisation —/);
  });
});
