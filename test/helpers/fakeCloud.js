// -----------------------------------------------------------------------------
// A fake iAquaLink cloud behind a fake `fetch`: it signs in, checks the
// tokens, plays an iAquaLink panel (toggles, set points, lights) and an eXO
// shadow, records every request and can fail on demand. No test touches the
// network.
// -----------------------------------------------------------------------------

import {
  AUX,
  EMAIL,
  HOME_VALUES,
  PASSWORD,
  SERIALS,
  SYSTEMS,
  devicesAnswer,
  homeAnswer,
  loginAnswer,
  shadowAnswer,
} from '../fixtures/iaqualink.js';

const json = (body, status = 200, headers = {}) =>
  new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const clone = (value) => JSON.parse(JSON.stringify(value));

function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = deepMerge(target[key] ?? {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/** The name of a call: login | refresh | systems | <session command> | shadow | desire. */
function routeOf(url, method) {
  if (url.pathname === '/users/v1/login') return 'login';
  if (url.pathname === '/users/v1/refresh') return 'refresh';
  if (url.pathname === '/v2/devices.json') return 'systems';
  if (url.pathname === '/v2/mobile/session.json') return url.searchParams.get('command');
  if (/^\/devices\/v1\/[^/]+\/shadow$/.test(url.pathname)) {
    return method === 'POST' ? 'desire' : 'shadow';
  }
  return 'unknown';
}

export function fakeCloud({
  systems = SYSTEMS,
  home = { ...HOME_VALUES },
  aux = AUX.map((a) => [...a]),
  shadow = shadowAnswer(),
} = {}) {
  const server = {
    systems: clone(systems),
    home,
    aux,
    shadow,
    deviceStatus: 'Online',
    /** When true, the panel ignores toggles (it reports the old state). */
    lagging: false,
    logins: 0,
    refreshes: 0,
    validTokens: new Set(),
    requests: [],
    /** name -> [{ status, body, headers }]: answers served before the normal one */
    failures: new Map(),
  };

  server.fail = (name, status, { body, headers = {}, times = 1 } = {}) => {
    const list = server.failures.get(name) ?? [];
    for (let i = 0; i < times; i += 1) {
      list.push({ status, body, headers });
    }
    server.failures.set(name, list);
  };
  server.calls = (name) => server.requests.filter((r) => r.name === name);
  server.names = () => server.requests.map((r) => r.name);
  /** Every token issued so far stops working (a revoked or expired session). */
  server.expireTokens = () => server.validTokens.clear();

  const issue = () => {
    server.logins += 1;
    server.validTokens.add(`id-token-${server.logins}`);
    return loginAnswer(server.logins);
  };

  const homeScreen = () => homeAnswer(server.home);
  const devicesScreen = () => devicesAnswer(server.aux, server.deviceStatus);

  const handlers = {
    login: (call) =>
      call.body.email === EMAIL && call.body.password === PASSWORD
        ? json(issue())
        : json({ error: 'Unauthorized' }, 401),
    refresh: (call) => {
      if (call.body.refresh_token !== 'refresh-1' || call.body.email !== EMAIL) {
        return json({ error: 'invalid refresh token' }, 401);
      }
      server.refreshes += 1;
      server.logins += 1;
      server.validTokens.add(`id-token-${server.logins}`);
      // A refresh answer carries no new refresh token.
      return json(loginAnswer(server.logins, { refreshToken: null }));
    },
    systems: () => json(server.systems),
    get_home: () => json(homeScreen()),
    get_devices: () => json(devicesScreen()),
    set_temps: (call) => {
      const { temp1, temp2 } = call.query;
      if (server.home.spa_set_point !== '') {
        server.home.spa_set_point = temp1;
        server.home.pool_set_point = temp2;
      } else {
        server.home.pool_set_point = temp1;
      }
      return json(homeScreen());
    },
    setpoint_hpm_temp: () => json({ isHPMPresent: true }),
    set_light: (call) => {
      const entry = server.aux.find((a) => a[0] === `aux_${call.query.aux}`);
      const light = Number(call.query.light);
      entry[1] = light > 0 ? '1' : '0';
      if (entry[3] === '1') {
        entry[4] = String(light);
      }
      return json(devicesScreen());
    },
    shadow: () => json(server.shadow),
    desire: (call) => {
      deepMerge(server.shadow.state.reported, call.body.state.desired);
      return json({});
    },
  };

  const toggle = (name) => {
    const homeKey = name.replace(/^set_/, '');
    if (homeKey in server.home) {
      if (!server.lagging) {
        server.home[homeKey] = server.home[homeKey] === '0' ? '1' : '0';
      }
      return json(homeScreen());
    }
    const entry = server.aux.find((a) => `set_${a[0]}` === name);
    if (entry) {
      if (!server.lagging) {
        entry[1] = entry[1] === '0' ? '1' : '0';
      }
      return json(devicesScreen());
    }
    return undefined;
  };

  const authorized = (call) => {
    const header = call.headers.Authorization ?? '';
    const token = header.replace(/^Bearer /, '');
    if (call.name === 'shadow' || call.name === 'desire') {
      // The shadow takes the bare IdToken.
      return !header.startsWith('Bearer ') && server.validTokens.has(token);
    }
    return header.startsWith('Bearer ') && server.validTokens.has(token);
  };

  server.fetch = async (href, init = {}) => {
    const url = new URL(href);
    const method = init.method ?? 'GET';
    const call = {
      name: routeOf(url, method),
      method,
      host: url.host,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
      href,
    };
    server.requests.push(call);
    // A test hook: a slow answer (moves the mocked clock), a check...
    await server.beforeAnswer?.(call);
    const queued = server.failures.get(call.name);
    if (queued?.length) {
      const failure = queued.shift();
      if (failure.status === 0) {
        throw new TypeError('fetch failed');
      }
      return typeof failure.body === 'string'
        ? new Response(failure.body, { status: failure.status, headers: failure.headers })
        : json(failure.body ?? { error: 'failure' }, failure.status, failure.headers);
    }
    if (call.name !== 'login' && call.name !== 'refresh' && !authorized(call)) {
      return json({ error: 'Unauthorized' }, 401);
    }
    if (call.name !== 'login' && call.name !== 'refresh' && call.name !== 'systems') {
      const serial = call.query.serial ?? url.pathname.split('/')[3];
      if (![SERIALS.iaqua, SERIALS.exo].includes(serial)) {
        return json({ error: 'not found' }, 404);
      }
    }
    if (handlers[call.name]) {
      return handlers[call.name](call);
    }
    const toggled = toggle(call.name);
    if (toggled) {
      return toggled;
    }
    throw new Error(`Unexpected iAquaLink call in a test: ${call.name} ${url.pathname}`);
  };

  return server;
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** A store in memory, in place of /data. */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    async load() {
      return this.data === null ? null : clone(this.data);
    },
    async save(data) {
      this.saves += 1;
      this.data = clone(data);
    },
  };
}
