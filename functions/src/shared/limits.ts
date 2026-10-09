// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
import type { Plan, PlanLimits } from './models.js';

/** Limites appliquées quand l'offre d'un cabinet est introuvable (catalogue non publié). */
export const FALLBACK_LIMITS: PlanLimits = {
  maxUtilisateurs: 3,
  resetsAppareilParMois: 2,
  appelsIaParMois: 200,
  maxAppareilsParUtilisateur: 1,
  delaiGraceJours: 14,
};

/** Offre attribuée à un nouveau cabinet. */
export const DEFAULT_PLAN_ID = 'essentiel';

/**
 * Délai de grâce par défaut après une baisse d'offre, avant que le cabinet ne passe en accès admin seul.
 * Chaque offre peut le fixer (`limits.delaiGraceJours`) ; cette valeur sert quand il est absent.
 */
export const GRACE_PERIOD_DAYS = 14;

/** Limites effectives d'un cabinet : celles de l'offre, surchargées champ par champ. */
export function computeEffectiveLimits(
  plan: Pick<Plan, 'limits'> | null | undefined,
  overrides?: Partial<PlanLimits> | null,
): PlanLimits {
  const base = plan?.limits ?? FALLBACK_LIMITS;
  return {
    maxUtilisateurs: overrides?.maxUtilisateurs ?? base.maxUtilisateurs,
    resetsAppareilParMois: overrides?.resetsAppareilParMois ?? base.resetsAppareilParMois,
    appelsIaParMois: overrides?.appelsIaParMois ?? base.appelsIaParMois ?? FALLBACK_LIMITS.appelsIaParMois,
    // Champs ajoutés après coup : une offre publiée avant eux ne les porte pas encore.
    maxAppareilsParUtilisateur:
      overrides?.maxAppareilsParUtilisateur ?? base.maxAppareilsParUtilisateur ?? FALLBACK_LIMITS.maxAppareilsParUtilisateur,
    delaiGraceJours: overrides?.delaiGraceJours ?? base.delaiGraceJours ?? GRACE_PERIOD_DAYS,
  };
}
