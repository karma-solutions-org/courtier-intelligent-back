// Règles Firestore de l'extension Chrome : session propre (liée à celle de l'app), écriture limitée au statut des jobs,
// aux offres automatiques et à formMemories, perte d'accès dès que la session de l'app est coupée.
// Lancer avec : npm run test (avec les autres tests de règles)
import { after, before, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collectionGroup, deleteField, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, updateDoc, where, writeBatch } from 'firebase/firestore';

const rulesPath = process.env.RULES_PATH ? path.resolve(process.env.RULES_PATH) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../firestore.rules');
let env;

/** L'app et l'extension d'un même courtier ont chacune leur connexion : deux auth_time différents. */
const APP_AUTH_TIME = 1_790_000_001;
const EXT_AUTH_TIME = 1_790_000_500;

const claims = (cabinet, role, authTime) => ({ ci_cabinet_id: cabinet, ci_role: role, auth_time: authTime });
const ext = (uid = 'courtier-a', cabinet = 'A', role = 'courtier', authTime = EXT_AUTH_TIME) =>
  env.authenticatedContext(uid, claims(cabinet, role, authTime)).firestore();
const app = (uid = 'courtier-a', cabinet = 'A', role = 'courtier') =>
  env.authenticatedContext(uid, claims(cabinet, role, APP_AUTH_TIME)).firestore();

const JOB = '/cabinets/A/dossiers/d1/quoteJobs/assureur-a';
const OTHER_JOB = '/cabinets/A/dossiers/d1/quoteJobs/assureur-b';
const OFFER = '/cabinets/A/dossiers/d1/offers/assureur-a';

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-courtier-intelligent', firestore: { rules: fs.readFileSync(rulesPath, 'utf8') } });
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'cabinets/A'), { name: 'A', active: true });
    await setDoc(doc(db, 'cabinets/B'), { name: 'B', active: true });
    const session = { id: 'appareil', authTime: APP_AUTH_TIME, lastSeen: Timestamp.now(), extensionAuthTime: EXT_AUTH_TIME };
    await setDoc(doc(db, 'cabinets/A/members/courtier-a'), { role: 'courtier', status: 'active', session });
    await setDoc(doc(db, 'cabinets/A/members/admin-a'), { role: 'admin', status: 'active', session: { ...session, authTime: APP_AUTH_TIME + 1, extensionAuthTime: EXT_AUTH_TIME + 1 } });
    await setDoc(doc(db, 'cabinets/B/members/courtier-b'), { role: 'courtier', status: 'active', session });
    await setDoc(doc(db, 'cabinets/A/dossiers/d1'), { status: 'complet', data: { 'client.lastName': 'Dupont' } });
    await setDoc(doc(db, JOB), { ownerUid: 'courtier-a', status: 'requested', quoteData: { 'client.lastName': 'Dupont' }, updatedAt: Timestamp.now() });
    await setDoc(doc(db, OTHER_JOB), { ownerUid: 'admin-a', status: 'requested', quoteData: {}, updatedAt: Timestamp.now() });
    await setDoc(doc(db, 'cabinets/A/assures/a1'), { firstName: 'Jean' });
    await setDoc(doc(db, 'insurers/assureur-a'), { name: 'Assureur A' });
    await setDoc(doc(db, 'products/auto'), { name: 'Auto' });
    await setDoc(doc(db, 'formMemories/m1'), { origin: 'extranet.assureur-a.fr', formFingerprint: 'f', version: 1, fields: [], hits: 0 });
  });
});

after(async () => {
  await env.cleanup();
});

describe("Extension : ce qu'elle voit", () => {
  it('lit ses propres jobs, pas ceux des collègues', async () => {
    await assertSucceeds(getDoc(doc(ext(), JOB)));
    await assertFails(getDoc(doc(ext(), OTHER_JOB)));
  });

  it('retrouve « mes jobs » avec la requête du side panel, mais pas ceux des autres', async () => {
    await assertSucceeds(getDocs(query(collectionGroup(ext(), 'quoteJobs'), where('ownerUid', '==', 'courtier-a'))));
    await assertFails(getDocs(query(collectionGroup(ext(), 'quoteJobs'), where('ownerUid', '==', 'admin-a'))));
    await assertFails(getDocs(collectionGroup(ext(), 'quoteJobs')));
  });

  it("n'accède ni aux dossiers, ni aux assurés, ni au cabinet, ni à l'historique", async () => {
    await assertFails(getDoc(doc(ext(), 'cabinets/A/dossiers/d1')));
    await assertFails(getDoc(doc(ext(), 'cabinets/A/assures/a1')));
    await assertFails(getDoc(doc(ext(), 'cabinets/A')));
    await assertFails(getDoc(doc(ext(), 'cabinets/A/members/admin-a')));
  });

  // Selon le fichier de règles, la fiche reste lisible après la perte de session (l'app s'en sert pour détecter une déconnexion) :
  // l'extension compare donc elle-même extensionAuthTime à son jeton, et traite aussi un refus comme une session perdue.
  it('relit sa propre fiche de membre (pour savoir si sa session est ouverte)', async () => {
    await assertSucceeds(getDoc(doc(ext(), 'cabinets/A/members/courtier-a')));
  });

  it('lit le catalogue et la mémoire des formulaires', async () => {
    await assertSucceeds(getDoc(doc(ext(), 'insurers/assureur-a')));
    await assertSucceeds(getDoc(doc(ext(), 'products/auto')));
    await assertSucceeds(getDoc(doc(ext(), 'formMemories/m1')));
  });

  it("n'a pas accès au cabinet d'un autre", async () => {
    await assertFails(getDoc(doc(ext('courtier-a', 'B'), JOB)));
  });
});

describe("Extension : ce qu'elle écrit", () => {
  it('fait avancer le statut et la progression de son job', async () => {
    await assertSucceeds(updateDoc(doc(ext(), JOB), { status: 'analyzing', currentStep: 1, totalSteps: 5, updatedAt: Timestamp.now() }));
    await assertSucceeds(updateDoc(doc(ext(), JOB), { status: 'needs_info', missingFields: [{ canonicalPath: 'vehicle.brand', label: 'Marque', type: 'text' }] }));
    await assertSucceeds(updateDoc(doc(ext(), JOB), { status: 'failed', error: 'Page introuvable', attempts: 2 }));
    await assertSucceeds(updateDoc(doc(ext(), JOB), { status: 'captured' }));
  });

  it('ne modifie ni les données à remplir, ni le propriétaire du job, ni un job de collègue', async () => {
    await assertFails(updateDoc(doc(ext(), JOB), { status: 'filling', quoteData: { 'client.lastName': 'Autre' } }));
    await assertFails(updateDoc(doc(ext(), JOB), { status: 'filling', ownerUid: 'admin-a' }));
    await assertFails(updateDoc(doc(ext(), OTHER_JOB), { status: 'filling' }));
  });

  it('ne relance pas un job et ne pose pas de statut inconnu', async () => {
    await assertFails(updateDoc(doc(ext(), JOB), { status: 'requested' }));
    await assertFails(updateDoc(doc(ext(), JOB), { status: 'valide' }));
  });

  it("ne crée pas de job", async () => {
    await assertFails(setDoc(doc(ext(), '/cabinets/A/dossiers/d1/quoteJobs/assureur-c'), { ownerUid: 'courtier-a', status: 'analyzing' }));
  });

  /** Offre telle que l'extension l'écrit après confirmation du courtier (E10-3). */
  const autoOffer = overrides => ({
    quoteNumber: 'DEV-42',
    premiumAnnual: 842,
    premiumMonthly: null,
    deductibles: { general: 300 },
    guarantees: [{ code: null, label: 'Vol', included: true, limit: 15000, deductible: 300 }],
    exclusions: ['Alcool'],
    source: 'auto',
    capturedAt: serverTimestamp(),
    ...overrides,
  });

  it('enregistre une offre automatique pour son job, sans score ni écarts', async () => {
    await assertSucceeds(setDoc(doc(ext(), OFFER), autoOffer()));
    await assertFails(setDoc(doc(ext(), OFFER), autoOffer({ score: 99 })));
    await assertFails(setDoc(doc(ext(), OFFER), autoOffer({ gaps: [] })));
    await assertFails(setDoc(doc(ext(), OFFER), autoOffer({ source: 'manual' })));
  });

  it('refuse une offre sans prime, mal typée, ou à la date fournie par le client', async () => {
    await assertFails(setDoc(doc(ext(), OFFER), autoOffer({ premiumAnnual: null })));
    await assertFails(setDoc(doc(ext(), OFFER), autoOffer({ premiumAnnual: '842 €' })));
    await assertFails(setDoc(doc(ext(), OFFER), autoOffer({ premiumAnnual: -1 })));
    await assertFails(setDoc(doc(ext(), OFFER), autoOffer({ guarantees: 'Vol' })));
    await assertFails(setDoc(doc(ext(), OFFER), autoOffer({ capturedAt: Timestamp.now() })));
  });

  it("confirme la capture : offre et job « captured » en une seule écriture", async () => {
    const db = ext();
    const batch = writeBatch(db);
    batch.set(doc(db, OFFER), autoOffer({ premiumAnnual: null, premiumMonthly: 61.2 }));
    batch.update(doc(db, JOB), { status: 'captured', missingFields: [], error: null, updatedAt: serverTimestamp() });
    await assertSucceeds(batch.commit());
  });

  it("n'écrit pas d'offre pour le job d'un collègue, ni ne supprime une offre", async () => {
    await assertFails(setDoc(doc(ext(), '/cabinets/A/dossiers/d1/offers/assureur-b'), autoOffer()));
    await env.withSecurityRulesDisabled(async context => setDoc(doc(context.firestore(), OFFER), { source: 'auto' }));
    await assertFails(env.authenticatedContext('courtier-a', claims('A', 'courtier', EXT_AUTH_TIME)).firestore().doc(OFFER).delete());
  });

  const report = overrides => ({
    insurerId: 'assureur-a',
    origin: 'https://extranet.assureur-a.fr',
    step: 'extract',
    issue: 'premium_not_found',
    at: serverTimestamp(),
    ...overrides,
  });

  it('signale un problème (extensionReports) par un code, sans pouvoir le relire', async () => {
    await assertSucceeds(setDoc(doc(ext(), 'extensionReports/r1'), report()));
    await assertFails(getDoc(doc(ext(), 'extensionReports/r1')));
  });

  it('un signalement ne porte aucune donnée client : ni champ en plus, ni texte libre, ni URL complète', async () => {
    await assertFails(setDoc(doc(ext(), 'extensionReports/r2'), report({ clientName: 'Dupont' })));
    await assertFails(setDoc(doc(ext(), 'extensionReports/r3'), report({ issue: 'prime introuvable pour M. Dupont' })));
    await assertFails(setDoc(doc(ext(), 'extensionReports/r4'), report({ step: 'remplissage' })));
    await assertFails(setDoc(doc(ext(), 'extensionReports/r5'), report({ origin: 'https://extranet.assureur-a.fr/devis?nom=Dupont' })));
    await assertFails(setDoc(doc(ext(), 'extensionReports/r6'), report({ at: Timestamp.now() })));
  });

  it("n'écrit jamais dans la mémoire des formulaires : seules les functions memoires-* le font (structure validée)", async () => {
    const memory = { origin: 'https://extranet.assureur-a.fr', formFingerprint: 'v1:00000000000000', version: 1, fields: [{ fieldKey: 'text:nom', label: 'Nom', type: 'text', order: 0, canonicalPath: 'client.lastName', confidence: 0.9 }], hits: 1 };
    await assertFails(setDoc(doc(ext(), 'formMemories/m2'), memory));
    await assertFails(updateDoc(doc(ext(), 'formMemories/m1'), { hits: 99 }));
    await assertFails(setDoc(doc(ext(), 'formMemories/m3'), { ...memory, fields: [{ ...memory.fields[0], valeur: 'Dupont' }] }));
    await assertFails(setDoc(doc(app(), 'formMemories/m4'), memory));
  });

  it("n'écrit pas dans le catalogue", async () => {
    await assertFails(setDoc(doc(ext(), 'insurers/assureur-a'), { name: 'Piraté' }));
  });
});

describe("L'extension n'a pas les droits de l'app, et l'app n'a pas ceux de l'extension", () => {
  it("la connexion de l'app (autre auth_time) ne lit ni n'écrit la mémoire des formulaires", async () => {
    await assertFails(getDoc(doc(app(), 'formMemories/m1')));
    await assertFails(setDoc(doc(app(), 'formMemories/m5'), { origin: 'x', formFingerprint: 'f', version: 1, fields: [], hits: 0 }));
    await assertFails(setDoc(doc(app(), 'extensionReports/r3'), { insurerId: 'a', origin: '', step: 'extract', issue: 'premium_not_found', at: serverTimestamp() }));
  });

  it("un jeton qui n'est ni celui de l'app ni celui de l'extension n'a accès à rien", async () => {
    const stranger = ext('courtier-a', 'A', 'courtier', 1_790_009_999);
    await assertFails(getDoc(doc(stranger, JOB)));
    await assertFails(getDoc(doc(stranger, 'formMemories/m1')));
  });

  it("le jeton de l'extension n'ouvre pas les données de l'app", async () => {
    await assertFails(getDoc(doc(ext(), 'cabinets/A/dossiers/d1')));
    await assertSucceeds(getDoc(doc(app(), 'cabinets/A/dossiers/d1')));
  });
});

describe("Perte d'accès dès que la session de l'app est coupée", () => {
  const revoke = change =>
    env.withSecurityRulesDisabled(async context => updateDoc(doc(context.firestore(), 'cabinets/A/members/courtier-a'), change));

  it("déconnexion de l'app (session supprimée)", async () => {
    await revoke({ session: deleteField() });
    await assertFails(getDoc(doc(ext(), JOB)));
    await assertFails(updateDoc(doc(ext(), JOB), { status: 'analyzing' }));
    await assertFails(getDocs(query(collectionGroup(ext(), 'quoteJobs'), where('ownerUid', '==', 'courtier-a'))));
    await assertFails(setDoc(doc(ext(), OFFER), { source: 'auto', premiumAnnual: 1, capturedAt: serverTimestamp() }));
    await assertFails(getDoc(doc(ext(), 'formMemories/m1')));
  });

  it("nouvelle connexion de l'app (la session est remplacée, sans connexion d'extension)", async () => {
    await revoke({ session: { id: 'appareil', authTime: APP_AUTH_TIME + 100, lastSeen: Timestamp.now() } });
    await assertFails(getDoc(doc(ext(), JOB)));
    await assertFails(updateDoc(doc(ext(), JOB), { status: 'analyzing' }));
    await assertFails(getDoc(doc(ext(), 'formMemories/m1')));
  });

  it("l'extension se déconnecte d'elle-même (sa connexion est retirée, l'app garde la sienne)", async () => {
    await revoke({ 'session.extensionAuthTime': deleteField() });
    await assertFails(getDoc(doc(ext(), JOB)));
    await assertSucceeds(getDoc(doc(app(), 'cabinets/A/dossiers/d1')));
  });

  it('membre désactivé', async () => {
    await revoke({ status: 'disabled', session: deleteField() });
    await assertFails(getDoc(doc(ext(), JOB)));
  });

  it('cabinet désactivé', async () => {
    await env.withSecurityRulesDisabled(async context => updateDoc(doc(context.firestore(), 'cabinets/A'), { active: false }));
    await assertFails(getDoc(doc(ext(), JOB)));
    await assertFails(getDoc(doc(ext(), 'formMemories/m1')));
  });

  it("cabinet au-delà de sa limite après le délai de grâce : l'extension d'un courtier est coupée, celle d'un admin non", async () => {
    await env.withSecurityRulesDisabled(async context => updateDoc(doc(context.firestore(), 'cabinets/A'), { graceEndsAt: Timestamp.fromMillis(Date.now() - 1000) }));
    await assertFails(getDoc(doc(ext(), JOB)));
    await assertSucceeds(getDoc(doc(ext('admin-a', 'A', 'admin', EXT_AUTH_TIME + 1), OTHER_JOB)));
  });

});
