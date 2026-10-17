// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake iAquaLink cloud behind `fetch`. Timers and Date are
// mocked: the tests move the clock second by second.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { IaqualinkApp } from '../src/app.js';
import { ACTIONS, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { EMAIL, MINUTE, NOW, PASSWORD, SERIALS } from './fixtures/iaqualink.js';
import { fakeCloud, memoryStore, settle } from './helpers/fakeCloud.js';

const CONFIG = { email: EMAIL, password: PASSWORD };
const CONTROL = { ...CONFIG, allow_commands: true };
const AUX = { ...CONTROL, allow_aux_commands: true };
const dev = (serial) => `ext:test-integration:iaqualink:${serial}`;
const IQ = SERIALS.iaqua;
const EXO = SERIALS.exo;

async function setup(t, { config = CONFIG, server = fakeCloud(), store = memoryStore() } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const lines = [];
  const logger = createLogger({ level: 'silent' });
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (...args) => lines.push(args.map(String).join(' '));
  }
  const app = new IaqualinkApp({
    gladys,
    logger,
    fetch: server.fetch,
    now: () => Date.now(),
    store,
    requestSpacing: 0,
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle();
  t.after(() => app.stop());
  const advance = async (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
      t.mock.timers.tick(1000);
      await settle(5);
    }
    await settle();
  };
  return { gladys, app, server, store, advance, lines };
}

const deviceOf = (gladys, serial) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === dev(serial));
const keysOf = (gladys, serial) =>
  deviceOf(gladys, serial).features.map((f) => f.external_id.split(':').at(-1));
const featureOf = (gladys, serial, key) =>
  deviceOf(gladys, serial).features.find((f) => f.external_id === `${dev(serial)}:${key}`);
const createAll = async (gladys) => {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
  await settle();
};
const last = (gladys, serial, key) => gladys.fake.lastState(`${dev(serial)}:${key}`);
const textOf = (gladys, serial, key) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === `${dev(serial)}:${key}`).at(-1)
    ?.text;
const set = (gladys, serial, key, value) =>
  gladys.fake.setValue(deviceOf(gladys, serial), featureOf(gladys, serial, key), value);
const badgeOf = (gladys, serial) =>
  gladys.fake.transports.filter((b) => b.device_external_id === dev(serial)).at(-1);

test('without credentials, the status asks for them and nothing is sent', async (t) => {
  const { gladys, server } = await setup(t, { config: {} });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /email and the password/);
  assert.equal(server.requests.length, 0);
});

test('start: sign-in, systems, the panel screens and the eXO shadow', async (t) => {
  const { gladys, server } = await setup(t);
  assert.deepEqual(server.names(), ['login', 'systems', 'get_home', 'get_devices', 'shadow']);
  assert.equal(gladys.fake.discoveredDevices.length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(
    gladys.fake.connectionStatus.message.fr,
    /2 systèmes de piscine \(1 autre appareil pas encore pris en charge\)/,
  );
});

test('the Gladys devices: features, units, names, params', async (t) => {
  const { gladys } = await setup(t);
  const panel = deviceOf(gladys, IQ);
  assert.equal(panel.name, 'Piscine');
  assert.deepEqual(keysOf(gladys, IQ), [
    'status',
    'pool-temperature',
    'spa-temperature',
    'air-temperature',
    'pool-pump',
    'spa-pump',
    'pool-heater',
    'spa-heater',
    'pool-setpoint',
    'spa-setpoint',
    'aux-1',
    'aux-2',
    'aux-3',
    'aux-3-brightness',
    'aux-4',
  ]);
  assert.equal(featureOf(gladys, IQ, 'pool-temperature').unit, 'celsius');
  assert.equal(featureOf(gladys, IQ, 'pool-setpoint').category, 'thermostat');
  assert.equal(featureOf(gladys, IQ, 'pool-setpoint').read_only, false);
  assert.equal(featureOf(gladys, IQ, 'pool-pump').name, 'Pompe de filtration piscine');
  assert.equal(featureOf(gladys, IQ, 'aux-1').name, 'Cleaner');
  assert.equal(featureOf(gladys, IQ, 'aux-1').category, 'switch');
  assert.equal(featureOf(gladys, IQ, 'aux-2').category, 'light');
  assert.equal(featureOf(gladys, IQ, 'aux-3-brightness').type, 'brightness');
  assert.deepEqual(panel.params, [
    { name: 'serial_number', value: IQ },
    { name: 'system_type', value: 'iaqua' },
    { name: 'temperature_unit', value: 'C' },
  ]);
  assert.deepEqual(keysOf(gladys, EXO), [
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
    'aux-2',
  ]);
  assert.equal(featureOf(gladys, EXO, 'ph').unit, 'ph');
  assert.equal(featureOf(gladys, EXO, 'orp').unit, 'millivolt');
  assert.equal(featureOf(gladys, EXO, 'chlorine-level').unit, undefined);
  assert.deepEqual(
    [
      featureOf(gladys, EXO, 'heating-setpoint').min,
      featureOf(gladys, EXO, 'heating-setpoint').max,
    ],
    [15, 32],
  );
});

test('states reach Gladys once the devices are created', async (t) => {
  const { gladys } = await setup(t);
  assert.equal(gladys.fake.states.length, 0);
  await createAll(gladys);
  assert.equal(last(gladys, IQ, 'pool-temperature'), 26);
  assert.equal(last(gladys, IQ, 'air-temperature'), 21);
  // Empty when the spa pump is off: nothing is sent.
  assert.equal(last(gladys, IQ, 'spa-temperature'), undefined);
  assert.equal(last(gladys, IQ, 'pool-pump'), 1);
  assert.equal(last(gladys, IQ, 'pool-heater'), 1, '"3" is an enabled heater');
  assert.equal(last(gladys, IQ, 'pool-setpoint'), 28);
  assert.equal(last(gladys, IQ, 'aux-2'), 1);
  assert.equal(last(gladys, IQ, 'aux-3-brightness'), 50);
  assert.equal(textOf(gladys, IQ, 'status'), 'En ligne');
  assert.equal(last(gladys, EXO, 'ph'), 7.5);
  assert.equal(last(gladys, EXO, 'orp'), 780);
  assert.equal(last(gladys, EXO, 'temperature'), 29);
  assert.equal(last(gladys, EXO, 'production'), 1);
  assert.equal(last(gladys, EXO, 'heating-setpoint'), 28);
  assert.equal(badgeOf(gladys, IQ).transport, DEVICE_TRANSPORTS.CLOUD);
});

test('read again every refresh interval, never faster than 30 seconds', async (t) => {
  const { app, server, advance, gladys } = await setup(t);
  await advance(59_000);
  assert.equal(server.calls('get_home').length, 1);
  await advance(6_000);
  assert.equal(server.calls('get_home').length, 2);
  // The systems list is not read at every round.
  assert.equal(server.calls('systems').length, 1);
  await gladys.fake.configUpdated({ ...CONFIG, refresh_interval: 5 });
  assert.equal(app.config.refreshInterval, 30);
  const before = server.calls('get_home').length;
  // Read 30 s after the last read, not 30 s after the change.
  await advance(20_000);
  assert.equal(server.calls('get_home').length, before);
  await advance(10_000);
  assert.equal(server.calls('get_home').length, before + 1);
});

test('read-only by default: every command is refused, nothing is sent', async (t) => {
  const { gladys, server } = await setup(t);
  await createAll(gladys);
  const before = server.requests.length;
  for (const [serial, key] of [
    [IQ, 'pool-pump'],
    [IQ, 'pool-setpoint'],
    [EXO, 'boost'],
  ]) {
    const denied = await set(gladys, serial, key, 1);
    assert.equal(denied.success, false);
    assert.match(denied.error, /désactivées/);
  }
  assert.equal(server.requests.length, before);
});

test('a toggle: the state is read again just before, nothing sent when already right', async (t) => {
  const { gladys, server, advance } = await setup(t, { config: CONTROL });
  await createAll(gladys);
  const before = server.requests.length;
  assert.deepEqual(await set(gladys, IQ, 'pool-pump', 0), { success: true });
  assert.deepEqual(server.names().slice(before), ['get_home', 'set_pool_pump']);
  assert.equal(server.home.pool_pump, '0');
  // The toggle answer is not shown: the next read tells.
  assert.equal(last(gladys, IQ, 'pool-pump'), 1);
  await advance(60_000);
  assert.equal(last(gladys, IQ, 'pool-pump'), 0);
  // Already off: one read, no toggle.
  const after = server.requests.length;
  assert.deepEqual(await set(gladys, IQ, 'pool-pump', 0), { success: true });
  assert.deepEqual(server.names().slice(after), ['get_home']);
});

test('a toggle is refused when the state is unknown', async (t) => {
  const { gladys, server } = await setup(t, { config: CONTROL });
  await createAll(gladys);
  server.home.spa_pump = '';
  const unknown = await set(gladys, IQ, 'spa-pump', 1);
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /n'a pas pu être lu/);
  assert.equal(server.calls('set_spa_pump').length, 0);
});

test('the guard: the expected state succeeds without sending, the old one is refused', async (t) => {
  const { gladys, server, advance } = await setup(t, { config: CONTROL });
  await createAll(gladys);
  // The panel does not apply the toggle at once.
  server.lagging = true;
  assert.equal((await set(gladys, IQ, 'pool-pump', 0)).success, true);
  // "off" again: already asked, nothing sent.
  assert.equal((await set(gladys, IQ, 'pool-pump', 0)).success, true);
  // "on": the old state, a toggle would undo the first one.
  const back = await set(gladys, IQ, 'pool-pump', 1);
  assert.equal(back.success, false);
  assert.match(back.error, /vient d'être commandé/);
  assert.equal(server.calls('set_pool_pump').length, 1);
  // A read showing nothing keeps the guard: "off" is still the expected state.
  server.home.pool_pump = '';
  assert.equal((await set(gladys, IQ, 'pool-pump', 0)).success, true);
  server.home.pool_pump = '1';
  assert.equal((await set(gladys, IQ, 'pool-pump', 1)).success, false);
  assert.equal(server.calls('set_pool_pump').length, 1);
  // Expired after 60 s: the panel state decides again.
  await advance(TIMINGS.toggleGuard);
  assert.equal((await set(gladys, IQ, 'pool-pump', 0)).success, true);
  assert.equal(server.calls('set_pool_pump').length, 2);
});

test('the guard ends as soon as the panel reports the change', async (t) => {
  const { gladys, server } = await setup(t, { config: CONTROL });
  await createAll(gladys);
  server.lagging = true;
  assert.equal((await set(gladys, IQ, 'pool-pump', 0)).success, true);
  server.home.pool_pump = '0';
  assert.equal((await set(gladys, IQ, 'pool-pump', 1)).success, true);
  assert.equal(server.calls('set_pool_pump').length, 2);
});

test('no guard when the toggle was refused before reaching the panel', async (t) => {
  const { gladys, server } = await setup(t, { config: CONTROL });
  await createAll(gladys);
  server.fail('set_pool_pump', 400);
  assert.equal((await set(gladys, IQ, 'pool-pump', 0)).success, false);
  assert.equal((await set(gladys, IQ, 'pool-pump', 0)).success, true);
  assert.equal(server.calls('set_pool_pump').length, 2);
  // A toggle without answer may have reached the panel: guarded.
  server.lagging = true;
  server.fail('set_pool_pump', 503);
  assert.equal((await set(gladys, IQ, 'pool-pump', 1)).success, false);
  assert.equal((await set(gladys, IQ, 'pool-pump', 0)).success, false);
  assert.equal(server.calls('set_pool_pump').length, 3);
});

for (const [first, second] of [
  [1, 0],
  [0, 1],
]) {
  test(`two commands together on a lagging panel [${first}, ${second}]: one toggle at most`, async (t) => {
    const { gladys, server } = await setup(t, { config: CONTROL });
    await createAll(gladys);
    server.lagging = true;
    const results = await Promise.all([
      set(gladys, IQ, 'pool-pump', first),
      set(gladys, IQ, 'pool-pump', second),
    ]);
    assert.equal(server.calls('set_pool_pump').length, 1);
    // The pump is on: "on" changes nothing, "off" toggles once; an "on"
    // after the "off" would undo it, so it is refused.
    assert.deepEqual(
      results.map((r) => r.success),
      first === 1 ? [true, true] : [true, false],
    );
  });
}

test('commands are refused when the panel is offline', async (t) => {
  const { gladys, server } = await setup(t, { config: CONTROL });
  await createAll(gladys);
  server.home.status = 'Offline';
  const offline = await set(gladys, IQ, 'pool-pump', 0);
  assert.equal(offline.success, false);
  assert.match(offline.error, /hors ligne/);
  assert.equal(server.calls('set_pool_pump').length, 0);
});

test('set points: both sent, the spa one first, within the range of the unit', async (t) => {
  const { gladys, server } = await setup(t, { config: CONTROL });
  await createAll(gladys);
  assert.equal((await set(gladys, IQ, 'pool-setpoint', 30.4)).success, true);
  const [temps] = server.calls('set_temps');
  assert.equal(temps.query.temp1, '36');
  assert.equal(temps.query.temp2, '30');
  assert.equal(last(gladys, IQ, 'pool-setpoint'), 30);
  const tooHot = await set(gladys, IQ, 'spa-setpoint', 45);
  assert.equal(tooHot.success, false);
  assert.match(tooHot.error, /entre 1 et 40/);
  assert.equal(server.calls('set_temps').length, 1);
});

test('a panel switched to Fahrenheit: values and set points converted, logged once', async (t) => {
  const { gladys, server, advance, lines } = await setup(t, { config: CONTROL });
  await createAll(gladys);
  Object.assign(server.home, {
    temp_scale: 'F',
    pool_temp: '80.6',
    pool_set_point: '82',
    spa_set_point: '97',
  });
  await advance(60_000);
  await advance(60_000);
  assert.equal(last(gladys, IQ, 'pool-temperature'), 27);
  assert.equal(featureOf(gladys, IQ, 'pool-temperature').unit, 'celsius');
  assert.equal(lines.filter((l) => /now reports in °F/.test(l)).length, 1);
  assert.equal((await set(gladys, IQ, 'pool-setpoint', 30)).success, true);
  const temps = server.calls('set_temps').at(-1).query;
  assert.deepEqual([temps.temp1, temps.temp2], ['97', '86']);
});

test('auxiliaries: lights without the auxiliary option, plain ones and valves with it', async (t) => {
  const { gladys, server } = await setup(t, { config: CONTROL });
  await createAll(gladys);
  const denied = await set(gladys, IQ, 'aux-1', 1);
  assert.equal(denied.success, false);
  assert.match(denied.error, /vanne/);
  assert.equal(server.calls('get_devices').length, 1, 'refused before any request');
  // An on/off light toggles.
  assert.equal((await set(gladys, IQ, 'aux-2', 0)).success, true);
  assert.equal(server.calls('set_aux_2').length, 1);
  assert.equal((await set(gladys, IQ, 'aux-3-brightness', 60)).success, true);
  assert.deepEqual(server.calls('set_light').at(-1).query.light, '50');
  assert.equal((await set(gladys, IQ, 'aux-4', 1)).success, true);
  const color = server.calls('set_light').at(-1).query;
  assert.deepEqual([color.aux, color.light, color.subtype], ['4', '1', '5']);
  assert.equal(last(gladys, IQ, 'aux-4'), 1);
  await gladys.fake.configUpdated(AUX);
  assert.equal((await set(gladys, IQ, 'aux-1', 1)).success, true);
  assert.equal(server.calls('set_aux_1').length, 1);
});

test('a valve actuator (type 3) is a switch commanded only with the auxiliary option', async (t) => {
  const server = fakeCloud();
  server.aux.push(['aux_5', '0', 'Spillover', '3', '0']);
  const { gladys } = await setup(t, { server, config: CONTROL });
  await createAll(gladys);
  assert.equal(featureOf(gladys, IQ, 'aux-5').category, 'switch');
  const denied = await set(gladys, IQ, 'aux-5', 1);
  assert.equal(denied.success, false);
  assert.equal(server.calls('set_aux_5').length, 0);
  await gladys.fake.configUpdated(AUX);
  assert.equal((await set(gladys, IQ, 'aux-5', 1)).success, true);
  assert.equal(server.calls('set_aux_5').length, 1);
});

test('eXO: absolute desired states, read just before, nothing sent when already right', async (t) => {
  const { gladys, server } = await setup(t, { config: CONTROL });
  await createAll(gladys);
  const before = server.requests.length;
  assert.equal((await set(gladys, EXO, 'production', 0)).success, true);
  assert.deepEqual(server.names().slice(before), ['shadow', 'desire']);
  assert.deepEqual(server.calls('desire')[0].body, {
    state: { desired: { equipment: { swc_0: { production: 0 } } } },
  });
  assert.equal(last(gladys, EXO, 'production'), 0);
  assert.equal((await set(gladys, EXO, 'filter-pump', 1)).success, true);
  assert.equal(server.calls('desire').length, 1, 'already on');
  assert.equal((await set(gladys, EXO, 'heating-setpoint', 30)).success, true);
  assert.deepEqual(server.calls('desire')[1].body.state.desired, { heating: { sp: 30 } });
  const out = await set(gladys, EXO, 'heating-setpoint', 35);
  assert.equal(out.success, false);
  assert.match(out.error, /entre 15 et 32/);
  // An aux output needs the auxiliary option; an unknown state is refused.
  assert.equal((await set(gladys, EXO, 'aux-2', 1)).success, false);
  delete server.shadow.state.reported.equipment.swc_0.boost;
  const unknown = await set(gladys, EXO, 'boost', 1);
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /n'a pas pu être lu/);
  assert.equal(server.calls('desire').length, 2);
});

test('a 429 answering a command pauses the reads and the commands', async (t) => {
  const { gladys, server, app } = await setup(t, { config: CONTROL });
  await createAll(gladys);
  server.fail('set_pool_pump', 429, { headers: { 'retry-after': '300' } });
  const limited = await set(gladys, IQ, 'pool-pump', 0);
  assert.equal(limited.success, false);
  assert.match(limited.error, /trop de requêtes/);
  assert.equal(app.pausedUntil, Date.now() + 300_000);
  assert.match((await set(gladys, IQ, 'pool-pump', 0)).error, /ralentir/);
});

test('refused credentials: no new sign-in for hours, at once after a change', async (t) => {
  const { gladys, server, advance } = await setup(t, {
    config: { email: EMAIL, password: 'wrong' },
  });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the email or the password/);
  await advance(10 * MINUTE);
  assert.equal(server.calls('login').length, 1);
  await gladys.fake.configUpdated(CONFIG);
  await settle();
  assert.equal(server.calls('login').length, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('429: a pause from Retry-After, the scan does not read during it', async (t) => {
  const server = fakeCloud();
  server.fail('systems', 429, { headers: { 'retry-after': '600' } });
  const { gladys, app, advance } = await setup(t, { server });
  assert.match(gladys.fake.connectionStatus.message.en, /slow down: pausing for 10 min/);
  await gladys.fake.scanRequest();
  assert.equal(server.calls('systems').length, 1);
  assert.match(
    (await gladys.fake.action(ACTIONS.TEST_CONNECTION, {})).data.message.en,
    /slow down/,
  );
  await advance(10 * MINUTE);
  assert.equal(server.calls('systems').length, 2);
  assert.equal(app.readAt !== undefined, true);
});

test('429 during the reads: commands are refused until the pause ends', async (t) => {
  const { gladys, server, advance } = await setup(t, { config: CONTROL });
  await createAll(gladys);
  server.fail('get_home', 429);
  await advance(60_000);
  const before = server.requests.length;
  const refused = await set(gladys, IQ, 'pool-pump', 0);
  assert.equal(refused.success, false);
  assert.match(refused.error, /ralentir/);
  assert.equal(server.requests.length, before);
  await advance(TIMINGS.rateLimitPause);
  assert.equal((await set(gladys, IQ, 'pool-pump', 0)).success, true);
});

test('cloud unreachable: growing pauses, unreachable badges, then back', async (t) => {
  const { gladys, server, advance } = await setup(t);
  await createAll(gladys);
  server.fail('get_home', 503, { times: 2 });
  await advance(60_000);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /Next try in 1 min/);
  assert.equal(badgeOf(gladys, IQ).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  await advance(60_000);
  assert.match(gladys.fake.connectionStatus.message.en, /Next try in 2 min/);
  await advance(2 * 60_000);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(badgeOf(gladys, IQ).transport, DEVICE_TRANSPORTS.CLOUD);
});

test('an offline panel: status text, degraded badge, no values', async (t) => {
  const server = fakeCloud();
  const { gladys, advance } = await setup(t, { server });
  await createAll(gladys);
  server.home.status = 'Offline';
  const count = gladys.fake.states.length;
  await advance(60_000);
  assert.equal(textOf(gladys, IQ, 'status'), 'Hors ligne');
  const sent = gladys.fake.states.slice(count).map((s) => s.device_feature_external_id);
  assert.deepEqual(sent, [`${dev(IQ)}:status`]);
  const badge = badgeOf(gladys, IQ);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.UNREACHABLE);
  assert.equal(badge.degraded, true);
  assert.match(gladys.fake.connectionStatus.message.en, /1 system offline/);
});

test('features survive a restart while the panel is offline (kept in /data)', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store });
  first.app.stop();
  assert.ok(store.data.systems[IQ].features.includes('pool-setpoint'));
  assert.equal(store.data.systems[IQ].unit, 'C');
  const server = fakeCloud();
  server.home.status = 'Offline';
  t.mock.timers.reset();
  const second = await setup(t, { server, store });
  assert.deepEqual(keysOf(second.gladys, IQ), keysOf(first.gladys, IQ));
  assert.doesNotMatch(JSON.stringify(store.data), /S3cret|id-token|session-/);
});

test('unnamed auxiliaries are shown only when asked', async (t) => {
  const { gladys } = await setup(t);
  assert.equal(featureOf(gladys, IQ, 'aux-b1'), undefined);
  await gladys.fake.configUpdated({ ...CONFIG, include_unnamed_aux: true });
  assert.equal(featureOf(gladys, IQ, 'aux-b1').name, 'Aux V5');
  assert.equal(featureOf(gladys, IQ, 'aux-ea').name, 'Extra Aux');
});

test('the test button: a summary, a cooldown, a refused password retried at once', async (t) => {
  const { gladys, server, advance } = await setup(t, {
    config: { email: EMAIL, password: 'wrong' },
  });
  const refused = await gladys.fake.action(ACTIONS.TEST_CONNECTION, {});
  assert.match(refused.data.message.en, /refused the email or the password/);
  assert.equal(server.calls('login').length, 2);
  await gladys.fake.configUpdated(CONFIG);
  await advance(TIMINGS.testCooldown);
  const ok = await gladys.fake.action(ACTIONS.TEST_CONNECTION, {});
  assert.match(ok.data.message.fr, /2 systèmes de piscine pris en charge, 1 autre appareil/);
  const again = await gladys.fake.action(ACTIONS.TEST_CONNECTION, {});
  assert.match(again.data.message.en, /less than 30 seconds/);
});

test('a state read too slowly for the 5 s ack: refused, nothing toggled', async (t) => {
  const { gladys, server } = await setup(t, { config: CONTROL });
  await createAll(gladys);
  server.beforeAnswer = (call) => {
    if (call.name === 'get_home') {
      server.beforeAnswer = undefined;
      t.mock.timers.tick(TIMINGS.commandReadDeadline + 500);
    }
  };
  const slow = await set(gladys, IQ, 'pool-pump', 0);
  assert.equal(slow.success, false);
  assert.match(slow.error, /trop lentement/);
  assert.equal(server.calls('set_pool_pump').length, 0);
  assert.equal((await set(gladys, IQ, 'pool-pump', 0)).success, true);
});

test('a system missing from one device list keeps its entry in /data', async (t) => {
  const store = memoryStore();
  const server = fakeCloud();
  const { gladys, advance } = await setup(t, { server, store });
  server.systems = server.systems.filter((s) => s.serial_number !== EXO);
  await gladys.fake.scanRequest();
  await advance(30_000);
  await gladys.fake.scanRequest();
  server.home.ph = '7.3';
  await advance(60_000);
  assert.ok(store.data.systems[IQ].features.includes('ph'));
  assert.ok(store.data.systems[EXO].features.includes('production'), 'kept');
});

test('three failed sign-ins in a row: a long pause', async (t) => {
  const server = fakeCloud();
  server.fail('login', 503, { times: 5 });
  const { gladys, advance } = await setup(t, { server });
  await advance(60_000);
  await advance(2 * 60_000);
  assert.equal(server.calls('login').length, 3);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /failed several times in a row: next try in 6 h/,
  );
  await advance(30 * 60_000);
  assert.equal(server.calls('login').length, 3);
});

test('no secret in the logs', async (t) => {
  const { gladys, lines, server } = await setup(t, { config: CONTROL });
  await createAll(gladys);
  await set(gladys, IQ, 'pool-pump', 0);
  server.expireTokens();
  server.fail('refresh', 401);
  await gladys.fake.action(ACTIONS.TEST_CONNECTION, {});
  const all = lines.join('\n');
  assert.ok(lines.length > 0);
  assert.doesNotMatch(all, /S3cret|id-token|session-\d|refresh-1|auth-\d|signature/);
});
