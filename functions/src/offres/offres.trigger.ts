import * as admin from "firebase-admin";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { REGION_ID } from "../core/config";
import { dossierPath, productPath } from "../core/firestore-paths";
import { analyzeOffer, type ComparableOffer, type ComparisonNeed, type Guarantee } from "../shared/index.js";

/**
 * Analyse d'une offre (Epic E13) à chaque écriture, qu'elle vienne de l'extension ou d'une saisie manuelle :
 * garanties rattachées au référentiel (synonymes de guaranteeSynonyms/{productId}), écarts avec le besoin et score indicatif.
 *
 * Anti-boucle : on n'écrit que si les garanties, les écarts ou le score changent ; la réécriture déclenche à nouveau
 * cette function, qui trouve alors un résultat identique et s'arrête.
 *
 * Le besoin n'est plus modifiable une fois la tarification commencée (enregistrerBesoin refuse au-delà de « besoin validé »),
 * donc aucun recalcul n'est nécessaire quand le besoin change : les offres sont toujours analysées sur le besoin final.
 */
export const onWrite = onDocumentWritten(
  { document: "cabinets/{cabinetId}/dossiers/{dossierId}/offers/{insurerId}", region: REGION_ID },
  async event => {
    const after = event.data?.after;
    if (!after?.exists) return;
    const { cabinetId, dossierId } = event.params;
    const db = admin.firestore();

    const dossier = await db.doc(dossierPath(cabinetId, dossierId)).get();
    if (!dossier.exists) return;
    const productId = dossier.get("productId") as string;
    const [product, synonymsDoc] = await Promise.all([
      db.doc(productPath(productId)).get(),
      db.doc(`guaranteeSynonyms/${productId}`).get(),
    ]);
    const catalog = (product.get("guaranteeCatalog") as Guarantee[] | undefined) ?? [];
    const synonyms = (synonymsDoc.get("synonyms") as Record<string, string[]> | undefined) ?? {};
    const need = (dossier.get("needAnalysis") as ComparisonNeed | null) ?? null;

    const offer = after.data() as ComparableOffer & { gaps?: unknown; score?: unknown };
    const analysis = analyzeOffer(offer, need, catalog, synonyms);
    const unchanged =
      JSON.stringify(analysis.guarantees) === JSON.stringify(offer.guarantees ?? []) &&
      JSON.stringify(analysis.gaps) === JSON.stringify(offer.gaps ?? []) &&
      analysis.score === (offer.score ?? null);
    if (unchanged) return;

    // Mise à jour sur la version lue : si l'offre a été remplacée entre-temps, la nouvelle écriture relancera l'analyse.
    try {
      await after.ref.update(
        { guarantees: analysis.guarantees, gaps: analysis.gaps, score: analysis.score },
        { lastUpdateTime: after.updateTime },
      );
    } catch (error) {
      logger.info("offres-onWrite : offre modifiée pendant l'analyse, nouvelle analyse à venir.", {
        cabinetId,
        dossierId,
        error: String(error),
      });
    }
  },
);
