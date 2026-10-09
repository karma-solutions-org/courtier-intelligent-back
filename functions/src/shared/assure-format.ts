// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
// Formats d'un assuré, partagés par l'app (validateurs du formulaire) et les règles Firestore
// (firestore.rules, bloc « assures » du repo back) : modifier les deux ensemble.

/** Email : « x@y.zz » sans espace. Les règles appliquent l'équivalent `[^ @]+@[^ @]+[.][^ @]{2,}`. */
export const ASSURE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** SIRET : 14 chiffres (espaces retirés avant l'enregistrement), réservé aux assurés professionnels. */
export const ASSURE_SIRET_PATTERN = /^\d{14}$/;
/** Code postal français : 5 chiffres. */
export const ASSURE_POSTAL_CODE_PATTERN = /^\d{5}$/;
/** Date de naissance : AAAA-MM-JJ. */
export const ASSURE_BIRTH_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Longueurs maximales contrôlées par les règles Firestore. */
export const ASSURE_MAX_LENGTHS = {
  firstName: 100,
  lastName: 100,
  companyName: 200,
  email: 254,
  phone: 30,
  street: 200,
  city: 100,
} as const;
