// -----------------------------------------------------------------------------
// Systems -> Gladys devices (pure): external ids, units allowed by the Gladys
// core for each category, a Fahrenheit panel, features that only grow.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig } from '../src/config.js';
import { buildDevice, observe, parseFeatureId, statesOf } from '../src/devices.js';
import { parseShadow } from '../src/iaqualink/exo.js';
import { parseDevices, parseHome } from '../src/iaqualink/iaqua.js';
import { memoryOf, normalizeMemory } from '../src/store.js';
import {
  HOME_VALUES,
  SERIALS,
  devicesAnswer,
  homeAnswer,
  shadowAnswer,
} from './fixtures/iaqualink.js';

const gladys = createFakeGladys();
const config = normalizeConfig();

/**
 * DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js (Gladys core),
 * for the categories used here; the others take no unit.
 */
const UNITS = {
  'temperature-sensor': ['celsius', 'fahrenheit', 'kelvin'],
  thermostat: ['celsius', 'fahrenheit'],
  'ph-sensor': ['ph'],
  'orp-sensor': ['millivolt'],
  switch: ['ampere', 'millivolt', 'volt', 'watt', 'kilowatt', 'watt-hour', 'kilowatt-hour'],
};

const panel = (values = HOME_VALUES, aux) => {
  const system = {
    serial: SERIALS.iaqua,
    type: 'iaqua',
    name: 'Piscine',
    seen: { features: new Set(), aux: new Map() },
    home: parseHome(homeAnswer(values)),
    aux: parseDevices(devicesAnswer(aux)).aux,
  };
  observe(system, config);
  return system;
};

const exo = () => {
  const system = {
    serial: SERIALS.exo,
    type: 'exo',
    name: '',
    seen: { features: new Set(), aux: new Map() },
    shadow: parseShadow(shadowAnswer()),
  };
  observe(system, config);
  return system;
};

test('external ids: the serial number, and the feature key', () => {
  const device = buildDevice(gladys, panel(), 'fr');
  assert.equal(device.external_id, `ext:test-integration:iaqualink:${SERIALS.iaqua}`);
  for (const feature of device.features) {
    const parsed = parseFeatureId(gladys, feature.external_id);
    assert.equal(parsed.serial, SERIALS.iaqua);
    assert.equal(feature.external_id, `${device.external_id}:${parsed.key}`);
  }
  assert.equal(parseFeatureId(gladys, 'ext:other:iaqualink:x:y'), undefined);
  assert.equal(parseFeatureId(gladys, 'ext:test-integration:iaqualink:nokey'), undefined);
});

test('every unit is one the Gladys core lists for the category', () => {
  for (const device of [buildDevice(gladys, panel(), 'en'), buildDevice(gladys, exo(), 'en')]) {
    for (const feature of device.features) {
      if (feature.unit === undefined) {
        continue;
      }
      assert.ok(
        UNITS[feature.category]?.includes(feature.unit),
        `${feature.external_id}: ${feature.unit} in ${feature.category}`,
      );
    }
    for (const feature of device.features.filter((f) => f.category === 'unknown')) {
      assert.equal(feature.unit, undefined, feature.external_id);
    }
  }
});

test('a Fahrenheit panel: temperatures and set points in Fahrenheit, the F range', () => {
  const device = buildDevice(gladys, panel({ ...HOME_VALUES, temp_scale: 'F' }), 'en');
  const setpoint = device.features.find((f) => f.external_id.endsWith(':pool-setpoint'));
  assert.equal(setpoint.unit, 'fahrenheit');
  assert.deepEqual([setpoint.min, setpoint.max], [34, 104]);
});

test('the unit is frozen at the first reading', () => {
  const system = panel();
  system.home = parseHome(homeAnswer({ ...HOME_VALUES, temp_scale: 'F' }));
  observe(system, config);
  assert.equal(system.unit, 'C');
});

test('a pool-only panel with chemistry: no spa, pH, ORP, salinity, solar heater', () => {
  const device = buildDevice(
    gladys,
    panel({
      ...HOME_VALUES,
      system_type: '1',
      spa_pump: '',
      ph: '7.4',
      orp: '650',
      pool_salinity: '3200',
      solar_heater: '0',
    }),
    'en',
  );
  const keys = device.features.map((f) => f.external_id.split(':').at(-1));
  assert.equal(keys.includes('spa-pump'), false);
  assert.ok(['ph', 'orp', 'pool-salinity', 'solar-heater'].every((k) => keys.includes(k)));
});

test('features only grow: an equipment seen once stays', () => {
  const system = panel({ ...HOME_VALUES, ph: '7.2' });
  system.home = parseHome(homeAnswer({ ...HOME_VALUES, ph: '' }));
  assert.equal(observe(system, config), false);
  const keys = buildDevice(gladys, system, 'en').features.map((f) => f.external_id);
  assert.ok(keys.some((k) => k.endsWith(':ph')));
  // ...and it survives a restart.
  const restored = normalizeMemory(JSON.parse(JSON.stringify(memoryOf([{ ...system }]))));
  assert.ok(restored[SERIALS.iaqua].seen.features.has('ph'));
  assert.equal(restored[SERIALS.iaqua].unit, 'C');
});

test('a panel never read online is not published', () => {
  const system = {
    serial: 'X',
    type: 'iaqua',
    seen: { features: new Set(), aux: new Map() },
    home: parseHome(homeAnswer({ status: 'Offline' })),
  };
  observe(system, config);
  assert.equal(buildDevice(gladys, system, 'en'), undefined);
  assert.deepEqual(statesOf(system, 'en'), [{ key: 'status', text: 'Offline' }]);
});

test('eXO status text: error code and low salt', () => {
  const system = exo();
  system.shadow.values.errorCode = 12;
  system.shadow.values.lowSalt = 1;
  assert.deepEqual(statesOf(system, 'fr')[0], {
    key: 'status',
    text: "En ligne, code d'erreur 12, sel insuffisant",
  });
  assert.equal(buildDevice(gladys, system, 'en').name, 'eXO 7654');
});

test('the memory file is repaired, never trusted blindly', () => {
  const memory = normalizeMemory({
    systems: {
      A: { type: 'iaqua', unit: 'K', features: ['ph', 3], aux: [{ key: 'bad', kind: 'switch' }] },
      B: { type: 'exo', heatingRange: { min: 30, max: 10 } },
    },
  });
  assert.equal(memory.A.unit, undefined);
  assert.deepEqual([...memory.A.seen.features], ['ph']);
  assert.equal(memory.A.seen.aux.size, 0);
  assert.equal(memory.B.seen.heatingRange, undefined);
  assert.deepEqual(normalizeMemory(null), {});
});
