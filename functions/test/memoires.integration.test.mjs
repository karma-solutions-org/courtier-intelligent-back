// Tests d'intégration de la mémoire des formulaires dans les emulators : copie du cabinet, mémoire commune seulement quand
// 2 cabinets distincts apprennent la même association, extranets connus seulement, jamais de chemin vide,
// remplacement d'une ancienne version, invalidation par des cabinets distincts.
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
const doc = async (origin, fingerprint) => (await db.collection('ci_formMemories').doc(memoryKey(origin, fingerprint)).get());

let extA;
let extB;
let appA;
let cabinetA;

/** Mémoire commune : il faut que les deux cabinets apprennent la même association. */
async function learn(origin, fingerprint, fields) {
  const first = await call('memoires-enregistrer', extA, memory(origin, fingerprint, fields));
  assert.equal(first.data?.outcome, 'pending', JSON.stringify(first));
  return call('memoires-enregistrer', extB, memory(origin, fingerprint, fields));
}

/** Connexion de l'app puis de l'extension (auth_time différent) pour un compte. */
async function connect(email) {
  const app = await signIn(email);
  await ouvrir(app, DEVICE_A);
  await sleep(1100);
  const ext = await signIn(email);
  assert.deepEqual((await call('sessions-ouvrirExtension', ext, { deviceId: DEVICE_A })).data, { success: true });
  return { app, ext };
}

before(async () => {
  ops('seed-catalog');
  for (const [name, email] of [['A', 'memoire-a@test.fr'], ['B', 'memoire-b@test.fr']]) {
    const user = await admin.auth().createUser({ email, password: PASSWORD });
    const id = await createCabinet({ name: `Cabinet ${name}`, orias: null, ownerUid: user.uid, planId: 'essentiel' });
    if (name === 'A') cabinetA = id;
  }
  // Extranets « connus » : seuls les domaines du catalogue global alimentent la mémoire.
  await db.doc('ci_insurers/test-memoires').set({
    name: 'Test mémoires',
    extranetDomains: ['acces.fr', 'enregistrement.fr', 'versions.fr', 'autre.fr', 'invalidation.fr', 'utilisation.fr'],
    productsSupported: [],
  });
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

  it('refuse un extranet inconnu du catalogue global', async () => {
    const result = await call('memoires-enregistrer', extA, memory('https://pirate.example.com', 'v1:00000000000003'));
    assert.equal(result.error?.details?.reason, 'unknown_origin');
  });
});

describe('Enregistrement', () => {
  const origin = 'https://extranet.enregistrement.fr';
  const fp = 'v1:00000000000001';
  const fields = () => [field(), field({ fieldKey: 'radio:civilite', type: 'radio', label: 'Civilité', order: 1, canonicalPath: null, confidence: 0 })];

  it('un seul cabinet : copie du cabinet tout de suite, mémoire commune en attente ; jamais de chemin vide', async () => {
    const result = await call('memoires-enregistrer', extA, memory(origin, fp, fields()));

    assert.deepEqual(result.data, { key: memoryKey(origin, fp), outcome: 'pending', superseded: 0 });
    assert.equal((await doc(origin, fp)).exists, false);
    const own = (await db.doc(`ci_cabinets/${cabinetA}/ci_formMemories/${memoryKey(origin, fp)}`).get()).data();
    assert.deepEqual(own.fields.map(f => f.fieldKey), ['text:nom']);
    assert.equal((await call('memoires-enregistrer', extA, memory(origin, fp, fields()))).data.outcome, 'pending', 'un cabinet ne compte qu’une fois');
  });

  it('un deuxième cabinet qui apprend la même association la rend commune (structure seulement)', async () => {
    const result = await call('memoires-enregistrer', extB, memory(origin, fp, fields()));

    assert.equal(result.data.outcome, 'created');
    const stored = (await doc(origin, fp)).data();
    assert.equal(stored.origin, origin);
    assert.equal(stored.formFingerprint, fp);
    assert.equal(stored.version, 1);
    assert.equal(stored.hits, 2);
    assert.equal(stored.fields.length, 1);
    assert.deepEqual(Object.keys(stored.fields[0]).sort(), ['canonicalPath', 'confidence', 'fieldKey', 'label', 'order', 'type']);
    assert.ok(stored.createdAt && stored.lastUsedAt);
  });

  it('une même association confirmée ensuite compte une utilisation de plus', async () => {
    const result = await call('memoires-enregistrer', extA, memory(origin, fp, [field()]));
    assert.equal(result.data.outcome, 'confirmed');
    assert.equal((await doc(origin, fp)).data().hits, 3);
  });

  it("une association différente ne remplace pas une mémoire valide (un cabinet ne peut pas fausser celle des autres)", async () => {
    const result = await call('memoires-enregistrer', extB, memory(origin, fp, [field({ canonicalPath: 'driver.lastName' })]));

    assert.equal(result.data.outcome, 'kept');
    const stored = (await doc(origin, fp)).data();
    assert.equal(stored.fields[0].canonicalPath, 'client.lastName');
    assert.equal(stored.hits, 3);
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
  const form = names => names.map((k, i) => field({ fieldKey: `text:${k}`, label: k, order: i }));

  it("une nouvelle empreinte très proche de l'ancienne la remplace ; un formulaire différent la laisse", async () => {
    await learn(origin, 'v1:0000000000000a', form(keys));
    await learn(origin, 'v1:0000000000000b', form(['x', 'y', 'z', 'w', 'v']));
    assert.equal((await doc(origin, 'v1:0000000000000a')).exists, true, 'formulaire sans rapport : on ne supprime rien');

    const result = await learn(origin, 'v1:0000000000000c', form(['a', 'b', 'c', 'd', 'nouveau']));

    assert.equal(result.data.outcome, 'created');
    assert.equal(result.data.superseded, 1);
    assert.equal((await doc(origin, 'v1:0000000000000a')).exists, false, "l'ancienne version a disparu");
    assert.equal((await doc(origin, 'v1:0000000000000b')).exists, true);
    assert.equal((await doc(origin, 'v1:0000000000000c')).exists, true);
  });

  it("ne supprime pas la mémoire d'un autre assureur", async () => {
    await learn('https://extranet.autre.fr', 'v1:0000000000000d', form(keys));
    await learn(origin, 'v1:0000000000000e', form(keys));

    assert.equal((await doc('https://extranet.autre.fr', 'v1:0000000000000d')).exists, true);
  });

  const failing = { origin: 'https://extranet.invalidation.fr', fp: 'v1:0000000000000f' };

  it("un échec signalé par un seul cabinet n'invalide pas (même répété) ; deux cabinets distincts, si", async () => {
    await learn(failing.origin, failing.fp, [field()]);
    const key = memoryKey(failing.origin, failing.fp);

    assert.deepEqual((await call('memoires-invalider', extA, { key })).data, { invalidated: false });
    assert.deepEqual((await call('memoires-invalider', extA, { key })).data, { invalidated: false });
    let stored = (await doc(failing.origin, failing.fp)).data();
    assert.equal(stored.failures, 1);
    assert.equal(stored.invalidatedAt, undefined);
    assert.equal((await db.doc(`ci_cabinets/${cabinetA}/ci_formMemories/${key}`).get()).exists, false, 'la copie du cabinet tombe tout de suite');

    assert.deepEqual((await call('memoires-invalider', extB, { key })).data, { invalidated: true });
    stored = (await doc(failing.origin, failing.fp)).data();
    assert.equal(stored.failures, 2);
    assert.ok(stored.invalidatedAt);
    assert.ok(!JSON.stringify(stored).includes('memoire-a@test.fr'), "aucun identifiant de cabinet n'est stocké en clair");
  });

  it('une mémoire invalidée est réapprise (par 2 cabinets) : nouvelle version, compteurs remis à zéro', async () => {
    const result = await learn(failing.origin, failing.fp, [field({ canonicalPath: 'driver.lastName' })]);

    assert.equal(result.data.outcome, 'relearned');
    const stored = (await doc(failing.origin, failing.fp)).data();
    assert.equal(stored.version, 2);
    assert.equal(stored.hits, 2);
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
    await learn(origin, fp, [field()]);
    const key = memoryKey(origin, fp);

    await call('memoires-utiliser', extA, { key });
    assert.equal((await doc(origin, fp)).get('hits'), 2, 'moins d’une heure après la dernière utilisation');

    await db.collection('ci_formMemories').doc(key).update({ lastUsedAt: admin.firestore.Timestamp.fromMillis(Date.now() - 2 * 3600 * 1000) });
    await call('memoires-utiliser', extA, { key });
    assert.equal((await doc(origin, fp)).get('hits'), 3);
  });
});
