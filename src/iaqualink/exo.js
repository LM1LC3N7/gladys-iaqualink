// -----------------------------------------------------------------------------
// Zodiac eXO iQ chlorinators (`device_type: "exo"`): the AWS IoT shadow read
// into a plain model, and the desired states of the commands. Pure; a port of
// iaqualink-py `systems/exo` (BSD-3-Clause, see THIRD_PARTY_NOTICES.md).
//
// The shadow takes absolute desired values ("production: 1"), not toggles.
// -----------------------------------------------------------------------------

import { AqualinkError } from './http.js';

const STATUS = {
  connected: 'online',
  online: 'online',
  offline: 'offline',
  disconnected: 'offline',
  service: 'service',
  firmware_update: 'service',
  unknown: 'unknown',
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const num = (value) => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};
const bit = (value) => {
  const n = num(value);
  return n === 1 ? 1 : n === 0 ? 0 : undefined;
};

/**
 * pH as the shadow sends it: tenths (75 = 7.5) on the observed answers; a
 * value already in pH units (≤ 14) is kept as is.
 */
export const phOf = (value) => {
  const n = num(value);
  if (n === undefined) {
    return undefined;
  }
  return n > 14 ? n / 10 : n;
};

/** The chlorinator switches written as plain values under `equipment.swc_0`. */
export const TOGGLE_KEYS = { production: 'production', boost: 'boost', low: 'low' };

/**
 * The shadow: `{ status, values, aux, heating }`. `values` holds numbers (or
 * undefined when absent); `heating` is undefined without a heating module.
 */
export function parseShadow(data) {
  const reported = data?.state?.reported;
  if (!isObject(reported)) {
    throw new AqualinkError('bad_response', 'iAquaLink sent no eXO state');
  }
  const raw = String(reported.aws?.status ?? '').toLowerCase();
  const swc = isObject(reported.equipment?.swc_0) ? reported.equipment.swc_0 : {};
  const sensors = {};
  for (const [key, sensor] of Object.entries(swc)) {
    if (/^sns_\d+$/.test(key) && isObject(sensor)) {
      const type = String(sensor.sensor_type ?? '').toLowerCase();
      // state 0: probe absent or faulty, its value is not a reading.
      sensors[type] = num(sensor.state) === 1 ? num(sensor.value) : undefined;
      sensors[`has ${type}`] = true;
    }
  }
  const aux = Object.entries(swc)
    .filter(([key, value]) => /^aux_\d+$/.test(key) && isObject(value) && value.type !== 'none')
    .map(([key, value]) => ({ key, state: bit(value.state) }));
  const heating = isObject(reported.heating)
    ? {
        enabled: bit(reported.heating.enabled),
        state: bit(reported.heating.state),
        sp: num(reported.heating.sp),
        min: num(reported.heating.sp_min),
        max: num(reported.heating.sp_max),
      }
    : undefined;
  return {
    status: STATUS[raw] ?? 'unknown',
    has: {
      temperature: sensors['has water temp'] === true,
      ph: sensors['has ph'] === true,
      orp: sensors['has orp'] === true,
      low: 'low' in swc,
      filterPump: isObject(swc.filter_pump),
      phSetpoint: 'ph_sp' in swc,
      orpSetpoint: 'orp_sp' in swc,
    },
    values: {
      temperature: sensors['water temp'],
      ph: phOf(sensors.ph),
      orp: sensors.orp,
      chlorineLevel: num(swc.swc),
      production: bit(swc.production),
      boost: bit(swc.boost),
      low: bit(swc.low),
      filterPump: bit(swc.filter_pump?.state),
      phSetpoint: phOf(swc.ph_sp),
      orpSetpoint: num(swc.orp_sp),
      errorCode: num(swc.error_code),
      lowSalt: bit(swc.swc_low),
    },
    aux,
    heating,
  };
}

/** The desired state of a command (iaqualink-py `set_toggle`, `set_aux`, `set_filter_pump`, `set_heating`). */
export function desiredOf(key, value) {
  if (TOGGLE_KEYS[key]) {
    return { equipment: { swc_0: { [TOGGLE_KEYS[key]]: value } } };
  }
  if (key === 'filter-pump') {
    return { equipment: { swc_0: { filter_pump: { state: value } } } };
  }
  const aux = /^aux-(\d+)$/.exec(key);
  if (aux) {
    return { equipment: { swc_0: { [`aux_${aux[1]}`]: { state: value } } } };
  }
  if (key === 'heating') {
    return { heating: { enabled: value } };
  }
  if (key === 'heating-setpoint') {
    return { heating: { sp: value } };
  }
  return undefined;
}
