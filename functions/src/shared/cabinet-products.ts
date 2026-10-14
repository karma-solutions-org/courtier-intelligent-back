// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
import { isCanonicalPath } from './canonical-paths.js';
import { Guarantee, GuaranteeType, Product, Question, QuestionChoice, QuestionnaireSection, QuestionType } from './models.js';

/**
 * Produits propres à un cabinet : créés par son admin (`cabinets/{c}/products/{id}`), à partir d'un produit existant
 * ou vierges, puis complétés à la main et par les champs découverts sur les extranets de ses assureurs.
 * Le préfixe dit sans lecture où trouver la fiche, et ne peut pas recouvrir un produit du catalogue.
 */
export const CABINET_PRODUCT_PREFIX = 'cab-';

export const CABINET_PRODUCT_NAME_MAX = 60;
export const CABINET_PRODUCTS_MAX = 30;
export const PRODUCT_SECTIONS_MAX = 20;
export const PRODUCT_QUESTIONS_MAX = 150;
export const PRODUCT_CHOICES_MAX = 40;
export const PRODUCT_GUARANTEES_MAX = 60;
export const PRODUCT_LABEL_MAX = 200;

export const QUESTION_TYPES: QuestionType[] = ['text', 'number', 'date', 'boolean', 'choice'];
export const GUARANTEE_TYPES: GuaranteeType[] = ['included', 'limit', 'deductible'];

export function isCabinetProductId(productId: string): boolean {
  return productId.startsWith(CABINET_PRODUCT_PREFIX);
}

/** Chemin Firestore de la fiche d'un produit, qu'il vienne du catalogue ou du cabinet. */
export function productDocPath(cabinetId: string, productId: string): string {
  return isCabinetProductId(productId) ? `ci_cabinets/${cabinetId}/ci_products/${productId}` : `ci_products/${productId}`;
}

/** Catalogue vu par un cabinet : produits globaux puis les siens (hors archivés), triés par nom. */
export function mergeProducts(global: Product[], cabinet: Product[]): Product[] {
  return [...global, ...cabinet.filter(product => !product.archived)].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/**
 * Point de départ d'un produit vierge : les questions sur le souscripteur (identité, contact, adresse), communes
 * à tous les produits, reprises d'un produit existant.
 */
export function blankQuestionnaire(from: QuestionnaireSection[]): QuestionnaireSection[] {
  const questions = from.flatMap(section => section.questions).filter(question => question.canonicalPath.startsWith('client.'));
  return questions.length ? [{ title: 'Souscripteur', questions: questions.map(question => ({ ...question })) }] : [];
}

/** Erreur de saisie d'un produit, lisible par le courtier. */
export class ProductValidationError extends Error {}

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');

function cleanChoices(raw: unknown, where: string): QuestionChoice[] {
  const list = Array.isArray(raw) ? raw : [];
  const choices: QuestionChoice[] = [];
  const values = new Set<string>();
  for (const item of list.slice(0, PRODUCT_CHOICES_MAX)) {
    const label = text((item as QuestionChoice)?.label, 100);
    const value = text((item as QuestionChoice)?.value, 100) || label;
    if (!label || values.has(value)) continue;
    values.add(value);
    choices.push({ value, label });
  }
  if (choices.length < 2) throw new ProductValidationError(`${where} : une liste de choix demande au moins 2 choix.`);
  return choices;
}

/**
 * Questionnaire saisi par le cabinet, contrôlé champ par champ (mêmes règles côté app et serveur) :
 * chemins canoniques ou `extra.*` uniques, types connus, choix pour une liste. Les informations posées par le système
 * (découverte sur un extranet, niveau de connaissance) sont gardées si elles sont bien formées.
 */
export function cleanQuestionnaire(raw: unknown): QuestionnaireSection[] {
  const sections = Array.isArray(raw) ? raw : [];
  if (sections.length > PRODUCT_SECTIONS_MAX) throw new ProductValidationError(`${PRODUCT_SECTIONS_MAX} sections au maximum.`);
  const paths = new Set<string>();
  let count = 0;
  const result: QuestionnaireSection[] = [];
  for (const rawSection of sections) {
    const title = text(rawSection?.title, 100);
    if (!title) throw new ProductValidationError('Chaque section doit avoir un titre.');
    const questions: Question[] = [];
    for (const rawQuestion of Array.isArray(rawSection?.questions) ? rawSection.questions : []) {
      const label = text(rawQuestion?.label, PRODUCT_LABEL_MAX);
      const path = String(rawQuestion?.canonicalPath ?? '');
      const type = rawQuestion?.type as QuestionType;
      if (!label) throw new ProductValidationError(`Section « ${title} » : chaque question doit avoir un libellé.`);
      if (!isCanonicalPath(path)) throw new ProductValidationError(`« ${label} » : identifiant de question invalide.`);
      if (paths.has(path)) throw new ProductValidationError(`« ${label} » : cette question existe déjà dans le questionnaire.`);
      if (!QUESTION_TYPES.includes(type)) throw new ProductValidationError(`« ${label} » : type de question inconnu.`);
      paths.add(path);
      if (++count > PRODUCT_QUESTIONS_MAX) throw new ProductValidationError(`${PRODUCT_QUESTIONS_MAX} questions au maximum.`);
      const question: Question = { canonicalPath: path, label, type, required: rawQuestion?.required === true };
      if (type === 'choice') question.choices = cleanChoices(rawQuestion?.choices, `« ${label} »`);
      if (rawQuestion?.withKnowledge === true) question.withKnowledge = true;
      if (rawQuestion?.mustBeKnown === true) question.mustBeKnown = true;
      if (Array.isArray(rawQuestion?.discoveredOn)) question.discoveredOn = rawQuestion.discoveredOn.slice(-20);
      const visibleIf = rawQuestion?.visibleIf;
      if (visibleIf && isCanonicalPath(String(visibleIf.path)) && ['string', 'number', 'boolean'].includes(typeof visibleIf.equals)) {
        question.visibleIf = { path: visibleIf.path, equals: visibleIf.equals };
      }
      questions.push(question);
    }
    result.push({ title, questions, ...(rawSection?.discovered === true ? { discovered: true } : {}) });
  }
  // Une condition d'affichage doit viser une question du questionnaire.
  for (const question of result.flatMap(section => section.questions)) {
    if (question.visibleIf && !paths.has(question.visibleIf.path)) delete question.visibleIf;
  }
  return result;
}

/** Référentiel des garanties saisi par le cabinet : libellés uniques, codes générés s'ils manquent. */
export function cleanGuarantees(raw: unknown): Guarantee[] {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > PRODUCT_GUARANTEES_MAX) throw new ProductValidationError(`${PRODUCT_GUARANTEES_MAX} garanties au maximum.`);
  const codes = new Set<string>();
  const labels = new Set<string>();
  return list.map((item, index) => {
    const label = text(item?.label, 100);
    if (!label) throw new ProductValidationError('Chaque garantie doit avoir un libellé.');
    if (labels.has(label.toLowerCase())) throw new ProductValidationError(`La garantie « ${label} » est en double.`);
    labels.add(label.toLowerCase());
    const type = GUARANTEE_TYPES.includes(item?.type) ? (item.type as GuaranteeType) : 'included';
    let code = /^[A-Z0-9_]{1,20}$/.test(String(item?.code ?? '')) ? String(item.code) : guaranteeCode(label, index);
    while (codes.has(code)) code = `${code.slice(0, 17)}_${index}`;
    codes.add(code);
    return { code, label, type };
  });
}

/** Code d'une garantie créée par le cabinet, tiré de son libellé (« Bris de glace » → BRIS_DE_GLACE). */
export function guaranteeCode(label: string, index = 0): string {
  const code = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 20);
  return code || `G${index + 1}`;
}
