import * as admin from "firebase-admin";
import { onCall } from "firebase-functions/v2/https";
import { getActiveMembership } from "../core/auth.utils";
import { CLAIM_ROLE, CLAIM_TENANT_ID, CALLABLE_OPTIONS } from "../core/config";

/**
 * Custom token pour connecter l'extension Chrome avec la même identité que le courtier
 * (même uid, même cabinet, même rôle). L'app le transmet à l'extension, qui fait signInWithCustomToken.
 * Nécessite que le compte de service des Functions ait le rôle « Service Account Token Creator ».
 */
export const createExtensionToken = onCall(CALLABLE_OPTIONS, async request => {
  const { uid, tenantId, role } = await getActiveMembership(request);
  const token = await admin.auth().createCustomToken(uid, { [CLAIM_TENANT_ID]: tenantId, [CLAIM_ROLE]: role });
  return { token };
});
