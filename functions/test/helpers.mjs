// Outils communs aux tests d'intégration (emulators auth + functions + firestore).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT = 'demo-courtier-intelligent';
export const PASSWORD = 'motdepasse-de-test';
export const DEVICE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FUNCTIONS = process.env.CALLABLES_HOST ?? '127.0.0.1:5001';
const functionsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Connexion par mot de passe : un jeton avec les claims actuels du compte. */
export async function signIn(email) {
  const response = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  return (await response.json()).idToken;
}

/** Appelle une callable ; renvoie { data } ou { error: { status, message, details } }. */
export async function call(name, token, data = {}) {
  const response = await fetch(`http://${FUNCTIONS}/${PROJECT}/europe-west3/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ data }),
  });
  const body = await response.json();
  return body.error ? { error: body.error } : { data: body.result };
}

export const ouvrir = (token, deviceId = DEVICE_A) => call('sessions-ouvrir', token, { deviceId, appareil: 'Chrome · Windows' });

export const ops = (script, ...args) =>
  execFileSync('node', [path.join(functionsDir, `lib/ops/${script}.js`), '--emulator', ...args], { encoding: 'utf8' });

/** Réponses obligatoires d'un dossier Auto complet (voir catalog/products/auto/questionnaire.json). */
export const completeAutoData = () => ({
  'client.lastName': 'Dupont',
  'client.firstName': 'Jean',
  'client.birthDate': '1985-03-12',
  'client.email': 'jean@example.fr',
  'client.address.street': '1 rue de la Paix',
  'client.address.postalCode': '75002',
  'client.address.city': 'Paris',
  'vehicle.registration': 'AB-123-CD',
  'vehicle.brand': 'Renault',
  'vehicle.model': 'Clio',
  'vehicle.firstRegistrationDate': '2019-05-01',
  'vehicle.fiscalPower': 5,
  'vehicle.vehicleType': 'voiture',
  'vehicle.usage': 'prive',
  'vehicle.parkingType': 'garage_prive',
  'driver.lastName': 'Dupont',
  'driver.firstName': 'Jean',
  'driver.birthDate': '1985-03-12',
  'driver.licenseDate': '2004-07-01',
  'driver.licenseType': 'B',
  'insuranceHistory.currentlyInsured': false,
  'insuranceHistory.bonusMalus': { value: 0.9, knowledge: 'KNOWN' },
  'insuranceHistory.claimsCount': { value: 0, knowledge: 'KNOWN' },
  'insuranceHistory.wasTerminated': false,
});
