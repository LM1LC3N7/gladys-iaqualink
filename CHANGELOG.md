# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- LICENSE: standard Apache-2.0 appendix line, without a personal name.

## [0.1.1] - 2026-10-17

### Added

- iAquaLink account (email and password of the iAquaLink app), through the
  iAquaLink cloud; the session is renewed before it expires, a refused
  password is not retried for 6 hours or until it is changed.
- Jandy iAquaLink panels: pool, spa and air temperatures, pool and spa pumps,
  pool, spa and solar heaters, pool and spa set points, lights (on/off,
  brightness of dimmable lights), auxiliary outputs, pH, ORP and salinity when
  reported, and a status text.
- Zodiac eXO iQ chlorinators: water temperature, pH, ORP and their set points,
  chlorine production level, chlorine production, boost, low mode, filter
  pump, auxiliary outputs, heating and its set point, and a status text (error
  code, low salt).
- Commands, off until allowed in the configuration; the auxiliary outputs
  (which may drive a valve, valve actuators included) need a second option.
  One at a time per system, after reading the state again within the 5 s ack
  of Gladys; a toggle is refused when the state is unknown, and for 60 seconds
  after the previous one only the new state is accepted, unless the panel
  reports the change sooner.
- A panel switching between Celsius and Fahrenheit: values and set points
  converted to the unit of the features.
- After three sign-ins in a row answered by a server error, a one-hour pause
  (a sign-in without any answer keeps the normal backoff).
- Reads every minute by default (30 seconds at the fastest), at most 20
  requests a minute, longer pauses after errors and on HTTP 429.
- Transport badges, a "Test the connection" button, feature names in French
  or English.

[Unreleased]: https://github.com/LM1LC3N7/gladys-iaqualink/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-iaqualink/releases/tag/v0.1.1
