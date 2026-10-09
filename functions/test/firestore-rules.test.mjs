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
      await setDoc(doc(db, `cabinets/${cabinet}`), { name: `Cabinet ${cabinet}`, active: true, planId: 'essentiel', limits: { maxUtilisateurs: 3, resetsAppareilParMois: 2 } });
      await setDoc(doc(db, `cabinets/${cabinet}/dossiers/d1`), { status: 'brouillon' });
      await setDoc(doc(db, `cabinets/${cabinet}/dossiers/d1/events/e1`), { type: 'created' });
    }
    for (const [uid, member] of Object.entries(MEMBERS)) {
      await setDoc(doc(db, `cabinets/${member.cabinet}/members/${uid}`), {
        role: member.role,
        status: 'active',
        session: { id: `appareil-${uid}`, authTime: member.authTime, appareil: 'Chrome', lastSeen: Timestamp.now() },
      });
    }
    await setDoc(doc(db, 'products/auto'), { name: 'Auto' });
  });
});

after(async () => {
  await env.cleanup();
});

describe('Isolation des cabinets', () => {
  it('un membre lit son cabinet et ses dossiers', async () => {
    await assertSucceeds(getDoc(doc(courtierA(), 'cabinets/A')));
    await assertSucceeds(getDoc(doc(courtierA(), 'cabinets/A/dossiers/d1')));
  });

  it('le cabinet A ne peut rien lire du cabinet B', async () => {
    await assertFails(getDoc(doc(adminA(), 'cabinets/B')));
    await assertFails(getDoc(doc(adminA(), 'cabinets/B/dossiers/d1')));
    await assertFails(getDoc(doc(adminA(), 'cabinets/B/members/admin-b')));
    await assertFails(getDoc(doc(adminA(), 'cabinets/B/dossiers/d1/events/e1')));
  });

  it('le cabinet A ne peut rien écrire dans le cabinet B', async () => {
    await assertFails(setDoc(doc(adminA(), 'cabinets/B/dossiers/d2'), { status: 'brouillon' }));
    await assertFails(updateDoc(doc(adminA(), 'cabinets/B'), { name: 'Piraté' }));
  });

  it('un compte sans cabinet ne lit aucun cabinet', async () => {
    await assertFails(getDoc(doc(noCabinet(), 'cabinets/A')));
    await assertFails(getDoc(doc(noCabinet(), 'cabinets/A/dossiers/d1')));
  });

  it("les claims génériques d'une autre application ne donnent aucun droit", async () => {
    await assertFails(getDoc(doc(otherAppAdmin(), 'cabinets/A')));
    await assertFails(setDoc(doc(otherAppAdmin(), 'products/auto'), { name: 'Piraté' }));
  });

  it('un visiteur non connecté ne lit rien', async () => {
    await assertFails(getDoc(doc(anonymous(), 'cabinets/A')));
    await assertFails(getDoc(doc(anonymous(), 'products/auto')));
  });
});

describe('Un seul appareil par utilisateur', () => {
  it("un deuxième appareil, avec le bon compte et les mêmes claims, n'a accès à rien", async () => {
    const autreAppareil = as('courtier-a', OTHER_DEVICE_AUTH_TIME);
    await assertFails(getDoc(doc(autreAppareil, 'cabinets/A')));
    await assertFails(getDoc(doc(autreAppareil, 'cabinets/A/dossiers/d1')));
    await assertFails(setDoc(doc(autreAppareil, 'cabinets/A/dossiers/d2'), { status: 'brouillon' }));
  });

  it("un compte dont la session a été fermée n'a plus accès", async () => {
    await env.withSecurityRulesDisabled(async context => {
      await updateDoc(doc(context.firestore(), 'cabinets/A/members/courtier-a'), { session: null });
    });
    await assertFails(getDoc(doc(courtierA(), 'cabinets/A/dossiers/d1')));
  });

  it('un membre envoie le signal de vie de sa session', async () => {
    await assertSucceeds(
      updateDoc(doc(courtierA(), 'cabinets/A/members/courtier-a'), { 'session.lastSeen': serverTimestamp() }),
    );
  });

  it("le signal de vie ne permet de modifier ni la session, ni le rôle, ni l'heure", async () => {
    const me = doc(courtierA(), 'cabinets/A/members/courtier-a');
    await assertFails(updateDoc(me, { 'session.id': 'session-pirate' }));
    await assertFails(updateDoc(me, { 'session.authTime': OTHER_DEVICE_AUTH_TIME }));
    await assertFails(updateDoc(me, { role: 'admin' }));
    await assertFails(updateDoc(me, { 'session.lastSeen': Timestamp.fromMillis(Date.now() + 3600_000) }));
  });

  it("un autre appareil ou un collègue ne peut pas entretenir la session d'un membre", async () => {
    await assertFails(
      updateDoc(doc(as('courtier-a', OTHER_DEVICE_AUTH_TIME), 'cabinets/A/members/courtier-a'), {
        'session.lastSeen': serverTimestamp(),
      }),
    );
    await assertFails(
      updateDoc(doc(adminA(), 'cabinets/A/members/courtier-a'), { 'session.lastSeen': serverTimestamp() }),
    );
  });
});

describe('Droits dans un cabinet', () => {
  it('un courtier ne crée pas un dossier directement (functions dossiers-creer), et ne modifie pas le cabinet', async () => {
    await assertFails(setDoc(doc(courtierA(), 'cabinets/A/dossiers/d2'), { status: 'brouillon' }));
    await assertFails(updateDoc(doc(courtierA(), 'cabinets/A'), { name: 'Nouveau nom' }));
  });

  it("l'admin modifie les informations de son cabinet", async () => {
    await assertSucceeds(updateDoc(doc(adminA(), 'cabinets/A'), { name: 'Nouveau nom', orias: '12345678' }));
  });

  it("l'admin ne peut pas augmenter la limite d'utilisateurs de son offre", async () => {
    await assertFails(updateDoc(doc(adminA(), 'cabinets/A'), { 'limits.maxUtilisateurs': 87 }));
    await assertFails(updateDoc(doc(adminA(), 'cabinets/A'), { limits: { maxUtilisateurs: 87, resetsAppareilParMois: 2 } }));
    await assertFails(updateDoc(doc(adminA(), 'cabinets/A'), { overrides: { maxUtilisateurs: 87 } }));
    await assertFails(updateDoc(doc(adminA(), 'cabinets/A'), { planId: 'illimite' }));
  });

  it("l'admin ne remet pas à zéro son quota de réinitialisations ni son délai de grâce", async () => {
    await assertFails(updateDoc(doc(adminA(), 'cabinets/A'), { deviceResets: { month: '2026-10', count: 0 } }));
    await assertFails(updateDoc(doc(adminA(), 'cabinets/A'), { graceEndsAt: null }));
  });

  it("l'admin choisit les assureurs et produits actifs de son cabinet, pas le courtier", async () => {
    await assertSucceeds(updateDoc(doc(adminA(), 'cabinets/A'), { enabledInsurers: ['axa'], enabledProducts: ['auto'] }));
    await assertFails(updateDoc(doc(courtierA(), 'cabinets/A'), { enabledInsurers: ['axa'] }));
  });

  it("l'admin ne peut ni réactiver son cabinet ni changer son propriétaire", async () => {
    await assertFails(updateDoc(doc(adminA(), 'cabinets/A'), { active: false }));
    await assertFails(updateDoc(doc(adminA(), 'cabinets/A'), { ownerUid: 'quelquun' }));
  });

  it('les membres ne sont jamais créés ni promus depuis le client, même par un admin', async () => {
    await assertFails(setDoc(doc(adminA(), 'cabinets/A/members/intrus'), { role: 'admin', status: 'active' }));
    await assertFails(updateDoc(doc(adminA(), 'cabinets/A/members/courtier-a'), { role: 'admin' }));
  });

  it("un courtier lit jobs et offres mais ne les écrit pas (functions tarification-*), pas plus qu'une collection inconnue", async () => {
    await assertFails(setDoc(doc(courtierA(), 'cabinets/A/dossiers/d1/quoteJobs/assureur-a'), { status: 'requested' }));
    await assertFails(setDoc(doc(courtierA(), 'cabinets/A/dossiers/d1/offers/assureur-a'), { premiumAnnual: 842, source: 'manual' }));
    await assertSucceeds(getDoc(doc(courtierA(), 'cabinets/A/dossiers/d1/quoteJobs/assureur-a')));
    await assertSucceeds(getDoc(doc(courtierA(), 'cabinets/A/dossiers/d1/offers/assureur-a')));
    await assertSucceeds(setDoc(doc(courtierA(), 'cabinets/A/dossiers/d1/documents/doc1'), { type: 'carte_grise' }));
    await assertFails(setDoc(doc(courtierA(), 'cabinets/A/collection-inconnue/x'), { a: 1 }));
    await assertFails(setDoc(doc(courtierA(), 'cabinets/A/counters/dossiers'), { value: 999 }));
  });

  it("l'historique d'un dossier est en ajout seul", async () => {
    await assertSucceeds(setDoc(doc(courtierA(), 'cabinets/A/dossiers/d1/events/e2'), { type: 'note', by: 'courtier-a' }));
    await assertFails(setDoc(doc(courtierA(), 'cabinets/A/dossiers/d1/events/e3'), { type: 'status_changed', by: 'courtier-a' }));
    await assertFails(setDoc(doc(courtierA(), 'cabinets/A/dossiers/d1/events/e4'), { type: 'note', by: 'admin-a' }));
    await assertFails(updateDoc(doc(courtierA(), 'cabinets/A/dossiers/d1/events/e1'), { type: 'modifié' }));
  });
});

describe('Cabinet désactivé', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async context => {
      await updateDoc(doc(context.firestore(), 'cabinets/A'), { active: false });
    });
  });

  it('ses membres ne lisent ni n’écrivent plus rien', async () => {
    await assertFails(getDoc(doc(adminA(), 'cabinets/A')));
    await assertFails(getDoc(doc(courtierA(), 'cabinets/A/dossiers/d1')));
    await assertFails(setDoc(doc(courtierA(), 'cabinets/A/dossiers/d2'), { status: 'brouillon' }));
  });

  it('les autres cabinets ne sont pas affectés', async () => {
    await assertSucceeds(getDoc(doc(adminB(), 'cabinets/B/dossiers/d1')));
  });
});

describe('Catalogue global', () => {
  it('tout utilisateur connecté le lit, personne ne le modifie depuis le client', async () => {
    await assertSucceeds(getDoc(doc(courtierA(), 'products/auto')));
    await assertFails(setDoc(doc(adminA(), 'products/auto'), { name: 'Modifié' }));
  });
});

describe('Offres', () => {
  it('tout utilisateur connecté lit les offres, personne ne les modifie depuis le client', async () => {
    await env.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'plans/essentiel'), { name: 'Essentiel', limits: { maxUtilisateurs: 3, resetsAppareilParMois: 2 } });
    });
    await assertSucceeds(getDoc(doc(courtierA(), 'plans/essentiel')));
    await assertFails(setDoc(doc(adminA(), 'plans/essentiel'), { limits: { maxUtilisateurs: 99 } }));
  });
});

describe("Journal d'audit", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'cabinets/A/auditLog/l1'), { type: 'connexion', uid: 'courtier-a', by: 'courtier-a' });
    });
  });

  it("l'admin du cabinet le lit, le courtier et l'autre cabinet non", async () => {
    await assertSucceeds(getDoc(doc(adminA(), 'cabinets/A/auditLog/l1')));
    await assertFails(getDoc(doc(courtierA(), 'cabinets/A/auditLog/l1')));
    await assertFails(getDoc(doc(adminB(), 'cabinets/A/auditLog/l1')));
  });

  it("personne ne l'écrit ni ne l'efface depuis le client", async () => {
    await assertFails(setDoc(doc(adminA(), 'cabinets/A/auditLog/l2'), { type: 'connexion' }));
    await assertFails(updateDoc(doc(adminA(), 'cabinets/A/auditLog/l1'), { type: 'autre' }));
    await assertFails(deleteDoc(doc(adminA(), 'cabinets/A/auditLog/l1')));
  });
});

describe('Cabinet au-delà de sa limite après une baisse d’offre', () => {
  const setGrace = delta =>
    env.withSecurityRulesDisabled(async context => {
      await updateDoc(doc(context.firestore(), 'cabinets/A'), { graceEndsAt: Timestamp.fromMillis(Date.now() + delta) });
    });

  it('pendant le délai de grâce, tout le monde garde l’accès', async () => {
    await setGrace(7 * 24 * 3600 * 1000);
    await assertSucceeds(getDoc(doc(adminA(), 'cabinets/A/dossiers/d1')));
    await assertSucceeds(getDoc(doc(courtierA(), 'cabinets/A/dossiers/d1')));
  });

  it('une fois le délai écoulé, seul l’admin garde l’accès', async () => {
    await setGrace(-1000);
    await assertSucceeds(getDoc(doc(adminA(), 'cabinets/A/dossiers/d1')));
    await assertFails(getDoc(doc(courtierA(), 'cabinets/A/dossiers/d1')));
    await assertFails(setDoc(doc(courtierA(), 'cabinets/A/dossiers/d2'), { status: 'brouillon' }));
  });

  it('les autres cabinets ne sont pas affectés', async () => {
    await setGrace(-1000);
    await assertSucceeds(getDoc(doc(adminB(), 'cabinets/B/dossiers/d1')));
  });
});

describe('Dossiers : écritures réservées aux functions', () => {
  it('un courtier modifie les champs libres du dossier, mais ni son statut, ni ses données, ni son besoin, ni sa référence, ni son assignation', async () => {
    const dossier = doc(courtierA(), 'cabinets/A/dossiers/d1');
    await assertSucceeds(updateDoc(dossier, { proposal: null }));
    for (const forbidden of [
      { status: 'complet' },
      { data: { 'client.firstName': 'X' } },
      { reference: '2026-000001' },
      { completeness: { ok: true, missing: [] } },
      { assignedTo: 'courtier-a' },
      { draft: { sectionIndex: 3 } },
      { needAnalysis: { coverageLevel: 'tous_risques', validatedAt: null } },
    ]) {
      await assertFails(updateDoc(dossier, forbidden));
    }
  });

  it('personne ne supprime un dossier', async () => {
    await assertFails(deleteDoc(doc(adminA(), 'cabinets/A/dossiers/d1')));
  });
});
