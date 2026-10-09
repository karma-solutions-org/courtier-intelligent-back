import * as admin from "firebase-admin";
import { CLAIM_CABINET_ID } from "../core/config";
import { createCabinet } from "../core/cabinet.utils";
import { loadPlan } from "../core/limits.utils";
import { fail, initOps, optionalCount, required, run } from "./ops.utils";

const USAGE =
  "npm run ops:create-cabinet -- (--emulator | --project <id>) --name <cabinet> --admin-email <email> " +
  "[--admin-name <nom>] [--orias <n°>] [--plan <offre>] [--max-utilisateurs <n>] [--resets-appareil <n>] [--appels-ia <n>]";

/**
 * Crée un cabinet « à la main » (sans passer par l'inscription) : compte admin (créé si besoin),
 * cabinet, membre admin et claims `{ci_cabinet_id, ci_role}`. Affiche un lien pour choisir son mot de passe.
 */
run(async () => {
  const args = initOps(
    {
      name: { type: "string" },
      "admin-email": { type: "string" },
      "admin-name": { type: "string" },
      orias: { type: "string" },
      plan: { type: "string" },
      "max-utilisateurs": { type: "string" },
      "resets-appareil": { type: "string" },
      "appels-ia": { type: "string" },
    },
    USAGE,
  );
  const name = required(args.name, "name", USAGE);
  const email = required(args["admin-email"], "admin-email", USAGE).toLowerCase();
  const planId = args.plan?.trim();
  if (planId && !(await loadPlan(planId))) {
    fail(`Offre « ${planId} » introuvable : publiez d'abord le catalogue (npm run ops:seed-catalog).`);
  }
  const overrides = Object.fromEntries(
    Object.entries({
      maxUtilisateurs: optionalCount(args["max-utilisateurs"], "max-utilisateurs"),
      resetsAppareilParMois: optionalCount(args["resets-appareil"], "resets-appareil"),
      appelsIaParMois: optionalCount(args["appels-ia"], "appels-ia"),
    }).filter(([, value]) => value !== undefined),
  );

  const auth = admin.auth();
  const user = await auth.getUserByEmail(email).catch(() => null);
  if (user?.customClaims?.[CLAIM_CABINET_ID]) {
    fail(`${email} est déjà rattaché au cabinet ${String(user.customClaims[CLAIM_CABINET_ID])}.`);
  }
  const owner = user ?? (await auth.createUser({ email, displayName: args["admin-name"]?.trim() || undefined }));

  const cabinetId = await createCabinet({
    name,
    orias: args.orias?.trim() || null,
    ownerUid: owner.uid,
    planId,
    overrides: Object.keys(overrides).length ? overrides : null,
  });

  console.log(`Cabinet « ${name} » créé : ${cabinetId} (admin : ${email}${user ? ", compte existant" : ""}).`);
  if (!user) {
    console.log(`Lien de définition du mot de passe : ${await auth.generatePasswordResetLink(email)}`);
  }
});
