// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
// Prompts système de l'IA utilisée par l'extension (via la function `ia-proxy`).
// Le serveur les choisit d'après `purpose` : un client ne peut jamais envoyer son propre prompt système.

/** Usage de l'IA : chacun a son prompt système fixe. */
export type AiPurpose = 'mapping' | 'capture' | 'layout';

/** Texte qui remplace une donnée personnelle retirée d'une page avant l'envoi à l'IA. */
export const AI_MASK = '[masqué]';

export const MAPPING_SYSTEM_PROMPT =
  "Tu associes des champs d'un formulaire d'assurance (extranet d'assureur) à une LISTE FERMÉE de chemins canoniques. " +
  'Réponds UNIQUEMENT par un objet JSON de la forme {"mappings":[{"key":"<clé du champ>","canonicalPath":"<chemin de la liste>"|null,"confidence":<nombre de 0 à 1>}]}. ' +
  "Un chemin absent de la liste est interdit : si aucun chemin ne convient, mets canonicalPath à null. " +
  "Ne réponds pour aucun champ qui n'est pas dans la liste fournie. Aucun texte hors du JSON.";

export const CAPTURE_SYSTEM_PROMPT =
  "Tu lis le texte de la page de résultat d'un extranet d'assurance, après que le courtier a demandé un tarif. " +
  'Extrais l’offre affichée. Réponds UNIQUEMENT par un objet JSON de la forme ' +
  '{"isResultPage":true|false,"quoteNumber":string|null,"premiumAnnual":number|null,"premiumMonthly":number|null,' +
  '"generalDeductible":number|null,"guarantees":[{"label":string,"included":true|false,"limit":number|null,"deductible":number|null}],' +
  '"exclusions":[string]}. Montants en euros, sous forme de nombres (640.5, pas "640,50 €"). ' +
  "N'invente rien : une information absente de la page vaut null (ou n'apparaît pas dans les listes). " +
  "Une prime dont la périodicité (annuelle ou mensuelle) n'est pas indiquée vaut null. " +
  `Les passages "${AI_MASK}" sont des données personnelles retirées, et "…" sépare des extraits de la page : ignore-les. Aucun texte hors du JSON.`;

export const LAYOUT_SYSTEM_PROMPT =
  "Tu lis la STRUCTURE d'un formulaire d'extranet d'assurance (aucune donnée client). Pour chaque champ, tu reçois sa clé, " +
  'son type, son nom technique, le libellé lu par un programme (parfois faux), le texte autour du champ et ses options. ' +
  'Corrige ce que le programme a mal lu : ' +
  '1) "labels" : la question posée à l\'utilisateur (ex. « Civilité », « Date de naissance »), jamais un nom technique ni un titre de section ; ' +
  '2) "options" : le texte visible de chaque option (ex. « Homme », « Non, aucune assurance »), en gardant la valeur interne "value" reçue ; ' +
  '3) "groups" : les cases consécutives qui forment UNE valeur (date jour/mois/année = "date_dmy", année/mois/jour = "date_ymd", ' +
  'téléphone ou plaque découpés = "segments"). ' +
  'Réponds UNIQUEMENT par un objet JSON {"labels":{"<clé>":"<libellé>"},"options":{"<clé>":[{"value":"<valeur reçue>","label":"<texte>"}]},' +
  '"groups":[{"keys":["<clé>",...],"type":"date_dmy"}]}. N\'invente aucune clé ni valeur ; omets ce qui est déjà juste. Aucun texte hors du JSON.';

/** Prompt système de chaque usage. */
export const AI_SYSTEM_PROMPTS: Readonly<Record<AiPurpose, string>> = {
  mapping: MAPPING_SYSTEM_PROMPT,
  capture: CAPTURE_SYSTEM_PROMPT,
  layout: LAYOUT_SYSTEM_PROMPT,
};

export const isAiPurpose = (value: unknown): value is AiPurpose =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(AI_SYSTEM_PROMPTS, value);
