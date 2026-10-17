// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { REFRESH_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  refresh_interval: REFRESH_INTERVAL.default,
  // Read-only at installation: the user turns the commands on (pumps, heaters,
  // set points, lights, eXO switches).
  allow_commands: false,
  // Plain auxiliaries of a panel, valve actuators and the eXO aux outputs can
  // drive anything, valves included: a second, separate opt-in.
  allow_aux_commands: false,
  // Auxiliaries still named "Aux 3", "Aux V12", "Extra Aux"... are usually unused.
  include_unnamed_aux: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/** A checkbox may arrive as a boolean or as a string from a form; absent = its default. */
const flag = (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return value === true || value === 'true' || value === 1 || value === '1';
};

export function normalizeConfig(raw = {}) {
  const given = raw?.refresh_interval;
  const interval = given === undefined || given === null || given === '' ? NaN : Number(given);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  return {
    email: String(raw?.email ?? '').trim(),
    // A password may begin or end with a space: kept as typed.
    password: String(raw?.password ?? ''),
    refreshInterval: Number.isFinite(interval)
      ? Math.round(Math.max(REFRESH_INTERVAL.min, Math.min(REFRESH_INTERVAL.max, interval)))
      : DEFAULTS.refresh_interval,
    allowCommands: flag(raw?.allow_commands, DEFAULTS.allow_commands),
    allowAuxCommands: flag(raw?.allow_aux_commands, DEFAULTS.allow_aux_commands),
    includeUnnamedAux: flag(raw?.include_unnamed_aux, DEFAULTS.include_unnamed_aux),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}
