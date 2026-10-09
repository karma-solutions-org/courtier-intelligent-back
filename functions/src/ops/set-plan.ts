import * as admin from "firebase-admin";
import { cabinetPath } from "../core/firestore-paths";
import { loadPlan } from "../core/limits.utils";
import { getSeatUsage, graceUpdate } from "../core/seats.utils";
import { computeEffectiveLimits, type PlanLimits } from "../shared/index.js";
import { fail, initOps, optionalCount, required, run } from "./ops.utils";

const USAGE =
  "npm run ops:set-plan -- (--emulator | --project <id>) --cabinet <id> --plan <offre> " +
  "[--max-utilisateurs <n>] [--resets-appareil <n>] [--appels-ia <n>] [--clear-overrides]";

/**
 * Change l'offre d'un cabinet et/ou surcharge ses limites, sans redéploiement
 * (ex. passer de 3 à 6 sièges). Recalcule les limites effectives du cabinet.
 * Si les membres actifs dépassent la nouvelle limite, ouvre le délai de grâce (GRACE_PERIOD_DAYS),
 * après lequel seuls les admins accèdent au cabinet.
 */
run(async () => {
  const args = initOps(
    {
      cabinet: { type: "string" },
      plan: { type: "string" },
      "max-utilisateurs": { type: "string" },
      "resets-appareil": { type: "string" },
      "appels-ia": { type: "string" },
      "clear-overrides": { type: "boolean" },
    },
    USAGE,
  );
  const cabinetId = required(args.cabinet, "cabinet", USAGE);
  const planId = required(args.plan, "plan", USAGE);
  const plan = await loadPlan(planId);
  if (!plan) {
    fail(`Offre « ${planId} » introuvable : publiez d'abord le catalogue (npm run ops:seed-catalog).`);
  }
  const newOverrides: Partial<PlanLimits> = {};
  const maxUtilisateurs = optionalCount(args["max-utilisateurs"], "max-utilisateurs");
  const resets = optionalCount(args["resets-appareil"], "resets-appareil");
  if (maxUtilisateurs !== undefined) newOverrides.maxUtilisateurs = maxUtilisateurs;
  if (resets !== undefined) newOverrides.resetsAppareilParMois = resets;
  const iaCalls = optionalCount(args["appels-ia"], "appels-ia");
  if (iaCalls !== undefined) newOverrides.appelsIaParMois = iaCalls;

  const db = admin.firestore();
  const ref = db.doc(cabinetPath(cabinetId));
  const result = await db.runTransaction(async tx => {
    const cabinet = await tx.get(ref);
    if (!cabinet.exists) {
      fail(`Cabinet ${cabinetId} introuvable.`);
    }
    const usage = await getSeatUsage(cabinetId, tx);
    const overrides: Partial<PlanLimits> = {
      ...(args["clear-overrides"] ? {} : ((cabinet.get("overrides") as Partial<PlanLimits> | null) ?? {})),
      ...newOverrides,
    };
    const limits = computeEffectiveLimits(plan, overrides);
    const grace = graceUpdate(usage.activeMembers, limits.maxUtilisateurs, usage.graceEndsAt);
    tx.update(ref, { planId, overrides: Object.keys(overrides).length ? overrides : null, limits, ...grace });
    return { limits, activeMembers: usage.activeMembers };
  });

  console.log(
    `Cabinet ${cabinetId} : offre « ${planId} », ${result.limits.maxUtilisateurs} utilisateurs, ` +
      `${result.limits.resetsAppareilParMois} réinitialisation(s) d'appareil par mois, ${result.limits.appelsIaParMois} appels IA par mois.`,
  );
  if (result.activeMembers > result.limits.maxUtilisateurs) {
    console.log(
      `⚠️ ${result.activeMembers} membres actifs pour ${result.limits.maxUtilisateurs} places : ` +
        "délai de grâce ouvert, puis accès réservé aux admins.",
    );
  }
});
