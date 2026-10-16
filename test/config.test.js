// -----------------------------------------------------------------------------
// The configuration of the manifest, normalized.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig } from '../src/config.js';

test('defaults', () => {
  assert.deepEqual(normalizeConfig(), {
    email: '',
    password: '',
    refreshInterval: 60,
    allowCommands: true,
    includeUnnamedAux: false,
    language: 'fr',
  });
  assert.equal(DEFAULTS.refresh_interval, 60);
});

test('the refresh interval stays between 30 s and one hour', () => {
  assert.equal(normalizeConfig({ refresh_interval: 5 }).refreshInterval, 30);
  assert.equal(normalizeConfig({ refresh_interval: '45' }).refreshInterval, 45);
  assert.equal(normalizeConfig({ refresh_interval: 99999 }).refreshInterval, 3600);
  assert.equal(normalizeConfig({ refresh_interval: 'soon' }).refreshInterval, 60);
});

test('checkboxes, language, email trimmed, password kept as typed', () => {
  const config = normalizeConfig({
    email: '  me@example.com ',
    password: ' pass ',
    allow_commands: 'false',
    include_unnamed_aux: 'true',
    language: 'EN',
  });
  assert.equal(config.email, 'me@example.com');
  assert.equal(config.password, ' pass ');
  assert.equal(config.allowCommands, false);
  assert.equal(config.includeUnnamedAux, true);
  assert.equal(config.language, 'en');
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});
