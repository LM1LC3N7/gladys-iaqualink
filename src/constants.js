// -----------------------------------------------------------------------------
// iAquaLink cloud constants, manifest keys, limits and timings.
//
// The endpoints, the public application keys and the request shapes come from
// flz/iaqualink-py (BSD-3-Clause, see THIRD_PARTY_NOTICES.md), the Python
// library Home Assistant uses for iAquaLink: they are the ones of the official
// iAquaLink mobile application, not a documented public API.
// -----------------------------------------------------------------------------

export const AQUALINK = {
  /** The application key of the iAquaLink app (iaqualink-py `AQUALINK_API_KEY`). */
  apiKey: 'EOOEMOW4YR6QNB07',
  /** Signs the device-list request (iaqualink-py `AQUALINK_API_SIGNING_KEY`). */
  signingKey: 'cj7iYKjiKxOqiLcN65PffA',
  loginUrl: 'https://prod.zodiac-io.com/users/v1/login',
  refreshUrl: 'https://prod.zodiac-io.com/users/v1/refresh',
  devicesUrl: 'https://r-api.iaqualink.net/v2/devices.json',
  /** iAquaLink panels (`iaqua`): one "session" command per request. */
  sessionUrl: 'https://p-api.iaqualink.net/v2/mobile/session.json',
  /** eXO chlorinators: the AWS IoT shadow, read and written over REST. */
  shadowUrl: (serial) =>
    `https://prod.zodiac-io.com/devices/v1/${encodeURIComponent(serial)}/shadow`,
  /** The app is an OkHttp client; iaqualink-py sends the same User-Agent. */
  userAgent: 'okhttp/3.14.7',
};

/** The `device_type` of the systems this integration reads; the others are listed as unsupported. */
export const SYSTEM_TYPES = {
  IAQUA: 'iaqua',
  EXO: 'exo',
};

/** Gladys values (server/utils/constants.js of the Gladys core). */
export const GLADYS = {
  ON: 1,
  OFF: 0,
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** Refresh of the pool states, in seconds: never faster than 30 s. */
export const REFRESH_INTERVAL = { min: 30, max: 3600, default: 60 };

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  /** States per publishStates request. */
  statesPerRequest: 100,
  /** Our own ceiling of iAquaLink requests per minute, commands included. */
  requestsPerMinute: 20,
  /** Largest HTTP answer read. */
  responseBytes: 2 * 1024 * 1024,
  /** Systems read per account (a pool owner has one or two). */
  systems: 10,
  /** Auxiliary outputs read per panel (an iAquaLink RS has up to 32). */
  auxPerSystem: 40,
  /** Dated states kept while Gladys is unreachable. */
  queuedEvents: 200,
};

export const TIMINGS = {
  requestTimeout: 20_000,
  /** Between two iAquaLink requests, to stay gentle with the cloud. */
  requestSpacing: 1_000,
  /** The scheduler looks this often whether a read is due. */
  tickInterval: 5_000,
  /** The list of systems of the account is read again this often. */
  systemsInterval: 30 * 60_000,
  /** Renew the IdToken this long before it expires. */
  tokenMargin: 5 * 60_000,
  /** IdToken lifetime when the answer gives none (Cognito: one hour). */
  tokenLifetime: 60 * 60_000,
  /** Never sign in again more often than this, except after a configuration change. */
  loginCooldown: 5 * 60_000,
  /** Pauses after a failed read: 1, 2, 5, 10 then 15 minutes. */
  backoff: [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000],
  /** After a 429 without Retry-After; a Retry-After is kept between 1 minute and 1 hour. */
  rateLimitPause: 15 * 60_000,
  rateLimitMin: 60_000,
  rateLimitMax: 60 * 60_000,
  /** Email or password refused: one new try this late, or at once after a configuration change. */
  refusedRetry: 6 * 60 * 60_000,
  /**
   * After a toggle command (iAquaLink panels only know "toggle"), a new
   * command on the same equipment is refused this long, unless the panel
   * already reports the change: a second toggle would undo the first one.
   */
  toggleGuard: 30_000,
  /** The publisher sends what is pending every second. */
  flushInterval: 1_000,
  /** An unchanged state is sent again every 30 minutes. */
  stateHeartbeat: 30 * 60_000,
  /** The "Test the connection" button and the Discovery scan read at most this often. */
  testCooldown: 30_000,
};
