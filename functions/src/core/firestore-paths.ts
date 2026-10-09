/** Chemins Firestore : identiques à ceux décrits dans CONTEXTE_PROJET.md (repo front). */
export const cabinetPath = (cabinetId: string) => `cabinets/${cabinetId}`;
export const memberPath = (cabinetId: string, uid: string) => `cabinets/${cabinetId}/members/${uid}`;
export const invitationsPath = (cabinetId: string) => `cabinets/${cabinetId}/invitations`;
export const invitationPath = (cabinetId: string, invitationId: string) =>
  `cabinets/${cabinetId}/invitations/${invitationId}`;
export const auditLogPath = (cabinetId: string) => `cabinets/${cabinetId}/auditLog`;
export const planPath = (planId: string) => `plans/${planId}`;
export const dossiersPath = (cabinetId: string) => `cabinets/${cabinetId}/dossiers`;
export const dossierPath = (cabinetId: string, dossierId: string) => `cabinets/${cabinetId}/dossiers/${dossierId}`;
export const assurePath = (cabinetId: string, assureId: string) => `cabinets/${cabinetId}/assures/${assureId}`;
export const productPath = (productId: string) => `products/${productId}`;
/** Compteur des références d'un cabinet : un document par année (la numérotation repart à 1 chaque année). */
export const dossierCounterPath = (cabinetId: string, year: number) => `cabinets/${cabinetId}/counters/dossiers-${year}`;
/** Consommation d'IA d'un cabinet pour un mois (« AAAA-MM ») : cabinets/{id}/usage/ia-2026-10. */
export const iaUsagePath = (cabinetId: string, month: string) => `cabinets/${cabinetId}/usage/ia-${month}`;
export const insurerPath = (insurerId: string) => `insurers/${insurerId}`;
export const quoteJobPath = (cabinetId: string, dossierId: string, insurerId: string) =>
  `cabinets/${cabinetId}/dossiers/${dossierId}/quoteJobs/${insurerId}`;
export const offerPath = (cabinetId: string, dossierId: string, insurerId: string) =>
  `cabinets/${cabinetId}/dossiers/${dossierId}/offers/${insurerId}`;
export const documentsPath = (cabinetId: string, dossierId: string) => `cabinets/${cabinetId}/dossiers/${dossierId}/documents`;
