// Tests des règles Storage dans l'emulator : logo du cabinet (admins), devis joints aux offres (E9-5), isolation.
// Lancer avec : npm test
import { after, before, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, Timestamp } from 'firebase/firestore';
import { deleteObject, getBytes, ref, uploadBytes } from 'firebase/storage';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let env;

const MEMBERS = {
  'admin-a': { cabinet: 'A', role: 'admin', authTime: 1_790_000_001 },
  'courtier-a': { cabinet: 'A', role: 'courtier', authTime: 1_790_000_002 },
  'courtier-b': { cabinet: 'B', role: 'courtier', authTime: 1_790_000_003 },
};

/** Le client Storage d'un membre, depuis l'appareil de sa session (ou un autre `authTime`). */
function storageOf(uid, authTime = MEMBERS[uid].authTime) {
  const { cabinet, role } = MEMBERS[uid];
  return env.authenticatedContext(uid, { ci_cabinet_id: cabinet, ci_role: role, auth_time: authTime }).storage();
}

const DEVIS = 'cabinets/A/dossiers/d1/devis';
const file = (bytes, contentType) => [new Uint8Array(bytes), { contentType }];
const pdf = (size = 1024) => file(size, 'application/pdf');
const upload = (storage, filePath, [bytes, metadata]) => uploadBytes(ref(storage, filePath), bytes, metadata);

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-courtier-intelligent',
    firestore: { rules: fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8') },
    storage: { rules: fs.readFileSync(path.join(root, 'storage.rules'), 'utf8') },
  });
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const cabinet of ['A', 'B']) await setDoc(doc(db, `cabinets/${cabinet}`), { name: cabinet, active: true });
    for (const [uid, member] of Object.entries(MEMBERS)) {
      await setDoc(doc(db, `cabinets/${member.cabinet}/members/${uid}`), {
        role: member.role,
        status: 'active',
        session: { id: uid, authTime: member.authTime, lastSeen: Timestamp.now() },
      });
    }
  });
});

after(async () => env.cleanup());

describe('Devis joint à une offre (E9-5)', () => {
  it('un membre du cabinet envoie un devis PDF, JPG ou PNG, et le relit', async () => {
    const storage = storageOf('courtier-a');
    await assertSucceeds(upload(storage, `${DEVIS}/assureur-a-1.pdf`, pdf()));
    await assertSucceeds(upload(storage, `${DEVIS}/assureur-a-2.jpg`, file(10, 'image/jpeg')));
    await assertSucceeds(upload(storage, `${DEVIS}/assureur-a-3.png`, file(10, 'image/png')));
    await assertSucceeds(getBytes(ref(storage, `${DEVIS}/assureur-a-1.pdf`)));
  });

  it('refuse un autre type de fichier, plus de 10 Mo, ou un nom de fichier douteux', async () => {
    const storage = storageOf('courtier-a');
    await assertFails(upload(storage, `${DEVIS}/script.html`, file(10, 'text/html')));
    await assertFails(upload(storage, `${DEVIS}/devis.exe`, file(10, 'application/octet-stream')));
    await assertFails(upload(storage, `${DEVIS}/gros.pdf`, pdf(10 * 1024 * 1024 + 1)));
    await assertFails(upload(storage, `${DEVIS}/.cache.pdf`, pdf()));
    await assertFails(upload(storage, `${DEVIS}/mon devis.pdf`, pdf()));
  });

  it('un devis envoyé n’est ni remplacé ni supprimé', async () => {
    const storage = storageOf('courtier-a');
    await assertSucceeds(upload(storage, `${DEVIS}/remplace-1.pdf`, pdf()));
    await assertFails(upload(storage, `${DEVIS}/remplace-1.pdf`, pdf(2048)));
    await assertFails(deleteObject(ref(storage, `${DEVIS}/remplace-1.pdf`)));
  });

  it("un autre cabinet, ou un autre appareil du même compte, n'y a pas accès", async () => {
    await assertSucceeds(upload(storageOf('courtier-a'), `${DEVIS}/isole-1.pdf`, pdf()));
    await assertFails(getBytes(ref(storageOf('courtier-b'), `${DEVIS}/isole-1.pdf`)));
    await assertFails(upload(storageOf('courtier-b'), `${DEVIS}/intrus.pdf`, pdf()));
    await assertFails(getBytes(ref(storageOf('courtier-a', 1_790_009_999), `${DEVIS}/isole-1.pdf`)));
  });
});

describe('Logo du cabinet', () => {
  it("seul un admin le change, avec une image de moins de 2 Mo", async () => {
    await assertSucceeds(upload(storageOf('admin-a'), 'cabinets/A/logo/logo', file(100, 'image/png')));
    await assertFails(upload(storageOf('admin-a'), 'cabinets/A/logo/logo', file(100, 'application/pdf')));
    await assertFails(upload(storageOf('admin-a'), 'cabinets/A/logo/logo', file(2 * 1024 * 1024, 'image/png')));
  });

  it("un courtier ne peut pas le remplacer (la règle générale ne contourne plus celle du logo)", async () => {
    await assertSucceeds(upload(storageOf('admin-a'), 'cabinets/A/logo/logo', file(100, 'image/png')));
    await assertFails(upload(storageOf('courtier-a'), 'cabinets/A/logo/logo', file(100, 'image/png')));
    await assertSucceeds(getBytes(ref(storageOf('courtier-a'), 'cabinets/A/logo/logo')));
  });
});

describe('Autres fichiers du cabinet', () => {
  it('les documents des dossiers (E12) restent accessibles à ses membres, et à eux seuls', async () => {
    await assertSucceeds(upload(storageOf('courtier-a'), 'cabinets/A/dossiers/d1/documents/carte-grise.pdf', pdf()));
    await assertFails(upload(storageOf('courtier-b'), 'cabinets/A/dossiers/d1/documents/carte-grise.pdf', pdf()));
  });

  it('tout autre emplacement est refusé, même à un admin du cabinet', async () => {
    await assertFails(upload(storageOf('admin-a'), 'cabinets/A/divers/fichier.pdf', pdf()));
    await assertFails(upload(storageOf('admin-a'), 'cabinets/A/dossiers/d1/fichier.pdf', pdf()));
  });
});
