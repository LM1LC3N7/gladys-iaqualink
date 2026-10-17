// -----------------------------------------------------------------------------
// The iAquaLink account: the sign-in with the email and password of the
// iAquaLink app, the IdToken renewed before it expires (or once when a request
// is refused), and the calls the integration needs. A port of the client of
// flz/iaqualink-py (BSD-3-Clause, see THIRD_PARTY_NOTICES.md).
//
// Renewal rules, so the account is never hammered:
// - one renewal at a time, shared by the requests waiting for it;
// - a refused refresh token is dropped, then ONE sign-in;
// - a refused sign-in is final until the configuration changes (the app
//   tries again hours later);
// - never a new automatic sign-in within TIMINGS.loginCooldown of one that
//   worked (a session refused right after a sign-in waits for the backoff).
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { AQUALINK, TIMINGS } from '../constants.js';
import { AqualinkError, request } from './http.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The signature of the device-list request: HMAC-SHA1 of "user_id,timestamp" (iaqualink-py `sign`). */
export function sign(parts, secret = AQUALINK.signingKey) {
  return createHmac('sha1', secret).update(parts.join(',')).digest('hex');
}

/** The expiry (ms) of a JWT, from its `exp` claim; undefined when unreadable. */
export function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session of a login or refresh answer. The refresh answer may omit the
 * refresh token: the previous one is kept (iaqualink-py `_apply_login_data`).
 */
export function parseSession(json, now, previousRefreshToken) {
  const oauth = json?.userPoolOAuth;
  const idToken = oauth?.IdToken;
  if (typeof idToken !== 'string' || idToken === '' || json?.id === undefined) {
    throw new AqualinkError('bad_response', 'iAquaLink sent no session');
  }
  const lifetime = Number(oauth.ExpiresIn);
  const expiresAt =
    Number.isFinite(lifetime) && lifetime > 0
      ? now + lifetime * 1000
      : (jwtExpiry(idToken) ?? now + TIMINGS.tokenLifetime);
  const refreshToken = oauth.RefreshToken || previousRefreshToken;
  return {
    userId: String(json.id),
    sessionId: String(json.session_id ?? ''),
    idToken,
    refreshToken:
      typeof refreshToken === 'string' && refreshToken !== '' ? refreshToken : undefined,
    expiresAt,
    country: String(json.country || 'us').toLowerCase(),
  };
}

export class AqualinkClient {
  constructor({ budget, fetch = globalThis.fetch, now = Date.now, sleep = delay, logger }) {
    this.budget = budget;
    this.fetch = fetch;
    this.now = now;
    this.sleep = sleep;
    this.logger = logger;
    this.email = '';
    this.password = '';
    this.session = null;
    this.renewing = undefined;
    this.lastLoginAt = -Infinity;
  }

  /** New credentials forget the session; the next request signs in at once. */
  configure({ email, password }) {
    if (email !== this.email || password !== this.password) {
      this.email = email;
      this.password = password;
      this.session = null;
      this.lastLoginAt = -Infinity;
    }
  }

  get hasCredentials() {
    return this.email !== '' && this.password !== '';
  }

  /** Lets the next sign-in happen at once (the "Test the connection" button). */
  allowLogin() {
    this.lastLoginAt = -Infinity;
  }

  /**
   * One request within the budget. `urgent` (the requests of a command, whose
   * ack Gladys awaits 5 s) skips the gap between requests, never the budget.
   */
  async send({ urgent = false, ...options }) {
    const wait = urgent ? 0 : this.budget.wait();
    if (wait > 0) {
      await this.sleep(wait);
    }
    if (!this.budget.spend()) {
      throw new AqualinkError('budget', 'request budget of the minute spent');
    }
    return request(this.fetch, { ...options, now: this.now() });
  }

  async login() {
    if (!this.hasCredentials) {
      throw new AqualinkError('no_credentials', 'no email or password configured');
    }
    if (this.now() - this.lastLoginAt < TIMINGS.loginCooldown) {
      throw new AqualinkError('login_cooldown', 'the iAquaLink session was refused again');
    }
    this.session = null;
    let json;
    try {
      json = await this.send({
        method: 'POST',
        url: AQUALINK.loginUrl,
        json: { api_key: AQUALINK.apiKey, email: this.email, password: this.password },
        login: true,
      });
      this.session = parseSession(json, this.now());
    } catch (err) {
      // The app counts the sign-ins failing in a row.
      err.during = 'login';
      throw err;
    }
    // Only a sign-in that worked counts: a failed one is paced by the backoff of the app.
    this.lastLoginAt = this.now();
    this.logger?.info('Signed in to iAquaLink');
  }

  /** A new IdToken from the refresh token; a refused refresh token falls back to one sign-in. */
  async refresh() {
    const refreshToken = this.session?.refreshToken;
    if (!refreshToken) {
      return this.login();
    }
    let json;
    try {
      json = await this.send({
        method: 'POST',
        url: AQUALINK.refreshUrl,
        json: { email: this.email, refresh_token: refreshToken },
        login: true,
      });
    } catch (err) {
      if (err.kind !== 'refused' && err.kind !== 'unauthorized') {
        throw err;
      }
      // Never used again: the next renewal is a sign-in.
      this.session = null;
      this.logger?.info('iAquaLink refused the refresh token: signing in again');
      return this.login();
    }
    this.session = parseSession(json, this.now(), refreshToken);
    this.logger?.debug('iAquaLink session renewed');
  }

  /** One renewal at a time: the requests waiting for one share it. */
  renew() {
    if (!this.renewing) {
      this.renewing = (this.session ? this.refresh() : this.login()).finally(() => {
        this.renewing = undefined;
      });
    }
    return this.renewing;
  }

  async ensureSession() {
    if (this.renewing) {
      await this.renewing;
    }
    if (!this.session || this.now() >= this.session.expiresAt - TIMINGS.tokenMargin) {
      await this.renew();
    }
    return this.session;
  }

  /** Runs `call(session)`; a refused session is renewed once and the call made again. */
  async authorized(call) {
    const session = await this.ensureSession();
    try {
      return await call(session);
    } catch (err) {
      if (err.kind !== 'unauthorized') {
        throw err;
      }
      // Another request may have renewed it meanwhile: no second renewal then.
      if (this.session === session) {
        await this.renew();
      } else if (this.renewing) {
        await this.renewing;
      }
      if (!this.session) {
        throw err;
      }
      return call(this.session);
    }
  }

  /** The systems of the account (`[{ serial_number, device_type, name, ... }]`). */
  systems() {
    return this.authorized(async (session) => {
      const timestamp = String(Math.floor(this.now() / 1000));
      let data;
      try {
        data = await this.send({
          url: AQUALINK.devicesUrl,
          query: {
            user_id: session.userId,
            signature: sign([session.userId, timestamp]),
            timestamp,
          },
          headers: { api_key: AQUALINK.apiKey, Authorization: `Bearer ${session.idToken}` },
        });
      } catch (err) {
        // iaqualink-py reads a 404 of the device list as an expired session.
        if (err.status === 404) {
          throw new AqualinkError('unauthorized', 'iAquaLink refused the session', { status: 404 });
        }
        throw err;
      }
      if (!Array.isArray(data)) {
        throw new AqualinkError('bad_response', 'iAquaLink sent no list of systems');
      }
      return data;
    });
  }

  /**
   * One command of an iAquaLink panel (`get_home`, `set_pool_pump`...).
   * `options`: `{ urgent, timeout }` for the requests of a Gladys command.
   */
  iaqua(serial, command, params = {}, options = {}) {
    return this.authorized(async (session) => {
      const extra =
        command === 'get_home' ? { attached_test: 'true', country: session.country } : {};
      const data = await this.send({
        ...options,
        url: AQUALINK.sessionUrl,
        query: {
          ...extra,
          ...params,
          actionID: 'command',
          command,
          serial,
          sessionID: session.sessionId,
        },
        headers: { Authorization: `Bearer ${session.idToken}`, api_key: AQUALINK.apiKey },
      });
      if (!data || typeof data !== 'object') {
        throw new AqualinkError('bad_response', 'iAquaLink sent an empty answer');
      }
      return data;
    });
  }

  /** The shadow of an eXO chlorinator. */
  shadow(serial, options = {}) {
    return this.authorized(async (session) => {
      const data = await this.send({
        ...options,
        url: AQUALINK.shadowUrl(serial),
        headers: { Authorization: session.idToken },
      });
      if (!data || typeof data !== 'object') {
        throw new AqualinkError('bad_response', 'iAquaLink sent an empty shadow');
      }
      return data;
    });
  }

  /** Writes a desired state into the shadow of an eXO chlorinator. */
  desire(serial, desired, options = {}) {
    return this.authorized((session) =>
      this.send({
        ...options,
        method: 'POST',
        url: AQUALINK.shadowUrl(serial),
        headers: { Authorization: session.idToken },
        json: { state: { desired } },
      }),
    );
  }
}
