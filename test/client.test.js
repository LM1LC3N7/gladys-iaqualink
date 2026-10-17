// -----------------------------------------------------------------------------
// The iAquaLink account against the fake cloud: sign-in, signature of the
// device list, the headers of each API family, the renewal of the session
// (once, never in a loop), the classification of the failures.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { RequestBudget } from '../src/budget.js';
import { AQUALINK, TIMINGS } from '../src/constants.js';
import { AqualinkClient, jwtExpiry, parseSession, sign } from '../src/iaqualink/client.js';
import { AqualinkError, errorReason, retryAfterMs } from '../src/iaqualink/http.js';
import { EMAIL, NOW, PASSWORD, SERIALS, UNAUTHORIZED_HTML, USER_ID } from './fixtures/iaqualink.js';
import { fakeCloud } from './helpers/fakeCloud.js';

function setup({ server = fakeCloud(), perMinute = 100 } = {}) {
  let now = NOW;
  const clock = { now: () => now, advance: (ms) => (now += ms) };
  const budget = new RequestBudget({ now: clock.now, perMinute, gap: 0 });
  const client = new AqualinkClient({ budget, fetch: server.fetch, now: clock.now });
  client.configure({ email: EMAIL, password: PASSWORD });
  return { server, client, clock, budget };
}

test('sign-in, then the signed device list with the Bearer IdToken', async () => {
  const { server, client } = setup();
  const systems = await client.systems();
  assert.equal(systems.length, 3);
  const [login, list] = server.requests;
  assert.equal(login.name, 'login');
  assert.equal(login.method, 'POST');
  assert.deepEqual(login.body, { api_key: AQUALINK.apiKey, email: EMAIL, password: PASSWORD });
  assert.equal(login.headers['User-Agent'], 'okhttp/3.14.7');
  assert.equal(list.name, 'systems');
  assert.equal(list.host, 'r-api.iaqualink.net');
  assert.equal(list.headers.Authorization, 'Bearer id-token-1');
  assert.equal(list.headers.api_key, AQUALINK.apiKey);
  const timestamp = String(Math.floor(NOW / 1000));
  assert.deepEqual(list.query, {
    user_id: String(USER_ID),
    signature: createHmac('sha1', AQUALINK.signingKey)
      .update(`${USER_ID},${timestamp}`)
      .digest('hex'),
    timestamp,
  });
});

test('sign() is the HMAC-SHA1 of the comma-joined parts', () => {
  assert.equal(sign(['1', '2'], 'key'), createHmac('sha1', 'key').update('1,2').digest('hex'));
});

test('a panel command: the session query and headers, get_home with its extra parameters', async () => {
  const { server, client } = setup();
  await client.iaqua(SERIALS.iaqua, 'get_home');
  await client.iaqua(SERIALS.iaqua, 'set_temps', { temp1: '30' });
  const [home, temps] = server.requests.slice(1);
  assert.equal(home.host, 'p-api.iaqualink.net');
  assert.deepEqual(home.query, {
    attached_test: 'true',
    country: 'fr',
    actionID: 'command',
    command: 'get_home',
    serial: SERIALS.iaqua,
    sessionID: 'session-1',
  });
  assert.equal(home.headers.Authorization, 'Bearer id-token-1');
  assert.equal(home.headers.api_key, AQUALINK.apiKey);
  assert.equal(temps.query.temp1, '30');
  assert.equal(temps.query.attached_test, undefined);
});

test('the eXO shadow takes the bare IdToken, the desired state a JSON body', async () => {
  const { server, client } = setup();
  const shadow = await client.shadow(SERIALS.exo);
  assert.equal(shadow.state.reported.aws.status, 'connected');
  await client.desire(SERIALS.exo, { equipment: { swc_0: { boost: 1 } } });
  const [, get, post] = server.requests;
  assert.equal(get.path, `/devices/v1/${SERIALS.exo}/shadow`);
  assert.equal(get.headers.Authorization, 'id-token-1');
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, { state: { desired: { equipment: { swc_0: { boost: 1 } } } } });
});

test('a refused session is renewed once with the refresh token, which is kept', async () => {
  const { server, client } = setup();
  await client.iaqua(SERIALS.iaqua, 'get_home');
  server.expireTokens();
  await client.iaqua(SERIALS.iaqua, 'get_home');
  assert.deepEqual(server.names(), ['login', 'get_home', 'get_home', 'refresh', 'get_home']);
  const refresh = server.calls('refresh')[0];
  assert.deepEqual(refresh.body, { email: EMAIL, refresh_token: 'refresh-1' });
  assert.equal(server.requests.at(-1).headers.Authorization, 'Bearer id-token-2');
  // The refresh answer had no refresh token: the first one is kept.
  assert.equal(client.session.refreshToken, 'refresh-1');
});

test('a refused refresh token is dropped, then one sign-in', async () => {
  const { server, client, clock } = setup();
  await client.iaqua(SERIALS.iaqua, 'get_home');
  clock.advance(TIMINGS.loginCooldown);
  server.expireTokens();
  server.fail('refresh', 401);
  await client.iaqua(SERIALS.iaqua, 'get_home');
  assert.deepEqual(server.names(), [
    'login',
    'get_home',
    'get_home',
    'refresh',
    'login',
    'get_home',
  ]);
});

test('a session refused right after a renewal fails instead of looping', async () => {
  const { server, client } = setup();
  await client.iaqua(SERIALS.iaqua, 'get_home');
  server.fail('get_home', 401, { times: 5 });
  await assert.rejects(client.iaqua(SERIALS.iaqua, 'get_home'), { kind: 'unauthorized' });
  assert.deepEqual(server.names(), ['login', 'get_home', 'get_home', 'refresh', 'get_home']);
});

test('no new automatic sign-in within the cooldown of the last one', async () => {
  const { server, client } = setup();
  await client.iaqua(SERIALS.iaqua, 'get_home');
  server.expireTokens();
  server.fail('refresh', 401);
  await assert.rejects(client.iaqua(SERIALS.iaqua, 'get_home'), { kind: 'login_cooldown' });
  assert.equal(server.calls('login').length, 1);
  // The test button lifts it.
  client.allowLogin();
  await client.iaqua(SERIALS.iaqua, 'get_home');
  assert.equal(server.calls('login').length, 2);
});

test('the IdToken is renewed before it expires', async () => {
  const { server, client, clock } = setup();
  await client.iaqua(SERIALS.iaqua, 'get_home');
  clock.advance(3600_000 - TIMINGS.tokenMargin + 1);
  await client.iaqua(SERIALS.iaqua, 'get_home');
  assert.deepEqual(server.names(), ['login', 'get_home', 'refresh', 'get_home']);
});

test('concurrent refused requests share one renewal', async () => {
  const { server, client } = setup();
  await client.iaqua(SERIALS.iaqua, 'get_home');
  server.expireTokens();
  await Promise.all([
    client.iaqua(SERIALS.iaqua, 'get_home'),
    client.iaqua(SERIALS.iaqua, 'get_devices'),
  ]);
  assert.equal(server.calls('refresh').length, 1);
});

test('the device list answering 404 is a refused session (iaqualink-py)', async () => {
  const { server, client } = setup();
  await client.systems();
  server.fail('systems', 404);
  await client.systems();
  assert.deepEqual(server.names(), ['login', 'systems', 'systems', 'refresh', 'systems']);
});

test('a refused email or password: "refused", without the password anywhere', async () => {
  const { server, client } = setup();
  client.configure({ email: EMAIL, password: 'wrong password' });
  const err = await client.systems().catch((e) => e);
  assert.equal(err.kind, 'refused');
  assert.equal(err.status, 401);
  assert.doesNotMatch(`${err.message} ${errorReason(err)} ${err.stack}`, /wrong password/);
  assert.equal(server.calls('login').length, 1);
});

test('the failures are classified, with no URL in the message', async () => {
  const { server, client } = setup();
  await client.systems();
  server.fail('get_home', 429, { headers: { 'retry-after': '120' } });
  const limited = await client.iaqua(SERIALS.iaqua, 'get_home').catch((e) => e);
  assert.equal(limited.kind, 'rate_limited');
  assert.equal(limited.retryAfter, 120_000);
  server.fail('get_home', 503);
  assert.equal((await client.iaqua(SERIALS.iaqua, 'get_home').catch((e) => e)).kind, 'unavailable');
  server.fail('get_home', 403, {
    body: '<html><body>The request could not be satisfied. CloudFront</body></html>',
  });
  assert.equal((await client.iaqua(SERIALS.iaqua, 'get_home').catch((e) => e)).kind, 'unavailable');
  server.fail('get_home', 0);
  const network = await client.iaqua(SERIALS.iaqua, 'get_home').catch((e) => e);
  assert.equal(network.kind, 'network');
  server.fail('get_home', 200, { body: 'not json' });
  const bad = await client.iaqua(SERIALS.iaqua, 'get_home').catch((e) => e);
  assert.equal(bad.kind, 'bad_response');
  for (const err of [limited, network, bad]) {
    assert.doesNotMatch(err.message, /session|iaqualink\.net|id-token/);
  }
});

test('a 401 answered as an HTML page: a refused session on data, a refused password on login', async () => {
  const { server, client } = setup();
  await client.systems();
  server.fail('get_home', 401, { body: UNAUTHORIZED_HTML });
  await client.iaqua(SERIALS.iaqua, 'get_home');
  assert.deepEqual(server.names().slice(-3), ['get_home', 'refresh', 'get_home']);
  const other = setup();
  other.server.fail('login', 401, { body: UNAUTHORIZED_HTML });
  const err = await other.client.systems().catch((e) => e);
  assert.equal(err.kind, 'refused');
  assert.equal(err.during, 'login');
});

test('the requests of a command skip the gap between requests, never the budget', async () => {
  const server = fakeCloud();
  let now = NOW;
  const sleeps = [];
  const budget = new RequestBudget({ now: () => now, perMinute: 100, gap: 1000 });
  const client = new AqualinkClient({
    budget,
    fetch: server.fetch,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  client.configure({ email: EMAIL, password: PASSWORD });
  await client.iaqua(SERIALS.iaqua, 'get_home');
  assert.deepEqual(sleeps, [1000], 'the read after the sign-in waits for the gap');
  await client.iaqua(SERIALS.iaqua, 'set_pool_pump', {}, { urgent: true, timeout: 900 });
  assert.deepEqual(sleeps, [1000]);
});

test('a busy edge page on the login is not a refused password', async () => {
  const { server, client } = setup();
  server.fail('login', 403, { body: '<html>502 Bad Gateway</html>' });
  assert.equal((await client.systems().catch((e) => e)).kind, 'unavailable');
});

test('the request budget: nothing is sent once the minute is spent', async () => {
  const { server, client } = setup({ perMinute: 2 });
  await client.systems();
  const err = await client.iaqua(SERIALS.iaqua, 'get_home').catch((e) => e);
  assert.equal(err.kind, 'budget');
  assert.equal(server.requests.length, 2);
});

test('without credentials, nothing is sent', async () => {
  const { server, client } = setup();
  client.configure({ email: '', password: '' });
  assert.equal((await client.systems().catch((e) => e)).kind, 'no_credentials');
  assert.equal(server.requests.length, 0);
});

test('parseSession: lifetime, JWT expiry, missing token', () => {
  const answer = { id: 1, session_id: 's', userPoolOAuth: { IdToken: 't', ExpiresIn: 60 } };
  assert.equal(parseSession(answer, 0).expiresAt, 60_000);
  const payload = Buffer.from(JSON.stringify({ exp: 1000 })).toString('base64url');
  const jwt = `h.${payload}.s`;
  assert.equal(jwtExpiry(jwt), 1_000_000);
  assert.equal(parseSession({ id: 1, userPoolOAuth: { IdToken: jwt } }, 0).expiresAt, 1_000_000);
  assert.equal(parseSession({ id: 1, userPoolOAuth: { IdToken: 'x' } }, 0).expiresAt, 3_600_000);
  assert.equal(parseSession({ id: 1, userPoolOAuth: { IdToken: 'x' } }, 0).country, 'us');
  assert.throws(() => parseSession({ id: 1, userPoolOAuth: {} }, 0), AqualinkError);
});

test('retryAfterMs: seconds, HTTP date, nonsense', () => {
  assert.equal(retryAfterMs('30'), 30_000);
  assert.equal(retryAfterMs(new Date(NOW + 90_000).toUTCString(), NOW), 90_000);
  assert.equal(retryAfterMs('soon'), undefined);
  assert.equal(retryAfterMs(undefined), undefined);
});
