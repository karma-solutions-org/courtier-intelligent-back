// Tests des règles Firestore dans l'emulator : isolation des cabinets et droits par rôle.
// Lancer avec : npm run test:rules
import { after, before, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

const rulesPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../firestore.rules');
let env;

// Identités de test (claims préfixés ci_, comme en production).
const adminA = () => env.authenticatedContext('admin-a', { ci_tenant_id: 'A', ci_role: 'admin' }).firestore();
const courtierA = () => env.authenticatedContext('courtier-a', { ci_tenant_id: 'A', ci_role: 'courtier' }).firestore();
const adminB = () => env.authenticatedContext('admin-b', { ci_tenant_id: 'B', ci_role: 'admin' }).firestore();
const noTenant = () => env.authenticatedContext('sans-cabinet', {}).firestore();
const genericAdmin = () => env.authenticatedContext('autre-app', { admin: true, role: 'SUPER_ADMIN' }).firestore();
const superAdmin = () => env.authenticatedContext('super', { ci_role: 'superadmin' }).firestore();
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
    for (const tenant of ['A', 'B']) {
      await setDoc(doc(db, `tenants/${tenant}`), { name: `Cabinet ${tenant}`, active: true });
      await setDoc(doc(db, `tenants/${tenant}/members/admin-${tenant.toLowerCase()}`), { role: 'admin', status: 'active' });
      await setDoc(doc(db, `tenants/${tenant}/dossiers/d1`), { status: 'brouillon' });
      await setDoc(doc(db, `tenants/${tenant}/dossiers/d1/events/e1`), { type: 'created' });
    }
    await setDoc(doc(db, 'products/auto'), { name: 'Auto' });
  });
});

after(async () => {
  await env.cleanup();
});

describe('Isolation des cabinets', () => {
  it('un membre lit son cabinet et ses dossiers', async () => {
    await assertSucceeds(getDoc(doc(courtierA(), 'tenants/A')));
    await assertSucceeds(getDoc(doc(courtierA(), 'tenants/A/dossiers/d1')));
  });

  it("le cabinet A ne peut rien lire du cabinet B", async () => {
    await assertFails(getDoc(doc(adminA(), 'tenants/B')));
    await assertFails(getDoc(doc(adminA(), 'tenants/B/dossiers/d1')));
    await assertFails(getDoc(doc(adminA(), 'tenants/B/members/admin-b')));
    await assertFails(getDoc(doc(adminA(), 'tenants/B/dossiers/d1/events/e1')));
  });

  it("le cabinet A ne peut rien écrire dans le cabinet B", async () => {
    await assertFails(setDoc(doc(adminA(), 'tenants/B/dossiers/d2'), { status: 'brouillon' }));
    await assertFails(updateDoc(doc(adminA(), 'tenants/B'), { name: 'Piraté' }));
  });

  it('un compte sans cabinet ne lit aucun cabinet', async () => {
    await assertFails(getDoc(doc(noTenant(), 'tenants/A')));
    await assertFails(getDoc(doc(noTenant(), 'tenants/A/dossiers/d1')));
  });

  it("les claims génériques d'une autre application ne donnent aucun droit", async () => {
    await assertFails(getDoc(doc(genericAdmin(), 'tenants/A')));
    await assertFails(setDoc(doc(genericAdmin(), 'products/auto'), { name: 'Piraté' }));
  });

  it('un visiteur non connecté ne lit rien', async () => {
    await assertFails(getDoc(doc(anonymous(), 'tenants/A')));
    await assertFails(getDoc(doc(anonymous(), 'products/auto')));
  });
});

describe('Droits dans un cabinet', () => {
  it('un courtier crée un dossier, mais ne modifie pas le cabinet', async () => {
    await assertSucceeds(setDoc(doc(courtierA(), 'tenants/A/dossiers/d2'), { status: 'brouillon' }));
    await assertFails(updateDoc(doc(courtierA(), 'tenants/A'), { name: 'Nouveau nom' }));
  });

  it("l'admin modifie les informations de son cabinet", async () => {
    await assertSucceeds(updateDoc(doc(adminA(), 'tenants/A'), { name: 'Nouveau nom', orias: '12345678' }));
  });

  it("l'admin ne peut ni réactiver son cabinet ni changer son propriétaire", async () => {
    await assertFails(updateDoc(doc(adminA(), 'tenants/A'), { active: false }));
    await assertFails(updateDoc(doc(adminA(), 'tenants/A'), { ownerUid: 'quelquun' }));
  });

  it('les membres ne sont jamais modifiés depuis le client, même par un admin', async () => {
    await assertFails(setDoc(doc(adminA(), 'tenants/A/members/intrus'), { role: 'admin', status: 'active' }));
    await assertFails(updateDoc(doc(adminA(), 'tenants/A/members/admin-a'), { role: 'courtier' }));
  });

  it('un courtier écrit les jobs et offres de ses dossiers, pas une collection inconnue', async () => {
    await assertSucceeds(setDoc(doc(courtierA(), 'tenants/A/dossiers/d1/quoteJobs/assureur-a'), { status: 'requested' }));
    await assertSucceeds(setDoc(doc(courtierA(), 'tenants/A/dossiers/d1/offers/assureur-a'), { premiumAnnual: 842 }));
    await assertFails(setDoc(doc(courtierA(), 'tenants/A/collection-inconnue/x'), { a: 1 }));
    await assertFails(setDoc(doc(courtierA(), 'tenants/A/counters/dossiers'), { value: 999 }));
  });

  it("l'historique d'un dossier est en ajout seul", async () => {
    await assertSucceeds(setDoc(doc(courtierA(), 'tenants/A/dossiers/d1/events/e2'), { type: 'note' }));
    await assertFails(updateDoc(doc(courtierA(), 'tenants/A/dossiers/d1/events/e1'), { type: 'modifié' }));
  });
});

describe('Cabinet désactivé', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async context => {
      await updateDoc(doc(context.firestore(), 'tenants/A'), { active: false });
    });
  });

  it('ses membres ne lisent ni n’écrivent plus rien', async () => {
    await assertFails(getDoc(doc(adminA(), 'tenants/A')));
    await assertFails(getDoc(doc(courtierA(), 'tenants/A/dossiers/d1')));
    await assertFails(setDoc(doc(courtierA(), 'tenants/A/dossiers/d2'), { status: 'brouillon' }));
    await assertFails(updateDoc(doc(adminA(), 'tenants/A'), { name: 'Nouveau nom' }));
  });

  it('les autres cabinets ne sont pas affectés, le super-admin garde la lecture', async () => {
    await assertSucceeds(getDoc(doc(adminB(), 'tenants/B/dossiers/d1')));
    await assertSucceeds(getDoc(doc(superAdmin(), 'tenants/A')));
  });
});

describe('Catalogue global', () => {
  it('tout utilisateur connecté lit le catalogue, seul le super-admin le modifie', async () => {
    await assertSucceeds(getDoc(doc(courtierA(), 'products/auto')));
    await assertFails(setDoc(doc(adminA(), 'products/auto'), { name: 'Modifié' }));
    await assertSucceeds(setDoc(doc(superAdmin(), 'products/auto'), { name: 'Modifié' }));
  });

  it('le super-admin lit tous les cabinets', async () => {
    await assertSucceeds(getDoc(doc(superAdmin(), 'tenants/A')));
    await assertSucceeds(getDoc(doc(superAdmin(), 'tenants/B/dossiers/d1')));
  });
});
