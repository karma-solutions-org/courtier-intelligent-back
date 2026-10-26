// ⚠️ Copie générée par scripts/sync-shared.mjs — ne pas modifier ici.
// Photo d'une étape bloquée (signalements `step_blocked` / `advance_refused`) : revérifiée par le service worker avant
// l'écriture, car elle vient de la page de l'extranet. Les règles Firestore en vérifient la forme générale.
import {
  BlockedStepSnapshot,
  FILL_FAILURE_CODES,
  FORM_FIELD_KINDS,
  STEP_FIELD_STATUSES,
  STEP_SNAPSHOT_MAX_BUTTONS,
  STEP_SNAPSHOT_MAX_FIELDS,
  STEP_SNAPSHOT_MAX_OPTIONS,
  StepSnapshotField,
} from './models.js';

const LABEL_MAX = 120;
const PATH_MAX = 120;

const isIn = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

function sanitizeField(raw: unknown): StepSnapshotField | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const label = text(f['label'], LABEL_MAX);
  if (!label || !isIn(FORM_FIELD_KINDS, f['kind']) || !isIn(STEP_FIELD_STATUSES, f['status'])) return null;
  return {
    label,
    kind: f['kind'],
    required: f['required'] === true,
    status: f['status'],
    path: text(f['path'], PATH_MAX),
    ...(isIn(FILL_FAILURE_CODES, f['failure']) ? { failure: f['failure'] } : {}),
    ...(Array.isArray(f['options'])
      ? { options: f['options'].map(o => text(o, LABEL_MAX)).filter((o): o is string => !!o).slice(0, STEP_SNAPSHOT_MAX_OPTIONS) }
      : {}),
    ...(Number.isInteger(f['optionCount']) && (f['optionCount'] as number) >= 0 ? { optionCount: Math.min(f['optionCount'] as number, 10000) } : {}),
  };
}

/** Photo nettoyée (champs et codes inconnus écartés, plafonds appliqués), ou null si elle est inutilisable. */
export function sanitizeSnapshot(raw: unknown): BlockedStepSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (!Array.isArray(s['fields'])) return null;
  const fields = s['fields'].slice(0, STEP_SNAPSHOT_MAX_FIELDS).map(sanitizeField).filter((f): f is StepSnapshotField => !!f);
  const buttons = Array.isArray(s['buttons'])
    ? s['buttons'].map(b => text(b, LABEL_MAX)).filter((b): b is string => !!b).slice(0, STEP_SNAPSHOT_MAX_BUTTONS)
    : [];
  const step = Number.isInteger(s['stepNumber']) && (s['stepNumber'] as number) > 0 && (s['stepNumber'] as number) < 100 ? (s['stepNumber'] as number) : null;
  return fields.length ? { stepNumber: step, fields, buttons } : null;
}
