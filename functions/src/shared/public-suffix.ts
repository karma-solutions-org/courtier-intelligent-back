// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
/**
 * Suffixes publics les plus courants, sous lesquels n'importe qui peut obtenir un sous-domaine (hébergeurs, domaines de
 * second niveau des pays). Un extranet ne peut pas être déclaré sur l'un d'eux : l'extension injecterait son script et
 * les données du client sur les sites de tous les autres titulaires. Liste volontairement courte (pas la Public Suffix
 * List complète) ; les « co.xx », « com.xx »… des pays sont couverts par motif.
 */
const PUBLIC_SUFFIXES = new Set([
  // Hébergeurs et plateformes
  'github.io', 'gitlab.io', 'web.app', 'firebaseapp.com', 'appspot.com', 'run.app', 'cloudfunctions.net',
  'googleusercontent.com', 'blogspot.com', 'sites.google.com', 'netlify.app', 'vercel.app', 'herokuapp.com',
  'pages.dev', 'workers.dev', 'trycloudflare.com', 'azurewebsites.net', 'azurestaticapps.net', 'cloudapp.net',
  'cloudfront.net', 'amazonaws.com', 's3.amazonaws.com', 'elasticbeanstalk.com', 'onrender.com', 'fly.dev',
  'glitch.me', 'repl.co', 'surge.sh', 'ngrok.io', 'ngrok-free.app', 'ngrok.app', 'wixsite.com', 'wordpress.com',
  'myshopify.com', 'sharepoint.com', 'webflow.io', 'framer.website', 'notion.site', 'ovh.net',
  // Second niveau ouvert à tous (France et Tunisie)
  'asso.fr', 'nom.fr', 'prd.fr', 'presse.fr', 'tm.fr', 'gouv.fr', 'com.fr', 'ens.tn', 'fin.tn', 'info.tn', 'nat.tn',
]);

/** Second niveau générique d'un domaine de pays : « co.uk », « com.tn », « org.au », « gov.fr »… */
const COUNTRY_SECOND_LEVEL = /^(?:co|com|org|net|gov|gouv|edu|ac|or|ne|go|mil|ltd|plc|biz|info)\.[a-z]{2}$/;

/** Le domaine est-il un suffixe public (et donc trop large pour désigner un extranet) ? */
export function isPublicSuffix(domain: string): boolean {
  const host = domain.trim().toLowerCase().replace(/^\*?\./, '').replace(/\.$/, '');
  return PUBLIC_SUFFIXES.has(host) || COUNTRY_SECOND_LEVEL.test(host);
}
