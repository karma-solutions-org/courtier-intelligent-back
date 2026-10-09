// Tests d'intégration de la connexion de l'extension Chrome dans les emulators : session liée à celle de l'app,
// perte d'accès quand elle est coupée, et proxy d'IA (clé côté serveur, quota selon l'offre).
// Le faux service d IA écoute sur le port 9988 (functions/.env.demo-courtier-intelligent : URL et clé factice)
// Lancer avec : npm run test:integration
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { call, DEVICE_A, ops, ouvrir, PASSWORD, signIn } from './helpers.mjs';

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');
const { createCabinet } = require('../lib/core/cabinet.utils.js');
const { setCabinetClaims } = require('../lib/core/auth.utils.js');

admin.initializeApp({ projectId: 'demo-courtier-intelligent' });
const db = admin.firestore();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── Faux service d'IA : enregistre ce qu'il reçoit ─────────────────────────────
// Il imite l'API Gemini (`/v1beta/models/<modèle>:generateContent`) ; chaque modèle peut avoir son propre statut.
const upstreamRequests = [];
let upstreamStatus = 200;
/** Statut renvoyé pour un modèle donné (repli sur le modèle suivant), sinon `upstreamStatus`. */
let upstreamStatusByModel = {};
/** Réponse 200 sans texte (bloquée par le filtre de sécurité, ou coupée). */
let upstreamEmptyModels = [];
const upstream = http.createServer((request, response) => {
  let body = '';
  request.on('data', chunk => (body += chunk));
  request.on('end', () => {
    const model = decodeURIComponent(/\/v1beta\/models\/([^:]+):generateContent$/.exec(request.url)?.[1] ?? '');
    upstreamRequests.push({ model, headers: request.headers, body: JSON.parse(body || '{}') });
    const status = upstreamStatusByModel[model] ?? upstreamStatus;
    response.writeHead(status, { 'content-type': 'application/json' });
    if (status !== 200) return response.end(JSON.stringify({ error: { code: status, message: 'boom' } }));
    const parts = upstreamEmptyModels.includes(model) ? [] : [{ text: 'canonicalPath: ' }, { text: 'client.lastName' }];
    response.end(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts }, finishReason: parts.length ? 'STOP' : 'SAFETY' }],
        usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 7 },
      }),
    );
  });
});
const MODELS = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];

let cabinetId;
let adminUid;
let courtierUid;

const member = async () => (await db.doc(`cabinets/${cabinetId}/members/${courtierUid}`).get()).data();
const audit = async type => {
  const snapshot = await db.collection(`cabinets/${cabinetId}/auditLog`).where('type', '==', type).where('uid', '==', courtierUid).get();
  return snapshot.size;
};
const iaCalls = async () => {
  const snapshot = await db.collection(`cabinets/${cabinetId}/usage`).get();
  return snapshot.docs.reduce((sum, d) => sum + (d.get('calls') ?? 0), 0);
};
const ask = (token, overrides = {}) =>
  call('ia-proxy', token, { messages: [{ role: 'user', content: 'Quel champ correspond à « Nom » ?' }], ...overrides });

/** Une connexion de l'app puis une connexion distincte pour l'extension (auth_time différent, en secondes). */
async function newLogins(email) {
  const appToken = await signIn(email);
  await ouvrir(appToken, DEVICE_A);
  await sleep(1100);
  const extToken = await signIn(email);
  return { appToken, extToken };
}

before(async () => {
  await new Promise(resolve => upstream.listen(9988, '127.0.0.1', resolve));
  ops('seed-catalog');
  const owner = await admin.auth().createUser({ email: 'admin-ext@test.fr', password: PASSWORD });
  const courtier = await admin.auth().createUser({ email: 'courtier-ext@test.fr', password: PASSWORD });
  adminUid = owner.uid;
  courtierUid = courtier.uid;
  cabinetId = await createCabinet({ name: 'Cabinet Extension', orias: null, ownerUid: adminUid, planId: 'essentiel', overrides: { appelsIaParMois: 3 } });
  await db.doc(`cabinets/${cabinetId}/members/${courtierUid}`).set({ email: 'courtier-ext@test.fr', role: 'courtier', status: 'active' });
  await setCabinetClaims(courtierUid, cabinetId, 'courtier');
});

after(() => {
  // Les connexions keep-alive du client fetch empêcheraient sinon le processus de se terminer.
  upstream.closeAllConnections();
  upstream.close();
});

describe("Connexion de l'extension", () => {
  it("refuse tant qu'aucune session de l'app n'est ouverte sur l'appareil", async () => {
    const token = await signIn('courtier-ext@test.fr');
    const refused = await call('sessions-ouvrirExtension', token);
    assert.equal(refused.error?.status, 'FAILED_PRECONDITION');
    assert.equal(refused.error.details?.reason, 'no_app_session');
  });

  it("refuse si la session de l'app n'a plus donné signe de vie (app fermée sans déconnexion)", async () => {
    const appToken = await signIn('courtier-ext@test.fr');
    await ouvrir(appToken, DEVICE_A);
    await db.doc(`cabinets/${cabinetId}/members/${courtierUid}`).update({
      'session.lastSeen': admin.firestore.Timestamp.fromMillis(Date.now() - 10 * 60 * 1000),
    });
    await sleep(1100);
    const refused = await call('sessions-ouvrirExtension', await signIn('courtier-ext@test.fr'));
    assert.equal(refused.error?.details?.reason, 'no_app_session');
  });

  it("refuse un compte sans cabinet", async () => {
    await admin.auth().createUser({ email: 'sans-cabinet@test.fr', password: PASSWORD });
    const refused = await call('sessions-ouvrirExtension', await signIn('sans-cabinet@test.fr'));
    assert.equal(refused.error?.status, 'FAILED_PRECONDITION');
  });

  it("enregistre la connexion de l'extension dans la session de l'app, et la trace une seule fois", async () => {
    await sleep(1100);
    const { appToken, extToken } = await newLogins('courtier-ext@test.fr');
    const before = await audit('extension_connexion');

    assert.deepEqual((await call('sessions-ouvrirExtension', extToken)).data, { success: true });
    assert.deepEqual((await call('sessions-ouvrirExtension', extToken)).data, { success: true });

    const session = (await member()).session;
    assert.ok(typeof session.extensionAuthTime === 'number');
    assert.notEqual(session.extensionAuthTime, session.authTime, "l'extension a sa propre connexion");
    assert.equal(await audit('extension_connexion'), before + 1);
    // L'app, elle, garde sa session.
    assert.deepEqual((await ouvrir(appToken, DEVICE_A)).data, { success: true });
  });
});

describe("Accès de l'extension aux functions", () => {
  it("le jeton de l'app n'ouvre pas ia-proxy, celui de l'extension oui", async () => {
    await sleep(1100);
    const { appToken, extToken } = await newLogins('courtier-ext@test.fr');
    const denied = await ask(appToken);
    assert.equal(denied.error?.status, 'PERMISSION_DENIED');
    assert.equal(denied.error.details?.reason, 'extension_session_closed');

    await call('sessions-ouvrirExtension', extToken);
    assert.ok((await ask(extToken)).data?.text);
  });

  it("recharger l'app ne coupe pas l'extension, une nouvelle connexion de l'app si", async () => {
    await sleep(1100);
    const { appToken, extToken } = await newLogins('courtier-ext@test.fr');
    await call('sessions-ouvrirExtension', extToken);

    await ouvrir(appToken, DEVICE_A); // rechargement de la page : même connexion
    assert.ok((await ask(extToken)).data?.text, "l'extension reste connectée");

    await sleep(1100);
    const newAppToken = await signIn('courtier-ext@test.fr');
    await ouvrir(newAppToken, DEVICE_A); // nouvelle connexion de l'app : la session est remplacée
    const refused = await ask(extToken);
    assert.equal(refused.error?.status, 'PERMISSION_DENIED');
    assert.equal(refused.error.details?.reason, 'extension_session_closed');
  });

  it("la déconnexion de l'app coupe l'extension", async () => {
    await sleep(1100);
    const { appToken, extToken } = await newLogins('courtier-ext@test.fr');
    await call('sessions-ouvrirExtension', extToken);

    await call('sessions-fermer', appToken);

    assert.equal((await ask(extToken)).error?.status, 'PERMISSION_DENIED');
    assert.equal((await member()).session, undefined);
  });

  it("l'extension se déconnecte sans toucher à la session de l'app", async () => {
    await sleep(1100);
    const { appToken, extToken } = await newLogins('courtier-ext@test.fr');
    await call('sessions-ouvrirExtension', extToken);

    await call('sessions-fermerExtension', extToken);

    assert.equal((await ask(extToken)).error?.status, 'PERMISSION_DENIED');
    const session = (await member()).session;
    assert.equal(session.extensionAuthTime, undefined);
    assert.ok(session.authTime, "la session de l'app est intacte");
    assert.deepEqual((await ouvrir(appToken, DEVICE_A)).data, { success: true });
  });

  it("la désactivation du membre coupe l'extension", async () => {
    await sleep(1100);
    const { extToken } = await newLogins('courtier-ext@test.fr');
    await call('sessions-ouvrirExtension', extToken);
    await sleep(1100);
    await ouvrir(await signIn('admin-ext@test.fr'), DEVICE_A);
    const adminToken = await signIn('admin-ext@test.fr');
    await ouvrir(adminToken, DEVICE_A);

    assert.deepEqual((await call('equipe-activerMembre', adminToken, { uid: courtierUid, status: 'disabled' })).data, { success: true });

    assert.equal((await ask(extToken)).error?.status, 'PERMISSION_DENIED');
    await call('equipe-activerMembre', adminToken, { uid: courtierUid, status: 'active' });
  });
});

describe('ia-proxy', () => {
  let extToken;
  before(async () => {
    await sleep(1100);
    ({ extToken } = await newLogins('courtier-ext@test.fr'));
    await call('sessions-ouvrirExtension', extToken);
    await db.collection(`cabinets/${cabinetId}/usage`).get().then(snapshot => Promise.all(snapshot.docs.map(d => d.ref.delete())));
    upstreamRequests.length = 0;
  });

  it("transmet à Gemini avec la clé du serveur, le premier modèle imposé et des tailles bornées", async () => {
    const result = await ask(extToken, { system: 'Tu associes des champs.', maxTokens: 999_999, model: 'un-autre-modele', apiKey: 'pirate' });

    assert.equal(result.data.text, 'canonicalPath: client.lastName');
    assert.deepEqual(result.data.usage, { inputTokens: 42, outputTokens: 7 });
    assert.equal(result.data.remaining, 2);

    const sent = upstreamRequests.at(-1);
    assert.equal(sent.headers['x-goog-api-key'], 'cle-de-test', 'la clé vient du serveur');
    assert.equal(sent.model, MODELS[0], "le modèle n'est pas choisi par l'extension");
    assert.equal(sent.body.generationConfig.maxOutputTokens, 2000, 'plafonné');
    assert.deepEqual(sent.body.systemInstruction, { parts: [{ text: 'Tu associes des champs.' }] });
    assert.deepEqual(sent.body.contents, [{ role: 'user', parts: [{ text: 'Quel champ correspond à « Nom » ?' }] }]);
    assert.deepEqual(Object.keys(sent.body).sort(), ['contents', 'generationConfig', 'systemInstruction']);
  });

  it('passe au modèle suivant quand un modèle est introuvable, surchargé ou renvoie une réponse vide, sans compter deux fois', async () => {
    const before = await iaCalls();
    upstreamRequests.length = 0;
    upstreamStatusByModel = { [MODELS[0]]: 404 };
    upstreamEmptyModels = [MODELS[1]];
    const result = await ask(extToken);
    upstreamStatusByModel = {};
    upstreamEmptyModels = [];

    assert.equal(result.data.text, 'canonicalPath: client.lastName');
    assert.deepEqual(upstreamRequests.map(r => r.model), MODELS, 'les modèles sont essayés dans l’ordre');
    assert.equal(await iaCalls(), before + 1, 'un seul appel décompté');

    upstreamRequests.length = 0;
    upstreamStatusByModel = { [MODELS[0]]: 429 };
    assert.ok((await ask(extToken)).data);
    upstreamStatusByModel = {};
    assert.deepEqual(upstreamRequests.map(r => r.model), MODELS.slice(0, 2), 'le premier qui répond l’emporte');
    // Ces deux appels sont rendus pour ne pas fausser les tests de quota qui suivent.
    await db.doc(`cabinets/${cabinetId}/usage/ia-${new Date().toISOString().substring(0, 7)}`).set({ calls: before }, { merge: true });
  });

  it("n'essaie pas les autres modèles quand la clé est refusée, et rembourse l'appel", async () => {
    const before = await iaCalls();
    upstreamRequests.length = 0;
    upstreamStatus = 403;
    const failed = await ask(extToken);
    upstreamStatus = 200;

    assert.equal(failed.error?.details?.reason, 'ia_upstream');
    assert.equal(upstreamRequests.length, 1);
    assert.equal(await iaCalls(), before);
  });

  it('refuse les demandes mal formées, sans consommer de quota', async () => {
    const before = await iaCalls();
    const invalid = [
      { messages: [] },
      { messages: [{ role: 'assistant', content: 'je commence' }] },
      { messages: [{ role: 'system', content: 'x' }] },
      { messages: [{ role: 'user', content: '   ' }] },
      { messages: [{ role: 'user', content: 'x'.repeat(30_001) }] },
      { messages: [{ role: 'user', content: 'ok' }], maxTokens: 0 },
      { messages: [{ role: 'user', content: 'ok' }], system: 42 },
    ];
    for (const body of invalid) {
      const result = await call('ia-proxy', extToken, body);
      assert.equal(result.error?.status, 'INVALID_ARGUMENT', JSON.stringify(body).slice(0, 80));
    }
    assert.equal(await iaCalls(), before);
  });

  it("rembourse l'appel quand le service d'IA est en panne", async () => {
    const before = await iaCalls();
    upstreamRequests.length = 0;
    upstreamStatus = 500;
    const failed = await ask(extToken);
    upstreamStatus = 200;

    assert.deepEqual(upstreamRequests.map(r => r.model), MODELS, 'tous les modèles ont été essayés');

    assert.equal(failed.error?.status, 'UNAVAILABLE');
    assert.equal(failed.error.details?.reason, 'ia_upstream');
    assert.equal(await iaCalls(), before);
  });

  it("applique la limite d'appels de l'offre, y compris pour des appels simultanés", async () => {
    // 1 appel déjà consommé (premier test) : il en reste 2 sur 3.
    const results = await Promise.all([ask(extToken), ask(extToken), ask(extToken), ask(extToken)]);
    const ok = results.filter(r => r.data);
    const refused = results.filter(r => r.error);

    assert.equal(ok.length, 2);
    assert.equal(refused.length, 2);
    assert.equal(refused[0].error.status, 'RESOURCE_EXHAUSTED');
    assert.equal(refused[0].error.details?.reason, 'ia_quota');
    assert.equal(await iaCalls(), 3);
    assert.equal(upstreamRequests.filter(r => r.body.contents).length >= 3, true);
  });

  it("le quota repart à zéro le mois suivant, et dépend de l'offre du cabinet", async () => {
    await db.collection(`cabinets/${cabinetId}/usage`).get().then(snapshot => Promise.all(snapshot.docs.map(d => d.ref.delete())));
    assert.ok((await ask(extToken)).data);

    ops('set-plan', '--cabinet', cabinetId, '--plan', 'essentiel', '--appels-ia', '1');
    assert.equal((await ask(extToken)).error?.details?.reason, 'ia_quota');
    ops('set-plan', '--cabinet', cabinetId, '--plan', 'cabinet', '--clear-overrides');
    assert.ok((await ask(extToken)).data, "l'offre supérieure autorise plus d'appels, sans redéploiement");
  });
});
