// Donne (ou retire) le rôle super-admin de Courtier Intelligent à un compte existant.
//
// Usage :  node scripts/set-superadmin.mjs <email> [--remove]
// Pré-requis : être authentifié sur le projet (gcloud auth application-default login)
// et définir GCLOUD_PROJECT (par défaut : aibs-partenaire-testing).
// Les claims des autres applications du projet partagé sont conservés.
import { cert, initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const [email, flag] = process.argv.slice(2);
if (!email) {
  console.error('Usage : node scripts/set-superadmin.mjs <email> [--remove]');
  process.exit(1);
}

const projectId = process.env.GCLOUD_PROJECT ?? 'aibs-partenaire-testing';
const credential = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? cert(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  : applicationDefault();
initializeApp({ credential, projectId });

const auth = getAuth();
const user = await auth.getUserByEmail(email);
const claims = { ...(user.customClaims ?? {}) };

if (flag === '--remove') {
  if (claims.ci_role === 'superadmin') delete claims.ci_role;
} else {
  if (claims.ci_tenant_id) {
    console.error('Ce compte est rattaché à un cabinet : utiliser un compte dédié au super-admin.');
    process.exit(1);
  }
  claims.ci_role = 'superadmin';
}

await auth.setCustomUserClaims(user.uid, claims);
console.log(`${email} : ${flag === '--remove' ? 'rôle super-admin retiré' : 'rôle super-admin accordé'} (projet ${projectId}).`);
console.log("L'utilisateur doit se reconnecter pour que le changement soit pris en compte.");
