// -----------------------------------------------------------------------------
// The only network access: one HTTPS request to the iAquaLink cloud over
// `fetch`, with a timeout, a size limit and a classification of the failures.
// Error messages never carry a URL (its query holds the user id, the session
// id and the serial numbers), a token or a password.
// -----------------------------------------------------------------------------

import { AQUALINK, LIMITS, TIMINGS } from '../constants.js';

/**
 * A failed iAquaLink call. `kind`:
 * - `refused`: the login endpoint refused the email or the password;
 * - `unauthorized`: a data endpoint refused the session (401);
 * - `rate_limited`: 429, `retryAfter` in ms when the cloud gave one;
 * - `unavailable`: the cloud is down (5xx, or the 403 page of a busy CDN);
 * - `network`: no answer (DNS, connection, timeout);
 * - `bad_response`: an answer that is not the expected JSON;
 * - `http`: any other status;
 * - `budget`: our own request budget is spent (never sent);
 * - `no_credentials`: no email or password configured;
 * - `login_cooldown`: a new sign-in would come too soon after the previous one.
 */
export class AqualinkError extends Error {
  constructor(kind, message, { status, retryAfter } = {}) {
    super(message);
    this.name = 'AqualinkError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** A short, secret-free reason for a log or a status message. */
export function errorReason(err) {
  if (err instanceof AqualinkError) {
    return err.status ? `${err.message} (HTTP ${err.status})` : err.message;
  }
  return String(err?.message ?? err);
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent or invalid. */
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** The HTML page CloudFront / API Gateway answer when they are busy: not a refusal. */
const isEdgePage = (text) =>
  /<html/i.test(text) && /(cloudfront|could not be satisfied|gateway)/i.test(text);

function errorFor(status, text, { login, now, headers }) {
  if (status === 429) {
    return new AqualinkError('rate_limited', 'iAquaLink asked to slow down', {
      status,
      retryAfter: retryAfterMs(headers?.get?.('retry-after'), now),
    });
  }
  if (status >= 500 || (status === 403 && isEdgePage(text))) {
    return new AqualinkError('unavailable', 'iAquaLink is unavailable', { status });
  }
  if (login && (status === 400 || status === 401 || status === 403)) {
    return new AqualinkError('refused', 'iAquaLink refused the email or the password', { status });
  }
  if (status === 401) {
    return new AqualinkError('unauthorized', 'iAquaLink refused the session', { status });
  }
  return new AqualinkError('http', 'iAquaLink refused the request', { status });
}

/**
 * One HTTP request; resolves with the parsed JSON body (null when empty).
 * `query` values are appended to the URL, `json` is sent as the body.
 * `login`: the account endpoints, where 400/401/403 mean "credentials refused".
 */
export async function request(
  fetchImpl,
  {
    method = 'GET',
    url,
    query,
    headers = {},
    json,
    login = false,
    now = Date.now(),
    timeout = TIMINGS.requestTimeout,
  },
) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(query ?? {})) {
    target.searchParams.set(key, String(value));
  }
  const failed = (err) => {
    const late = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const error = new AqualinkError(
      'network',
      late ? 'iAquaLink did not answer in time' : 'iAquaLink cannot be reached',
    );
    error.timeout = late;
    return error;
  };
  let response;
  let text;
  try {
    response = await fetchImpl(target.toString(), {
      method,
      headers: {
        'User-Agent': AQUALINK.userAgent,
        Accept: 'application/json',
        ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: json === undefined ? undefined : JSON.stringify(json),
      signal: AbortSignal.timeout(timeout),
    });
    text = await response.text();
  } catch (err) {
    throw failed(err);
  }
  if (text.length > LIMITS.responseBytes) {
    throw new AqualinkError('bad_response', 'iAquaLink sent an answer too large', {
      status: response.status,
    });
  }
  if (!response.ok) {
    throw errorFor(response.status, text, { login, now, headers: response.headers });
  }
  if (text.trim() === '') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AqualinkError('bad_response', 'iAquaLink sent an answer that is not JSON');
  }
}
