// Tests d'intégration de la mémoire partagée des formulaires dans les emulators : écriture validée par les functions
// memoires-*, confirmation, mémoire conservée, remplacement d'une ancienne version, invalidation par des cabinets distincts.
// Lancer avec : npm run test:integration
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { call, DEVICE_A, ops, ouvrir, PASSWORD, signIn } from './helpers.mjs';

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
const { createCabinet } = require('../lib/core/cabinet.utils.js');
const { memoryKey } = require('../lib/core/form-memory.utils.js');

admin.initializeApp({ projectId: 'demo-courtier-intelligent' });
const db = admin.firestore();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const field = (overrides = {}) => ({ fieldKey: 'text:nom', label: 'Nom', type: 'text', order: 0, canonicalPath: 'client.lastName', confidence: 0.9, ...overrides });
const memory = (origin, fingerprint, fields = [field()]) => ({ origin, formFingerprint: fingerprint, fields });
const doc = async (origin, fingerprint) => (await db.collection('formMemories').doc(memoryKey(origin, fingerprint)).get());

let extA;
let extB;
let appA;

/** Connexion de l'app puis de l'extension (auth_time différent) pour un compte. */
async function connect(email) {
  const app = await signIn(email);
  await ouvrir(app, DEVICE_A);
  await sleep(1100);
  const ext = await signIn(email);
  assert.deepEqual((await call('sessions-ouvrirExtension', ext)).data, { success: true });
  return { app, ext };
}

before(async () => {
  ops('seed-catalog');
  for (const [name, email] of [['A', 'memoire-a@test.fr'], ['B', 'memoire-b@test.fr']]) {
    const user = await admin.auth().createUser({ email, password: PASSWORD });
    await createCabinet({ name: `Cabinet ${name}`, orias: null, ownerUid: user.uid, planId: 'essentiel' });
  }
  ({ app: appA, ext: extA } = await connect('memoire-a@test.fr'));
  ({ ext: extB } = await connect('memoire-b@test.fr'));
});

describe('Accès', () => {
  it("le jeton de l'app (ni celui d'un inconnu) n'écrit pas dans la mémoire : seule l'extension connectée le peut", async () => {
    const denied = await call('memoires-enregistrer', appA, memory('https://extranet.acces.fr', 'v1:0000000000000a'));
    assert.equal(denied.error?.status, 'PERMISSION_DENIED');
    assert.equal(denied.error.details?.reason, 'extension_session_closed');
    assert.equal((await doc('https://extranet.acces.fr', 'v1:0000000000000a')).exists, false);
  });
});

describe('Enregistrement', () => {
  const origin = 'https://extranet.enregistrement.fr';
  const fp = 'v1:00000000000001';

  it('crée la mémoire : structure seulement, clé calculée, première utilisation', async () => {
    const result = await call('memoires-enregistrer', extA, memory(origin, fp, [field(), field({ fieldKey: 'radio:civilite', type: 'radio', label: 'Civilité', order: 1, canonicalPath: null, confidence: 0 })]));

    assert.deepEqual(result.data, { key: memoryKey(origin, fp), outcome: 'created', superseded: 0 });
    const stored = (await doc(origin, fp)).data();
    assert.equal(stored.origin, origin);
    assert.equal(stored.formFingerprint, fp);
    assert.equal(stored.version, 1);
    assert.equal(stored.hits, 1);
    assert.equal(stored.fields.length, 2);
    assert.equal(stored.fields[1].canonicalPath, null);
    assert.deepEqual(Object.keys(stored.fields[0]).sort(), ['canonicalPath', 'confidence', 'fieldKey', 'label', 'order', 'type']);
    assert.ok(stored.createdAt && stored.lastUsedAt);
  });

  it('une même association confirmée par un autre cabinet compte une utilisation de plus', async () => {
    const result = await call('memoires-enregistrer', extB, memory(origin, fp, [field(), field({ fieldKey: 'radio:civilite', type: 'radio', label: 'Civilité', order: 1, canonicalPath: null, confidence: 0 })]));

    assert.equal(result.data.outcome, 'confirmed');
    const stored = (await doc(origin, fp)).data();
    assert.equal(stored.hits, 2);
    assert.equal(stored.version, 1);
  });

  it("une association différente ne remplace pas une mémoire valide (un cabinet ne peut pas fausser celle des autres)", async () => {
    const result = await call('memoires-enregistrer', extB, memory(origin, fp, [field({ canonicalPath: 'driver.lastName' })]));

    assert.equal(result.data.outcome, 'kept');
    const stored = (await doc(origin, fp)).data();
    assert.equal(stored.fields[0].canonicalPath, 'client.lastName');
    assert.equal(stored.hits, 2);
  });

  it('refuse une mémoire qui contient autre chose que de la structure, sans rien écrire', async () => {
    const attempts = [
      memory(origin, 'v1:00000000000002', [field({ valeur: 'Dupont' })]),
      memory(origin, 'v1:00000000000002', [field({ label: 'jean.dupont@example.fr' })]),
      memory(origin, 'v1:00000000000002', [field({ canonicalPath: 'client.inconnu' })]),
      memory('http://non-securise.fr', 'v1:00000000000002'),
      memory(origin, 'pas-une-empreinte'),
      { ...memory(origin, 'v1:00000000000002'), fields: [] },
    ];
    for (const attempt of attempts) {
      assert.equal((await call('memoires-enregistrer', extA, attempt)).error?.status, 'INVALID_ARGUMENT', JSON.stringify(attempt).slice(0, 90));
    }
    assert.equal((await doc(origin, 'v1:00000000000002')).exists, false);
  });
});

describe("Invalidation : le formulaire change, puis réapprentissage", () => {
  const origin = 'https://extranet.versions.fr';
  const keys = ['a', 'b', 'c', 'd', 'e'];
  const form = names => names.map((k, i) => field({ fieldKey: `text:${k}`, label: k, order: i, canonicalPath: null, confidence: 0 }));

  it("une nouvelle empreinte très proche de l'ancienne la remplace ; un formulaire différent la laisse", async () => {
    await call('memoires-enregistrer', extA, memory(origin, 'v1:0000000000000a', form(keys)));
    await call('memoires-enregistrer', extA, memory(origin, 'v1:0000000000000b', form(['x', 'y', 'z', 'w', 'v'])));
    assert.equal((await doc(origin, 'v1:0000000000000a')).exists, true, 'formulaire sans rapport : on ne supprime rien');

    const result = await call('memoires-enregistrer', extA, memory(origin, 'v1:0000000000000c', form(['a', 'b', 'c', 'd', 'nouveau'])));

    assert.equal(result.data.outcome, 'created');
    assert.equal(result.data.superseded, 1);
    assert.equal((await doc(origin, 'v1:0000000000000a')).exists, false, "l'ancienne version a disparu");
    assert.equal((await doc(origin, 'v1:0000000000000b')).exists, true);
    assert.equal((await doc(origin, 'v1:0000000000000c')).exists, true);
  });

  it("ne supprime pas la mémoire d'un autre assureur", async () => {
    await call('memoires-enregistrer', extA, memory('https://extranet.autre.fr', 'v1:0000000000000d', form(keys)));
    await call('memoires-enregistrer', extA, memory(origin, 'v1:0000000000000e', form(keys)));

    assert.equal((await doc('https://extranet.autre.fr', 'v1:0000000000000d')).exists, true);
  });

  const failing = { origin: 'https://extranet.invalidation.fr', fp: 'v1:0000000000000f' };

  it("un échec signalé par un seul cabinet n'invalide pas (même répété) ; deux cabinets distincts, si", async () => {
    await call('memoires-enregistrer', extA, memory(failing.origin, failing.fp));
    const key = memoryKey(failing.origin, failing.fp);

    assert.deepEqual((await call('memoires-invalider', extA, { key })).data, { invalidated: false });
    assert.deepEqual((await call('memoires-invalider', extA, { key })).data, { invalidated: false });
    let stored = (await doc(failing.origin, failing.fp)).data();
    assert.equal(stored.failures, 1);
    assert.equal(stored.invalidatedAt, undefined);

    assert.deepEqual((await call('memoires-invalider', extB, { key })).data, { invalidated: true });
    stored = (await doc(failing.origin, failing.fp)).data();
    assert.equal(stored.failures, 2);
    assert.ok(stored.invalidatedAt);
    assert.ok(!JSON.stringify(stored).includes('memoire-a@test.fr'), "aucun identifiant de cabinet n'est stocké en clair");
  });

  it('une mémoire invalidée est réapprise : nouvelle version, compteurs remis à zéro', async () => {
    const corrected = [field({ canonicalPath: 'driver.lastName' })];

    const result = await call('memoires-enregistrer', extB, memory(failing.origin, failing.fp, corrected));

    assert.equal(result.data.outcome, 'relearned');
    const stored = (await doc(failing.origin, failing.fp)).data();
    assert.equal(stored.version, 2);
    assert.equal(stored.hits, 1);
    assert.equal(stored.failures, 0);
    assert.equal(stored.invalidatedAt, undefined);
    assert.equal(stored.fields[0].canonicalPath, 'driver.lastName');
  });

  it('refuse une clé invalide, et ignore une mémoire inconnue', async () => {
    assert.equal((await call('memoires-invalider', extA, { key: 'pas-une-cle' })).error?.status, 'INVALID_ARGUMENT');
    assert.deepEqual((await call('memoires-invalider', extA, { key: 'a'.repeat(32) })).data, { invalidated: false });
  });
});

describe('Utilisation', () => {
  const origin = 'https://extranet.utilisation.fr';
  const fp = 'v1:00000000000010';

  it("compte une utilisation, au plus une fois par heure (pas d'écriture à chaque page)", async () => {
    await call('memoires-enregistrer', extA, memory(origin, fp));
    const key = memoryKey(origin, fp);

    await call('memoires-utiliser', extA, { key });
    assert.equal((await doc(origin, fp)).get('hits'), 1, 'moins d’une heure après la dernière utilisation');

    await db.collection('formMemories').doc(key).update({ lastUsedAt: admin.firestore.Timestamp.fromMillis(Date.now() - 2 * 3600 * 1000) });
    await call('memoires-utiliser', extA, { key });
    assert.equal((await doc(origin, fp)).get('hits'), 2);
  });
});
