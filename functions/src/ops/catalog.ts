import fs from "node:fs";
import path from "node:path";
import {
  CANONICAL_PATHS,
  isCanonicalPath,
  type Guarantee,
  type GuaranteeType,
  type Insurer,
  type Plan,
  type QuestionnaireSection,
  type QuestionType,
} from "../shared/index.js";

/** Dossier des JSON du catalogue, à la racine du dépôt back (versionnés avec le code). */
export const CATALOG_DIR = path.resolve(__dirname, "../../../catalog");

export interface CatalogProduct {
  id: string;
  name: string;
  active: boolean;
  questionnaireSchema: QuestionnaireSection[];
  guaranteeCatalog: Guarantee[];
  /** code de garantie → formulations des assureurs. */
  synonyms: Record<string, string[]>;
}

export interface Catalog {
  plans: Plan[];
  insurers: Insurer[];
  products: CatalogProduct[];
}

export interface CatalogIssue {
  file: string;
  message: string;
}

const QUESTION_TYPES: QuestionType[] = ["text", "number", "date", "boolean", "choice"];
const GUARANTEE_TYPES: GuaranteeType[] = ["included", "limit", "deductible"];

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/** Lit un fichier JSON ; une erreur de syntaxe est remontée comme un problème, pas comme une exception. */
function readJson(file: string, issues: CatalogIssue[], relative: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    issues.push({ file: relative, message: `JSON illisible : ${error instanceof Error ? error.message : String(error)}` });
    return undefined;
  }
}

function listJson(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort() : [];
}

/**
 * Charge et VALIDE le catalogue : le premier problème empêche la publication.
 * Contrôles : schéma de chaque fichier, `canonicalPath` appartenant à la liste fermée, références croisées
 * (garanties des synonymes, produits des assureurs, conditions d'affichage).
 */
export function loadCatalog(dir = CATALOG_DIR): { catalog: Catalog; issues: CatalogIssue[] } {
  const issues: CatalogIssue[] = [];
  const catalog: Catalog = { plans: [], insurers: [], products: [] };
  const add = (file: string, message: string) => issues.push({ file, message });

  // ── Offres ──────────────────────────────────────────────────────────────
  for (const name of listJson(path.join(dir, "plans"))) {
    const file = `plans/${name}`;
    const data = readJson(path.join(dir, file), issues, file);
    if (data === undefined) continue;
    const limits = isObject(data) && isObject(data.limits) ? data.limits : null;
    if (!isObject(data) || !isText(data.id) || !isText(data.name) || !limits) {
      add(file, "attendu : { id, name, limits: { maxUtilisateurs, resetsAppareilParMois, appelsIaParMois } }");
      continue;
    }
    if (data.id !== name.replace(/\.json$/, "")) add(file, `« id » (${data.id}) doit correspondre au nom du fichier`);
    if (!isCount(limits.maxUtilisateurs)) add(file, "limits.maxUtilisateurs : entier strictement positif attendu");
    if (typeof limits.resetsAppareilParMois !== "number" || !Number.isInteger(limits.resetsAppareilParMois) || limits.resetsAppareilParMois < 0) {
      add(file, "limits.resetsAppareilParMois : entier positif ou nul attendu");
    }
    if (typeof limits.appelsIaParMois !== "number" || !Number.isInteger(limits.appelsIaParMois) || limits.appelsIaParMois < 0) {
      add(file, "limits.appelsIaParMois : entier positif ou nul attendu");
    }
    catalog.plans.push(data as unknown as Plan);
  }

  // ── Produits ────────────────────────────────────────────────────────────
  const productsDir = path.join(dir, "products");
  const productIds = fs.existsSync(productsDir)
    ? fs.readdirSync(productsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
    : [];
  for (const productId of productIds) {
    const base = `products/${productId}`;
    const product = readJson(path.join(dir, base, "product.json"), issues, `${base}/product.json`);
    const questionnaire = readJson(path.join(dir, base, "questionnaire.json"), issues, `${base}/questionnaire.json`);
    const guarantees = readJson(path.join(dir, base, "guarantees.json"), issues, `${base}/guarantees.json`);
    const synonyms = readJson(path.join(dir, base, "synonyms.json"), issues, `${base}/synonyms.json`);
    if ([product, questionnaire, guarantees, synonyms].includes(undefined)) continue;

    if (!isObject(product) || !isText(product.id) || !isText(product.name) || typeof product.active !== "boolean") {
      add(`${base}/product.json`, "attendu : { id, name, active }");
      continue;
    }
    if (product.id !== productId) add(`${base}/product.json`, `« id » (${product.id}) doit correspondre au dossier (${productId})`);

    const guaranteeCodes = validateGuarantees(guarantees, `${base}/guarantees.json`, add);
    validateQuestionnaire(questionnaire, `${base}/questionnaire.json`, add);
    validateSynonyms(synonyms, guaranteeCodes, `${base}/synonyms.json`, add);

    catalog.products.push({
      id: product.id,
      name: product.name,
      active: product.active,
      questionnaireSchema: questionnaire as QuestionnaireSection[],
      guaranteeCatalog: guarantees as Guarantee[],
      synonyms: synonyms as Record<string, string[]>,
    });
  }

  // ── Assureurs ───────────────────────────────────────────────────────────
  for (const name of listJson(path.join(dir, "insurers"))) {
    const file = `insurers/${name}`;
    const data = readJson(path.join(dir, file), issues, file);
    if (data === undefined) continue;
    if (!isObject(data) || !isText(data.id) || !isText(data.name) || !isText(data.extranetUrl)) {
      add(file, "attendu : { id, name, extranetUrl, extranetDomains, productsSupported }");
      continue;
    }
    if (data.id !== name.replace(/\.json$/, "")) add(file, `« id » (${data.id}) doit correspondre au nom du fichier`);
    let host: string | null = null;
    try {
      const url = new URL(data.extranetUrl);
      host = url.hostname;
      if (url.protocol !== "https:") add(file, "extranetUrl doit être en https");
    } catch {
      add(file, `extranetUrl invalide : ${data.extranetUrl}`);
    }
    const domains = data.extranetDomains;
    if (!Array.isArray(domains) || domains.length === 0 || !domains.every(isText)) {
      add(file, "extranetDomains : liste non vide de domaines attendue");
    } else if (host && !domains.some(d => host === d || host.endsWith(`.${d}`))) {
      add(file, `extranetDomains ne couvre pas le domaine de extranetUrl (${host})`);
    }
    if (!Array.isArray(data.productsSupported) || !data.productsSupported.every(isText)) {
      add(file, "productsSupported : liste d'identifiants de produits attendue");
    } else {
      for (const id of data.productsSupported as string[]) {
        if (!productIds.includes(id)) add(file, `productsSupported : produit inconnu « ${id} »`);
      }
    }
    catalog.insurers.push(data as unknown as Insurer);
  }

  if (catalog.plans.length === 0) add("plans", "aucune offre : au moins une est nécessaire");
  return { catalog, issues };
}

function validateGuarantees(data: unknown, file: string, add: (file: string, message: string) => void): Set<string> {
  const codes = new Set<string>();
  if (!Array.isArray(data)) {
    add(file, "attendu : liste de garanties { code, label, type }");
    return codes;
  }
  data.forEach((item, index) => {
    if (!isObject(item) || !isText(item.code) || !isText(item.label) || !GUARANTEE_TYPES.includes(item.type as GuaranteeType)) {
      add(file, `garantie n°${index + 1} : attendu { code, label, type: ${GUARANTEE_TYPES.join(" | ")} }`);
      return;
    }
    if (codes.has(item.code)) add(file, `code de garantie en double : ${item.code}`);
    codes.add(item.code);
  });
  return codes;
}

function validateSynonyms(
  data: unknown,
  guaranteeCodes: Set<string>,
  file: string,
  add: (file: string, message: string) => void,
): void {
  if (!isObject(data)) {
    add(file, "attendu : objet { codeGarantie: [formulations] }");
    return;
  }
  const seen = new Map<string, string>();
  for (const [code, phrases] of Object.entries(data)) {
    if (!guaranteeCodes.has(code)) add(file, `code de garantie inconnu : ${code}`);
    if (!Array.isArray(phrases) || phrases.length === 0 || !phrases.every(isText)) {
      add(file, `${code} : liste non vide de formulations attendue`);
      continue;
    }
    for (const phrase of phrases as string[]) {
      const key = phrase.trim().toLowerCase();
      const owner = seen.get(key);
      if (owner && owner !== code) add(file, `formulation « ${phrase} » ambiguë : ${owner} et ${code}`);
      seen.set(key, code);
    }
  }
}

function validateQuestionnaire(data: unknown, file: string, add: (file: string, message: string) => void): void {
  if (!Array.isArray(data) || data.length === 0) {
    add(file, "attendu : liste non vide de sections { title, questions }");
    return;
  }
  const typeOf = new Map<string, QuestionType>();
  for (const section of data) {
    if (isObject(section) && Array.isArray(section.questions)) {
      for (const q of section.questions) {
        if (isObject(q) && typeof q.canonicalPath === "string") typeOf.set(q.canonicalPath, q.type as QuestionType);
      }
    }
  }

  const seen = new Set<string>();
  data.forEach((section, s) => {
    if (!isObject(section) || !isText(section.title) || !Array.isArray(section.questions) || section.questions.length === 0) {
      add(file, `section n°${s + 1} : attendu { title, questions: [...] } non vide`);
      return;
    }
    for (const q of section.questions as unknown[]) {
      const where = `section « ${section.title} »`;
      if (!isObject(q) || typeof q.canonicalPath !== "string") {
        add(file, `${where} : question sans canonicalPath`);
        continue;
      }
      const label = `${where}, ${q.canonicalPath}`;
      if (!isCanonicalPath(q.canonicalPath)) {
        add(file, `${label} : chemin absent du modèle canonique (${CANONICAL_PATHS.length} chemins autorisés)`);
      }
      if (seen.has(q.canonicalPath)) add(file, `${label} : question en double`);
      seen.add(q.canonicalPath);
      if (!isText(q.label)) add(file, `${label} : label manquant`);
      if (!QUESTION_TYPES.includes(q.type as QuestionType)) add(file, `${label} : type invalide (${QUESTION_TYPES.join(" | ")})`);
      if (typeof q.required !== "boolean") add(file, `${label} : « required » (booléen) manquant`);

      if (q.type === "choice") {
        const values = Array.isArray(q.choices) ? q.choices.map(c => (isObject(c) ? c.value : undefined)) : [];
        if (values.length === 0 || !values.every(isText) || new Set(values).size !== values.length) {
          add(file, `${label} : « choices » doit lister des valeurs distinctes { value, label }`);
        }
      } else if (q.choices !== undefined) {
        add(file, `${label} : « choices » n'est valable que pour le type choice`);
      }
      if (q.withKnowledge !== undefined && (typeof q.withKnowledge !== "boolean" || (q.withKnowledge && q.type !== "number"))) {
        add(file, `${label} : « withKnowledge » est réservé aux champs numériques`);
      }
      if (q.visibleIf !== undefined) {
        const cond = q.visibleIf;
        if (!isObject(cond) || typeof cond.path !== "string" || !["string", "number", "boolean"].includes(typeof cond.equals)) {
          add(file, `${label} : visibleIf attendu { path, equals }`);
        } else if (!typeOf.has(cond.path)) {
          add(file, `${label} : visibleIf référence un champ absent du questionnaire (${cond.path})`);
        } else if (cond.path === q.canonicalPath) {
          add(file, `${label} : visibleIf ne peut pas dépendre du champ lui-même`);
        } else if (typeOf.get(cond.path) === "boolean" && typeof cond.equals !== "boolean") {
          add(file, `${label} : visibleIf compare un booléen (${cond.path}) à autre chose qu'un booléen`);
        }
      }
    }
  });
}
