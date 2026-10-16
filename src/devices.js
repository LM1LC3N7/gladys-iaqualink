// -----------------------------------------------------------------------------
// iAquaLink systems -> Gladys devices, readings -> states (pure).
//
// One Gladys device per system of the account (an iAquaLink panel or an eXO
// chlorinator), keyed by its serial number. Feature keys are frozen forever:
// see TODO.md "Decisions". The features of a system only grow: an equipment
// seen once (in `system.seen`, kept in /data) keeps its feature even when the
// panel stops reporting it for a while.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { SYSTEM_TYPES } from './constants.js';
import { FEATURE_NAMES, STATUS_TEXT, word } from './i18n.js';
import {
  SETPOINT_RANGE,
  auxFeature,
  binaryOf,
  brightnessOf,
  isDefaultAuxName,
  numberOf,
} from './iaqualink/iaqua.js';

/** The external ids of a system: `ext:<selector>:iaqualink:<serial>`. */
export const systemIds = (gladys, serial) => gladys.externalIds('iaqualink', String(serial));

/** `{ serial, key }` of a feature external id of this integration, undefined otherwise. */
export function parseFeatureId(gladys, featureId) {
  const prefix = gladys.externalId('iaqualink:');
  if (typeof featureId !== 'string' || !featureId.startsWith(prefix)) {
    return undefined;
  }
  const rest = featureId.slice(prefix.length);
  const cut = rest.lastIndexOf(':');
  if (cut <= 0) {
    return undefined;
  }
  return { serial: rest.slice(0, cut), key: rest.slice(cut + 1) };
}

export const systemName = (system) =>
  String(system.name ?? '').trim() ||
  `${system.type === SYSTEM_TYPES.EXO ? 'eXO' : 'iAquaLink'} ${String(system.serial).slice(-4)}`;

// --- Feature shapes ----------------------------------------------------------

const temperatureUnit = (unit) => (unit === 'F' ? U.FAHRENHEIT : U.CELSIUS);

const SHAPES = {
  text: () => ({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false }),
  temperature: (unit) => ({
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: temperatureUnit(unit),
    min: unit === 'F' ? 14 : -10,
    max: unit === 'F' ? 122 : 50,
  }),
  setpoint: (unit, range = SETPOINT_RANGE[unit === 'F' ? 'F' : 'C']) => ({
    category: C.THERMOSTAT,
    type: T.THERMOSTAT.TARGET_TEMPERATURE,
    unit: temperatureUnit(unit),
    min: range.min,
    max: range.max,
    read_only: false,
  }),
  switch: () => ({ category: C.SWITCH, type: T.SWITCH.BINARY, min: 0, max: 1, read_only: false }),
  light: () => ({ category: C.LIGHT, type: T.LIGHT.BINARY, min: 0, max: 1, read_only: false }),
  brightness: () => ({
    category: C.LIGHT,
    type: T.LIGHT.BRIGHTNESS,
    min: 0,
    max: 100,
    read_only: false,
  }),
  ph: () => ({ category: C.PH_SENSOR, type: T.PH_SENSOR.DECIMAL, unit: U.PH, min: 0, max: 14 }),
  orp: () => ({
    category: C.ORP_SENSOR,
    type: T.ORP_SENSOR.DECIMAL,
    unit: U.MILLI_VOLT,
    min: 0,
    max: 2000,
  }),
  // Gladys has no salinity nor "production level" category, and the unknown
  // category takes no unit: the unit is in the feature name.
  salinity: () => ({ category: C.UNKNOWN, type: T.UNKNOWN.UNKNOWN, min: 0, max: 100000 }),
  percent: () => ({ category: C.UNKNOWN, type: T.UNKNOWN.UNKNOWN, min: 0, max: 100 }),
};

// --- iAquaLink panels --------------------------------------------------------

const hasSpa = (home) =>
  home?.systemType === '0' || home?.systemType === '2' || (home?.values.spa_pump ?? '') !== '';

/** The auxiliaries shown: the named ones, or all of them when the configuration says so. */
export const shownAux = (aux, { includeUnnamedAux }) =>
  (aux ?? []).filter((a) => includeUnnamedAux || !isDefaultAuxName(a.label));

/** The feature keys an iAquaLink panel has now, from its last reading. */
export function iaquaKeysNow(system) {
  const home = system.home;
  if (!home || home.status !== 'online') {
    return [];
  }
  const v = home.values;
  const keys = ['pool-temperature', 'air-temperature', 'pool-pump', 'pool-heater', 'pool-setpoint'];
  if (hasSpa(home)) {
    keys.push('spa-temperature', 'spa-pump', 'spa-heater', 'spa-setpoint');
  }
  for (const [key, raw] of [
    ['solar-heater', v.solar_heater],
    ['ph', v.ph],
    ['orp', v.orp],
    ['pool-salinity', v.pool_salinity],
    ['spa-salinity', v.spa_salinity],
  ]) {
    if (raw !== '') {
      keys.push(key);
    }
  }
  return keys;
}

const IAQUA_ORDER = [
  'status',
  'pool-temperature',
  'spa-temperature',
  'air-temperature',
  'pool-pump',
  'spa-pump',
  'pool-heater',
  'spa-heater',
  'solar-heater',
  'pool-setpoint',
  'spa-setpoint',
  'ph',
  'orp',
  'pool-salinity',
  'spa-salinity',
];

const IAQUA_SHAPES = {
  status: () => SHAPES.text(),
  'pool-temperature': (unit) => SHAPES.temperature(unit),
  'spa-temperature': (unit) => SHAPES.temperature(unit),
  'air-temperature': (unit) => SHAPES.temperature(unit),
  'pool-pump': () => SHAPES.switch(),
  'spa-pump': () => SHAPES.switch(),
  'pool-heater': () => SHAPES.switch(),
  'spa-heater': () => SHAPES.switch(),
  'solar-heater': () => SHAPES.switch(),
  'pool-setpoint': (unit) => SHAPES.setpoint(unit),
  'spa-setpoint': (unit) => SHAPES.setpoint(unit),
  ph: () => SHAPES.ph(),
  orp: () => SHAPES.orp(),
  'pool-salinity': () => SHAPES.salinity(),
  'spa-salinity': () => SHAPES.salinity(),
};

function iaquaFeatures(system, language) {
  const { unit, seen } = system;
  const features = IAQUA_ORDER.filter((key) => key === 'status' || seen.features.has(key)).map(
    (key) => ({ key, name: word(FEATURE_NAMES[key], language), ...IAQUA_SHAPES[key](unit) }),
  );
  for (const aux of seen.aux.values()) {
    const key = auxFeature(aux);
    const isLight = aux.kind !== 'switch';
    features.push({ key, name: aux.label, ...(isLight ? SHAPES.light() : SHAPES.switch()) });
    if (aux.kind === 'dimmer') {
      features.push({
        key: `${key}-brightness`,
        name: `${aux.label} (${word(FEATURE_NAMES.brightness, language)})`,
        ...SHAPES.brightness(),
      });
    }
  }
  return features;
}

function iaquaStates(system, language) {
  const home = system.home;
  if (!home) {
    return [];
  }
  const states = [{ key: 'status', text: word(STATUS_TEXT[home.status], language) }];
  if (home.status !== 'online') {
    return states;
  }
  const v = home.values;
  const put = (key, state) => {
    if (state !== undefined) {
      states.push({ key, state });
    }
  };
  put('pool-temperature', numberOf(v.pool_temp));
  put('spa-temperature', numberOf(v.spa_temp));
  put('air-temperature', numberOf(v.air_temp));
  put('pool-pump', binaryOf(v.pool_pump));
  put('spa-pump', binaryOf(v.spa_pump));
  put('pool-heater', binaryOf(v.pool_heater, { heater: true }));
  put('spa-heater', binaryOf(v.spa_heater, { heater: true }));
  put('solar-heater', binaryOf(v.solar_heater, { heater: true }));
  put('pool-setpoint', numberOf(v.pool_set_point));
  put('spa-setpoint', numberOf(v.spa_set_point));
  put('ph', numberOf(v.ph));
  put('orp', numberOf(v.orp));
  put('pool-salinity', numberOf(v.pool_salinity));
  put('spa-salinity', numberOf(v.spa_salinity));
  for (const aux of system.aux ?? []) {
    put(auxFeature(aux), binaryOf(aux.state));
    if (aux.kind === 'dimmer') {
      put(`${auxFeature(aux)}-brightness`, brightnessOf(aux));
    }
  }
  return states;
}

// --- eXO chlorinators ----------------------------------------------------------

/** The feature keys an eXO has now, from its last shadow. */
export function exoKeysNow(system) {
  const shadow = system.shadow;
  if (!shadow || shadow.status !== 'online') {
    return [];
  }
  const { has, values } = shadow;
  const keys = [];
  const add = (condition, ...list) => condition && keys.push(...list);
  add(has.temperature, 'temperature');
  add(has.ph, 'ph');
  add(has.orp, 'orp');
  add(has.phSetpoint, 'ph-setpoint');
  add(has.orpSetpoint, 'orp-setpoint');
  add(values.chlorineLevel !== undefined, 'chlorine-level');
  add(values.production !== undefined, 'production');
  add(values.boost !== undefined, 'boost');
  add(has.low, 'low');
  add(has.filterPump, 'filter-pump');
  for (const aux of shadow.aux) {
    keys.push(`aux-${aux.key.slice(4)}`);
  }
  add(shadow.heating !== undefined, 'heating', 'heating-setpoint');
  return keys;
}

const EXO_ORDER = [
  'status',
  'temperature',
  'ph',
  'orp',
  'ph-setpoint',
  'orp-setpoint',
  'chlorine-level',
  'production',
  'boost',
  'low',
  'filter-pump',
  'heating',
  'heating-setpoint',
];

const EXO_SHAPES = {
  status: () => SHAPES.text(),
  temperature: () => SHAPES.temperature('C'),
  ph: () => SHAPES.ph(),
  orp: () => SHAPES.orp(),
  'ph-setpoint': () => SHAPES.ph(),
  'orp-setpoint': () => SHAPES.orp(),
  'chlorine-level': () => SHAPES.percent(),
  production: () => SHAPES.switch(),
  boost: () => SHAPES.switch(),
  low: () => SHAPES.switch(),
  'filter-pump': () => SHAPES.switch(),
  heating: () => SHAPES.switch(),
  'heating-setpoint': (range) => SHAPES.setpoint('C', range),
};

const exoAuxName = (key, language) =>
  language === 'fr' ? `Auxiliaire ${key.slice(4)}` : `Auxiliary ${key.slice(4)}`;

function exoFeatures(system, language) {
  const { seen } = system;
  const features = EXO_ORDER.filter((key) => key === 'status' || seen.features.has(key)).map(
    (key) => ({
      key,
      name: word(FEATURE_NAMES[key], language),
      ...EXO_SHAPES[key](seen.heatingRange ?? SETPOINT_RANGE.C),
    }),
  );
  for (const key of [...seen.features].filter((k) => /^aux-\d+$/.test(k)).sort()) {
    features.push({ key, name: exoAuxName(key, language), ...SHAPES.switch() });
  }
  return features;
}

function exoStatusText(shadow, language) {
  const parts = [word(STATUS_TEXT[shadow.status], language)];
  if (shadow.status === 'online') {
    if (shadow.values.errorCode > 0) {
      parts.push(word(STATUS_TEXT.error(shadow.values.errorCode), language));
    }
    if (shadow.values.lowSalt === 1) {
      parts.push(word(STATUS_TEXT.lowSalt, language));
    }
  }
  return parts.join(', ');
}

function exoStates(system, language) {
  const shadow = system.shadow;
  if (!shadow) {
    return [];
  }
  const states = [{ key: 'status', text: exoStatusText(shadow, language) }];
  if (shadow.status !== 'online') {
    return states;
  }
  const v = shadow.values;
  const put = (key, state) => {
    if (state !== undefined) {
      states.push({ key, state });
    }
  };
  put('temperature', v.temperature);
  put('ph', v.ph);
  put('orp', v.orp);
  put('ph-setpoint', v.phSetpoint);
  put('orp-setpoint', v.orpSetpoint);
  put('chlorine-level', v.chlorineLevel);
  put('production', v.production);
  put('boost', v.boost);
  put('low', v.low);
  put('filter-pump', v.filterPump);
  for (const aux of shadow.aux) {
    put(`aux-${aux.key.slice(4)}`, aux.state);
  }
  put('heating', shadow.heating?.enabled);
  put('heating-setpoint', shadow.heating?.sp);
  return states;
}

// --- Both ------------------------------------------------------------------------

/**
 * Records what the last reading shows into `system.seen` (features only grow).
 * Returns true when something new was seen.
 */
export function observe(system, config) {
  const { seen } = system;
  const before = JSON.stringify([[...seen.features], [...seen.aux.entries()], seen.heatingRange]);
  if (system.type === SYSTEM_TYPES.IAQUA) {
    for (const key of iaquaKeysNow(system)) {
      seen.features.add(key);
    }
    for (const aux of shownAux(system.aux, config)) {
      seen.aux.set(aux.key, { key: aux.key, suffix: aux.suffix, label: aux.label, kind: aux.kind });
    }
    if (system.home?.tempUnit && !system.unit) {
      // Frozen: the unit of a feature cannot change once created.
      system.unit = system.home.tempUnit;
    }
  } else {
    for (const key of exoKeysNow(system)) {
      seen.features.add(key);
    }
    const heating = system.shadow?.heating;
    if (!seen.heatingRange && heating?.min !== undefined && heating?.max !== undefined) {
      seen.heatingRange = { min: heating.min, max: heating.max };
    }
  }
  return (
    before !== JSON.stringify([[...seen.features], [...seen.aux.entries()], seen.heatingRange])
  );
}

/** The Gladys device of a system, or undefined while it cannot be described yet. */
export function buildDevice(gladys, system, language) {
  const iaqua = system.type === SYSTEM_TYPES.IAQUA;
  if (iaqua && !system.unit) {
    // Never read online yet: the temperature unit is unknown.
    return undefined;
  }
  const ids = systemIds(gladys, system.serial);
  const features = (iaqua ? iaquaFeatures(system, language) : exoFeatures(system, language)).map(
    ({ key, ...feature }) => ({
      read_only: true,
      has_feedback: true,
      keep_history: true,
      ...feature,
      name: feature.name.slice(0, 250),
      external_id: ids.feature(key),
    }),
  );
  const params = [
    { name: 'serial_number', value: String(system.serial) },
    { name: 'system_type', value: system.type },
  ];
  if (iaqua) {
    params.push({ name: 'temperature_unit', value: system.unit });
  }
  return { name: systemName(system), external_id: ids.device, features, params };
}

/** The states of a system: `[{ key, state } | { key, text }]`. */
export const statesOf = (system, language) =>
  system.type === SYSTEM_TYPES.IAQUA ? iaquaStates(system, language) : exoStates(system, language);
