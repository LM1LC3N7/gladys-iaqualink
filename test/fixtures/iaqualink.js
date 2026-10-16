// -----------------------------------------------------------------------------
// Sample iAquaLink answers, adapted from the test fixtures of flz/iaqualink-py
// (BSD-3-Clause, see THIRD_PARTY_NOTICES.md): login, device list, the home and
// devices screens of an iAquaLink panel, the shadow of an eXO chlorinator.
// Every identifier and token here is made up.
// -----------------------------------------------------------------------------

export const NOW = Date.parse('2026-07-14T10:00:00Z');
export const MINUTE = 60_000;

export const EMAIL = 'pool.owner@example.com';
export const PASSWORD = 'S3cret pa55word';
export const USER_ID = 123456;

export const SERIALS = { iaqua: 'IQ20ABC123', exo: 'EXO0987654', robot: 'I2D555' };

export const loginAnswer = (n, { refreshToken = 'refresh-1', expiresIn = 3600 } = {}) => ({
  id: USER_ID,
  email: EMAIL,
  username: EMAIL,
  session_id: `session-${n}`,
  authentication_token: `auth-${n}`,
  country: 'FR',
  userPoolOAuth: {
    IdToken: `id-token-${n}`,
    AccessToken: `access-${n}`,
    ...(refreshToken ? { RefreshToken: refreshToken } : {}),
    ExpiresIn: expiresIn,
    TokenType: 'Bearer',
  },
  cognitoPool: { appClientId: 'app-client' },
});

export const SYSTEMS = [
  {
    id: 1,
    serial_number: SERIALS.iaqua,
    name: 'Piscine',
    device_type: 'iaqua',
    owner_id: USER_ID,
    firmware_version: null,
  },
  { id: 2, serial_number: SERIALS.exo, name: 'Électrolyseur', device_type: 'exo' },
  { id: 3, serial_number: SERIALS.robot, name: 'Robot', device_type: 'i2d' },
];

/** The home screen values of a pool + spa panel in Celsius (system_type 0). */
export const HOME_VALUES = {
  status: 'Online',
  response: 'AQU=XXXX',
  system_type: '0',
  temp_scale: 'C',
  spa_temp: '',
  pool_temp: '26',
  air_temp: '21',
  spa_set_point: '36',
  pool_set_point: '28',
  cover_pool: '',
  freeze_protection: '0',
  spa_pump: '0',
  pool_pump: '1',
  spa_heater: '0',
  pool_heater: '3',
  solar_heater: '',
  spa_salinity: '',
  pool_salinity: '',
  orp: '',
  ph: '',
  relay_count: '4',
};

/** The `[{ key: value }, ...]` list a home screen is made of. */
export const homeAnswer = (values = HOME_VALUES, extra = {}) => ({
  onetouch: 'false',
  message: '',
  home_screen: Object.entries(values).map(([key, value]) => ({ [key]: value })),
  ...extra,
});

/** The auxiliaries of the panel: [key, state, label, type, subtype]. */
export const AUX = [
  ['aux_1', '0', 'Cleaner', '0', '0'],
  ['aux_2', '1', 'POOL LIGHT', '0', '0'],
  ['aux_3', '1', 'Spa Light', '1', '50'],
  ['aux_4', '0', 'Colors', '2', '5'],
  ['aux_B1', '0', 'Aux V5', '0', '2'],
  ['aux_EA', '0', 'Extra Aux', '0', '0'],
];

export const devicesAnswer = (aux = AUX, status = 'Online') => ({
  message: '',
  devices_screen: [
    { status },
    { response: "AQU='72'" },
    { group: '1' },
    ...aux.map(([key, state, label, type, subtype]) => ({
      [key]: [{ state }, { label }, { icon: 'aux_1_0.png' }, { type }, { subtype }],
    })),
  ],
});

/** The shadow of an eXO iQ, from the iaqualink-py fixture, plus a heating module. */
export const shadowAnswer = () => ({
  state: {
    reported: {
      vr: 'V85W4',
      aws: { status: 'connected', timestamp: 123, session_id: 'xxxx' },
      equipment: {
        swc_0: {
          vr: 'V85R67',
          sn: 'xxxxx',
          amp: 1,
          vsp: 1,
          low: 0,
          swc: 50,
          temp: 1,
          lang: 2,
          ph_sp: 74,
          sns_1: { state: 1, value: 75, sensor_type: 'Ph' },
          aux_1: { type: 'none', mode: 0, color: 0, state: 0 },
          sns_2: { state: 1, value: 780, sensor_type: 'Orp' },
          sns_3: { state: 1, value: 29, sensor_type: 'Water temp' },
          aux_2: { type: 'light', mode: 0, state: 0, color: 0 },
          boost: 0,
          orp_sp: 830,
          aux230: 1,
          ph_only: 1,
          swc_low: 0,
          version: 'V1',
          exo_state: 1,
          dual_link: 1,
          production: 1,
          error_code: 0,
          boost_time: '24:00',
          filter_pump: { type: 1, state: 1 },
          error_state: 0,
        },
      },
      heating: { state: 0, enabled: 1, priority_enabled: 0, sp: 28, sp_min: 15, sp_max: 32 },
    },
  },
  deviceId: '123',
  ts: 123,
});
