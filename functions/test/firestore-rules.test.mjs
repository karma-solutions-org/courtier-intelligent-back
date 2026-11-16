// Tests des règles Firestore dans l'emulator : isolation des cabinets, rôles, session unique.
// Lancer avec : npm run test
import { after, before, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, Timestamp, updateDoc } from 'firebase/firestore';

const rulesPath = process.env.RULES_PATH ? path.resolve(process.env.RULES_PATH) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../firestore.rules');
let env;

// Chaque membre a une session ouverte, liée à l'heure de connexion (auth_time) de son appareil.
const MEMBERS = {
  'admin-a': { cabinet: 'A', role: 'admin', authTime: 1_790_000_001 },
  'courtier-a': { cabinet: 'A', role: 'courtier', authTime: 1_790_000_002 },
  'admin-b': { cabinet: 'B', role: 'admin', authTime: 1_790_000_003 },
};
/** Heure de connexion d'un autre appareil qui se connecte avec le même compte. */
const OTHER_DEVICE_AUTH_TIME = 1_790_009_999;

/**
 * Le client Firestore d'un membre, connecté depuis l'appareil dont la connexion date de [authTime]
 * (celui de sa session par défaut). Les claims ci_ sont ceux du compte : identiques sur tous ses appareils.
 */
function as(uid, authTime = MEMBERS[uid].authTime) {
  const { cabinet, role } = MEMBERS[uid];
  return env.authenticatedContext(uid, { ci_cabinet_id: cabinet, ci_role: role, auth_time: authTime }).firestore();
}
const adminA = () => as('admin-a');
const courtierA = () => as('courtier-a');
const adminB = () => as('admin-b');
const noCabinet = () => env.authenticatedContext('sans-cabinet', {}).firestore();
const otherAppAdmin = () => env.authenticatedContext('autre-app', { admin: true, role: 'SUPER_ADMIN' }).firestore();
const anonymous = () => env.unauthenticatedContext().firestore();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-courtier-intelligent',
    firestore: { rules: fs.readFileSync(rulesPath, 'utf8') },
  });
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const cabinet of ['A', 'B']) {
      await setDoc(doc(db, `ci_cabinets/${cabinet}`), { name: `Cabinet ${cabinet}`, active: true, planId: 'essentiel', limits: { maxUtilisateurs: 3, resetsAppareilParMois: 2 } });
      await setDoc(doc(db, `ci_cabinets/${cabinet}/ci_dossiers/d1`), { status: 'brouillon' });
      await setDoc(doc(db, `ci_cabinets/${cabinet}/ci_dossiers/d1/ci_events/e1`), { type: 'created' });
    }
    for (const [uid, member] of Object.entries(MEMBERS)) {
      await setDoc(doc(db, `ci_cabinets/${member.cabinet}/ci_members/${uid}`), {
        role: member.role,
        status: 'active',
        session: { id: `appareil-${uid}`, authTime: member.authTime, appareil: 'Chrome', lastSeen: Timestamp.now() },
      });
    }
    await setDoc(doc(db, 'ci_products/auto'), { name: 'Auto' });
  });
});

after(async () => {
  await env.cleanup();
});

describe('Isolation des cabinets', () => {
  it('un membre lit son cabinet et ses dossiers', async () => {
    await assertSucceeds(getDoc(doc(courtierA(), 'ci_cabinets/A')));
    await assertSucceeds(getDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1')));
  });

  it('le cabinet A ne peut rien lire du cabinet B', async () => {
    await assertFails(getDoc(doc(adminA(), 'ci_cabinets/B')));
    await assertFails(getDoc(doc(adminA(), 'ci_cabinets/B/ci_dossiers/d1')));
    await assertFails(getDoc(doc(adminA(), 'ci_cabinets/B/ci_members/admin-b')));
    await assertFails(getDoc(doc(adminA(), 'ci_cabinets/B/ci_dossiers/d1/ci_events/e1')));
  });

  it('le cabinet A ne peut rien écrire dans le cabinet B', async () => {
    await assertFails(setDoc(doc(adminA(), 'ci_cabinets/B/ci_dossiers/d2'), { status: 'brouillon' }));
    await assertFails(updateDoc(doc(adminA(), 'ci_cabinets/B'), { name: 'Piraté' }));
  });

  it('un compte sans cabinet ne lit aucun cabinet', async () => {
    await assertFails(getDoc(doc(noCabinet(), 'ci_cabinets/A')));
    await assertFails(getDoc(doc(noCabinet(), 'ci_cabinets/A/ci_dossiers/d1')));
  });

  it("les claims génériques d'une autre application ne donnent aucun droit", async () => {
    await assertFails(getDoc(doc(otherAppAdmin(), 'ci_cabinets/A')));
    await assertFails(setDoc(doc(otherAppAdmin(), 'ci_products/auto'), { name: 'Piraté' }));
  });

  it('un visiteur non connecté ne lit rien', async () => {
    await assertFails(getDoc(doc(anonymous(), 'ci_cabinets/A')));
    await assertFails(getDoc(doc(anonymous(), 'ci_products/auto')));
  });
});

describe('Un seul appareil par utilisateur', () => {
  it("un deuxième appareil, avec le bon compte et les mêmes claims, n'a accès à rien", async () => {
    const autreAppareil = as('courtier-a', OTHER_DEVICE_AUTH_TIME);
    await assertFails(getDoc(doc(autreAppareil, 'ci_cabinets/A')));
    await assertFails(getDoc(doc(autreAppareil, 'ci_cabinets/A/ci_dossiers/d1')));
    await assertFails(setDoc(doc(autreAppareil, 'ci_cabinets/A/ci_dossiers/d2'), { status: 'brouillon' }));
  });

  it("un compte dont la session a été fermée n'a plus accès", async () => {
    await env.withSecurityRulesDisabled(async context => {
      await updateDoc(doc(context.firestore(), 'ci_cabinets/A/ci_members/courtier-a'), { session: null });
    });
    await assertFails(getDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1')));
  });

  it('un membre envoie le signal de vie de sa session', async () => {
    await assertSucceeds(
      updateDoc(doc(courtierA(), 'ci_cabinets/A/ci_members/courtier-a'), { 'session.lastSeen': serverTimestamp() }),
    );
  });

  it("le signal de vie ne permet de modifier ni la session, ni le rôle, ni l'heure", async () => {
    const me = doc(courtierA(), 'ci_cabinets/A/ci_members/courtier-a');
    await assertFails(updateDoc(me, { 'session.id': 'session-pirate' }));
    await assertFails(updateDoc(me, { 'session.authTime': OTHER_DEVICE_AUTH_TIME }));
    await assertFails(updateDoc(me, { role: 'admin' }));
    await assertFails(updateDoc(me, { 'session.lastSeen': Timestamp.fromMillis(Date.now() + 3600_000) }));
  });

  it("un autre appareil ou un collègue ne peut pas entretenir la session d'un membre", async () => {
    await assertFails(
      updateDoc(doc(as('courtier-a', OTHER_DEVICE_AUTH_TIME), 'ci_cabinets/A/ci_members/courtier-a'), {
        'session.lastSeen': serverTimestamp(),
      }),
    );
    await assertFails(
      updateDoc(doc(adminA(), 'ci_cabinets/A/ci_members/courtier-a'), { 'session.lastSeen': serverTimestamp() }),
    );
  });
});

describe('Droits dans un cabinet', () => {
  it('un courtier ne crée pas un dossier directement (functions dossiers-creer), et ne modifie pas le cabinet', async () => {
    await assertFails(setDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d2'), { status: 'brouillon' }));
    await assertFails(updateDoc(doc(courtierA(), 'ci_cabinets/A'), { name: 'Nouveau nom' }));
  });

  it("l'admin modifie les informations de son cabinet", async () => {
    await assertSucceeds(updateDoc(doc(adminA(), 'ci_cabinets/A'), { name: 'Nouveau nom', orias: '12345678' }));
  });

  it("l'admin ne peut pas augmenter la limite d'utilisateurs de son offre", async () => {
    await assertFails(updateDoc(doc(adminA(), 'ci_cabinets/A'), { 'limits.maxUtilisateurs': 87 }));
    await assertFails(updateDoc(doc(adminA(), 'ci_cabinets/A'), { limits: { maxUtilisateurs: 87, resetsAppareilParMois: 2 } }));
    await assertFails(updateDoc(doc(adminA(), 'ci_cabinets/A'), { overrides: { maxUtilisateurs: 87 } }));
    await assertFails(updateDoc(doc(adminA(), 'ci_cabinets/A'), { planId: 'illimite' }));
  });

  it("l'admin ne remet pas à zéro son quota de réinitialisations ni son délai de grâce", async () => {
    await assertFails(updateDoc(doc(adminA(), 'ci_cabinets/A'), { deviceResets: { month: '2026-10', count: 0 } }));
    await assertFails(updateDoc(doc(adminA(), 'ci_cabinets/A'), { graceEndsAt: null }));
  });

  it("l'admin choisit les assureurs et produits actifs de son cabinet, pas le courtier", async () => {
    await assertSucceeds(updateDoc(doc(adminA(), 'ci_cabinets/A'), { enabledInsurers: ['axa'], enabledProducts: ['auto'] }));
    await assertFails(updateDoc(doc(courtierA(), 'ci_cabinets/A'), { enabledInsurers: ['axa'] }));
  });

  it("l'admin ne peut ni réactiver son cabinet ni changer son propriétaire", async () => {
    await assertFails(updateDoc(doc(adminA(), 'ci_cabinets/A'), { active: false }));
    await assertFails(updateDoc(doc(adminA(), 'ci_cabinets/A'), { ownerUid: 'quelquun' }));
  });

  it('les membres ne sont jamais créés ni promus depuis le client, même par un admin', async () => {
    await assertFails(setDoc(doc(adminA(), 'ci_cabinets/A/ci_members/intrus'), { role: 'admin', status: 'active' }));
    await assertFails(updateDoc(doc(adminA(), 'ci_cabinets/A/ci_members/courtier-a'), { role: 'admin' }));
  });

  it("un courtier lit jobs et offres mais ne les écrit pas (functions tarification-*), pas plus que les documents (documents-*), pas plus qu'une collection inconnue", async () => {
    await assertFails(setDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1/ci_quoteJobs/assureur-a'), { status: 'requested' }));
    await assertFails(setDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1/ci_offers/assureur-a'), { premiumAnnual: 842, source: 'manual' }));
    await assertSucceeds(getDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1/ci_quoteJobs/assureur-a')));
    await assertSucceeds(getDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1/ci_offers/assureur-a')));
    await assertFails(setDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1/ci_documents/doc1'), { type: 'carte_grise' }));
    await assertFails(setDoc(doc(courtierA(), 'ci_cabinets/A/collection-inconnue/x'), { a: 1 }));
    await assertFails(setDoc(doc(courtierA(), 'ci_cabinets/A/ci_counters/ci_dossiers'), { value: 999 }));
  });

  it("l'historique d'un dossier est en ajout seul", async () => {
    await assertSucceeds(setDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1/ci_events/e2'), { type: 'note', by: 'courtier-a' }));
    await assertFails(setDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1/ci_events/e3'), { type: 'status_changed', by: 'courtier-a' }));
    await assertFails(setDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1/ci_events/e4'), { type: 'note', by: 'admin-a' }));
    await assertFails(updateDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1/ci_events/e1'), { type: 'modifié' }));
  });
});

describe('Cabinet désactivé', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async context => {
      await updateDoc(doc(context.firestore(), 'ci_cabinets/A'), { active: false });
    });
  });

  it('ses membres ne lisent ni n’écrivent plus rien', async () => {
    await assertFails(getDoc(doc(adminA(), 'ci_cabinets/A')));
    await assertFails(getDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1')));
    await assertFails(setDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d2'), { status: 'brouillon' }));
  });

  it('les autres cabinets ne sont pas affectés', async () => {
    await assertSucceeds(getDoc(doc(adminB(), 'ci_cabinets/B/ci_dossiers/d1')));
  });
});

describe('Catalogue global', () => {
  it('tout utilisateur connecté le lit, personne ne le modifie depuis le client', async () => {
    await assertSucceeds(getDoc(doc(courtierA(), 'ci_products/auto')));
    await assertFails(setDoc(doc(adminA(), 'ci_products/auto'), { name: 'Modifié' }));
  });

  it("un cabinet n'a plus de catalogue à lui : ni lecture ni écriture d'assureurs ou de produits du cabinet", async () => {
    for (const collection of ['ci_insurers', 'ci_products']) {
      await assertFails(getDoc(doc(adminA(), `ci_cabinets/A/${collection}/x`)));
      await assertFails(setDoc(doc(adminA(), `ci_cabinets/A/${collection}/x`), { name: 'Ajouté' }));
    }
  });
});

describe('Offres', () => {
  it('tout utilisateur connecté lit les offres, personne ne les modifie depuis le client', async () => {
    await env.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'ci_plans/essentiel'), { name: 'Essentiel', limits: { maxUtilisateurs: 3, resetsAppareilParMois: 2 } });
    });
    await assertSucceeds(getDoc(doc(courtierA(), 'ci_plans/essentiel')));
    await assertFails(setDoc(doc(adminA(), 'ci_plans/essentiel'), { limits: { maxUtilisateurs: 99 } }));
  });
});

describe("Journal d'audit", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'ci_cabinets/A/ci_auditLog/l1'), { type: 'connexion', uid: 'courtier-a', by: 'courtier-a' });
    });
  });

  it("l'admin du cabinet le lit, le courtier et l'autre cabinet non", async () => {
    await assertSucceeds(getDoc(doc(adminA(), 'ci_cabinets/A/ci_auditLog/l1')));
    await assertFails(getDoc(doc(courtierA(), 'ci_cabinets/A/ci_auditLog/l1')));
    await assertFails(getDoc(doc(adminB(), 'ci_cabinets/A/ci_auditLog/l1')));
  });

  it("personne ne l'écrit ni ne l'efface depuis le client", async () => {
    await assertFails(setDoc(doc(adminA(), 'ci_cabinets/A/ci_auditLog/l2'), { type: 'connexion' }));
    await assertFails(updateDoc(doc(adminA(), 'ci_cabinets/A/ci_auditLog/l1'), { type: 'autre' }));
    await assertFails(deleteDoc(doc(adminA(), 'ci_cabinets/A/ci_auditLog/l1')));
  });
});

describe('Cabinet au-delà de sa limite après une baisse d’offre', () => {
  const setGrace = delta =>
    env.withSecurityRulesDisabled(async context => {
      await updateDoc(doc(context.firestore(), 'ci_cabinets/A'), { graceEndsAt: Timestamp.fromMillis(Date.now() + delta) });
    });

  it('pendant le délai de grâce, tout le monde garde l’accès', async () => {
    await setGrace(7 * 24 * 3600 * 1000);
    await assertSucceeds(getDoc(doc(adminA(), 'ci_cabinets/A/ci_dossiers/d1')));
    await assertSucceeds(getDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1')));
  });

  it('une fois le délai écoulé, seul l’admin garde l’accès', async () => {
    await setGrace(-1000);
    await assertSucceeds(getDoc(doc(adminA(), 'ci_cabinets/A/ci_dossiers/d1')));
    await assertFails(getDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1')));
    await assertFails(setDoc(doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d2'), { status: 'brouillon' }));
  });

  it('les autres cabinets ne sont pas affectés', async () => {
    await setGrace(-1000);
    await assertSucceeds(getDoc(doc(adminB(), 'ci_cabinets/B/ci_dossiers/d1')));
  });
});

describe('Dossiers : écritures réservées aux functions', () => {
  it('un courtier modifie les champs libres du dossier, mais ni son statut, ni ses données, ni son besoin, ni sa référence, ni son assignation', async () => {
    const dossier = doc(courtierA(), 'ci_cabinets/A/ci_dossiers/d1');
    await assertSucceeds(updateDoc(dossier, { updatedAt: new Date() }));
    for (const forbidden of [
      { status: 'complet' },
      { data: { 'client.firstName': 'X' } },
      { reference: '2026-000001' },
      { completeness: { ok: true, missing: [] } },
      { assignedTo: 'courtier-a' },
      { draft: { sectionIndex: 3 } },
      { needAnalysis: { coverageLevel: 'tous_risques', validatedAt: null } },
      { decision: { insurerId: 'assureur-a' } },
      { proposal: null },
      { outcome: { result: 'souscrit' } },
      { questionnaireSnapshot: [] },
      { champInconnu: 'x' },
    ]) {
      await assertFails(updateDoc(dossier, forbidden));
    }
  });

  it('personne ne supprime un dossier', async () => {
    await assertFails(deleteDoc(doc(adminA(), 'ci_cabinets/A/ci_dossiers/d1')));
  });
});

describe('Assurés : contrôles des écritures du client', () => {
  const valid = (uid = 'courtier-a') => ({
    type: 'pro',
    civilite: null,
    firstName: 'Jeanne',
    lastName: 'Martin',
    companyName: 'Martin SARL',
    siret: '12345678901234',
    birthDate: null,
    email: 'jeanne@martin.fr',
    phone: '06 12 34 56 78',
    address: { street: '1 rue de la Paix', postalCode: '75002', city: 'Paris', country: 'FR' },
    createdBy: uid,
    createdAt: serverTimestamp(),
  });
  const assure = (db, cabinet = 'A') => doc(db, `ci_cabinets/${cabinet}/ci_assures/as1`);

  // La création passe par la function assures-creer : l'assuré est posé en contournant les règles.
  const seed = (data = valid()) => env.withSecurityRulesDisabled(ctx => setDoc(assure(ctx.firestore()), data));

  it("personne ne crée un assuré directement (function assures-creer)", async () => {
    await assertFails(setDoc(assure(courtierA()), valid()));
    await assertFails(setDoc(assure(adminA()), valid('admin-a')));
  });

  it('un membre lit et modifie un assuré', async () => {
    await seed();
    await assertSucceeds(getDoc(assure(adminA())));
    await assertSucceeds(updateDoc(assure(courtierA()), { phone: '0700000000', updatedAt: serverTimestamp() }));
  });

  it("l'auteur et la date de création sont ceux de la requête", async () => {
    await assertFails(setDoc(assure(courtierA()), valid('admin-a')));
    await assertFails(setDoc(assure(courtierA()), { ...valid(), createdAt: Timestamp.fromMillis(0) }));
  });

  it('les champs inconnus et les formats invalides sont refusés', async () => {
    await assertFails(setDoc(assure(courtierA()), { ...valid(), role: 'admin' }));
    await assertFails(setDoc(assure(courtierA()), { ...valid(), type: 'entreprise' }));
    await assertFails(setDoc(assure(courtierA()), { ...valid(), email: 'pas-un-email' }));
    await assertFails(setDoc(assure(courtierA()), { ...valid(), siret: '1234' }));
    await assertFails(setDoc(assure(courtierA()), { ...valid(), type: 'particulier' }));
    await assertFails(setDoc(assure(courtierA()), { ...valid(), lastName: 'x'.repeat(101) }));
    await assertFails(setDoc(assure(courtierA()), { ...valid(), address: { postalCode: '7500' } }));
  });

  it("une modification ne change ni l'auteur ni la date de création, et personne ne supprime un assuré", async () => {
    await seed();
    await assertFails(updateDoc(assure(courtierA()), { createdBy: 'admin-a', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(assure(courtierA()), { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(assure(courtierA()), { email: 'invalide', updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(assure(adminA())));
  });

  it("le SIRET et l'email ne changent que par la function assures-modifier (doublon bloquant)", async () => {
    await seed();
    await assertFails(updateDoc(assure(courtierA()), { siret: '99998888777766', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(assure(adminA()), { email: 'autre@exemple.fr', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(assure(adminA()), { email: null, updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(assure(courtierA()), { phone: '0600000000', updatedAt: serverTimestamp() }));
  });

  it("un autre cabinet ne lit ni n'écrit les assurés", async () => {
    await assertFails(setDoc(assure(adminB(), 'A'), valid('admin-b')));
    await seed();
    await assertFails(getDoc(assure(adminB(), 'A')));
    await assertFails(updateDoc(assure(adminB(), 'A'), { phone: '0700000000', updatedAt: serverTimestamp() }));
  });
});
