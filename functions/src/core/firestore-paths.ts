/** Chemins Firestore : identiques à ceux décrits dans CONTEXTE_PROJET.md (repo front). */
export const cabinetPath = (cabinetId: string) => `cabinets/${cabinetId}`;
export const memberPath = (cabinetId: string, uid: string) => `cabinets/${cabinetId}/members/${uid}`;
export const invitationsPath = (cabinetId: string) => `cabinets/${cabinetId}/invitations`;
export const invitationPath = (cabinetId: string, invitationId: string) =>
  `cabinets/${cabinetId}/invitations/${invitationId}`;
