// Tests d'intégration des Cloud Functions dans les emulators (auth + firestore + functions) :
// appareil unique, journal d'audit, réinitialisation avec quota, délai de grâce, cabinet désactivé et scripts ops.
// Lancer avec : npm run test:integration
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
const { createCabinet } = require('../lib/core/cabinet.utils.js');
const { setCabinetClaims } = require('../lib/core/auth.utils.js');
const functionsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROJECT = 'demo-courtier-intelligent';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FUNCTIONS = process.env.CALLABLES_HOST ?? '127.0.0.1:5001';
const PASSWORD = 'motdepasse-de-test';
const DEVICE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DEVICE_B = 'bbbbbbbb-bbbbbb-bbbb-bbbb-bbbbbbbbbbbb';

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Connexion par mot de passe : un nouveau jeton, avec un nouvel auth_time (en secondes). */
async function signIn(email) {
  const response = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  return (await response.json()).idToken;
}

/** Appelle une callable ; renvoie { data } ou { error: { status, message, details } }. */
async function call(name, token, data = {}) {
  const response = await fetch(`http://${FUNCTIONS}/${PROJECT}/europe-west3/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
  });
  const body = await response.json();
  return body.error ? { error: body.error } : { data: body.result };
}

const ouvrir = (token, deviceId) => call('sessions-ouvrir', token, { deviceId, appareil: `Chrome · ${deviceId.substring(0, 1)}` });
const ops = (script, ...args) =>
  execFileSync('node', [path.join(functionsDir, `lib/ops/${script}.js`), '--emulator', ...args], { encoding: 'utf8' });
const auditTypes = async (cabinetId, uid) => {
  const snapshot = await db.collection(`cabinets/${cabinetId}/auditLog`).where('uid', '==', uid).get();
  return snapshot.docs.map(d => d.get('type')).sort();
};

let cabinetId;
let adminUid;
let courtierUid;

before(async () => {
  ops('seed-catalog');
  const owner = await admin.auth().createUser({ email: 'admin@test.fr', password: PASSWORD });
  const courtier = await admin.auth().createUser({ email: 'courtier@test.fr', password: PASSWORD });
  adminUid = owner.uid;
  courtierUid = courtier.uid;
  cabinetId = await createCabinet({ name: 'Cabinet Test', orias: null, ownerUid: adminUid, planId: 'essentiel' });
  await db.doc(`cabinets/${cabinetId}/members/${courtierUid}`).set({ email: 'courtier@test.fr', role: 'courtier', status: 'active' });
  await setCabinetClaims(courtierUid, cabinetId, 'courtier');
});

describe('Création du cabinet avec son offre', () => {
  it("applique les limites de l'offre « essentiel »", async () => {
    const cabinet = (await db.doc(`cabinets/${cabinetId}`).get()).data();
    assert.equal(cabinet.planId, 'essentiel');
    assert.deepEqual(cabinet.limits, { maxUtilisateurs: 3, resetsAppareilParMois: 2, appelsIaParMois: 200 });
  });
});

describe('Un compte, un appareil', () => {
  it("le premier appareil se lie au compte et la connexion est tracée", async () => {
    const result = await ouvrir(await signIn('courtier@test.fr'), DEVICE_A);
    assert.deepEqual(result.data, { success: true });
    const member = (await db.doc(`cabinets/${cabinetId}/members/${courtierUid}`).get()).data();
    assert.equal(member.device.id, DEVICE_A);
    assert.deepEqual(await auditTypes(cabinetId, courtierUid), ['appareil_lie', 'connexion']);
  });

  it('un deuxième appareil est refusé, même avec le bon mot de passe, et le refus est tracé', async () => {
    const result = await ouvrir(await signIn('courtier@test.fr'), DEVICE_B);
    assert.equal(result.error?.status, 'PERMISSION_DENIED');
    assert.equal(result.error.details?.reason, 'device_not_authorized');
    assert.ok((await auditTypes(cabinetId, courtierUid)).includes('connexion_refusee_appareil'));
    // L'appareil lié et sa session ne changent pas.
    const member = (await db.doc(`cabinets/${cabinetId}/members/${courtierUid}`).get()).data();
    assert.equal(member.device.id, DEVICE_A);
    assert.equal(member.session.id, DEVICE_A);
  });

  it("une nouvelle connexion de l'appareil lié coupe aussitôt la précédente", async () => {
    const oldToken = await signIn('admin@test.fr');
    assert.deepEqual((await ouvrir(oldToken, DEVICE_A)).data, { success: true });
    await sleep(1100); // auth_time est en secondes
    const newToken = await signIn('admin@test.fr');
    assert.deepEqual((await ouvrir(newToken, DEVICE_A)).data, { success: true });

    const oldCall = await call('equipe-annulerInvitation', oldToken, { invitationId: 'x' });
    assert.equal(oldCall.error?.status, 'PERMISSION_DENIED', "l'ancienne connexion doit être refusée");
    const newCall = await call('equipe-annulerInvitation', newToken, { invitationId: 'x' });
    assert.equal(newCall.error?.status, 'NOT_FOUND', 'la nouvelle connexion passe (invitation inexistante)');
  });
});

describe('Réinitialisation de l’appareil par un admin', () => {
  let adminToken;
  before(async () => {
    await sleep(1100);
    adminToken = await signIn('admin@test.fr');
    await ouvrir(adminToken, DEVICE_A);
  });

  it("un courtier ne peut pas réinitialiser l'appareil d'un collègue", async () => {
    const courtierToken = await signIn('courtier@test.fr');
    await ouvrir(courtierToken, DEVICE_A);
    const result = await call('equipe-reinitialiserAppareil', courtierToken, { uid: adminUid });
    assert.equal(result.error?.status, 'PERMISSION_DENIED');
  });

  it("libère l'appareil : le nouvel appareil se lie, l'ancien perd l'accès", async () => {
    const oldCourtierToken = await signIn('courtier@test.fr');
    await ouvrir(oldCourtierToken, DEVICE_A);

    const reset = await call('equipe-reinitialiserAppareil', adminToken, { uid: courtierUid });
    assert.deepEqual(reset.data, { success: true, remaining: 1 });
    assert.ok((await auditTypes(cabinetId, courtierUid)).includes('appareil_reinitialise'));
    const member = (await db.doc(`cabinets/${cabinetId}/members/${courtierUid}`).get()).data();
    assert.equal(member.device, undefined);
    assert.equal(member.session, undefined);

    assert.deepEqual((await ouvrir(await signIn('courtier@test.fr'), DEVICE_B)).data, { success: true });
    assert.equal((await db.doc(`cabinets/${cabinetId}/members/${courtierUid}`).get()).get('device.id'), DEVICE_B);
  });

  it('refuse au-delà du quota mensuel de l’offre et trace le refus', async () => {
    assert.equal((await call('equipe-reinitialiserAppareil', adminToken, { uid: courtierUid })).data?.remaining, 0);
    await ouvrir(await signIn('courtier@test.fr'), DEVICE_A);

    const refused = await call('equipe-reinitialiserAppareil', adminToken, { uid: courtierUid });
    assert.equal(refused.error?.status, 'RESOURCE_EXHAUSTED');
    assert.equal(refused.error.details?.reason, 'device_reset_quota');
    assert.ok((await auditTypes(cabinetId, courtierUid)).includes('reinitialisation_refusee_quota'));
    // L'appareil n'a pas été libéré.
    assert.equal((await db.doc(`cabinets/${cabinetId}/members/${courtierUid}`).get()).get('device.id'), DEVICE_A);
  });

  it('le quota repart à zéro le mois suivant', async () => {
    await db.doc(`cabinets/${cabinetId}`).update({ 'deviceResets.month': '2000-01' });
    assert.equal((await call('equipe-reinitialiserAppareil', adminToken, { uid: courtierUid })).data?.remaining, 1);
  });
});

describe('Baisse d’offre : délai de grâce', () => {
  it('3 → 6 sièges sans redéploiement', async () => {
    ops('set-plan', '--cabinet', cabinetId, '--plan', 'essentiel', '--max-utilisateurs', '6');
    assert.deepEqual((await db.doc(`cabinets/${cabinetId}`).get()).get('limits'), { maxUtilisateurs: 6, resetsAppareilParMois: 2, appelsIaParMois: 200 });
  });

  it("ouvre le délai de grâce quand les membres actifs dépassent la limite, et le ferme à la désactivation d'un membre", async () => {
    ops('set-plan', '--cabinet', cabinetId, '--plan', 'essentiel', '--clear-overrides', '--max-utilisateurs', '1');
    const cabinet = await db.doc(`cabinets/${cabinetId}`).get();
    assert.equal(cabinet.get('limits.maxUtilisateurs'), 1);
    assert.ok(cabinet.get('graceEndsAt').toMillis() > Date.now());

    // Invitations bloquées : plus aucune place.
    const adminToken = await signIn('admin@test.fr');
    await ouvrir(adminToken, DEVICE_A);
    const invite = await call('equipe-inviter', adminToken, { email: 'nouveau@test.fr', role: 'courtier', appUrl: 'http://localhost:4200' });
    assert.equal(invite.error?.status, 'RESOURCE_EXHAUSTED');

    const disabled = await call('equipe-activerMembre', adminToken, { uid: courtierUid, status: 'disabled' });
    assert.deepEqual(disabled.data, { success: true });
    assert.equal((await db.doc(`cabinets/${cabinetId}`).get()).get('graceEndsAt'), undefined);
  });

  it("après le délai de grâce, seul l'admin garde l'accès", async () => {
    ops('set-plan', '--cabinet', cabinetId, '--plan', 'essentiel', '--max-utilisateurs', '3');
    const adminToken = await signIn('admin@test.fr');
    await ouvrir(adminToken, DEVICE_A);
    assert.deepEqual((await call('equipe-activerMembre', adminToken, { uid: courtierUid, status: 'active' })).data, { success: true });
    await db.doc(`cabinets/${cabinetId}`).update({ graceEndsAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000) });

    const courtierToken = await signIn('courtier@test.fr');
    const refused = await ouvrir(courtierToken, DEVICE_A);
    assert.equal(refused.error?.status, 'PERMISSION_DENIED');
    assert.match(refused.error.message, /administrateurs/);
    assert.deepEqual((await ouvrir(await signIn('admin@test.fr'), DEVICE_A)).data, { success: true });
    await db.doc(`cabinets/${cabinetId}`).update({ graceEndsAt: admin.firestore.FieldValue.delete() });
  });
});

describe('Cabinet désactivé (script set-cabinet-status)', () => {
  it('est refusé par sessions-ouvrir, puis de nouveau accepté une fois réactivé', async () => {
    ops('set-cabinet-status', '--cabinet', cabinetId, '--status', 'disabled');
    const refused = await ouvrir(await signIn('admin@test.fr'), DEVICE_A);
    assert.equal(refused.error?.status, 'PERMISSION_DENIED');
    assert.match(refused.error.message, /désactivé/);

    ops('set-cabinet-status', '--cabinet', cabinetId, '--status', 'active');
    assert.deepEqual((await ouvrir(await signIn('admin@test.fr'), DEVICE_A)).data, { success: true });
  });
});
