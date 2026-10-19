import * as admin from "firebase-admin";
import { computeEffectiveLimits, type Plan, type PlanLimits } from "../shared/index.js";
import { planPath } from "./firestore-paths";

/** Offre du catalogue, ou null si elle n'existe pas (catalogue non publié). */
export async function loadPlan(planId: string): Promise<Plan | null> {
  const snapshot = await admin.firestore().doc(planPath(planId)).get();
  return snapshot.exists ? ({ id: snapshot.id, ...snapshot.data() } as Plan) : null;
}

/** Limites effectives d'un cabinet : offre + surcharge. */
export async function resolveLimits(planId: string, overrides?: Partial<PlanLimits> | null): Promise<PlanLimits> {
  return computeEffectiveLimits(await loadPlan(planId), overrides);
}
