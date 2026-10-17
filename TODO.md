# TODO — iAquaLink v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — iAquaLink cloud** (2026-10-16): sign-in and session
      renewal, signed device list, iAquaLink panels (`iaqua`: home and devices
      screens, toggles, lights, set points, heat-pump set points) and eXO
      chlorinators (`exo`: shadow, desired states), Gladys devices with
      features kept in `/data`, commands serialized per system and read again
      before, toggle guard, backoff, 429 pause, request budget, transport
      badges, "Test the connection" button, manifest, docs en/fr, cover.
      Tested against sample answers and a fake cloud only.
- [ ] **Milestone 2 — real accounts** (testers with an iAquaLink panel or an
      eXO): record real answers as fixtures, fix what differs. To check first:
  - [ ] the login and refresh answers (`ExpiresIn`, `RefreshToken` on
        refresh, `country`), and what a wrong password answers (400? 401?
        403? an HTML page, see `UNAUTHORIZED_HTML` in the fixtures?);
  - [x] **HTTP/1.1**: the Node `fetch` (HTTP/1.1 only) accepted by the
        endpoints iaqualink-py reaches over HTTP/2 — anonymous probe of
        2026-10-16: application 401s over HTTP/1.1 on prod.zodiac-io.com,
        r-api and p-api, no protocol error;
  - [ ] eXO: pH in tenths (75 = 7.5) on every firmware, `ph_sp` too; the aux
        `type` values; the shadow `reported` catching up after a desired
        state (and whether `production` is the switch the app shows);
  - [ ] panels: `pool_temp` empty while the pump is off, salinity in ppm, pH
        in tenths or not, the labels of lights (`LIGHT` in the label), the
        `type` 3 of the valve actuators (SJVA), the answer of `set_light` and
        of `setpoint_hpm_temp`, how long a panel takes to report a toggle (the
        60 s guard);
  - [ ] a pool + spa panel (`system_type` 0 and 2), the order of
        `temp1`/`temp2`;
  - [ ] the time a read takes (the 4 s deadline of a command);
  - [ ] which status code a busy cloud answers (429? 503?).
- [ ] **Milestone 3 — more of iaqualink-py**: OneTouch scenes, variable-speed
      pumps of a panel (`vsp_pump_*`, speed presets), IntelliCenter light
      zones (`icl_zone_*`), colour effects (`text`/`select`), the heat pump
      paired with a panel (on/off, heat/chill, alerts), freeze protection,
      chlorinator production percentage as a command.
- [ ] **Milestone 4 — other Zodiac devices** (not in iaqualink-py when the
      brief was written; iaqualink-py has since added some of them, to be
      ported from it): robot cleaners i2d / Vortex / Cyclobat (`i2d`,
      `cyclobat`, WebSocket commands), standalone Zodiac heat pumps (`hpm`),
      iQPump. Today they are listed as "not supported yet" in the status.
- [ ] **Milestone 5 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published
      (at milestone 1 its only expected error is the `docker_image` not yet
      pullable from GHCR).

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: flz/iaqualink-py (BSD-3-Clause) is Python, so its logic is ported,
  not imported; its full notice is in `THIRD_PARTY_NOTICES.md`, shipped in
  the image with `LICENSE`. No runtime dependency besides the SDK (`fetch` is
  built in).
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its `docker_image` were someone else's. The first patch release gives 0.1.1.
- External ids: `gladys.externalIds('iaqualink', serial_number)`, one device
  per system (panel or eXO). Feature keys are frozen: panels `status`,
  `pool-temperature`, `spa-temperature`, `air-temperature`, `pool-pump`,
  `spa-pump`, `pool-heater`, `spa-heater`, `solar-heater`, `pool-setpoint`,
  `spa-setpoint`, `ph`, `orp`, `pool-salinity`, `spa-salinity`,
  `aux-<suffix in lower case>` and `aux-<suffix>-brightness`; eXO `status`,
  `temperature`, `ph`, `orp`, `ph-setpoint`, `orp-setpoint`,
  `chlorine-level`, `production`, `boost`, `low`, `filter-pump`, `heating`,
  `heating-setpoint`, `aux-<n>`.
- Features only grow: what a system showed once is kept (in memory and in
  `/data/iaqualink-state.json`, with the auxiliaries and their kind), so a
  panel offline or reporting "" at start keeps its features in Discovery.
  The temperature unit of a panel is frozen at its first online reading
  (Gladys freezes units at creation); a panel never read online is not
  published.
- Units: only the ones `DEVICE_FEATURE_UNITS_BY_CATEGORY` lists — °C/°F for
  temperatures and set points (`thermostat`/`target-temperature`), `ph`,
  `millivolt` for ORP. Salinity and the chlorine production level have no
  Gladys category: `unknown` without unit, the unit in the feature name.
- Commands are off by default (`allow_commands: false`, read-only at
  installation; once on: pumps, heaters, set points, lights, eXO switches).
  The plain auxiliaries of a panel (kind `switch`), its valve actuators
  (`type` 3, SJVA, kind `valve`) and the eXO `aux_N` can drive anything, a
  valve included: they need `allow_aux_commands` (false by default) on top.
  Lights stay under `allow_commands` alone. Review of milestone 1.
- Command safety: one command at a time per system; the state is read again
  just before (never decided on a state in memory), with no gap and a 4 s
  timeout, and nothing is sent when that read ended after 4 s (Gladys awaits
  the ack 5 s); the command request gets what is left of 4.8 s (0.8 s at
  least). A toggle is refused when the panel is offline or the state unknown,
  skipped when already right. After a toggle, a guard holds 60 s from the end
  of its request: the expected state is `1 - from`; asking it succeeds
  without sending, asking the old one is refused ("moving"); the guard ends
  early only on a reading of the system online showing `1 - from`, never on
  an unknown state. A toggle refused or never sent (4xx, 401, 429, budget,
  sign-in failure) leaves no guard; one that may have reached the panel
  (no answer, 5xx, unreadable answer) is guarded. The answer of a toggle is
  not shown (the panel may still report the old state). Lights, set points
  and the eXO take absolute values; an eXO state not reported is refused. A
  command finding fewer than 2 requests left in the minute is refused, not
  queued; a 429 answering a command pauses the reads and the commands.
- A panel whose scale changes after the features were created (unit frozen):
  values and set points are converted C↔F, the change logged once; a set
  point is refused while the scale of the panel cannot be read.
- Set points: `set_temps` sends both (spa first when the panel has a spa set
  point, the other seeded with the value just read); refused when the other
  one is unknown. With a heat pump paired, `setpoint_hpm_temp` (as
  iaqualink-py). Range 1–40 °C / 34–104 °F (panels), `sp_min`–`sp_max` (eXO).
- Session: proactive renewal 5 min before `ExpiresIn` (JWT `exp`, else one
  hour), and once on a 401 (or a 404 of the device list, as iaqualink-py). A
  refused refresh token is dropped, then one sign-in; no automatic sign-in
  within 5 minutes of the last successful one; a refused password (400, 401
  or 403 on the login, except an HTML page of a busy CDN) waits 6 hours, a
  configuration change, or the Test button. Three sign-ins in a row answered
  by a 5xx or an unreadable answer wait 1 hour (`loginFailurePause`; the
  counter resets on a successful read, a change of the email or password, or
  the Test button). A sign-in without any answer (`network`: an internet box
  still starting after a power cut) only follows the normal backoff, 1 to
  15 minutes (approval review, round 1). A command's 5 s ack budget runs from
  its reception, waiting in the per-system queue included.
- Rate: refresh 30 s minimum (60 s default); device list every 30 minutes;
  our own ceiling of 20 requests per minute, 1 s apart; backoff 1, 2, 5, 10,
  15 minutes; 429 pauses for Retry-After clamped to 1–60 minutes (15 by
  default); the scan, the Test button and the commands never read during that
  pause, nor (scan, button) more often than every 30 s. Four systems per
  account at most (1 + 4 × 2 requests per round).
- Errors of one system (`http`, `bad_response`) mark that system unreachable
  and the read goes on with the others; account-level errors stop the round.
- `/data` keeps the systems missing from one device list (a hiccup of the
  cloud), so they come back with their features. The kind of an auxiliary
  already seen is never rewritten (it shapes the feature).
- pH (eXO and panel): tenths (75 = 7.5) are divided by ten, a value already in
  pH units is kept. Air temperature down to -30 °C (-22 °F).
- Error reasons are shown in the language of the configuration, by kind,
  never with a URL, a token or a password.
- Unnamed auxiliaries ("Aux 3", "Aux V12", "Extra Aux") are left out unless
  `include_unnamed_aux` is ticked: a panel lists up to 32, most unused.
- Status texts and feature names follow the `language` option (fr default).
