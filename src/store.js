// -----------------------------------------------------------------------------
// What must survive a restart: per system, the features already seen, the
// auxiliaries and their kind, and the frozen temperature unit, so a panel that
// is offline or reports an empty value at start does not lose features in the
// Discovery tab. Kept in /data, the only writable place of the container.
// No secret is ever written here.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';

export const STATE_FILE = '/data/iaqualink-state.json';

export function fileStore(path = STATE_FILE) {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    async save(data) {
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(data));
      await rename(temporary, path);
    },
  };
}

const KINDS = ['switch', 'light', 'dimmer', 'color'];
const str = (value) => (typeof value === 'string' ? value : '');

/** The `seen` of one system, from its persisted form (repaired). */
export function seenFromMemory(raw) {
  const features = new Set(
    (Array.isArray(raw?.features) ? raw.features : []).filter((k) => typeof k === 'string'),
  );
  const aux = new Map();
  for (const a of Array.isArray(raw?.aux) ? raw.aux : []) {
    if (/^aux_[A-Za-z0-9]+$/.test(str(a?.key)) && KINDS.includes(a.kind)) {
      aux.set(a.key, {
        key: a.key,
        suffix: a.key.slice(4),
        label: str(a.label) || a.key,
        kind: a.kind,
      });
    }
  }
  const range = raw?.heatingRange;
  const heatingRange =
    Number.isFinite(range?.min) && Number.isFinite(range?.max) && range.min < range.max
      ? { min: range.min, max: range.max }
      : undefined;
  return { features, aux, heatingRange };
}

/** The persisted form of the systems. */
export function memoryOf(systems) {
  const out = {};
  for (const system of systems) {
    out[system.serial] = {
      type: system.type,
      unit: system.unit,
      features: [...system.seen.features],
      aux: [...system.seen.aux.values()],
      heatingRange: system.seen.heatingRange,
    };
  }
  return { systems: out };
}

/** `{ [serial]: { type, unit, seen } }` from the file (repaired, never throws). */
export function normalizeMemory(raw) {
  const out = {};
  for (const [serial, entry] of Object.entries(raw?.systems ?? {})) {
    out[serial] = {
      type: str(entry?.type),
      unit: entry?.unit === 'C' || entry?.unit === 'F' ? entry.unit : undefined,
      seen: seenFromMemory(entry),
    };
  }
  return out;
}
