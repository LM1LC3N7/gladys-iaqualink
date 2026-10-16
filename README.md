# gladys-iaqualink

[Gladys Assistant](https://gladysassistant.com) external integration for
**Zodiac / Jandy iAquaLink** pools, through the iAquaLink cloud (the account
of the iAquaLink app): Jandy iAquaLink panels (pool, spa and air
temperatures, pumps, heaters and set points, lights, auxiliaries) and Zodiac
eXO iQ chlorinators (chlorine production, boost, pH, ORP, temperature,
status). Unofficial, not affiliated with Zodiac, Jandy or Fluidra.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress (milestone 1).** Tested with sample answers only, never
> with a real iAquaLink account or system.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (IaqualinkApp) ⇄ src/iaqualink/client.js ⇄ src/iaqualink/http.js ⇄ iAquaLink cloud
                                   ├─ src/iaqualink/iaqua.js  panel screens and commands (pure)
                                   ├─ src/iaqualink/exo.js    eXO shadow and desired states (pure)
                                   ├─ src/devices.js          -> Gladys devices and states (pure)
                                   ├─ src/budget.js           20 requests/min, 1 s apart
                                   ├─ src/store.js            features seen, kept in /data
                                   └─ src/publisher.js        300 states/min
```

- **Account**: email and password (`secret` field) of the iAquaLink app.
  `POST prod.zodiac-io.com/users/v1/login` gives a session id, the user id and
  a Cognito IdToken (one hour), renewed 5 minutes before it expires with
  `/users/v1/refresh`, and once when a request is refused (401, or 404 on the
  device list). A refused refresh token is dropped and leads to one sign-in;
  never two automatic sign-ins within 5 minutes; a refused email or password
  (400/401/403 on the login, the busy pages of the CDN excluded) waits 6 hours
  or a configuration change. Nothing secret is written to `/data` or logged.
- **Reading**: the signed device list (`r-api.iaqualink.net/v2/devices.json`,
  HMAC-SHA1 of `user_id,timestamp`) every 30 minutes; at the refresh interval
  (60 s by default, 30 s at the fastest) `get_home` and `get_devices` of each
  panel (`p-api.iaqualink.net/v2/mobile/session.json`) and the shadow of each
  eXO (`prod.zodiac-io.com/devices/v1/<serial>/shadow`). Errors back off 1, 2,
  5, 10 then 15 minutes; 429 pauses for its Retry-After (1 to 60 minutes,
  15 by default); our own ceiling is 20 requests a minute.
- **Devices**: `ext:<selector>:iaqualink:<serial>`, one per system, feature
  keys frozen (see TODO.md "Decisions"). The features only grow and are kept in
  `/data/iaqualink-state.json` with the temperature unit, frozen at the first
  reading.
- **Commands**: one at a time per system, after reading the state again.
  Panel pumps, heaters and plain auxiliaries are toggles: refused when the
  state is unknown or the panel offline, skipped when already right, and a
  second toggle of the same equipment is refused for 30 s unless the panel
  reports the change. Lights (`set_light`), set points (`set_temps`, both at
  once; `setpoint_hpm_temp` with a heat pump) and the eXO (desired state) take
  absolute values. The `allow_commands` option turns every command off.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit
npm run cover                                   # regenerates cover.png (800×534)
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/iaqualink.js` holds sample answers adapted from the iaqualink-py
fixtures (made-up identifiers); `test/helpers/fakeCloud.js` serves them behind
a fake `fetch`, plays a panel (toggles, set points, lights) and an eXO shadow,
and checks the tokens.

## Credits

- [flz/iaqualink-py](https://github.com/flz/iaqualink-py) (BSD-3-Clause), the
  Python library Home Assistant uses for iAquaLink: endpoints, application
  keys, sign-in and renewal, request signature, panel screens and commands,
  eXO shadow. Ported to JavaScript (no Python runs here); its notice is in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic lists the repository in the Gladys store
(added at the first real release).

## License

Apache-2.0. iAquaLink, Jandy and Zodiac are trademarks of their owners; this
project is not affiliated with them.
