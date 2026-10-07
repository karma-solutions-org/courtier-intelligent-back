/** Chemins Firestore : identiques à ceux décrits dans CONTEXTE_PROJET.md (repo front). */
export const tenantPath = (tenantId: string) => `tenants/${tenantId}`;
export const memberPath = (tenantId: string, uid: string) => `tenants/${tenantId}/members/${uid}`;
export const invitationsPath = (tenantId: string) => `tenants/${tenantId}/invitations`;
export const invitationPath = (tenantId: string, invitationId: string) =>
  `tenants/${tenantId}/invitations/${invitationId}`;
