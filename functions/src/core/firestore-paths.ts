/** Chemins Firestore : identiques à ceux décrits dans CONTEXTE_PROJET.md (repo front). */
export const cabinetPath = (cabinetId: string) => `ci_cabinets/${cabinetId}`;
export const memberPath = (cabinetId: string, uid: string) => `ci_cabinets/${cabinetId}/ci_members/${uid}`;
export const invitationsPath = (cabinetId: string) => `ci_cabinets/${cabinetId}/ci_invitations`;
export const invitationPath = (cabinetId: string, invitationId: string) =>
  `ci_cabinets/${cabinetId}/ci_invitations/${invitationId}`;
export const auditLogPath = (cabinetId: string) => `ci_cabinets/${cabinetId}/ci_auditLog`;
export const planPath = (planId: string) => `ci_plans/${planId}`;
export const dossiersPath = (cabinetId: string) => `ci_cabinets/${cabinetId}/ci_dossiers`;
export const dossierPath = (cabinetId: string, dossierId: string) => `ci_cabinets/${cabinetId}/ci_dossiers/${dossierId}`;
export const assurePath = (cabinetId: string, assureId: string) => `ci_cabinets/${cabinetId}/ci_assures/${assureId}`;
export const productPath = (productId: string) => `ci_products/${productId}`;
/** Compteur des références d'un cabinet : un document par année (la numérotation repart à 1 chaque année). */
export const dossierCounterPath = (cabinetId: string, year: number) => `ci_cabinets/${cabinetId}/ci_counters/dossiers-${year}`;
/** Consommation d'IA d'un cabinet pour un mois (« AAAA-MM ») : cabinets/{id}/usage/ia-2026-10. */
export const iaUsagePath = (cabinetId: string, month: string) => `ci_cabinets/${cabinetId}/ci_usage/ia-${month}`;
export const plaqueUsagePath = (cabinetId: string, month: string) => `ci_cabinets/${cabinetId}/ci_usage/plaque-${month}`;
export const insurerPath = (insurerId: string) => `ci_insurers/${insurerId}`;
export const quoteJobPath = (cabinetId: string, dossierId: string, insurerId: string) =>
  `ci_cabinets/${cabinetId}/ci_dossiers/${dossierId}/ci_quoteJobs/${insurerId}`;
export const offerPath = (cabinetId: string, dossierId: string, insurerId: string) =>
  `ci_cabinets/${cabinetId}/ci_dossiers/${dossierId}/ci_offers/${insurerId}`;
export const documentsPath = (cabinetId: string, dossierId: string) => `ci_cabinets/${cabinetId}/ci_dossiers/${dossierId}/ci_documents`;
/** Mémoire de formulaire propre à un cabinet : servie à son extension dès le premier remplissage réussi. */
export const cabinetMemoryPath = (cabinetId: string, key: string) => `ci_cabinets/${cabinetId}/ci_formMemories/${key}`;
/** Comptes déjà rattachés à un cabinet (un par uid) : verrou de `creerMonCabinet` et `accepterInvitation`. */
export const userCabinetPath = (uid: string) => `ci_userCabinets/${uid}`;
