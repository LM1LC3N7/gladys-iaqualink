// -----------------------------------------------------------------------------
// The answers of the iAquaLink panels and of the eXO shadow, read into the
// plain model, and the parameters of the commands (pure functions).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desiredOf, parseShadow, phOf } from '../src/iaqualink/exo.js';
import {
  auxFeature,
  auxKind,
  binaryOf,
  brightnessOf,
  isDefaultAuxName,
  lightParams,
  parseDevices,
  parseHome,
  roundBrightness,
  setTempsParams,
} from '../src/iaqualink/iaqua.js';
import { HOME_VALUES, devicesAnswer, homeAnswer, shadowAnswer } from './fixtures/iaqualink.js';

test('the home screen of iaqualink-py (Fahrenheit, pool only, heat pump paired)', () => {
  const home = parseHome(
    homeAnswer(
      {
        status: 'Online',
        system_type: '1',
        temp_scale: 'F',
        spa_temp: '',
        pool_temp: '89',
        air_temp: '93',
        spa_set_point: '54',
        pool_set_point: '48',
        pool_pump: '1',
        spa_heater: '0',
        is_icl_present: 'present',
      },
      {},
    ),
  );
  assert.equal(home.status, 'online');
  assert.equal(home.systemType, '1');
  assert.equal(home.tempUnit, 'F');
  assert.equal(home.values.pool_temp, '89');
  assert.equal(home.values.ph, '');
  assert.equal(home.heatPump, false);
  const withPump = parseHome({
    home_screen: [{ status: 'Online' }, { heatpump_info: { isheatpumpPresent: true } }],
  });
  assert.equal(withPump.heatPump, true);
  assert.equal(withPump.tempUnit, undefined);
});

test('the status of a home screen', () => {
  assert.equal(parseHome(homeAnswer({ ...HOME_VALUES, status: 'Offline' })).status, 'offline');
  assert.equal(parseHome(homeAnswer({ ...HOME_VALUES, status: 'Service' })).status, 'service');
  assert.equal(parseHome(homeAnswer({ ...HOME_VALUES, status: 'Weird' })).status, 'unknown');
  assert.throws(() => parseHome({ message: 'nope' }), { kind: 'bad_response' });
});

test('the devices screen: auxiliaries, their kind, a NaN state skips the update', () => {
  const { status, aux } = parseDevices(devicesAnswer());
  assert.equal(status, 'online');
  assert.deepEqual(
    aux.map((a) => [a.key, a.suffix, a.kind, a.state]),
    [
      ['aux_1', '1', 'switch', '0'],
      ['aux_2', '2', 'light', '1'],
      ['aux_3', '3', 'dimmer', '1'],
      ['aux_4', '4', 'color', '0'],
      ['aux_B1', 'B1', 'switch', '0'],
      ['aux_EA', 'EA', 'switch', '0'],
    ],
  );
  assert.equal(auxFeature(aux[4]), 'aux-b1');
  assert.equal(brightnessOf(aux[2]), 50);
  const nan = parseDevices(devicesAnswer([['aux_1', 'NaN', 'Cleaner', '0', '0']]));
  assert.equal(nan.aux, null);
  assert.throws(() => parseDevices({}), { kind: 'bad_response' });
});

test('auxKind and the default names of the panel', () => {
  assert.equal(auxKind({ type: '0', label: 'Pool Light' }), 'light');
  assert.equal(auxKind({ type: '0', label: 'Cleaner' }), 'switch');
  assert.equal(auxKind({ type: '3', label: 'Pool Light Valve' }), 'valve', 'SJVA first');
  for (const name of ['Aux3', 'Aux V12', 'AUX 4', 'Extra Aux', 'Aux B1']) {
    assert.equal(isDefaultAuxName(name), true, name);
  }
  for (const name of ['Cleaner', 'Sheer Dscnts', 'Pool Light', 'Auxiliary heater']) {
    assert.equal(isDefaultAuxName(name), false, name);
  }
});

test('binary values: "3" is an enabled heater, "" is unknown', () => {
  assert.equal(binaryOf('1'), 1);
  assert.equal(binaryOf('0'), 0);
  assert.equal(binaryOf(''), undefined);
  assert.equal(binaryOf('3'), undefined);
  assert.equal(binaryOf('3', { heater: true }), 1);
});

test('set_temps: the spa first when the panel has one, the other value kept', () => {
  const values = { ...HOME_VALUES };
  assert.deepEqual(setTempsParams(values, 'pool', 30), { temp1: '36', temp2: '30' });
  assert.deepEqual(setTempsParams(values, 'spa', 38), { temp1: '38', temp2: '28' });
  assert.deepEqual(setTempsParams({ ...values, spa_set_point: '' }, 'pool', 27), { temp1: '27' });
});

test('set_light: dimmers by steps of 25, colour lights on their first colour', () => {
  const dimmer = { suffix: '3', kind: 'dimmer', subtype: '50' };
  assert.deepEqual(lightParams(dimmer, { on: true }), { aux: '3', light: '100' });
  assert.deepEqual(lightParams(dimmer, { on: false }), { aux: '3', light: '0' });
  assert.deepEqual(lightParams(dimmer, { brightness: 60 }), { aux: '3', light: '50' });
  const color = { suffix: '4', kind: 'color', subtype: '5' };
  assert.deepEqual(lightParams(color, { on: true }), { aux: '4', light: '1', subtype: '5' });
  assert.equal(roundBrightness(13), 25);
  assert.equal(roundBrightness(140), 100);
});

test('the eXO shadow of iaqualink-py', () => {
  const shadow = parseShadow(shadowAnswer());
  assert.equal(shadow.status, 'online');
  assert.deepEqual(shadow.values, {
    temperature: 29,
    ph: 7.5,
    orp: 780,
    chlorineLevel: 50,
    production: 1,
    boost: 0,
    low: 0,
    filterPump: 1,
    phSetpoint: 7.4,
    orpSetpoint: 830,
    errorCode: 0,
    lowSalt: 0,
  });
  assert.deepEqual(shadow.aux, [{ key: 'aux_2', state: 0 }]);
  assert.deepEqual(shadow.heating, { enabled: 1, state: 0, sp: 28, min: 15, max: 32 });
  assert.equal(shadow.has.temperature, true);
});

test('eXO: a faulty probe gives no reading, the statuses, a broken answer', () => {
  const answer = shadowAnswer();
  answer.state.reported.equipment.swc_0.sns_1.state = 0;
  answer.state.reported.aws.status = 'offline';
  delete answer.state.reported.heating;
  const shadow = parseShadow(answer);
  assert.equal(shadow.values.ph, undefined);
  assert.equal(shadow.has.ph, true);
  assert.equal(shadow.status, 'offline');
  assert.equal(shadow.heating, undefined);
  answer.state.reported.aws.status = 'firmware_update';
  assert.equal(parseShadow(answer).status, 'service');
  answer.state.reported.aws = {};
  assert.equal(parseShadow(answer).status, 'unknown');
  assert.throws(() => parseShadow({ state: {} }), { kind: 'bad_response' });
  assert.equal(phOf(7.2), 7.2);
  assert.equal(phOf(''), undefined);
});

test('eXO desired states (iaqualink-py set_toggle, set_aux, set_filter_pump, set_heating)', () => {
  assert.deepEqual(desiredOf('production', 0), { equipment: { swc_0: { production: 0 } } });
  assert.deepEqual(desiredOf('boost', 1), { equipment: { swc_0: { boost: 1 } } });
  assert.deepEqual(desiredOf('filter-pump', 1), {
    equipment: { swc_0: { filter_pump: { state: 1 } } },
  });
  assert.deepEqual(desiredOf('aux-2', 1), { equipment: { swc_0: { aux_2: { state: 1 } } } });
  assert.deepEqual(desiredOf('heating', 0), { heating: { enabled: 0 } });
  assert.deepEqual(desiredOf('heating-setpoint', 27), { heating: { sp: 27 } });
  assert.equal(desiredOf('ph', 7), undefined);
});
