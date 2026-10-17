// -----------------------------------------------------------------------------
// iAquaLink panels (Jandy iQ20 / RS, `device_type: "iaqua"`): the answers of
// the "home" and "devices" screens read into a plain model, and the commands.
// Pure; a port of iaqualink-py `systems/iaqua` (BSD-3-Clause, see
// THIRD_PARTY_NOTICES.md).
//
// Protocol facts that matter for safety:
// - the pumps, heaters and plain auxiliaries only know TOGGLE commands
//   (`set_pool_pump`, `set_aux_3`...): the integration reads the state again
//   right before sending one, and sends nothing when it is already right;
// - dimmable and colour lights take an absolute value (`set_light`);
// - `set_temps` sets both set points at once (spa first when the panel has
//   one): the other one is sent again with its value just read.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';
import { AqualinkError } from './http.js';

const STATUS = { Online: 'online', Offline: 'offline', Service: 'service', Unknown: 'unknown' };

/** The keys of the home screen the integration reads. */
export const HOME_KEYS = [
  'pool_temp',
  'spa_temp',
  'air_temp',
  'pool_pump',
  'spa_pump',
  'pool_heater',
  'spa_heater',
  'solar_heater',
  'pool_set_point',
  'spa_set_point',
  'freeze_protection',
  'ph',
  'orp',
  'pool_salinity',
  'spa_salinity',
];

/** Toggle commands of the home screen equipment, by feature key. */
export const TOGGLES = {
  'pool-pump': { home: 'pool_pump', command: 'set_pool_pump' },
  'spa-pump': { home: 'spa_pump', command: 'set_spa_pump' },
  'pool-heater': { home: 'pool_heater', command: 'set_pool_heater' },
  'spa-heater': { home: 'spa_heater', command: 'set_spa_heater' },
  'solar-heater': { home: 'solar_heater', command: 'set_solar_heater' },
};

/** Set point limits (iaqualink-py `IAQUA_TEMP_*`). */
export const SETPOINT_RANGE = { C: { min: 1, max: 40 }, F: { min: 34, max: 104 } };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

/** Merges the `[{ a }, { b }, ...]` list of a screen into one object. */
const merge = (list) => Object.assign({}, ...list.filter(isObject));

/**
 * The home screen: `{ status, systemType, tempUnit, values, heatPump }`.
 * `values` holds the raw strings ("" when the panel has no such equipment).
 */
export function parseHome(data) {
  if (!Array.isArray(data?.home_screen)) {
    throw new AqualinkError('bad_response', 'iAquaLink sent no home screen');
  }
  const home = merge(data.home_screen);
  const scale = text(home.temp_scale);
  const values = {};
  for (const key of HOME_KEYS) {
    values[key] = text(home[key]);
  }
  const hp = isObject(home.heatpump_info) ? home.heatpump_info : undefined;
  return {
    status: STATUS[text(home.status)] ?? 'unknown',
    systemType: text(home.system_type),
    tempUnit: scale === 'C' || scale === 'F' ? scale : undefined,
    values,
    heatPump: Boolean(hp?.isheatpumpPresent ?? hp?.isHPMPresent),
  };
}

/** Kinds of auxiliaries that can drive anything (valves included): `allow_aux_commands`. */
export const RAW_AUX_KINDS = ['switch', 'valve'];

/** The kind of an auxiliary output (iaqualink-py `_parse_devices_response`). */
export function auxKind({ type, label }) {
  if (type === '3') {
    // SJVA: a valve actuator (spa spillover, solar, water feature...).
    return 'valve';
  }
  if (type === '2') {
    return 'color';
  }
  if (type === '1') {
    return 'dimmer';
  }
  return /light/i.test(label) ? 'light' : 'switch';
}

/** "Aux3", "Aux V12", "Extra Aux": the names a panel gives an auxiliary nobody named. */
export const isDefaultAuxName = (label) =>
  /^(extra\s*aux|aux\s*v?\s*[a-z]?\d+)$/i.test(String(label).trim());

/**
 * The devices screen: `{ status, aux }`, `aux` being null when the panel sent
 * a NaN state (iaqualink-py skips such an update entirely).
 */
export function parseDevices(data) {
  const screen = data?.devices_screen;
  if (!Array.isArray(screen)) {
    throw new AqualinkError('bad_response', 'iAquaLink sent no devices screen');
  }
  const status = STATUS[text(screen[0]?.status)] ?? 'unknown';
  const aux = [];
  for (const entry of screen.slice(3)) {
    if (!isObject(entry)) {
      continue;
    }
    const [key] = Object.keys(entry);
    if (!/^aux_[A-Za-z0-9]+$/.test(key ?? '') || !Array.isArray(entry[key])) {
      continue;
    }
    const attrs = merge(entry[key]);
    if (text(attrs.state) === 'NaN') {
      return { status, aux: null };
    }
    const item = {
      key,
      suffix: key.slice(4),
      label: text(attrs.label) || key,
      state: text(attrs.state),
      type: text(attrs.type) || '0',
      subtype: text(attrs.subtype),
    };
    aux.push({ ...item, kind: auxKind(item) });
    if (aux.length >= LIMITS.auxPerSystem) {
      break;
    }
  }
  return { status, aux };
}

/** The feature key of an auxiliary: `aux-3`, `aux-b1`. */
export const auxFeature = (aux) => `aux-${aux.suffix.toLowerCase()}`;

/** A home value as a number, undefined when empty or not a number. */
export function numberOf(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** "1" / "3" (heater enabled) -> on, "0" -> off, "" or anything else -> unknown. */
export function binaryOf(value, { heater = false } = {}) {
  if (value === '1' || (heater && value === '3')) {
    return 1;
  }
  if (value === '0') {
    return 0;
  }
  return undefined;
}

/** The brightness (0-100) of a dimmable light: its subtype (iaqualink-py). */
export const brightnessOf = (aux) => (aux.state === '0' ? 0 : numberOf(aux.subtype));

/** Dimmable lights only take 0, 25, 50, 75 or 100. */
export const roundBrightness = (value) => Math.max(0, Math.min(100, Math.round(value / 25) * 25));

/** The `set_light` parameters of a light turned on or off, or dimmed. */
export function lightParams(aux, { on, brightness }) {
  if (aux.kind === 'dimmer') {
    const level = brightness ?? (on ? 100 : 0);
    return { aux: aux.suffix, light: String(roundBrightness(level)) };
  }
  // A colour light turned on starts with its first colour (iaqualink-py `turn_on`).
  return { aux: aux.suffix, light: on ? '1' : '0', subtype: aux.subtype };
}

/**
 * The `set_temps` parameters: both set points, the spa one first when the
 * panel has one (iaqualink-py `set_temps`), seeded with the values just read.
 */
export function setTempsParams(values, which, value) {
  const spa = values.spa_set_point;
  const pool = values.pool_set_point;
  const next = {
    spa: which === 'spa' ? String(value) : spa,
    pool: which === 'pool' ? String(value) : pool,
  };
  if (spa !== '') {
    return { temp1: next.spa, temp2: next.pool };
  }
  return { temp1: next.pool };
}

/** A temperature from one unit ('C' or 'F') to the other. */
export function convertTemperature(value, from, to) {
  if (value === undefined || from === to || !from || !to) {
    return value;
  }
  return to === 'F' ? (value * 9) / 5 + 32 : ((value - 32) * 5) / 9;
}

/** The heat pump command of a set point, when a heat pump is paired (iaqualink-py `_set_value`). */
export const HEAT_PUMP_SETPOINT = { pool: 'poolheatsetpointtemp', spa: 'spaheatsetpointtemp' };
